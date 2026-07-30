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
 */
function classifyTransport(err: unknown, signal: AbortSignal | undefined): TransportHealth {
  if (signal?.aborted) return "alive";
  if (err instanceof McpError) return err.code === ErrorCode.ConnectionClosed ? "dead" : "alive";
  return "dead";
}

function failureReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/** Keeps only allowlisted tools when `include` is set; keeps all tools when
 *  `include` is undefined (operator has not curated this server's surface). */
export function filterByAllowlist(tools: McpToolRef[], include: string[] | undefined): McpToolRef[] {
  if (include === undefined) return tools;
  const allowed = new Set(include);
  return tools.filter((tool) => allowed.has(tool.name));
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
    const filtered = filterByAllowlist(refs, entry.tools?.include);
    log.info("mcp.list-tools.ok", {
      serverName,
      totalCount: refs.length,
      filteredCount: filtered.length,
      elapsedMs: Date.now() - startedAt,
    });
    return filtered;
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
        const isError = !!result.isError;
        log.info("mcp.call-tool.ok", {
          serverName,
          name,
          isError,
          contentLength: content.length,
          elapsedMs: Date.now() - startedAt,
        });
        return { content, isError };
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
