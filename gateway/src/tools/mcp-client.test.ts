import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpCatalog } from "@sentient/config";
import {
  type McpToolRef,
  classifyTransport,
  createMcpClient,
  filterByAllowlist,
  normalizeToolResult,
} from "./mcp-client.js";

const tools = [
  { serverName: "ha", name: "ha_get_state", description: "", inputSchema: {} },
  { serverName: "ha", name: "ha_dangerous", description: "", inputSchema: {} },
];

function toolRef(name: string): McpToolRef {
  return { serverName: "ha", name, description: "", inputSchema: {} };
}

describe("filterByAllowlist", () => {
  it("keeps only allowlisted tools when an include list is set", () => {
    expect(filterByAllowlist(tools, ["ha_get_state"]).kept.map((t) => t.name)).toEqual(["ha_get_state"]);
  });
  it("keeps all tools when no include list is set", () => {
    expect(filterByAllowlist(tools, undefined).kept).toHaveLength(2);
  });
  it("reports no unmatched entries when no include list is set", () => {
    expect(filterByAllowlist(tools, undefined).unmatched).toEqual([]);
  });
  it("reports no unmatched entries when every include entry is advertised", () => {
    expect(filterByAllowlist(tools, ["ha_get_state"]).unmatched).toEqual([]);
  });

  // D19: `ha_search_entities` sat in config.yaml's include list and its own
  // mcp-policy.yaml rule for weeks while the real tool (`ha_search`) went
  // unreachable — filterByAllowlist intersected the include list with what
  // the server advertised and silently dropped the rest, so the curated
  // surface read like coverage while it rotted. This is the regression test
  // for that mechanism: an include entry matching no advertised tool must be
  // REPORTED, not silently dropped, so the caller can WARN on it.
  it("INVARIANT: an include entry matching no advertised tool is reported, not silently dropped", () => {
    const { kept, unmatched } = filterByAllowlist([toolRef("ha_search")], ["ha_search", "ha_search_entities"]);
    expect(kept).toHaveLength(1);
    expect(kept.map((t) => t.name)).toEqual(["ha_search"]);
    expect(unmatched).toEqual(["ha_search_entities"]);
  });
});

// ---------------------------------------------------------------------------
// D18 — a tool that fails IN-BAND still reports isError:false. The upstream
// searxng-mcp-server (pip, pinned 0.1.9) swallows its own DNS failure and
// answers a 131-byte "success":
//   {"total_results": 0, "results": [], "error": "[Errno -3] ..."}
// Nothing between it and the model flagged that as a failure, so the model
// answered a currency question from its training weights instead of
// refusing (docs/native-todo.md D18). `normalizeToolResult` is the shared
// boundary check on the `callTool` result path — every MCP server inherits
// it, not just searxng.
// ---------------------------------------------------------------------------
describe("normalizeToolResult", () => {
  it("INVARIANT: a result whose payload carries an error is isError, whatever the flag said", () => {
    const r = normalizeToolResult({
      isError: false,
      content: '{"total_results":0,"results":[],"error":"[Errno -3] Temporary failure in name resolution"}',
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("name resolution"); // the reason survives, so the model can say WHAT failed
  });

  it("does not flag a result that already reports isError:true (nothing to upgrade)", () => {
    const r = normalizeToolResult({ isError: true, content: "already an error" });
    expect(r).toEqual({ isError: true, content: "already an error" });
  });

  it("does not flag plain-text content that merely contains the word 'error'", () => {
    // A log-search or article result mentioning "error" as prose, not JSON.
    const r = normalizeToolResult({ isError: false, content: "Found 3 log lines mentioning error today." });
    expect(r.isError).toBe(false);
  });

  it("does not flag a home-assistant entity literally named 'error' nested in results", () => {
    const content = '{"results":[{"entity_id":"sensor.error","state":"off"}]}';
    const r = normalizeToolResult({ isError: false, content });
    expect(r.isError).toBe(false);
  });

  it("does not flag a top-level `error` key whose value is null", () => {
    expect(normalizeToolResult({ isError: false, content: '{"error":null,"results":[]}' }).isError).toBe(false);
  });

  it("does not flag a top-level `error` key whose value is an empty string", () => {
    expect(normalizeToolResult({ isError: false, content: '{"error":"","results":[]}' }).isError).toBe(false);
  });

  it("does not flag a top-level `error` key whose value is an object, not a string", () => {
    expect(normalizeToolResult({ isError: false, content: '{"error":{"code":1},"results":[]}' }).isError).toBe(false);
  });

  it("does NOT flag a call that returned real results alongside a warning — narrow beats broad", () => {
    // A search that returned hits AND a warning is a working call, not a
    // failed one; turning it into a manufactured error is worse than the
    // bug being fixed.
    const content = '{"total_results":2,"results":[{"title":"a"},{"title":"b"}],"error":"partial index"}';
    const r = normalizeToolResult({ isError: false, content });
    expect(r.isError).toBe(false);
  });

  it("does NOT flag a fetch-shaped result whose real answer is a non-array `content` string", () => {
    // A fetched page's body lives in a STRING field, not an array — the
    // original array-only check missed this and would have discarded a
    // real fetched page just because a benign warning sat alongside it.
    const content = '{"content":"<html>…</html>","error":"SSL warning, proceeding anyway"}';
    const r = normalizeToolResult({ isError: false, content });
    expect(r.isError).toBe(false);
  });

  it("does NOT flag a ha_get_state-shaped result with no arrays anywhere", () => {
    // ha_get_state's real shape: a single entity object with `state` and
    // `attributes` fields, never an array. The array-only check had no way
    // to see this as populated at all.
    const content = '{"state":"on","attributes":{"friendly_name":"Kitchen Light"},"error":"history backfill stale"}';
    const r = normalizeToolResult({ isError: false, content });
    expect(r.isError).toBe(false);
  });

  it("does not flag a genuine no-hits search with no error key — emptiness alone is not failure", () => {
    const r = normalizeToolResult({ isError: false, content: '{"total_results":0,"results":[]}' });
    expect(r.isError).toBe(false);
  });

  it("does not flag a top-level JSON array", () => {
    const r = normalizeToolResult({ isError: false, content: '[{"error":"x"}]' });
    expect(r.isError).toBe(false);
  });

  it("does not flag content that fails to parse as JSON at all", () => {
    const r = normalizeToolResult({ isError: false, content: "error: connection refused" });
    expect(r.isError).toBe(false);
  });

  it("flags a bare in-band error with no results field present at all", () => {
    // Generic case beyond searxng's specific shape: any MCP server that
    // answers isError:false with only {"error": "..."} at the top level.
    const r = normalizeToolResult({ isError: false, content: '{"error":"upstream unavailable"}' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("upstream unavailable");
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

type ToolBehaviour = "ok" | "app-error" | "rpc-error" | "in-band-error";

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
        // D18 reproduction: the peer answers isError:false at the JSON-RPC
        // level, exactly like the real searxng-mcp-server (pip 0.1.9)
        // swallowing its own DNS failure — the failure lives only inside the
        // text payload.
        const text =
          toolBehaviour === "in-band-error"
            ? '{"total_results":0,"results":[],"error":"[Errno -3] Temporary failure in name resolution"}'
            : isAppError
              ? "No such playlist"
              : "played";
        return jsonResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text }],
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

  // D18, end-to-end through the real callTool path (not just the pure
  // normalizeToolResult unit above) — the peer answers isError:false at the
  // wire level, byte-for-byte the searxng-mcp-server shape, and the client
  // must still surface it as a failure.
  it("D18: surfaces an in-band error even though the peer answered isError:false", async () => {
    peer.setToolBehaviour("in-band-error");
    const result = await client.callTool("music_assistant", "ma_search", {}, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("name resolution");
    // No JSON-RPC error occurred, so the transport is proven fine — the next
    // call must reuse the same session, not redial.
    peer.setToolBehaviour("ok");
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
