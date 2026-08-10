import { describe, expect, it } from "vitest";
import { handleRpc } from "./mcp-server.js";
import type { ToolHandler, ToolRegistry } from "./mcp-server.js";

function makeRegistry(handlers: ToolHandler[]): ToolRegistry {
  const map = new Map(handlers.map((h) => [h.def.name, h]));
  return {
    list() {
      return handlers.map((h) => h.def);
    },
    get(name) {
      return map.get(name) ?? null;
    },
  };
}

describe("handleRpc", () => {
  const deps = {
    registry: makeRegistry([
      {
        def: {
          name: "echo",
          description: "returns input",
          inputSchema: {
            type: "object" as const,
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
        async run(args) {
          return {
            content: [{ type: "text" as const, text: String(args.text) }],
          };
        },
      },
    ]),
    contextFor: () => ({ sessionId: null, userId: null, sessionChannel: "voice" as const }),
  };

  it("responds to initialize", async () => {
    const res = await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, "conn1", deps);
    expect(res?.result).toMatchObject({
      serverInfo: { name: "sentient-gateway-mcp" },
    });
  });

  it("lists tools", async () => {
    const res = await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "conn1", deps);
    const r = res?.result as { tools: Array<{ name: string }> };
    expect(r.tools[0]?.name).toBe("echo");
  });

  it("calls an existing tool", async () => {
    const res = await handleRpc(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hi" } },
      },
      "conn1",
      deps,
    );
    expect(res?.result).toMatchObject({
      content: [{ type: "text", text: "hi" }],
    });
  });

  it("returns error for unknown tool", async () => {
    const res = await handleRpc(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "nope" },
      },
      "conn1",
      deps,
    );
    expect(res?.error?.code).toBe(-32601);
  });

  it("returns null for notifications", async () => {
    const res = await handleRpc({ jsonrpc: "2.0", method: "notify_something" }, "conn1", deps);
    expect(res).toBeNull();
  });

  // WIRE CONTRACT on the delegated socket. The proxied catalog tier is derived
  // at listing time, not cached at boot: an addon that came up after the gateway
  // did must appear without a restart. A `tools/list` that answered from a stale
  // registry would leave a delegated agent permanently tool-less on any boot
  // that raced the addons — which is the whole class of defect D11 belonged to.
  it("refreshes the dynamic tool tier before answering tools/list", async () => {
    let refreshed = 0;
    const dynamic: ToolHandler[] = [];
    const refreshDeps = {
      ...deps,
      registry: {
        list: () => dynamic.map((h) => h.def),
        get: (name: string) => dynamic.find((h) => h.def.name === name) ?? null,
      },
      refreshTools: async () => {
        refreshed += 1;
        dynamic.push({
          def: { name: "search_web", description: "", inputSchema: { type: "object" as const, properties: {} } },
          async run() {
            return { content: [{ type: "text" as const, text: "" }] };
          },
        });
      },
    };

    const res = await handleRpc({ jsonrpc: "2.0", id: 7, method: "tools/list" }, "conn1", refreshDeps);

    expect(refreshed).toBe(1);
    expect((res?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual(["search_web"]);
  });

  it("answers tools/list from the previous surface when the refresh fails", async () => {
    const failing = { ...deps, refreshTools: () => Promise.reject(new Error("all servers down")) };

    const res = await handleRpc({ jsonrpc: "2.0", id: 8, method: "tools/list" }, "conn1", failing);

    expect((res?.result as { tools: Array<{ name: string }> }).tools[0]?.name).toBe("echo");
  });
});
