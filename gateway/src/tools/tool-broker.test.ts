import { describe, expect, it } from "bun:test";
import { ALL_TOOLS_PERMISSION_KEY } from "@sentient/config";
import type { OrchestratorConfig, ToolPermission, ToolPermissionMap } from "@sentient/config";
import type { Result } from "@sentient/protocol";
import { createAccessManager } from "../access/access-manager.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import { applyProfileDefaults } from "../profile-store/profile-defaults.js";
import type { ProfileStore, ProfileStoreError } from "../profile-store/profile-store.js";
import { type ProfileV1, profileV1Schema } from "../profile-store/profile-types.js";
import type { PolicyContext, PolicyDecision, PolicyEngine } from "../security/policy-engine.js";
import type { SessionStore } from "../store/session-store.js";
import type { McpClient, McpToolRef } from "./mcp-client.js";
import type { BackgroundToolRunner } from "./tool-broker.js";
import { createToolBroker } from "./tool-broker.js";
import { ConfirmUnavailableError } from "./tool-types.js";
import type { DelegationProgress, ToolInvocation, ToolResult } from "./tool-types.js";
import { createToolPermissionsReader } from "./user-tool-permissions.js";

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

/** The pre-permissions world: the table was never set, so every tool inherits
 *  `mcp-policy.yaml`. `undefined`, NOT `{}` — an empty table is a table naming
 *  no server, i.e. every server off. Every test below that is not about
 *  permissions uses this, so their expectations still describe the operator
 *  policy alone. */
const noUserPermissions = async (): Promise<ToolPermissionMap | undefined> => undefined;

/** A table naming one server, which is what switches the server-level rule on
 *  (an UNSET table inherits everything — see `permissionFor`). */
function permissionsFor(serverName: string, tools: Record<string, ToolPermission>): () => Promise<ToolPermissionMap> {
  return async () => ({ [serverName]: tools });
}

function profileFixture(permissions: ProfileV1["tools"]["permissions"]): ProfileV1 {
  return {
    schemaVersion: 1,
    userId: capability.ownerUserId,
    model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
    voice: { provider: "local-tts", id: "default" },
    audio: { ttsEnabled: true, channel: "voice" },
    persona: { template: "default", overrides: "" },
    tools: { permissions, toolsets: [] },
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" },
  };
}

/** Answers `get` from a queue, so one broker can read a real table and then
 *  find the file unreadable — the sequence the fail-closed rule is about. */
function profileStoreReturning(...results: Array<Result<ProfileV1, ProfileStoreError>>): ProfileStore {
  let i = 0;
  const refuse = () => {
    throw new Error("not used by the permissions reader");
  };
  return {
    get: async () => results[Math.min(i++, results.length - 1)] as Result<ProfileV1, ProfileStoreError>,
    save: refuse,
    remove: refuse,
  };
}

function fakeStore(): SessionStore {
  return {
    append: () => {
      throw new Error("not used by ToolBroker — append is owned by the ReAct loop (Task 6)");
    },
    readSession: () => [],
    readSince: () => [],
    findByPendingId: () => null,
    listSessions: () => [],
    createSession: () => {
      throw new Error("not used by ToolBroker — createSession is owned by the store's opener (Task 3)");
    },
    findSessionByMintKey: () => null,
    getSession: () => null,
    listSessionsWithMetadata: () => [],
    setTitle: () => false,
    close: () => {},
  };
}

const principal = createUserPrincipal("u_aaaaaaaa", "adult", "household-1");
// A real AccessManager grant — the broker's authority is this value, not the
// `principal` above (which stays only for log correlation, see
// ToolBrokerDeps.principal's doc comment).
const accessManager = createAccessManager({ userDataRoot: "/tmp/sentient-tool-broker-test" });
const capability = accessManager.grant(principal, "tool-broker");

const toolsConfig: OrchestratorConfig["tools"] = {
  foreground_timeout_ms: 30000,
  max_concurrent_background_tasks: 1,
  background_completion_request_echo_chars: 240,
  max_tool_result_chars: 20000,
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
// Authority — the broker's identity comes from its capability, not the
// ambient principal (spec §3.2, closing the second of two L2 holes CLAUDE.md
// claimed were already closed; the first is session-store.ts's resource-class
// check).
// ---------------------------------------------------------------------------

describe("ToolBroker — authority", () => {
  it("SECURITY: the broker's authority comes from its capability, not an ambient principal", () => {
    const mismatchedPrincipal = createUserPrincipal("u_bbbbbbbb", "adult", "household-1");
    const broker = createToolBroker({
      mcp: fakeMcp([weatherTool]),
      policy: fakePolicy({ action: "allow" }),
      store: fakeStore(),
      // Deliberately mismatched from `capability` below — proves ownerUserId
      // is read from the capability, never from this ambient principal.
      principal: mismatchedPrincipal,
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
      requestConfirm: async () => false,
    });

    expect(broker.ownerUserId).toBe(capability.ownerUserId);
  });
});

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
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
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
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
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
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
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
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
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
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
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

describe("ToolBroker — the foreground in-flight counter", () => {
  // It feeds the SESSION RETENTION predicate (runtime/session-retention.ts):
  // `hasPendingForegroundTool` is what keeps a session resident while a tool
  // round-trip outlives the socket that provoked it. A leaked count is
  // therefore invisible — the session simply never goes away, with no error and
  // nothing a smoke run would notice — which is why it is pinned here.
  it("INVARIANT: a rejecting MCP call still releases its in-flight slot", async () => {
    const mcp = fakeMcp([weatherTool]);
    mcp.callTool = async () => {
      throw new Error("mcp transport died mid-call");
    };
    const broker = createToolBroker({
      mcp,
      policy: fakePolicy({ action: "allow" }),
      store: fakeStore(),
      principal,
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
      requestConfirm: async () => false,
    });

    await expect(broker.dispatch(makeInvocation())).rejects.toThrow("mcp transport died mid-call");

    expect(broker.foregroundInFlight).toBe(0);
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
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
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
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
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
// Existence before permission
//
// Observed live 3× in one day: the model called `ha_search`; the catalog has
// `ha_search_entities`. The PDP prompted the owner to authorize a tool that
// does not exist, they approved it, and only then did the broker log
// `dispatch.unknown-tool`. A permission prompt is a claim that the thing being
// authorized is real — asking a human to vouch for a hallucination trains them
// to click through, and the prompt is the last line of defence for the tools
// that ARE real.
// ---------------------------------------------------------------------------

describe("ToolBroker — a hallucinated tool never reaches the permission prompt", () => {
  it("answers an unknown tool as a tool error without evaluating the policy or prompting", async () => {
    const mcp = fakeMcp([weatherTool]);
    const policy = fakePolicy({ action: "confirm", reason: "side-effecting tool" });
    let confirmCalls = 0;
    const broker = createToolBroker({
      mcp,
      policy,
      store: fakeStore(),
      principal,
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
      requestConfirm: async () => {
        confirmCalls += 1;
        return true;
      },
    });

    const result = await broker.dispatch(makeInvocation({ name: "ha_search" }));

    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(result).toEqual({ content: "Unknown tool: ha_search", isError: true });
    expect(confirmCalls).toBe(0);
    expect(policy.contexts).toHaveLength(0);
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("still prompts for a tool that EXISTS and matches no rule — fail-closed is a different path", async () => {
    const mcp = fakeMcp([weatherTool]);
    const policy = fakePolicy({ action: "confirm", reason: "no rule matched" });
    let confirmCalls = 0;
    const broker = createToolBroker({
      mcp,
      policy,
      store: fakeStore(),
      principal,
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
      requestConfirm: async () => {
        confirmCalls += 1;
        return false;
      },
    });

    const result = await broker.dispatch(makeInvocation({ name: "get_weather" }));

    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(confirmCalls).toBe(1);
    expect(policy.contexts).toHaveLength(1);
    expect(result).toMatchObject({ isError: true });
    // The model must be told a PERSON said no, not read back the policy
    // rationale — a rule reads like something to route around, a person's
    // answer does not. The system prompt promises "a tool result saying so".
    expect(result.content).toContain("The user declined");
    expect(result.content).toContain("Do not retry");
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("a registered background tool is not unknown, even though the MCP catalog has never heard of it", async () => {
    const runner: BackgroundToolRunner = {
      definition: { name: "delegateTask", description: "", parameters: {}, category: "background" },
      run: () => ({ cancel: () => {}, result: neverSettles<ToolResult>() }),
    };
    const policy = fakePolicy({ action: "allow" });
    const broker = createToolBroker({
      mcp: fakeMcp([weatherTool]),
      policy,
      store: fakeStore(),
      principal,
      capability,
      sessionId: "session-1",
      backgroundTools: new Map([["delegateTask", runner]]),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
      requestConfirm: async () => false,
    });

    const result = await broker.dispatch(makeInvocation({ name: "delegateTask" }));

    expect(result).toHaveProperty("taskId");
    expect(policy.contexts).toHaveLength(1);
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
      capability,
      sessionId: "session-1",
      backgroundTools: new Map([["delegateTask", runner]]),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
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
      capability,
      sessionId: "session-1",
      backgroundTools: new Map([["delegateTask", runner]]),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
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
      capability,
      sessionId: "session-1",
      backgroundTools: new Map([["delegateTask", runner]]),
      config: toolsConfig, // max_concurrent_background_tasks: 1
      toolPermissions: noUserPermissions,
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
      capability,
      sessionId: "session-1",
      backgroundTools: new Map([["delegateTask", runner]]),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
      requestConfirm: async () => false,
    });

    const { promise, sink } = deferredSinkCall<{
      taskId: string;
      toolName: string;
      request: Record<string, unknown>;
      content: string;
      isError: boolean;
    }>();
    broker.setBackgroundCompletionSink(sink);

    const args = { agent: "hermes", taskPrompt: "explain a Fresnel lens" };
    const dispatchResult = await broker.dispatch(makeInvocation({ name: "delegateTask", toolCallId: "call-1", args }));
    if (!("taskId" in dispatchResult)) throw new Error("expected a background handle");
    const { taskId } = dispatchResult;

    const settled = await promise;
    // `request` rides along because a completion outlives the context that
    // explains it: compaction summarises the dispatch away, and a bare taskId
    // then binds to nothing — exactly when several tasks are in flight.
    expect(settled).toEqual({
      taskId,
      toolName: "delegateTask",
      request: args,
      content: "the delegated output",
      isError: false,
    });
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
      capability,
      sessionId: "session-1",
      backgroundTools: new Map([["delegateTask", runner]]),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
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
      capability,
      sessionId: "session-1",
      backgroundTools: new Map([["delegateTask", runner]]),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
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
      capability,
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
      toolPermissions: noUserPermissions,
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
      capability,
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
      toolPermissions: noUserPermissions,
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

// ---------------------------------------------------------------------------
// Tool result cap (task 18, D17) — "Cap tool result size at the broker, not
// in any one tool." ha_get_history returning ~81KB was the first result big
// enough to crowd the model's answer out of its own output budget entirely
// (finish_reason:"length", zero visible text, silently committed as a
// completed turn). Both dispatch lanes are pinned here: the foreground path
// (what ha_get_history/read_file/write_file actually use) and the background
// completion path (a delegated task's own settled result reaches the model
// too, via the completion sink).
// ---------------------------------------------------------------------------

function fakeMcpWithContent(content: string): McpClient {
  return {
    async listTools() {
      return [weatherTool];
    },
    async callTool() {
      return { content, isError: false };
    },
    async close() {},
  };
}

const tightCapConfig: OrchestratorConfig["tools"] = { ...toolsConfig, max_tool_result_chars: 100 };

describe("ToolBroker — tool result cap", () => {
  it("INVARIANT: an oversized FOREGROUND result is truncated head-and-tail before reaching the model", async () => {
    const oversized = `${"A".repeat(500)}Z`;
    const broker = createToolBroker({
      mcp: fakeMcpWithContent(oversized),
      policy: fakePolicy({ action: "allow" }),
      store: fakeStore(),
      principal,
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: tightCapConfig,
      toolPermissions: noUserPermissions,
      requestConfirm: async () => false,
    });

    const result = await broker.dispatch(makeInvocation());

    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(result.content.length).toBeLessThan(oversized.length);
    expect(result.content).toContain("truncated");
    expect(result.content.startsWith("A")).toBe(true);
    expect(result.content.endsWith("Z")).toBe(true);
  });

  it("leaves a result at or under the configured limit completely unchanged", async () => {
    const small = "well within budget";
    const broker = createToolBroker({
      mcp: fakeMcpWithContent(small),
      policy: fakePolicy({ action: "allow" }),
      store: fakeStore(),
      principal,
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: tightCapConfig,
      toolPermissions: noUserPermissions,
      requestConfirm: async () => false,
    });

    const result = await broker.dispatch(makeInvocation());

    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(result.content).toBe(small);
  });

  it("INVARIANT: an oversized BACKGROUND completion is truncated before reaching the completion sink", async () => {
    const oversized = `${"B".repeat(500)}Z`;
    const runner: BackgroundToolRunner = {
      definition: { name: "delegateTask", description: "", parameters: {}, category: "background" },
      run: () => ({ cancel: () => {}, result: Promise.resolve({ content: oversized, isError: false }) }),
    };
    const broker = createToolBroker({
      mcp: fakeMcp([]),
      policy: fakePolicy({ action: "allow" }),
      store: fakeStore(),
      principal,
      capability,
      sessionId: "session-1",
      backgroundTools: new Map([["delegateTask", runner]]),
      config: tightCapConfig,
      toolPermissions: noUserPermissions,
      requestConfirm: async () => false,
    });

    const { promise, sink } = deferredSinkCall<{ content: string; isError: boolean }>();
    broker.setBackgroundCompletionSink(sink);

    await broker.dispatch(makeInvocation({ name: "delegateTask" }));
    const settled = await promise;

    expect(settled.content.length).toBeLessThan(oversized.length);
    expect(settled.content).toContain("truncated");
  });
});

// ---------------------------------------------------------------------------
// Per-tool permissions (plan 2026-08-07-tool-permissions, task 2).
//
// The person's `profile.tools.permissions` is read at the broker's TWO choke
// points and nowhere else: `definitions()` drops `off`, `resolveDecision()`
// reads `allow`/`ask`/`deny`. The operator's `mcp-policy.yaml` still runs and
// still wins on `deny`.
// ---------------------------------------------------------------------------

const searchTool: McpToolRef = {
  serverName: "test-mcp",
  name: "search_web",
  description: "searches the web",
  inputSchema: {},
};

/** A broker whose ONE catalog tool (`get_weather`, on server `test-mcp`)
 *  carries `permission`, over an operator policy that would otherwise
 *  `confirm` it — so every assertion below is about the user's setting
 *  overriding an inherit, not about agreeing with it by accident. */
function brokerWithPermission(
  permission: ToolPermission,
  opts: { policy?: PolicyDecision; confirm?: () => Promise<boolean> } = {},
) {
  const mcp = fakeMcp([weatherTool, searchTool]);
  let confirmCalls = 0;
  const broker = createToolBroker({
    mcp,
    policy: fakePolicy(opts.policy ?? { action: "confirm", reason: "no rule matched" }),
    store: fakeStore(),
    principal,
    capability,
    sessionId: "session-1",
    backgroundTools: new Map(),
    config: toolsConfig,
    toolPermissions: permissionsFor("test-mcp", { get_weather: permission }),
    requestConfirm: async () => {
      confirmCalls += 1;
      return opts.confirm ? opts.confirm() : true;
    },
  });
  return { broker, mcp, confirmCalls: () => confirmCalls };
}

describe("ToolBroker — per-tool permissions", () => {
  it("omits an off tool from definitions()", async () => {
    const { broker } = brokerWithPermission("off");
    await broker.ready();

    expect(broker.definitions().map((d) => d.name)).toEqual(["search_web"]);
  });

  it("dispatches an allow tool with no confirm prompt", async () => {
    const { broker, mcp, confirmCalls } = brokerWithPermission("allow");

    const result = await broker.dispatch(makeInvocation());

    expect(result).toEqual({ content: "result from test-mcp/get_weather", isError: false });
    // The operator policy said `confirm`; the person's explicit Allow is what
    // makes this prompt-free. Without that, Allow would be indistinguishable
    // from inherit for every tool no rule tiers.
    expect(confirmCalls()).toBe(0);
    expect(mcp.callToolCalls).toEqual([{ serverName: "test-mcp", name: "get_weather" }]);
  });

  it("rejects a deny tool with a reason the model can read, without prompting", async () => {
    const { broker, mcp, confirmCalls } = brokerWithPermission("deny");

    const result = await broker.dispatch(makeInvocation());

    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("get_weather");
    expect(result.content).toContain("Deny");
    expect(confirmCalls()).toBe(0);
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("keeps a deny tool IN definitions() — that is the whole difference from off", async () => {
    const { broker } = brokerWithPermission("deny");
    await broker.ready();

    expect(broker.definitions().map((d) => d.name)).toContain("get_weather");
  });

  it("prompts for an ask tool even when the operator policy would have allowed it", async () => {
    const { broker, mcp, confirmCalls } = brokerWithPermission("ask", { policy: { action: "allow" } });

    const result = await broker.dispatch(makeInvocation());

    expect(confirmCalls()).toBe(1);
    expect(result).toEqual({ content: "result from test-mcp/get_weather", isError: false });
    expect(mcp.callToolCalls).toHaveLength(1);
  });

  it("fails closed if an off tool reaches dispatch anyway — a proxied or mid-turn call", async () => {
    const { broker, mcp } = brokerWithPermission("off", { policy: { action: "allow" } });

    const result = await broker.dispatch(makeInvocation());

    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("turned off");
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("SECURITY: an operator deny beats a user allow", async () => {
    const { broker, mcp, confirmCalls } = brokerWithPermission("allow", {
      policy: { action: "deny", reason: "not allowed for this role" },
    });

    const result = await broker.dispatch(makeInvocation());

    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(result).toEqual({ content: "not allowed for this role", isError: true });
    expect(confirmCalls()).toBe(0);
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("SECURITY: an operator deny beats a user ask — the person is never even prompted", async () => {
    const { broker, mcp, confirmCalls } = brokerWithPermission("ask", {
      policy: { action: "deny", reason: "not allowed for this role" },
    });

    const result = await broker.dispatch(makeInvocation());

    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(result).toEqual({ content: "not allowed for this role", isError: true });
    // A prompt here would be a way to talk a person into overriding the
    // operator's own file.
    expect(confirmCalls()).toBe(0);
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("an absent tool under a PRESENT server inherits the operator policy", async () => {
    const mcp = fakeMcp([weatherTool, searchTool]);
    let confirmCalls = 0;
    const broker = createToolBroker({
      mcp,
      policy: fakePolicy({ action: "confirm", reason: "no rule matched" }),
      store: fakeStore(),
      principal,
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      // `search_web` is unnamed: it must behave exactly as it did before this
      // field existed, i.e. inherit the confirm.
      toolPermissions: permissionsFor("test-mcp", { get_weather: "allow" }),
      requestConfirm: async () => {
        confirmCalls += 1;
        return false;
      },
    });

    const result = await broker.dispatch(makeInvocation({ name: "search_web" }));

    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(confirmCalls).toBe(1);
    expect(result.isError).toBe(true);
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("applies a server's '*' wildcard to a tool with no key of its own", async () => {
    const mcp = fakeMcp([weatherTool, searchTool]);
    const broker = createToolBroker({
      mcp,
      policy: fakePolicy({ action: "allow" }),
      store: fakeStore(),
      principal,
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      // How a whole server is switched off: the profile schema never sees the
      // catalog, so it cannot write one `off` per tool name.
      toolPermissions: permissionsFor("test-mcp", { [ALL_TOOLS_PERMISSION_KEY]: "off" }),
      requestConfirm: async () => true,
    });
    await broker.ready();

    expect(broker.definitions()).toEqual([]);
  });

  it("prefers a tool's own key over the server's '*' wildcard", async () => {
    const mcp = fakeMcp([weatherTool, searchTool]);
    const broker = createToolBroker({
      mcp,
      policy: fakePolicy({ action: "allow" }),
      store: fakeStore(),
      principal,
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      toolPermissions: permissionsFor("test-mcp", { [ALL_TOOLS_PERMISSION_KEY]: "off", get_weather: "allow" }),
      requestConfirm: async () => true,
    });
    await broker.ready();

    expect(broker.definitions().map((d) => d.name)).toEqual(["get_weather"]);
  });

  it("treats a server ABSENT from a non-empty table as off, which is how every client still spells it", async () => {
    const mcp = fakeMcp([weatherTool]);
    const broker = createToolBroker({
      mcp,
      policy: fakePolicy({ action: "allow" }),
      store: fakeStore(),
      principal,
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      // The web and mobile Tools panes turn a server off by DELETING its key.
      // Reading that as "inherit" would show the person "off" while the model
      // kept the tools.
      toolPermissions: permissionsFor("some-other-server", { whatever: "allow" }),
      requestConfirm: async () => true,
    });
    await broker.ready();

    expect(broker.definitions()).toEqual([]);
  });

  it("an UNSET table inherits everything — adding the field changed nothing on its own", async () => {
    const broker = createToolBroker({
      mcp: fakeMcp([weatherTool]),
      policy: fakePolicy({ action: "allow" }),
      store: fakeStore(),
      principal,
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      toolPermissions: noUserPermissions, // undefined — never set
      requestConfirm: async () => true,
    });
    await broker.ready();

    expect(broker.definitions().map((d) => d.name)).toEqual(["get_weather"]);
  });

  it("an EMPTY table is a table, so every server is off — 'unset' and 'empty' are not the same answer", async () => {
    const broker = createToolBroker({
      mcp: fakeMcp([weatherTool]),
      policy: fakePolicy({ action: "allow" }),
      store: fakeStore(),
      principal,
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      // What "turn all five servers off in the UI" produces, and what the
      // reader reports for a profile it cannot parse. `permissions` is
      // `.optional()` rather than `.default({})` exactly so this is reachable.
      toolPermissions: async () => ({}),
      requestConfirm: async () => true,
    });
    await broker.ready();

    expect(broker.definitions()).toEqual([]);
  });

  it("never hides a background tool, which belongs to no server and so has no key", async () => {
    const runner: BackgroundToolRunner = {
      definition: { name: "delegateTask", description: "delegates", parameters: {}, category: "background" },
      run: () => ({ cancel: () => {}, result: neverSettles<ToolResult>() }),
    };
    const broker = createToolBroker({
      mcp: fakeMcp([weatherTool]),
      policy: fakePolicy({ action: "allow" }),
      store: fakeStore(),
      principal,
      capability,
      sessionId: "session-1",
      backgroundTools: new Map([["delegateTask", runner]]),
      config: toolsConfig,
      // Every catalog server is off, so if `delegateTask` were resolved
      // against this table at all it would vanish with them.
      toolPermissions: permissionsFor("some-other-server", { whatever: "allow" }),
      requestConfirm: async () => true,
    });
    await broker.ready();

    expect(broker.definitions().map((d) => d.name)).toEqual(["delegateTask"]);
  });

  it("re-reads the table per turn, so a settings save lands without rebuilding the broker", async () => {
    // Explicitly unset to begin with — the state a profile is in before
    // anybody touches a dropdown.
    let table: ToolPermissionMap | undefined = undefined;
    const broker = createToolBroker({
      mcp: fakeMcp([weatherTool]),
      policy: fakePolicy({ action: "allow" }),
      store: fakeStore(),
      principal,
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      toolPermissions: async () => table,
      requestConfirm: async () => true,
    });

    await broker.ready();
    expect(broker.definitions().map((d) => d.name)).toEqual(["get_weather"]);

    // The person opens Settings and switches the tool off. Settings' Apply does
    // not reopen the WS, so the SAME broker has to notice.
    table = { "test-mcp": { get_weather: "off" } };
    await broker.ready();

    expect(broker.definitions()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The whole path, from a real `profile.json` read to the model's tool array.
// The two suites above use hand-written getters; this one wires the actual
// reader over a fake ProfileStore, because the failure it pins lives in the
// seam BETWEEN them: a reader that collapsed every store error into "unset"
// would re-advertise and re-dispatch a tool somebody had switched off, and both
// suites above would still be green.
// ---------------------------------------------------------------------------

describe("ToolBroker — an unreadable profile does not resurrect a switched-off tool", () => {
  function brokerOverStore(store: ProfileStore) {
    const mcp = fakeMcp([weatherTool]);
    let confirmCalls = 0;
    const broker = createToolBroker({
      mcp,
      // The operator allow-tiers it, which is what makes this dangerous: if the
      // person's `off` is lost, the tool runs with no prompt at all.
      policy: fakePolicy({ action: "allow" }),
      store: fakeStore(),
      principal,
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      toolPermissions: createToolPermissionsReader({ profileStore: store, userId: capability.ownerUserId }),
      requestConfirm: async () => {
        confirmCalls += 1;
        return true;
      },
    });
    return { broker, mcp, confirmCalls: () => confirmCalls };
  }

  it("SECURITY: a corrupt profile.json keeps an off tool out of tools[] and out of dispatch", async () => {
    const { broker, mcp } = brokerOverStore(profileStoreReturning({ ok: false, error: "corrupt-file" }));

    await broker.ready();
    expect(broker.definitions()).toEqual([]);

    const result = await broker.dispatch(makeInvocation());
    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(result.isError).toBe(true);
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("SECURITY: a profile that goes corrupt AFTER a read keeps that read's deny", async () => {
    const denied = profileFixture({ "test-mcp": { get_weather: "deny" } });
    const { broker, mcp, confirmCalls } = brokerOverStore(
      profileStoreReturning({ ok: true, value: denied }, { ok: false, error: "io-error" }),
    );

    await broker.ready(); // reads the real table
    const result = await broker.dispatch(makeInvocation()); // store has since gone unreadable

    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(result.content).toContain("Deny");
    expect(confirmCalls()).toBe(0);
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("a missing profile is genuinely unset, so the operator policy decides as it always did", async () => {
    const { broker, mcp } = brokerOverStore(profileStoreReturning({ ok: false, error: "not-found" }));

    await broker.ready();
    expect(broker.definitions().map((d) => d.name)).toEqual(["get_weather"]);

    const result = await broker.dispatch(makeInvocation());
    expect(result).toEqual({ content: "result from test-mcp/get_weather", isError: false });
    expect(mcp.callToolCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A BRAND-NEW ACCOUNT HAS TOOLS. The far end of the chain the handler tests
// pin the near end of: what the account-creation path persists has to arrive
// here as a NON-EMPTY tool array. Both halves are needed — the handler test
// alone proves the right object was built, this one proves the broker agrees
// about what it means. Between them sits the unset-vs-empty distinction, and
// every account-creation path in the product feeds it the ambiguous shape.
// ---------------------------------------------------------------------------

describe("ToolBroker — a freshly created account can see its tools", () => {
  const searxngTool: McpToolRef = {
    serverName: "searxng",
    name: "web_search",
    description: "searches the web",
    inputSchema: {},
  };

  /** Exactly what the web wizard's INITIAL_DRAFT and mobile's
   *  templateMemberProfile POST, run through the two layers that stand between
   *  the request body and `profile.json`. */
  function provisionedProfile(toolsBody: unknown): ProfileV1 {
    const parsed = profileV1Schema.parse({
      schemaVersion: 1,
      userId: capability.ownerUserId,
      model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
      voice: { provider: "local-tts", id: "default" },
      persona: { template: "default", overrides: "" },
      tools: toolsBody,
      compression: { threshold: 0.5 },
      advanced: { extraSystemPrompt: "", maxTokens: 1024 },
    });
    return applyProfileDefaults(parsed);
  }

  function definitionsFor(profile: ProfileV1): Promise<string[]> {
    const broker = createToolBroker({
      mcp: fakeMcp([searxngTool]),
      policy: fakePolicy({ action: "allow" }),
      store: fakeStore(),
      principal,
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      toolPermissions: createToolPermissionsReader({
        profileStore: profileStoreReturning({ ok: true, value: profile }),
        userId: capability.ownerUserId,
      }),
      requestConfirm: async () => true,
    });
    return broker.ready().then(() => broker.definitions().map((d) => d.name));
  }

  it("REGRESSION: a wizard-created account gets a non-empty tools[]", async () => {
    expect(await definitionsFor(provisionedProfile({ enabled: {}, toolsets: [] }))).toEqual(["web_search"]);
  });

  it("still honours an account created with an EXPLICIT everything-off table", async () => {
    expect(await definitionsFor(provisionedProfile({ permissions: {}, toolsets: [] }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE CACHE-STABILITY INVARIANT.
//
// `tools[]` is serialized AHEAD of `messages[]`, so it is part of the
// provider's cached prefix (openai-provider.ts reads
// `prompt_tokens_details.cached_tokens`). If `allow`, `ask` and `deny` perturbed
// the array at all — order, a description annotation, an extra field — every
// permission tweak would silently re-prime the entire system prompt and history.
// That cost is the whole reason `off` is a separate state from `deny`, so this
// is the test the feature's economics rest on.
// ---------------------------------------------------------------------------

describe("ToolBroker — tools[] cache stability across permissions", () => {
  async function definitionsUnder(permission: ToolPermission): Promise<string> {
    const { broker } = brokerWithPermission(permission);
    await broker.ready();
    return JSON.stringify(broker.definitions());
  }

  it("INVARIANT: keeps the tools array byte-identical across allow, ask and deny", async () => {
    const allow = await definitionsUnder("allow");

    expect(await definitionsUnder("ask")).toBe(allow);
    expect(await definitionsUnder("deny")).toBe(allow);
    // …and `off` is the ONE state permitted to move it.
    expect(await definitionsUnder("off")).not.toBe(allow);
  });
});
