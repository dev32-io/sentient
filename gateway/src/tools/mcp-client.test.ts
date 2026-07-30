import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpCatalog } from "@sentient/config";
import { classifyTransport, createMcpClient, filterByAllowlist } from "./mcp-client.js";

const tools = [
  { serverName: "ha", name: "ha_get_state", description: "", inputSchema: {} },
  { serverName: "ha", name: "ha_dangerous", description: "", inputSchema: {} },
];

describe("filterByAllowlist", () => {
  it("keeps only allowlisted tools when an include list is set", () => {
    expect(filterByAllowlist(tools, ["ha_get_state"]).map((t) => t.name)).toEqual(["ha_get_state"]);
  });
  it("keeps all tools when no include list is set", () => {
    expect(filterByAllowlist(tools, undefined)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Transport-eviction invariant — pinned against a REAL streamable-HTTP peer.
//
// Wire fact, measured against the live ma-mcp container on 2026-07-30: once the
// system orchestrator recreates a catalog server under an already-connected
// gateway, that server answers every further POST with
//   HTTP 404 {"jsonrpc":"2.0","id":"server-error",
//             "error":{"code":-32600,"message":"Session not found"}}
// The peer below reproduces that byte-for-byte and drives the real SDK
// transport, so these tests pin the wire contract rather than a mock of it.
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  id?: string | number;
  method?: string;
  params?: { protocolVersion?: string };
}

type ToolBehaviour = "ok" | "app-error" | "rpc-error";

interface FakeMcpPeer {
  url: string;
  /** How many `initialize` handshakes the peer has served — i.e. how many
   *  times the client dialled it. */
  initializeCount(): number;
  /** Forgets every session, exactly as a container recreate does. */
  recreate(): void;
  setToolBehaviour(behaviour: ToolBehaviour): void;
  stop(): Promise<void>;
}

const SESSION_NOT_FOUND_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: "server-error",
  error: { code: -32600, message: "Session not found" },
});

function jsonResponse(payload: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function startFakeMcpPeer(): FakeMcpPeer {
  let liveSessionId: string | null = null;
  let sessionSeq = 0;
  let initializes = 0;
  let toolBehaviour: ToolBehaviour = "ok";

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      // 405 on GET = "no standalone SSE stream", the SDK's expected case.
      if (req.method !== "POST") return new Response(null, { status: 405 });
      const body = (await req.json()) as JsonRpcRequest;
      if (body.method === "initialize") {
        initializes += 1;
        sessionSeq += 1;
        liveSessionId = `session-${sessionSeq}`;
        return jsonResponse(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: body.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "fake-mcp-peer", version: "1.0.0" },
            },
          },
          { "mcp-session-id": liveSessionId },
        );
      }
      if (req.headers.get("mcp-session-id") !== liveSessionId) {
        return new Response(SESSION_NOT_FOUND_BODY, {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [{ name: "ma_search", description: "", inputSchema: { type: "object" } }] },
        });
      }
      if (body.method === "tools/call") {
        if (toolBehaviour === "rpc-error") {
          return jsonResponse({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32602, message: "Invalid params: query is required" },
          });
        }
        const isAppError = toolBehaviour === "app-error";
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: isAppError ? "No such playlist" : "played" }],
            ...(isAppError ? { isError: true } : {}),
          },
        });
      }
      return jsonResponse({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    initializeCount: () => initializes,
    recreate: () => {
      liveSessionId = null;
    },
    setToolBehaviour: (behaviour) => {
      toolBehaviour = behaviour;
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}

describe("a catalog server that restarts under the client", () => {
  let peer: FakeMcpPeer;
  let client: ReturnType<typeof createMcpClient>;

  beforeEach(() => {
    peer = startFakeMcpPeer();
    const catalog: McpCatalog = {
      music_assistant: { transport: "http", url: peer.url, timeout: 5, connect_timeout: 5 },
    };
    client = createMcpClient(catalog);
  });

  afterEach(async () => {
    await client.close();
    await peer.stop();
  });

  it("re-lists tools after a recreate instead of serving the dead transport forever", async () => {
    expect(await client.listTools()).toHaveLength(1);
    peer.recreate();
    expect(await client.listTools()).toHaveLength(1);
    expect(peer.initializeCount()).toBe(2);
  });

  it("fails a call on a dead transport once, then reconnects on the next call", async () => {
    expect(await client.listTools()).toHaveLength(1);
    peer.recreate();
    const first = await client.callTool("music_assistant", "ma_search", {}, new AbortController().signal);
    expect(first.isError).toBe(true);
    const second = await client.callTool("music_assistant", "ma_search", {}, new AbortController().signal);
    expect(second.isError).toBe(false);
    expect(second.content).toBe("played");
    expect(peer.initializeCount()).toBe(2);
  });

  it("keeps the transport when the tool itself errors — no reconnect storm", async () => {
    peer.setToolBehaviour("app-error");
    const result = await client.callTool("music_assistant", "ma_search", {}, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.content).toBe("No such playlist");
    // The peer 404s a stale session, so a second success proves the SAME
    // session was reused — and the handshake count proves no redial.
    const again = await client.callTool("music_assistant", "ma_search", {}, new AbortController().signal);
    expect(again.isError).toBe(true);
    expect(peer.initializeCount()).toBe(1);
  });

  it("keeps the transport when the peer answers a call with a JSON-RPC error", async () => {
    peer.setToolBehaviour("rpc-error");
    const result = await client.callTool("music_assistant", "ma_search", {}, new AbortController().signal);
    expect(result.isError).toBe(true);
    peer.setToolBehaviour("ok");
    const after = await client.callTool("music_assistant", "ma_search", {}, new AbortController().signal);
    expect(after.content).toBe("played");
    expect(peer.initializeCount()).toBe(1);
  });

  it("keeps the transport when the caller aborts — barge-in must not poison the pool", async () => {
    expect(await client.listTools()).toHaveLength(1);
    const result = await client.callTool("music_assistant", "ma_search", {}, AbortSignal.abort());
    expect(result.isError).toBe(true);
    const after = await client.callTool("music_assistant", "ma_search", {}, new AbortController().signal);
    expect(after.content).toBe("played");
    expect(peer.initializeCount()).toBe(1);
  });
});

// The one carve-out in the eviction rule, and the only branch of it the wire
// tests above cannot reach. `McpError` normally proves the peer answered, which
// KEEPS the transport — except for `ConnectionClosed`, which the SDK raises
// LOCALLY when the transport closes with a request still in flight
// (`protocol.js:263` rejects every pending response handler with it). By the
// time that error surfaces, whoever closed the transport has already dropped it
// from the pool, so `dropIfCurrent` makes "dead" and "alive" produce the same
// observable result through `callTool` — hence the classifier is pinned here
// directly. The inverse (any other `McpError` keeps the transport) is pinned
// end-to-end by "keeps the transport when the peer answers a call with a
// JSON-RPC error" above; together the two make the carve-out non-droppable.
describe("classifyTransport", () => {
  it("treats a locally-raised ConnectionClosed as a dead transport, not as a peer answer", () => {
    const closed = new McpError(ErrorCode.ConnectionClosed, "Connection closed");
    expect(classifyTransport(closed, undefined)).toBe("dead");
  });
});

// MCP containers publish NO host ports (`.claude/rules/gateway/mcp-deployment.md`),
// so there is no default localhost URL to dial from the host. This gated
// @live test only runs when a developer temporarily exposes one and points
// MCP_LIVE_URL at it — skips cleanly everywhere else (CI, plain `bun test`).
const live = process.env.MCP_LIVE ? describe : describe.skip;

live("[@live] mcp-client against a real MCP server", () => {
  it("lists at least one tool", async () => {
    const url = process.env.MCP_LIVE_URL;
    if (!url) throw new Error("live test requires MCP_LIVE_URL (e.g. http://localhost:8088/mcp)");
    const catalog: McpCatalog = {
      live: { transport: "http", url, timeout: 30, connect_timeout: 5 },
    };
    const client = createMcpClient(catalog);
    try {
      const tools = await client.listTools();
      expect(tools.length).toBeGreaterThanOrEqual(1);
    } finally {
      await client.close();
    }
  });
});
