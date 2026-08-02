import { describe, expect, it } from "vitest";
import type { BackgroundRegistry } from "../../tools/background-registry.js";
import type { McpToolRef } from "../../tools/mcp-client.js";
import type { ToolBroker } from "../../tools/tool-broker.js";
import type { ToolInvocation, ToolResult } from "../../tools/tool-types.js";
import type { ToolContext } from "../mcp-server.js";
import { createProxiedCatalogTool } from "./proxied-catalog-tool.js";

const REF: McpToolRef = {
  serverName: "searxng",
  name: "search_web",
  description: "Read-only web search",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

const CTX: ToolContext = { sessionId: null, userId: "u_deadbeef", role: "user", sessionChannel: "voice" };

function fakeBroker(outcome: ToolResult | { taskId: string }): ToolBroker & { dispatched: ToolInvocation[] } {
  const dispatched: ToolInvocation[] = [];
  return {
    dispatched,
    ownerUserId: "u_deadbeef",
    definitions: () => [],
    async dispatch(inv) {
      dispatched.push(inv);
      return outcome;
    },
    background: null as unknown as BackgroundRegistry,
    setBackgroundCompletionSink() {},
  };
}

describe("createProxiedCatalogTool", () => {
  // SECURITY BOUNDARY — the whole justification for this tier existing. A
  // proxied tool that dialled the upstream MCP server itself would be WORSE
  // than no proxy, because it looks mediated and is not: the gateway's PDP
  // would never see the call, its arguments, or its deny.
  it("dispatches through the broker rather than dialing the upstream server", async () => {
    const broker = fakeBroker({ content: "three results", isError: false });
    const tool = createProxiedCatalogTool(REF, { brokerFor: () => broker });

    const result = await tool.run({ query: "tide times" }, CTX);

    expect(broker.dispatched).toHaveLength(1);
    expect(broker.dispatched[0]?.name).toBe("search_web");
    expect(broker.dispatched[0]?.args).toEqual({ query: "tide times" });
    expect(result).toEqual({ content: [{ type: "text", text: "three results" }], isError: false });
  });

  // The broker's PDP verdict is the tool's answer. A denied call must come back
  // as an error the delegated model can read, never as a silent success.
  it("surfaces a broker deny as an error result", async () => {
    const broker = fakeBroker({ content: "denied by policy", isError: true });
    const tool = createProxiedCatalogTool(REF, { brokerFor: () => broker });

    const result = await tool.run({ query: "x" }, CTX);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("denied by policy");
  });

  // Fail closed: with no broker there is no PDP, so there must be no call.
  it("fails closed when no broker can be resolved for the connection's user", async () => {
    const tool = createProxiedCatalogTool(REF, { brokerFor: () => null });

    const result = await tool.run({ query: "x" }, CTX);

    expect(result.isError).toBe(true);
  });

  it("fails closed when the connection carries no user", async () => {
    const broker = fakeBroker({ content: "should never run", isError: false });
    const tool = createProxiedCatalogTool(REF, { brokerFor: () => broker });

    const result = await tool.run({ query: "x" }, { ...CTX, userId: null });

    expect(result.isError).toBe(true);
    expect(broker.dispatched).toHaveLength(0);
  });

  // Defensive: a `{taskId}` here would mean a background tool leaked into the
  // proxied surface, and returning it as success would report a task that
  // nothing on this socket can ever observe.
  it("reports an error when the broker answers with a background taskId", async () => {
    const broker = fakeBroker({ taskId: "task-1" });
    const tool = createProxiedCatalogTool(REF, { brokerFor: () => broker });

    const result = await tool.run({ query: "x" }, CTX);

    expect(result.isError).toBe(true);
  });
});
