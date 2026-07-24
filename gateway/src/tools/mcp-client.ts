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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpCatalog, McpServerEntry } from "@sentient/config";
import { getLog } from "../logging/logger.js";
import type { ToolResult } from "./tool-types.js";

const log = getLog(["sentient", "tools", "mcp-client"]);

const CLIENT_NAME = "sentient-gateway";
const CLIENT_VERSION = "2.0.0";

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
   *  skipped — it never fails discovery for the rest of the catalog. */
  listTools(): Promise<McpToolRef[]>;
  /** Invokes one tool on one server. Failures (unknown server, connect
   *  failure, McpError, timeout) are mapped into an error ToolResult
   *  rather than thrown — the ReAct loop feeds this straight back to the
   *  model as the tool's outcome. */
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
    connectPromise.catch(() => connections.delete(serverName)); // allow retry on next call
    return connectPromise;
  }

  async function listToolsForServer(serverName: string, entry: McpHttpEntry): Promise<McpToolRef[]> {
    const startedAt = Date.now();
    try {
      const client = await connect(serverName, entry, undefined);
      const { tools } = await client.listTools();
      const refs: McpToolRef[] = tools.map((tool) => ({
        serverName,
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));
      const filtered = filterByAllowlist(refs, entry.tools?.include);
      log.info("mcp.list-tools.ok", {
        serverName,
        totalCount: refs.length,
        filteredCount: filtered.length,
        elapsedMs: Date.now() - startedAt,
      });
      return filtered;
    } catch (err) {
      log.warn("mcp.list-tools.failed", {
        serverName,
        reason: err instanceof Error ? err.message : String(err),
        elapsedMs: Date.now() - startedAt,
      });
      return [];
    }
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
      try {
        const client = await connect(serverName, entry, signal);
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
        const reason = err instanceof Error ? err.message : String(err);
        log.warn("mcp.call-tool.failed", { serverName, name, reason, elapsedMs: Date.now() - startedAt });
        return { content: `MCP tool call failed: ${reason}`, isError: true };
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
