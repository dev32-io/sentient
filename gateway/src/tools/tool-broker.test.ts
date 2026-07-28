import { describe, expect, it } from "bun:test";
import type { OrchestratorConfig } from "@sentient/config";
import { createUserPrincipal } from "../identity/user-principal.js";
import type { PolicyContext, PolicyDecision, PolicyEngine } from "../security/policy-engine.js";
import type { SessionStore } from "../store/session-store.js";
import type { McpClient, McpToolRef } from "./mcp-client.js";
import type { BackgroundToolRunner } from "./tool-broker.js";
import { createToolBroker } from "./tool-broker.js";
import { ConfirmUnavailableError } from "./tool-types.js";
import type { DelegationProgress, ToolInvocation, ToolResult } from "./tool-types.js";

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
    turnId: "turn-1",
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

  it("SECURITY: a confirm hook that THROWS fails closed (deny), never rejects dispatch", async () => {
    const mcp = fakeMcp([weatherTool]);
    const broker = createToolBroker({
      mcp,
      policy: fakePolicy({ action: "confirm", reason: "side-effecting tool" }),
      store: fakeStore(),
      principal,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      requestConfirm: async () => {
        throw new Error("confirm UI crashed");
      },
    });

    // dispatch must resolve to an isError ToolResult, not reject — and the
    // tool must never run.
    const result = await broker.dispatch(makeInvocation());
    expect(result).toEqual({ content: expect.stringContaining("confirmation error"), isError: true });
    expect(mcp.callToolCalls).toEqual([]);
  });
});

describe("ToolBroker — unanswerable confirm (fail-closed reason passthrough)", () => {
  it("surfaces a ConfirmUnavailableError message to the model verbatim as the deny reason", async () => {
    const mcp = fakeMcp([weatherTool]);
    const broker = createToolBroker({
      mcp,
      policy: fakePolicy({ action: "confirm", reason: "side-effecting" }),
      store: fakeStore(),
      principal,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      requestConfirm: async () => {
        throw new ConfirmUnavailableError("permission request timed out");
      },
    });

    const result = await broker.dispatch(makeInvocation());

    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(result).toEqual({ content: "permission request timed out", isError: true });
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("keeps any other throw opaque — a buggy hook never leaks internals to the model", async () => {
    const mcp = fakeMcp([weatherTool]);
    const broker = createToolBroker({
      mcp,
      policy: fakePolicy({ action: "confirm", reason: "side-effecting" }),
      store: fakeStore(),
      principal,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      requestConfirm: async () => {
        throw new Error("ECONNREFUSED /var/run/internal.sock");
      },
    });

    const result = await broker.dispatch(makeInvocation());

    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(result).toEqual({ content: "confirmation error", isError: true });
    expect(mcp.callToolCalls).toHaveLength(0);
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

// ---------------------------------------------------------------------------
// Background completion sink — closes the delegateTask fire-and-steer loop.
// A background runner's settled `result` must reach `setBackgroundCompletionSink`
// (the seam `phase-services.ts` binds to `SessionRuntime.submit`), not just get
// logged and dropped. See tool-broker.ts's `dispatchBackground` doc comment.
// ---------------------------------------------------------------------------

/** Resolves once, capturing whatever `setBackgroundCompletionSink` is called
 *  with — lets a test `await` the async `.then()` chain inside
 *  `dispatchBackground` instead of racing it with an arbitrary tick count. */
function deferredSinkCall<T>(): { promise: Promise<T>; sink: (value: T) => void } {
  let sink!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    sink = resolve;
  });
  return { promise, sink };
}

describe("ToolBroker — background completion sink", () => {
  it("forwards the settled ToolResult to a bound sink, after freeing the concurrency slot", async () => {
    const runner: BackgroundToolRunner = {
      definition: { name: "delegateTask", description: "", parameters: {}, category: "background" },
      run: () => ({ cancel: () => {}, result: Promise.resolve({ content: "the delegated output", isError: false }) }),
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

    const { promise, sink } = deferredSinkCall<{
      taskId: string;
      toolName: string;
      content: string;
      isError: boolean;
    }>();
    broker.setBackgroundCompletionSink(sink);

    const dispatchResult = await broker.dispatch(makeInvocation({ name: "delegateTask", toolCallId: "call-1" }));
    if (!("taskId" in dispatchResult)) throw new Error("expected a background handle");
    const { taskId } = dispatchResult;

    const settled = await promise;
    expect(settled).toEqual({ taskId, toolName: "delegateTask", content: "the delegated output", isError: false });
    // The slot is freed before (or at latest alongside) the sink firing —
    // never leaked because a sink happened to be bound.
    expect(broker.background.count()).toBe(0);
  });

  it("normalizes a rejected runner promise into an isError completion — the sink never sees a rejection", async () => {
    const runner: BackgroundToolRunner = {
      definition: { name: "delegateTask", description: "", parameters: {}, category: "background" },
      run: () => ({ cancel: () => {}, result: Promise.reject(new Error("hermes process crashed")) }),
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

    const { promise, sink } = deferredSinkCall<{
      taskId: string;
      toolName: string;
      content: string;
      isError: boolean;
    }>();
    broker.setBackgroundCompletionSink(sink);

    await broker.dispatch(makeInvocation({ name: "delegateTask", toolCallId: "call-1" }));

    const settled = await promise;
    expect(settled.isError).toBe(true);
    expect(settled.content).toContain("hermes process crashed");
  });

  it("an unbound sink is a safe no-op — the settled result is dropped, never thrown", async () => {
    const runner: BackgroundToolRunner = {
      definition: { name: "delegateTask", description: "", parameters: {}, category: "background" },
      run: () => ({ cancel: () => {}, result: Promise.resolve({ content: "nobody is listening", isError: false }) }),
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

    // No setBackgroundCompletionSink call.
    await broker.dispatch(makeInvocation({ name: "delegateTask", toolCallId: "call-1" }));

    // Give the internal .then() chain a chance to run; must not throw or
    // leave the slot stuck.
    await Promise.resolve();
    await Promise.resolve();
    expect(broker.background.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// delegation.progress producer — the `{taskId}` handle a background dispatch
// hands back is invisible to the client unless the broker announces it. This
// pins both ends of that announcement (running on dispatch, done/error on
// settle) and the taskId/turnId/agent correlation every surface's delegation
// tile is keyed by.
// ---------------------------------------------------------------------------

describe("ToolBroker — delegation.progress producer", () => {
  /** Hands the runner's own `resolve` back to the caller so a test can settle
   *  the background task at the exact moment it wants to observe the terminal
   *  progress frame. */
  function progressRunner(captureResolve: (resolve: (r: ToolResult) => void) => void): BackgroundToolRunner {
    return {
      definition: {
        name: "delegateTask",
        description: "delegates",
        parameters: { type: "object", properties: {} },
        category: "background",
      },
      run: () => ({ cancel: () => {}, result: new Promise<ToolResult>((resolve) => captureResolve(resolve)) }),
    };
  }

  it("emits running on dispatch and done on settle, keyed by taskId + turnId + agent", async () => {
    const progress: DelegationProgress[] = [];
    let finish: (r: ToolResult) => void = () => {};
    const broker = createToolBroker({
      mcp: fakeMcp([]),
      policy: fakePolicy({ action: "allow" }),
      store: fakeStore(),
      principal,
      sessionId: "session-1",
      backgroundTools: new Map([
        [
          "delegateTask",
          progressRunner((res) => {
            finish = res;
          }),
        ],
      ]),
      config: toolsConfig,
      requestConfirm: async () => false,
      onDelegationProgress: (p) => progress.push(p),
    });

    const dispatched = await broker.dispatch(
      makeInvocation({ name: "delegateTask", args: { agent: "hermes", taskPrompt: "go" }, turnId: "turn-9" }),
    );
    if (!("taskId" in dispatched)) throw new Error("expected a background handle");

    expect(progress).toEqual([{ taskId: dispatched.taskId, turnId: "turn-9", agent: "hermes", status: "running" }]);

    finish({ content: "all done", isError: false });
    await Promise.resolve();
    await Promise.resolve();

    expect(progress[1]).toEqual({
      taskId: dispatched.taskId,
      turnId: "turn-9",
      agent: "hermes",
      status: "done",
    });
  });

  it("reports an errored background task as status error with a truncated note", async () => {
    const progress: DelegationProgress[] = [];
    let finish: (r: ToolResult) => void = () => {};
    const broker = createToolBroker({
      mcp: fakeMcp([]),
      policy: fakePolicy({ action: "allow" }),
      store: fakeStore(),
      principal,
      sessionId: "session-1",
      backgroundTools: new Map([
        [
          "delegateTask",
          progressRunner((res) => {
            finish = res;
          }),
        ],
      ]),
      config: toolsConfig,
      requestConfirm: async () => false,
      onDelegationProgress: (p) => progress.push(p),
    });

    await broker.dispatch(makeInvocation({ name: "delegateTask", args: { agent: "hermes" }, turnId: "turn-9" }));
    finish({ content: "hermes exited 1", isError: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(progress[1]).toMatchObject({ status: "error", note: "hermes exited 1" });
  });
});
