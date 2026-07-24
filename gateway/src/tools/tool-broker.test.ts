import { describe, expect, it } from "bun:test";
import type { OrchestratorConfig } from "@sentient/config";
import { createUserPrincipal } from "../identity/user-principal.js";
import type { PolicyContext, PolicyDecision, PolicyEngine } from "../security/policy-engine.js";
import type { SessionStore } from "../store/session-store.js";
import type { McpClient, McpToolRef } from "./mcp-client.js";
import type { BackgroundToolRunner } from "./tool-broker.js";
import { createToolBroker } from "./tool-broker.js";
import type { ToolInvocation } from "./tool-types.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeMcp(tools: McpToolRef[]): McpClient & { callToolCalls: Array<{ serverName: string; name: string }> } {
  const callToolCalls: Array<{ serverName: string; name: string }> = [];
  return {
    callToolCalls,
    async listTools() {
      return tools;
    },
    async callTool(serverName, name) {
      callToolCalls.push({ serverName, name });
      return { content: `result from ${serverName}/${name}`, isError: false };
    },
    async close() {},
  };
}

function fakePolicy(decision: PolicyDecision): PolicyEngine & { contexts: PolicyContext[] } {
  const contexts: PolicyContext[] = [];
  return {
    contexts,
    evaluate(ctx) {
      contexts.push(ctx);
      return decision;
    },
  };
}

// Never resolves — used to prove background dispatch doesn't block on the runner.
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function fakeStore(): SessionStore {
  return {
    append: () => {
      throw new Error("not used by ToolBroker — append is owned by the ReAct loop (Task 6)");
    },
    readSession: () => [],
    readSince: () => [],
    listSessions: () => [],
    close: () => {},
  };
}

const principal = createUserPrincipal("u_aaaaaaaa", "adult", "household-1");

const toolsConfig: OrchestratorConfig["tools"] = {
  foreground_timeout_ms: 30000,
  max_concurrent_background_tasks: 1,
};

function makeInvocation(overrides: Partial<ToolInvocation> = {}): ToolInvocation {
  return {
    toolCallId: "call-1",
    name: "get_weather",
    args: {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

const weatherTool: McpToolRef = {
  serverName: "test-mcp",
  name: "get_weather",
  description: "gets the weather",
  inputSchema: {},
};

// ---------------------------------------------------------------------------
// Foreground: allow / deny / confirm
// ---------------------------------------------------------------------------

describe("ToolBroker — PDP choke point (foreground)", () => {
  it("an allow runs the MCP call and returns its result", async () => {
    const mcp = fakeMcp([weatherTool]);
    const broker = createToolBroker({
      mcp,
      policy: fakePolicy({ action: "allow" }),
      store: fakeStore(),
      principal,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      requestConfirm: async () => false,
    });

    const result = await broker.dispatch(makeInvocation());

    expect(result).toEqual({ content: "result from test-mcp/get_weather", isError: false });
    expect(mcp.callToolCalls).toEqual([{ serverName: "test-mcp", name: "get_weather" }]);
  });

  it("a deny returns an isError result and never touches the MCP", async () => {
    const mcp = fakeMcp([weatherTool]);
    const broker = createToolBroker({
      mcp,
      policy: fakePolicy({ action: "deny", reason: "not allowed for this role" }),
      store: fakeStore(),
      principal,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      requestConfirm: async () => true,
    });

    const result = await broker.dispatch(makeInvocation());

    expect(result).toMatchObject({ isError: true });
    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(result.content).toContain("not allowed for this role");
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("a confirm resolved to false blocks the call as a deny", async () => {
    const mcp = fakeMcp([weatherTool]);
    let askedReason: string | undefined;
    const broker = createToolBroker({
      mcp,
      policy: fakePolicy({ action: "confirm", reason: "side-effecting tool" }),
      store: fakeStore(),
      principal,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      requestConfirm: async (_inv, reason) => {
        askedReason = reason;
        return false;
      },
    });

    const result = await broker.dispatch(makeInvocation());

    expect(result).toMatchObject({ isError: true });
    expect(askedReason).toBe("side-effecting tool");
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("a confirm resolved to true runs the call", async () => {
    const mcp = fakeMcp([weatherTool]);
    const broker = createToolBroker({
      mcp,
      policy: fakePolicy({ action: "confirm", reason: "side-effecting tool" }),
      store: fakeStore(),
      principal,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      requestConfirm: async () => true,
    });

    const result = await broker.dispatch(makeInvocation());

    expect(result).toEqual({ content: "result from test-mcp/get_weather", isError: false });
    expect(mcp.callToolCalls).toEqual([{ serverName: "test-mcp", name: "get_weather" }]);
  });
});

// ---------------------------------------------------------------------------
// Background: taskId handle + cap
// ---------------------------------------------------------------------------

describe("ToolBroker — background dispatch", () => {
  it("returns a taskId synchronously without waiting on the runner", async () => {
    const runner: BackgroundToolRunner = {
      definition: { name: "delegateTask", description: "", parameters: {}, category: "background" },
      run: () => ({ cancel: () => {}, result: neverSettles() }),
    };
    const broker = createToolBroker({
      mcp: fakeMcp([]),
      policy: fakePolicy({ action: "allow" }),
      store: fakeStore(),
      principal,
      sessionId: "session-1",
      backgroundTools: new Map([["delegateTask", runner]]),
      config: toolsConfig,
      requestConfirm: async () => false,
    });

    const result = await broker.dispatch(makeInvocation({ name: "delegateTask" }));

    expect("taskId" in result).toBe(true);
    if (!("taskId" in result)) throw new Error("expected a background handle");
    expect(typeof result.taskId).toBe("string");
    expect(broker.background.count()).toBe(1);
  });

  it("still evaluates the PDP first — a deny never registers or runs the background tool", async () => {
    let runCalls = 0;
    const runner: BackgroundToolRunner = {
      definition: { name: "delegateTask", description: "", parameters: {}, category: "background" },
      run: () => {
        runCalls += 1;
        return { cancel: () => {}, result: neverSettles() };
      },
    };
    const broker = createToolBroker({
      mcp: fakeMcp([]),
      policy: fakePolicy({ action: "deny", reason: "delegation disabled" }),
      store: fakeStore(),
      principal,
      sessionId: "session-1",
      backgroundTools: new Map([["delegateTask", runner]]),
      config: toolsConfig,
      requestConfirm: async () => true,
    });

    const result = await broker.dispatch(makeInvocation({ name: "delegateTask" }));

    expect(result).toMatchObject({ isError: true });
    expect(runCalls).toBe(0);
    expect(broker.background.count()).toBe(0);
  });

  it("rejects with 'too many running tasks' once the concurrency cap is reached", async () => {
    const runner: BackgroundToolRunner = {
      definition: { name: "delegateTask", description: "", parameters: {}, category: "background" },
      run: () => ({ cancel: () => {}, result: neverSettles() }),
    };
    const broker = createToolBroker({
      mcp: fakeMcp([]),
      policy: fakePolicy({ action: "allow" }),
      store: fakeStore(),
      principal,
      sessionId: "session-1",
      backgroundTools: new Map([["delegateTask", runner]]),
      config: toolsConfig, // max_concurrent_background_tasks: 1
      requestConfirm: async () => false,
    });

    const first = await broker.dispatch(makeInvocation({ name: "delegateTask", toolCallId: "call-1" }));
    expect("taskId" in first).toBe(true);

    const second = await broker.dispatch(makeInvocation({ name: "delegateTask", toolCallId: "call-2" }));
    expect("taskId" in second).toBe(false);
    if ("taskId" in second) throw new Error("expected a ToolResult, got a background handle");
    expect(second.isError).toBe(true);
    expect(second.content).toContain("too many running tasks");
  });
});
