// MCP CLIENT — the inverse of gateway/src/mcp-host/ (which HOSTS an MCP
// server for Hermes). This module DIALS OUT to operator-configured MCP
// servers (`gateway/config.yaml#mcp_catalog`) over streamable-HTTP and
// exposes their tools to the native ReAct loop (Plan 2 Task 3).
//
// Uses the official `@modelcontextprotocol/sdk` Client + streamable-HTTP
// transport rather than hand-rolling SSE/session framing. Per
// `.claude/rules/gateway/mcp-deployment.md`, every catalog entry is
// addressed by HTTP url (`http://<svc>:<port>/mcp`); stdio entries are
// deprecated and skipped here (logged as a warn).
//
// Connections are lazy and per-server: dialing happens on first use
// (listTools or callTool), not at construction, so an unused/down MCP
// container never blocks gateway boot.
//
// A cached transport is EVICTED as soon as a request proves it dead (see
// `classifyTransport` below). Before that existed, the system orchestrator
// recreating an addon after the boot warm-up had already connected left the
// gateway holding a session the server had forgotten, and every later call to
// that server failed for the rest of the process's life.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpCatalog, McpServerEntry } from "@sentient/config";
import { getLog } from "../logging/logger.js";
import type { ToolResult } from "./tool-types.js";

const log = getLog(["sentient", "tools", "mcp-client"]);

const CLIENT_NAME = "sentient-gateway";
const CLIENT_VERSION = "2.0.0";

/** Whether a failed request leaves the cached transport usable. */
type TransportHealth = "alive" | "dead";

/**
 * The eviction boundary, and the whole judgement of this module.
 *
 * `alive` means the MCP session is PROVEN still usable, and there are exactly
 * two ways to prove it:
 *   - the caller cancelled (barge-in / interrupt / turn abort). The signal
 *     says so directly; the SDK surfaces it as a bare `AbortError` from
 *     `signal.throwIfAborted()` or as `McpError(RequestTimeout)` from its
 *     cancel path, so the signal is checked first and the error shape second.
 *   - the peer answered with a JSON-RPC error — bad arguments, unknown tool,
 *     the tool itself blew up, or our own request timeout. Those arrive as
 *     `McpError` with any code except `ConnectionClosed`.
 * Evicting on either would be worse than the bug it fixes: a tool that
 * legitimately answers "no such playlist" is a WORKING transport, and every
 * user mistake or barge-in would become a redial.
 *
 * Everything else — an HTTP-level rejection of the POST (a recreated FastMCP
 * server answers a forgotten session with 404 + JSON-RPC -32600 "Session not
 * found", measured live against ma-mcp), a socket error, a transport close —
 * leaves usability UNPROVEN, so the transport is presumed dead. The cost of
 * being wrong that way is one redial on next use; the cost of the other way
 * is a permanently dead tool surface.
 *
 * Exported so the `ConnectionClosed` carve-out can be pinned directly: the SDK
 * raises that one LOCALLY, when the transport closes under an in-flight
 * request, and by then whoever closed the transport has already dropped it from
 * the pool — so `dropIfCurrent` makes both classifications look identical from
 * outside `callTool`. The carve-out is unobservable end-to-end.
 */
export function classifyTransport(err: unknown, signal: AbortSignal | undefined): TransportHealth {
  if (signal?.aborted) return "alive";
  if (err instanceof McpError) return err.code === ErrorCode.ConnectionClosed ? "dead" : "alive";
  return "dead";
}

function failureReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether a JSON value plausibly carries real data, for the "is there a
 *  populated field alongside `error`" check in `detectInBandError` below.
 *  Deliberately typed per JSON shape rather than JS truthiness: a naive
 *  truthy check gets objects wrong in the direction that matters here —
 *  every object is truthy in JS regardless of contents, so it would treat
 *  an empty `{}` as "real data". (It happens to get `0` right, by accident:
 *  `0` is falsy, which is also the answer we want for `total_results:0`
 *  below — but relying on that coincidence is exactly the kind of guess
 *  this function exists to avoid making.) The rule, one JSON type at a
 *  time:
 *   - string:  non-empty. `""` carries nothing; `"<html>…</html>"` does.
 *   - array:   non-empty. Matches the pre-existing array rule (searxng's
 *     `results:[]` carries nothing).
 *   - object:  has at least one own key. `{}` carries nothing; a nested
 *     `attributes: {...}` with fields is real data.
 *   - number:  non-zero. `total_results:0` is a COUNT of nothing — the
 *     numeric analogue of a 0-length array — so it must NOT count as
 *     populated, or the searxng D18 payload stops being flagged. A
 *     genuinely meaningful number (a temperature, an id) is never 0-as-a-
 *     placeholder in the payloads we've observed; if that changes, extend
 *     this deliberately rather than guessing here.
 *   - boolean / null: never populated. No observed tool payload puts real
 *     data behind a bare boolean or null field; extend deliberately if one
 *     shows up rather than defaulting a guess in now. */
function isPopulatedValue(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && value !== null) return Object.keys(value).length > 0;
  return false;
}

/** Detects a tool result that reports `isError:false` at the JSON-RPC level
 *  while carrying its own failure INSIDE the payload (D18: the upstream
 *  `searxng-mcp-server`, pip-pinned 0.1.9, swallows its own DNS failure and
 *  answers a 131-byte "success" — `{"total_results":0,"results":[],
 *  "error":"[Errno -3] Temporary failure in name resolution"}`. Nothing
 *  between it and the model flagged that as a failure, so the model
 *  answered a currency question from its own weights instead of refusing.
 *  We cannot fix the upstream package; this is our boundary check).
 *
 *  Deliberately narrow. The false positive that matters more than the bug
 *  being fixed is turning a REAL result into a manufactured error — a log
 *  search, a home-assistant entity literally named "error", a web page
 *  ABOUT errors, a fetch whose real answer lives in a `content` STRING, a
 *  `ha_get_state` reply whose real answer is a single entity OBJECT with no
 *  arrays anywhere, or a search that returned hits alongside a warning. All
 *  three conditions below must hold:
 *   1. `content` parses as JSON and the top level is a plain object — prose
 *      that merely contains the word "error" (a log line, an article) is
 *      not JSON and never reaches this branch. A top-level JSON ARRAY is
 *      also rejected here: every observed tool answers with an object
 *      envelope, so an in-band error inside a bare array (e.g.
 *      `[{"error":"x"}]`) is a deliberate scope call, not an oversight —
 *      left uncaught rather than widening the shape this function accepts.
 *   2. that object has an OWN top-level property literally named `error`
 *      holding a non-empty string — an id/message/title containing the
 *      substring "error" nested inside a results array is not a top-level
 *      key named `error`.
 *   3. every OTHER top-level property on that object is unpopulated per
 *      `isPopulatedValue` — a call that returned a real answer (search
 *      hits, log lines, a fetched page's `content` string, an entity's
 *      `state`/`attributes`) alongside a warning is a working call, not a
 *      failure; emptiness only corroborates the error string, it is never
 *      sufficient on its own (a genuine no-hits search with no `error` key
 *      is not flagged here).
 *  Returns the error message when all three hold, `null` otherwise. */
export function detectInBandError(content: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const errorMessage = obj.error;
  if (typeof errorMessage !== "string" || errorMessage.length === 0) return null;
  const hasPopulatedField = Object.entries(obj).some(([key, value]) => key !== "error" && isPopulatedValue(value));
  if (hasPopulatedField) return null;
  return errorMessage;
}

/** Applies `detectInBandError` to an already-"successful" `ToolResult`,
 *  flipping it to `isError:true` when the payload proves the flag lied. A
 *  result that already reports `isError:true` passes through unchanged —
 *  there is nothing to upgrade. Called on the shared `callTool` result path
 *  (see below) so every MCP server inherits the check, not just searxng. */
export function normalizeToolResult(result: ToolResult): ToolResult {
  if (result.isError) return result;
  const reason = detectInBandError(result.content);
  if (reason === null) return result;
  return {
    isError: true,
    content: `MCP tool reported success but its payload carries an error: ${reason}`,
  };
}

/** One tool advertised by an MCP server, tagged with the catalog entry it
 *  came from so callers can route a call back to the right server. */
export interface McpToolRef {
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpClient {
  /** Dials every configured HTTP server (lazily connecting as needed),
   *  lists its tools, applies the per-server include allowlist, and
   *  returns the aggregate. A single unreachable server is logged and
   *  skipped — it never fails discovery for the rest of the catalog.
   *  A server that died under a cached transport is redialled ONCE inside
   *  this call: listing is read-only and idempotent, so re-running it
   *  cannot double a side effect. */
  listTools(): Promise<McpToolRef[]>;
  /** Invokes one tool on one server. Failures (unknown server, connect
   *  failure, McpError, timeout) are mapped into an error ToolResult
   *  rather than thrown — the ReAct loop feeds this straight back to the
   *  model as the tool's outcome. A dead transport is evicted so the NEXT
   *  call redials, but the call is never transparently re-invoked: a tool
   *  may have side effects and the transport layer cannot know whether a
   *  request that failed mid-flight already executed. */
  callTool(serverName: string, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
  /** Closes every connected server transport. */
  close(): Promise<void>;
}

/** The result of intersecting a catalog entry's curated `tools.include` list
 *  against what the server actually advertises. */
export interface AllowlistFilterResult {
  /** Tools kept — advertised by the server AND named in `include`. */
  kept: McpToolRef[];
  /** `include` entries that matched no advertised tool (D19): the operator's
   *  curated surface has drifted from upstream, silently, until something
   *  reads this. Empty whenever `include` is undefined. */
  unmatched: string[];
}

/** Keeps only allowlisted tools when `include` is set; keeps all tools when
 *  `include` is undefined (operator has not curated this server's surface).
 *
 *  Pure — reports the diff instead of just dropping it, so the caller can log
 *  the drift (D19: `filterByAllowlist` used to intersect and discard
 *  silently, so a curated surface rotted invisibly as upstream renamed
 *  things while the config kept reading like coverage). */
export function filterByAllowlist(tools: McpToolRef[], include: string[] | undefined): AllowlistFilterResult {
  if (include === undefined) return { kept: tools, unmatched: [] };
  const advertised = new Set(tools.map((tool) => tool.name));
  const allowed = new Set(include);
  const kept = tools.filter((tool) => allowed.has(tool.name));
  const unmatched = include.filter((name) => !advertised.has(name));
  return { kept, unmatched };
}

/** The one transport this v1 client dials — stdio catalog entries are
 *  skipped (see `httpEntry` below). */
type McpHttpEntry = Extract<McpServerEntry, { transport: "http" }>;

export function createMcpClient(catalog: McpCatalog, opts: { includeServers?: string[] } = {}): McpClient {
  const connections = new Map<string, Promise<Client>>();

  const serverNames = Object.keys(catalog).filter(
    (name) => opts.includeServers === undefined || opts.includeServers.includes(name),
  );

  function httpEntry(serverName: string): McpHttpEntry | undefined {
    const entry = catalog[serverName];
    if (!entry) return undefined;
    if (entry.transport === "stdio") {
      log.warn("mcp.entry.stdio-skipped", { serverName, reason: "v1 only dials http transport" });
      return undefined;
    }
    return entry;
  }

  /** Connects to a server on first use and caches the live client. Concurrent
   *  callers for the same server share the in-flight connect promise. `signal`
   *  is forwarded into the SDK's `initialize` request alongside the
   *  operator-configured `connect_timeout` — without it the SDK silently
   *  defaults to a hardcoded 60s timeout and ignores caller aborts. */
  function connect(serverName: string, entry: McpHttpEntry, signal: AbortSignal | undefined): Promise<Client> {
    const cached = connections.get(serverName);
    if (cached) return cached;

    const connectPromise = (async () => {
      const startedAt = Date.now();
      const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
      const transport = new StreamableHTTPClientTransport(new URL(entry.url));
      // The SDK's own `Transport.sessionId` (optional `string`) and
      // `StreamableHTTPClientTransport`'s getter (`string | undefined`) are
      // only incompatible under our `exactOptionalPropertyTypes` — an
      // upstream typing gap, not a real structural mismatch.
      // `exactOptionalPropertyTypes` forbids `signal: undefined` against the
      // SDK's `signal?: AbortSignal` — spread it in only when present.
      await client.connect(transport as unknown as Transport, {
        ...(signal ? { signal } : {}),
        timeout: entry.connect_timeout * 1000,
      });
      log.info("mcp.connect.ok", { serverName, url: entry.url, elapsedMs: Date.now() - startedAt });
      return client;
    })();

    connections.set(serverName, connectPromise);
    connectPromise.catch(() => dropIfCurrent(serverName, connectPromise)); // allow retry on next call
    return connectPromise;
  }

  /** Compare-and-delete. Only drops the cache entry when it still holds THIS
   *  connection: without the comparison, a slow failure could evict the newer,
   *  healthy transport a concurrent caller had already installed. */
  function dropIfCurrent(serverName: string, stale: Promise<Client>): boolean {
    if (connections.get(serverName) !== stale) return false;
    connections.delete(serverName);
    return true;
  }

  /** Drops the cached transport when `err` proves it dead, so the next use
   *  redials. Returns whether it was actually evicted. */
  function evictIfDead(
    serverName: string,
    stale: Promise<Client>,
    err: unknown,
    signal: AbortSignal | undefined,
  ): boolean {
    const health = classifyTransport(err, signal);
    if (health === "alive") {
      log.debug("mcp.transport.kept", { serverName, reason: failureReason(err) });
      return false;
    }
    if (!dropIfCurrent(serverName, stale)) return false;
    log.warn("mcp.transport.evicted", { serverName, reason: failureReason(err) });
    void stale
      .then((client) => client.close())
      .catch((closeErr) => log.debug("mcp.transport.close-failed", { serverName, reason: failureReason(closeErr) }));
    return true;
  }

  type ListAttempt = { ok: true; refs: McpToolRef[] } | { ok: false; reason: string; transportEvicted: boolean };

  /** One `tools/list` round trip against the cached-or-fresh transport. */
  async function tryListTools(serverName: string, entry: McpHttpEntry, timeoutMs: number): Promise<ListAttempt> {
    const connectPromise = connect(serverName, entry, undefined);
    try {
      const client = await connectPromise;
      const { tools } = await client.listTools(undefined, { timeout: timeoutMs });
      return {
        ok: true,
        refs: tools.map((tool) => ({
          serverName,
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema as Record<string, unknown>,
        })),
      };
    } catch (err) {
      return {
        ok: false,
        reason: failureReason(err),
        transportEvicted: evictIfDead(serverName, connectPromise, err, undefined),
      };
    }
  }

  function finishListTools(serverName: string, entry: McpHttpEntry, refs: McpToolRef[], startedAt: number) {
    const { kept, unmatched } = filterByAllowlist(refs, entry.tools?.include);
    // D19: an include entry naming a tool the server no longer (or never
    // did) advertise is catalog drift, not a mere zero-hit filter — WARN so
    // it surfaces at startup instead of rotting silently in the allowlist.
    if (unmatched.length > 0) {
      log.warn("mcp.list-tools.allowlist-drift", { serverName, unmatched });
    }
    log.info("mcp.list-tools.ok", {
      serverName,
      totalCount: refs.length,
      filteredCount: kept.length,
      elapsedMs: Date.now() - startedAt,
    });
    return kept;
  }

  async function listToolsForServer(serverName: string, entry: McpHttpEntry): Promise<McpToolRef[]> {
    const startedAt = Date.now();
    // WHOLE-PHASE budget: the redial below shares the operator's `timeout`
    // with the first attempt instead of being granted a fresh one, so a
    // recovering server can never double a user-visible wait.
    const deadline = startedAt + entry.timeout * 1000;

    const first = await tryListTools(serverName, entry, entry.timeout * 1000);
    if (first.ok) return finishListTools(serverName, entry, first.refs, startedAt);

    const remainingMs = deadline - Date.now();
    // Redial only when the failure evicted a transport — a failure to CONNECT
    // means the server is simply down, and dialling it twice in one phase adds
    // nothing but latency.
    if (!first.transportEvicted || remainingMs <= 0) {
      log.warn("mcp.list-tools.failed", { serverName, reason: first.reason, elapsedMs: Date.now() - startedAt });
      return [];
    }

    log.info("mcp.list-tools.redial", { serverName, reason: first.reason, remainingMs });
    const second = await tryListTools(serverName, entry, remainingMs);
    if (second.ok) return finishListTools(serverName, entry, second.refs, startedAt);

    log.warn("mcp.list-tools.failed", {
      serverName,
      reason: second.reason,
      afterRedial: true,
      elapsedMs: Date.now() - startedAt,
    });
    return [];
  }

  return {
    async listTools(): Promise<McpToolRef[]> {
      const perServer = await Promise.all(
        serverNames.flatMap((serverName) => {
          const entry = httpEntry(serverName);
          return entry ? [listToolsForServer(serverName, entry)] : [];
        }),
      );
      return perServer.flat();
    },

    async callTool(
      serverName: string,
      name: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<ToolResult> {
      const startedAt = Date.now();
      const catalogEntry = catalog[serverName];
      const entry = httpEntry(serverName);
      if (!entry) {
        const reason =
          catalogEntry?.transport === "stdio" ? "configured but stdio transport (unsupported in v1)" : "not configured";
        log.warn("mcp.call-tool.unknown-server", { serverName, name, reason });
        return { content: `Unknown MCP server: ${serverName} (${reason})`, isError: true };
      }
      const connectPromise = connect(serverName, entry, signal);
      try {
        const client = await connectPromise;
        const result = await client.callTool({ name, arguments: args }, undefined, {
          signal,
          timeout: entry.timeout * 1000,
        });
        const parts = Array.isArray(result.content) ? result.content : [];
        const textParts = parts.filter((part): part is { type: "text"; text: string } => part.type === "text");
        const nonTextParts = parts.filter((part) => part.type !== "text");
        const content = textParts.map((part) => part.text).join("\n");
        if (textParts.length === 0 && nonTextParts.length > 0) {
          log.debug("mcp.call-tool.dropped-nontext-parts", {
            serverName,
            droppedPartTypes: [...new Set(nonTextParts.map((part) => part.type))],
          });
        }
        const wireIsError = !!result.isError;
        const normalized = normalizeToolResult({ content, isError: wireIsError });
        if (normalized.isError && !wireIsError) {
          // D18: the peer said isError:false, but its own payload disagrees.
          log.warn("mcp.call-tool.in-band-error", {
            serverName,
            name,
            reason: normalized.content,
          });
        }
        log.info("mcp.call-tool.ok", {
          serverName,
          name,
          isError: normalized.isError,
          contentLength: normalized.content.length,
          elapsedMs: Date.now() - startedAt,
        });
        return normalized;
      } catch (err) {
        const reason = failureReason(err);
        // Evict, but never re-invoke: this tool may have side effects and the
        // transport layer cannot know whether a request that failed mid-flight
        // already executed. Retrying is a decision for the ReAct loop, where it
        // is re-mediated by the PDP.
        const transportEvicted = evictIfDead(serverName, connectPromise, err, signal);
        log.warn("mcp.call-tool.failed", {
          serverName,
          name,
          reason,
          transportEvicted,
          elapsedMs: Date.now() - startedAt,
        });
        const hint = transportEvicted ? " (connection was reset; a retry will redial the server)" : "";
        return { content: `MCP tool call failed: ${reason}${hint}`, isError: true };
      }
    },

    async close(): Promise<void> {
      const clients = await Promise.all([...connections.values()].map((p) => p.catch(() => null)));
      await Promise.all(clients.filter((c): c is Client => c !== null).map((c) => c.close()));
      connections.clear();
      log.info("mcp.close.ok", { serverCount: clients.length });
    },
  };
}
