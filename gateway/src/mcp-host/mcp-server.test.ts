import { describe, expect, it } from "vitest";
import type { PolicyContext, PolicyDecision, PolicyEngine } from "../security/policy-engine.js";
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

const allowAllPolicy: PolicyEngine = {
  evaluate(_ctx: PolicyContext): PolicyDecision {
    return { action: "allow" };
  },
};

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
    policy: allowAllPolicy,
    contextFor: () => ({ sessionId: null, userId: null, role: "user" as const, sessionChannel: "voice" as const }),
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

  it("denies tool call when policy returns deny", async () => {
    const denyPolicy: PolicyEngine = {
      evaluate(_ctx: PolicyContext): PolicyDecision {
        return { action: "deny", reason: "not allowed", rule: "test-deny" };
      },
    };
    const denyDeps = { ...deps, policy: denyPolicy };
    const res = await handleRpc(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } },
      "conn1",
      denyDeps,
    );
    const result = res?.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not allowed");
  });

  it("auto-approves tool call when policy returns confirm", async () => {
    const confirmPolicy: PolicyEngine = {
      evaluate(_ctx: PolicyContext): PolicyDecision {
        return { action: "confirm", rule: "test-confirm" };
      },
    };
    const confirmDeps = { ...deps, policy: confirmPolicy };
    const res = await handleRpc(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "echo", arguments: { text: "ok" } } },
      "conn1",
      confirmDeps,
    );
    const result = res?.result as { content: Array<{ text: string }> };
    expect(result.content[0]?.text).toBe("ok");
  });
});
