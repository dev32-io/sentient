import { describe, expect, it } from "bun:test";
import { ALL_TOOLS_PERMISSION_KEY, mcpCatalogSchema } from "@sentient/config";
import type { McpCatalog, OrchestratorConfig, ToolPermission, ToolPermissionMap } from "@sentient/config";
import type { Result, UserRole } from "@sentient/protocol";
import { createAccessManager } from "../access/access-manager.js";
import type { Capability } from "../access/capability.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import { applyProfileDefaults } from "../profile-store/profile-defaults.js";
import type { ProfileStore, ProfileStoreError } from "../profile-store/profile-store.js";
import { type ProfileV1, profileV1Schema } from "../profile-store/profile-types.js";
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

// Never resolves — used to prove background dispatch doesn't block on the runner.
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/** Every account created before per-tool permissions shipped: the table was
 *  never set, so every tool resolves from the ROLE TEMPLATE. `undefined`, NOT
 *  `{}` — an empty table is a table naming no server, i.e. every server off. */
const noUserPermissions = async (): Promise<ToolPermissionMap | undefined> => undefined;

/** A table naming one server, which is what switches the server-level rule on
 *  (an UNSET table falls to the role template — see `storedPermissionFor`). */
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
// A real AccessManager grant — `ToolBrokerDeps` holds no principal at all
// (task 2026-08-07 #2), so this capability — userId AND role both baked in at
// mint — is the broker's only source of authority.
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
  tier: "read",
};

const todoTool: McpToolRef = {
  serverName: "test-mcp",
  name: "add_todo",
  description: "adds a todo",
  inputSchema: {},
  tier: "write",
};

const doorTool: McpToolRef = {
  serverName: "test-mcp",
  name: "unlock_door",
  description: "unlocks the door",
  inputSchema: {},
  tier: "confirm",
};

/**
 * The operator catalog every broker below resolves its FLOOR from — the same
 * object account creation seeds a table from, so floor and seed cannot
 * disagree. Parsed through the real schema rather than cast, so a catalog-shape
 * change breaks these fixtures instead of hiding behind them.
 *
 * One tool per tier on one server. That is what makes the two gates separable:
 * `get_weather` is reachable by everyone and prompt-free, `add_todo` prompts and
 * is out of a guest's reach, `unlock_door` is out of a child's.
 */
const testCatalog: McpCatalog = mcpCatalogSchema.parse({
  "test-mcp": {
    transport: "http",
    url: "http://127.0.0.1:9000/mcp",
    tools: {
      include: [
        { name: "get_weather", tier: "read" },
        { name: "search_web", tier: "read" },
        { name: "add_todo", tier: "write" },
        { name: "unlock_door", tier: "confirm" },
      ],
    },
  },
});

/** What the resolution answers for `add_todo` with nothing stored: the write
 *  tier's template value is `ask`, so the person is prompted, and the prompt
 *  copy names their settings rather than an operator rule. */
const ASK_REASON = "Your settings ask for confirmation before every add_todo call.";

// ---------------------------------------------------------------------------
// Authority — the broker's identity comes from its capability alone.
// `ToolBrokerDeps` carries no `principal` field at all (spec §3.2, task
// 2026-08-07 #2) — the two describe blocks below are what makes that a fact
// about the type, not just the current callers: userId and role both have to
// travel on the capability, with nothing else in the deps object able to
// answer either question.
// ---------------------------------------------------------------------------

describe("ToolBroker — authority", () => {
  it("reads ownerUserId from the capability — there is no other identity input in ToolBrokerDeps", () => {
    const broker = createToolBroker({
      mcp: fakeMcp([weatherTool]),
      catalog: testCatalog,
      store: fakeStore(),
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
// The capability carries the role (plan 2026-08-07-tool-permissions, task 2).
//
// `AccessManager.grant` bakes the minting principal's role into the
// capability; the broker's PDP context reads `capability.role`. This is the
// task's own failing-test-first requirement: two brokers built from
// differently-roled capabilities must disagree about the same tool call, and
// neither `ToolBrokerDeps` nor this test constructs a `UserPrincipal`
// anywhere — the role has nowhere ambient left to come from.
// ---------------------------------------------------------------------------

describe("ToolBroker — the capability carries the role", () => {
  it("SECURITY: an adult capability and a guest capability disagree about the same tool, with no principal in sight", async () => {
    // Hand-built, not minted through AccessManager — this IS "no principal in
    // sight": nothing in this test ever constructs a UserPrincipal. The role
    // gate reads `capability.role` and `ToolBrokerDeps` has no other field that
    // could answer, so these two dispatches can only differ if it did.
    const adultCapability: Capability = {
      ownerUserId: "u_aaaaaaaa",
      resource: "tool-broker",
      rootPath: "/tmp/sentient-tool-broker-test/u_aaaaaaaa",
      role: "adult",
    };
    const guestCapability: Capability = { ...adultCapability, role: "guest" };

    const buildBroker = (cap: Capability) =>
      createToolBroker({
        mcp: fakeMcp([todoTool]),
        catalog: testCatalog,
        store: fakeStore(),
        capability: cap,
        sessionId: "session-1",
        backgroundTools: new Map(),
        config: toolsConfig,
        toolPermissions: noUserPermissions,
        requestConfirm: async () => true,
      });

    const invocation = makeInvocation({ name: "add_todo" });
    const adultResult = await buildBroker(adultCapability).dispatch(invocation);
    const guestResult = await buildBroker(guestCapability).dispatch(invocation);

    expect(adultResult).toEqual({ content: "result from test-mcp/add_todo", isError: false });
    expect(guestResult).toMatchObject({ isError: true });
    if ("taskId" in guestResult) throw new Error("expected a ToolResult, got a background handle");
    expect(guestResult.content).toContain("add_todo");
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
      catalog: testCatalog,
      store: fakeStore(),
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
      catalog: testCatalog,
      store: fakeStore(),
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      toolPermissions: permissionsFor("test-mcp", { get_weather: "deny" }),
      requestConfirm: async () => true,
    });

    const result = await broker.dispatch(makeInvocation());

    expect(result).toMatchObject({ isError: true });
    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(result.content).toContain("Deny");
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("a confirm resolved to false blocks the call as a deny", async () => {
    const mcp = fakeMcp([todoTool]);
    let askedReason: string | undefined;
    const broker = createToolBroker({
      mcp,
      catalog: testCatalog,
      store: fakeStore(),
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

    const result = await broker.dispatch(makeInvocation({ name: "add_todo" }));

    expect(result).toMatchObject({ isError: true });
    expect(askedReason).toBe(ASK_REASON);
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("a confirm resolved to true runs the call", async () => {
    const mcp = fakeMcp([todoTool]);
    const broker = createToolBroker({
      mcp,
      catalog: testCatalog,
      store: fakeStore(),
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
      requestConfirm: async () => true,
    });

    const result = await broker.dispatch(makeInvocation({ name: "add_todo" }));

    expect(result).toEqual({ content: "result from test-mcp/add_todo", isError: false });
    expect(mcp.callToolCalls).toEqual([{ serverName: "test-mcp", name: "add_todo" }]);
  });

  it("SECURITY: a confirm hook that THROWS fails closed (deny), never rejects dispatch", async () => {
    const mcp = fakeMcp([todoTool]);
    const broker = createToolBroker({
      mcp,
      catalog: testCatalog,
      store: fakeStore(),
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
    const result = await broker.dispatch(makeInvocation({ name: "add_todo" }));
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
      catalog: testCatalog,
      store: fakeStore(),
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
    const mcp = fakeMcp([todoTool]);
    const broker = createToolBroker({
      mcp,
      catalog: testCatalog,
      store: fakeStore(),
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
      requestConfirm: async () => {
        throw new ConfirmUnavailableError("permission request timed out");
      },
    });

    const result = await broker.dispatch(makeInvocation({ name: "add_todo" }));

    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(result).toEqual({ content: "permission request timed out", isError: true });
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("keeps any other throw opaque — a buggy hook never leaks internals to the model", async () => {
    const mcp = fakeMcp([todoTool]);
    const broker = createToolBroker({
      mcp,
      catalog: testCatalog,
      store: fakeStore(),
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
      requestConfirm: async () => {
        throw new Error("ECONNREFUSED /var/run/internal.sock");
      },
    });

    const result = await broker.dispatch(makeInvocation({ name: "add_todo" }));

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
  it("answers an unknown tool as a tool error without resolving a permission or prompting", async () => {
    const mcp = fakeMcp([weatherTool]);
    let confirmCalls = 0;
    const broker = createToolBroker({
      mcp,
      catalog: testCatalog,
      store: fakeStore(),
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
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("still prompts for a tool that EXISTS and resolves to Ask — a real name is a different path", async () => {
    const mcp = fakeMcp([todoTool]);
    let confirmCalls = 0;
    const broker = createToolBroker({
      mcp,
      catalog: testCatalog,
      store: fakeStore(),
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

    const result = await broker.dispatch(makeInvocation({ name: "add_todo" }));

    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(confirmCalls).toBe(1);
    expect(result).toMatchObject({ isError: true });
    // The model must be told a PERSON said no, not read back a rule's
    // rationale — a rule reads like something to route around, a person's
    // answer does not. The system prompt promises "a tool result saying so".
    expect(result.content).toContain("The user declined");
    expect(result.content).toContain("Do not retry");
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("a registered background tool is not unknown, even though the MCP catalog has never heard of it", async () => {
    const runner: BackgroundToolRunner = {
      definition: { name: "delegateTask", description: "", parameters: {}, category: "background", tier: "confirm" },
      run: () => ({ cancel: () => {}, result: neverSettles<ToolResult>() }),
    };
    let confirmCalls = 0;
    const broker = createToolBroker({
      mcp: fakeMcp([weatherTool]),
      catalog: testCatalog,
      store: fakeStore(),
      capability,
      sessionId: "session-1",
      backgroundTools: new Map([["delegateTask", runner]]),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
      requestConfirm: async () => {
        confirmCalls += 1;
        return true;
      },
    });

    const result = await broker.dispatch(makeInvocation({ name: "delegateTask" }));

    expect(result).toHaveProperty("taskId");
    // It reached the PDP rather than the unknown-tool answer, and the PDP
    // resolved it from its own declared tier — `confirm` → `ask` → a prompt.
    expect(confirmCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Background: taskId handle + cap
// ---------------------------------------------------------------------------

describe("ToolBroker — background dispatch", () => {
  it("returns a taskId synchronously without waiting on the runner", async () => {
    const runner: BackgroundToolRunner = {
      definition: { name: "delegateTask", description: "", parameters: {}, category: "background", tier: "confirm" },
      run: () => ({ cancel: () => {}, result: neverSettles() }),
    };
    const broker = createToolBroker({
      mcp: fakeMcp([]),
      catalog: testCatalog,
      store: fakeStore(),
      capability,
      sessionId: "session-1",
      backgroundTools: new Map([["delegateTask", runner]]),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
      requestConfirm: async () => true,
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
      definition: { name: "delegateTask", description: "", parameters: {}, category: "background", tier: "confirm" },
      run: () => {
        runCalls += 1;
        return { cancel: () => {}, result: neverSettles() };
      },
    };
    const broker = createToolBroker({
      mcp: fakeMcp([]),
      catalog: testCatalog,
      store: fakeStore(),
      capability,
      sessionId: "session-1",
      backgroundTools: new Map([["delegateTask", runner]]),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
      requestConfirm: async () => false,
    });

    const result = await broker.dispatch(makeInvocation({ name: "delegateTask" }));

    expect(result).toMatchObject({ isError: true });
    expect(runCalls).toBe(0);
    expect(broker.background.count()).toBe(0);
  });

  it("rejects with 'too many running tasks' once the concurrency cap is reached", async () => {
    const runner: BackgroundToolRunner = {
      definition: { name: "delegateTask", description: "", parameters: {}, category: "background", tier: "confirm" },
      run: () => ({ cancel: () => {}, result: neverSettles() }),
    };
    const broker = createToolBroker({
      mcp: fakeMcp([]),
      catalog: testCatalog,
      store: fakeStore(),
      capability,
      sessionId: "session-1",
      backgroundTools: new Map([["delegateTask", runner]]),
      config: toolsConfig, // max_concurrent_background_tasks: 1
      toolPermissions: noUserPermissions,
      requestConfirm: async () => true,
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
      definition: { name: "delegateTask", description: "", parameters: {}, category: "background", tier: "confirm" },
      run: () => ({ cancel: () => {}, result: Promise.resolve({ content: "the delegated output", isError: false }) }),
    };
    const broker = createToolBroker({
      mcp: fakeMcp([]),
      catalog: testCatalog,
      store: fakeStore(),
      capability,
      sessionId: "session-1",
      backgroundTools: new Map([["delegateTask", runner]]),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
      requestConfirm: async () => true,
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
      definition: { name: "delegateTask", description: "", parameters: {}, category: "background", tier: "confirm" },
      run: () => ({ cancel: () => {}, result: Promise.reject(new Error("hermes process crashed")) }),
    };
    const broker = createToolBroker({
      mcp: fakeMcp([]),
      catalog: testCatalog,
      store: fakeStore(),
      capability,
      sessionId: "session-1",
      backgroundTools: new Map([["delegateTask", runner]]),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
      requestConfirm: async () => true,
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
      definition: { name: "delegateTask", description: "", parameters: {}, category: "background", tier: "confirm" },
      run: () => ({ cancel: () => {}, result: Promise.resolve({ content: "nobody is listening", isError: false }) }),
    };
    const broker = createToolBroker({
      mcp: fakeMcp([]),
      catalog: testCatalog,
      store: fakeStore(),
      capability,
      sessionId: "session-1",
      backgroundTools: new Map([["delegateTask", runner]]),
      config: toolsConfig,
      toolPermissions: noUserPermissions,
      requestConfirm: async () => true,
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
        tier: "confirm",
      },
      run: () => ({ cancel: () => {}, result: new Promise<ToolResult>((resolve) => captureResolve(resolve)) }),
    };
  }

  it("emits running on dispatch and done on settle, keyed by taskId + turnId + agent", async () => {
    const progress: DelegationProgress[] = [];
    let finish: (r: ToolResult) => void = () => {};
    const broker = createToolBroker({
      mcp: fakeMcp([]),
      catalog: testCatalog,
      store: fakeStore(),
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
      requestConfirm: async () => true,
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
      catalog: testCatalog,
      store: fakeStore(),
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
      requestConfirm: async () => true,
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
      catalog: testCatalog,
      store: fakeStore(),
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: tightCapConfig,
      toolPermissions: noUserPermissions,
      requestConfirm: async () => true,
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
      catalog: testCatalog,
      store: fakeStore(),
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: tightCapConfig,
      toolPermissions: noUserPermissions,
      requestConfirm: async () => true,
    });

    const result = await broker.dispatch(makeInvocation());

    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(result.content).toBe(small);
  });

  it("INVARIANT: an oversized BACKGROUND completion is truncated before reaching the completion sink", async () => {
    const oversized = `${"B".repeat(500)}Z`;
    const runner: BackgroundToolRunner = {
      definition: { name: "delegateTask", description: "", parameters: {}, category: "background", tier: "confirm" },
      run: () => ({ cancel: () => {}, result: Promise.resolve({ content: oversized, isError: false }) }),
    };
    const broker = createToolBroker({
      mcp: fakeMcp([]),
      catalog: testCatalog,
      store: fakeStore(),
      capability,
      sessionId: "session-1",
      backgroundTools: new Map([["delegateTask", runner]]),
      config: tightCapConfig,
      toolPermissions: noUserPermissions,
      requestConfirm: async () => true,
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
// reads `allow`/`ask`/`deny`.
// ---------------------------------------------------------------------------

const searchTool: McpToolRef = {
  serverName: "test-mcp",
  name: "search_web",
  description: "searches the web",
  inputSchema: {},
  tier: "read",
};

/** A broker whose ONE named tool (`get_weather`, on server `test-mcp`) carries
 *  an explicit `permission`. It is `read`-tier, so the role template underneath
 *  says `allow` — every assertion below that expects something else is
 *  therefore about the stored value overriding the floor, not agreeing with it
 *  by accident. */
function brokerWithPermission(permission: ToolPermission, opts: { confirm?: () => Promise<boolean> } = {}) {
  const mcp = fakeMcp([weatherTool, searchTool]);
  let confirmCalls = 0;
  const broker = createToolBroker({
    mcp,
    catalog: testCatalog,
    store: fakeStore(),
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

  it("prompts for an ask tool whose tier the role template would have allowed", async () => {
    const { broker, mcp, confirmCalls } = brokerWithPermission("ask");

    const result = await broker.dispatch(makeInvocation());

    expect(confirmCalls()).toBe(1);
    expect(result).toEqual({ content: "result from test-mcp/get_weather", isError: false });
    expect(mcp.callToolCalls).toHaveLength(1);
  });

  it("fails closed if an off tool reaches dispatch anyway — a proxied or mid-turn call", async () => {
    const { broker, mcp } = brokerWithPermission("off");

    const result = await broker.dispatch(makeInvocation());

    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("turned off");
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("an absent tool under a PRESENT server falls to the role template", async () => {
    const mcp = fakeMcp([weatherTool, todoTool]);
    let confirmCalls = 0;
    const broker = createToolBroker({
      mcp,
      catalog: testCatalog,
      store: fakeStore(),
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      // `add_todo` is unnamed under a server that IS named, so the stored table
      // does not answer and the template's `ask` for the write tier does.
      toolPermissions: permissionsFor("test-mcp", { get_weather: "allow" }),
      requestConfirm: async () => {
        confirmCalls += 1;
        return false;
      },
    });

    const result = await broker.dispatch(makeInvocation({ name: "add_todo" }));

    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(confirmCalls).toBe(1);
    expect(result.isError).toBe(true);
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("applies a server's '*' wildcard to a tool with no key of its own", async () => {
    const mcp = fakeMcp([weatherTool, searchTool]);
    const broker = createToolBroker({
      mcp,
      catalog: testCatalog,
      store: fakeStore(),
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
      catalog: testCatalog,
      store: fakeStore(),
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

  it("treats a server ABSENT from a non-empty table as off — a stored answer, not a gap", async () => {
    const mcp = fakeMcp([weatherTool]);
    const broker = createToolBroker({
      mcp,
      catalog: testCatalog,
      store: fakeStore(),
      capability,
      sessionId: "session-1",
      backgroundTools: new Map(),
      config: toolsConfig,
      // NO CLIENT PRODUCES THIS STATE ANY MORE — since task 6 all three Tools
      // panes turn a server off by writing a named `off` per tool plus the
      // wildcard (`withServerMasterPermission`), and `profile-update.ts` merges
      // a delta, so an omitted key is never deleted from storage either. The
      // rule is pinned because the STORED table can still hold it: a table
      // written before seeding, or hand-edited. Letting the role template answer
      // underneath a missing server would show the person "off" while the model
      // kept the tools.
      toolPermissions: permissionsFor("some-other-server", { whatever: "allow" }),
      requestConfirm: async () => true,
    });
    await broker.ready();

    expect(broker.definitions()).toEqual([]);
  });

  it("an UNSET table falls to the role template, which is every account created before seeding", async () => {
    const broker = createToolBroker({
      mcp: fakeMcp([weatherTool]),
      catalog: testCatalog,
      store: fakeStore(),
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
      catalog: testCatalog,
      store: fakeStore(),
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
      definition: {
        name: "delegateTask",
        description: "delegates",
        parameters: {},
        category: "background",
        tier: "confirm",
      },
      run: () => ({ cancel: () => {}, result: neverSettles<ToolResult>() }),
    };
    const broker = createToolBroker({
      mcp: fakeMcp([weatherTool]),
      catalog: testCatalog,
      store: fakeStore(),
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
      catalog: testCatalog,
      store: fakeStore(),
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
      catalog: testCatalog,
      store: fakeStore(),
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

  it("a missing profile is genuinely unset, so the role template decides", async () => {
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
    tier: "read",
  };

  /** The catalog the account is seeded from AND the one the broker resolves its
   *  floor from — the one server this broker's fake MCP advertises, so "seeded",
   *  "advertised" and "resolvable" are all the same universe. Handing the two
   *  sides different catalogs is exactly the drift this pins. */
  const catalog: McpCatalog = mcpCatalogSchema.parse({
    searxng: {
      transport: "http",
      url: "http://127.0.0.1:9002/mcp",
      tools: { include: [{ name: "web_search", tier: "read" }] },
    },
  });

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
    return applyProfileDefaults(parsed, { role: "adult", mcpCatalog: catalog });
  }

  function definitionsFor(profile: ProfileV1): Promise<string[]> {
    const broker = createToolBroker({
      mcp: fakeMcp([searxngTool]),
      catalog,
      store: fakeStore(),
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
// ONE RESOLUTION, NO FALLTHROUGH (plan 2026-08-07-tool-permissions, task 4).
//
// Two independent gates, and the distinction is the point:
//
//   the ROLE gate    canExecute(capability.role, def.tier) — what this person's
//                    role may EVER reach, read off the capability by value.
//   the PERMISSION   what this person chose for that tool, resolved as
//                      stored[server]?[tool] ?? roleTemplate[server]?[tool] ?? "off"
//
// Both can produce absence from `tools[]`, for the same reason — the model must
// not spend context on a tool it can never use — but they answer different
// questions, and the logs say which fired.
// ---------------------------------------------------------------------------

const everyTierTools = [weatherTool, todoTool, doorTool];

function capabilityFor(role: UserRole): Capability {
  return accessManager.grant(createUserPrincipal("u_aaaaaaaa", role, "household-1"), "tool-broker");
}

/** `delegateTask`'s stand-in: gateway-native, so it belongs to no MCP server
 *  and `serverOf` answers null for it structurally. Its tier is its own
 *  declaration — the one tool the catalog cannot answer for. */
function delegateRunner(): BackgroundToolRunner {
  return {
    definition: {
      name: "delegateTask",
      description: "delegates",
      parameters: {},
      category: "background",
      tier: "confirm",
    },
    run: () => ({ cancel: () => {}, result: neverSettles<ToolResult>() }),
  };
}

interface ResolutionHarnessOpts {
  role: UserRole;
  tools?: McpToolRef[];
  permissions?: () => Promise<ToolPermissionMap | undefined>;
  backgroundTools?: Map<string, BackgroundToolRunner>;
  confirm?: boolean;
}

function resolutionBroker(opts: ResolutionHarnessOpts) {
  const mcp = fakeMcp(opts.tools ?? everyTierTools);
  let confirmCalls = 0;
  const broker = createToolBroker({
    mcp,
    store: fakeStore(),
    capability: capabilityFor(opts.role),
    catalog: testCatalog,
    sessionId: "session-1",
    backgroundTools: opts.backgroundTools ?? new Map(),
    config: toolsConfig,
    toolPermissions: opts.permissions ?? noUserPermissions,
    requestConfirm: async () => {
      confirmCalls += 1;
      return opts.confirm ?? true;
    },
  });
  return { broker, mcp, confirmCalls: () => confirmCalls };
}

async function namesFor(opts: ResolutionHarnessOpts): Promise<string[]> {
  const { broker } = resolutionBroker(opts);
  await broker.ready();
  return broker.definitions().map((d) => d.name);
}

/** A stored table that explicitly ALLOWS the write- and confirm-tier tools.
 *
 *  THE ONLY SHAPE THAT ISOLATES THE ROLE GATE. With nothing stored, a
 *  restricted role is already refused by the FLOOR — its role template simply
 *  has no entry for a tool it cannot execute, so the `?? "off"` backstop
 *  answers and the tool vanishes with the role gate deleted. Every "a guest
 *  does not see this" assertion therefore passes against its own mutation. An
 *  explicit stored `allow` short-circuits the floor, so the role gate is the
 *  only thing left that can refuse — which is also the real invariant: a
 *  permission a person holds must never widen what their role may reach.
 *
 *  Not a contrived fixture. It is what a demotion leaves behind: the table was
 *  written while the account was an adult and it survives the re-role, exactly
 *  as the brief's role-change case describes. */
const storedAllowAll = permissionsFor("test-mcp", {
  get_weather: "allow",
  add_todo: "allow",
  unlock_door: "allow",
});

describe("ToolBroker — the role gate decides what reaches tools[]", () => {
  it("SECURITY: a stored Allow cannot put a tool the role may not reach into tools[]", async () => {
    // The floor cannot answer here — the stored `allow` is read first — so this
    // is the role gate or nothing. Pins the PRESENCE of the read-tier tool in
    // the same breath, so "advertise nothing at all" does not satisfy it.
    expect(await namesFor({ role: "guest", permissions: storedAllowAll })).toEqual(["get_weather"]);
    expect(await namesFor({ role: "child", permissions: storedAllowAll })).toEqual(["get_weather", "add_todo"]);
    expect(await namesFor({ role: "adult", permissions: storedAllowAll })).toEqual([
      "get_weather",
      "add_todo",
      "unlock_door",
    ]);
  });

  it("SECURITY: a guest never sees a write-tier tool, and still sees the read-tier one", async () => {
    // Both halves matter. The absence alone is satisfied by a broker that
    // advertises nothing at all, which is the mutation this shape invites.
    expect(await namesFor({ role: "guest" })).toEqual(["get_weather"]);
  });

  it("SECURITY: a child sees read and write but never the confirm tier", async () => {
    expect(await namesFor({ role: "child" })).toEqual(["get_weather", "add_todo"]);
  });

  it("gives an adult every tier the catalog uses", async () => {
    expect(await namesFor({ role: "adult" })).toEqual(["get_weather", "add_todo", "unlock_door"]);
  });

  it("withholds a background tool from a role that cannot execute its tier", async () => {
    const backgroundTools = new Map([["delegateTask", delegateRunner()]]);
    expect(await namesFor({ role: "child", tools: [weatherTool], backgroundTools })).toEqual(["get_weather"]);
    expect(await namesFor({ role: "adult", tools: [weatherTool], backgroundTools })).toEqual([
      "get_weather",
      "delegateTask",
    ]);
  });
});

describe("ToolBroker — the role gate is re-asked at dispatch, not trusted from tools[]", () => {
  it("SECURITY: a stored Allow cannot get a tool past the role gate at dispatch either", async () => {
    // Same isolation as the `definitions()` case above: with the stored `allow`
    // read first, the floor never runs, so only the role gate can refuse. This
    // is "a user's own permission cannot widen their role", stated at the PDP.
    const { broker, mcp, confirmCalls } = resolutionBroker({ role: "guest", permissions: storedAllowAll });

    const result = await broker.dispatch(makeInvocation({ name: "add_todo" }));

    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("add_todo");
    expect(confirmCalls()).toBe(0);
    expect(mcp.callToolCalls).toHaveLength(0);

    // …and the same table's `allow` on a tool the role DOES reach still runs,
    // so this is not "a guest can do nothing".
    const allowed = await broker.dispatch(makeInvocation());
    expect(allowed).toEqual({ content: "result from test-mcp/get_weather", isError: false });
  });

  it("SECURITY: denies a child a confirm-tier tool it was never advertised, without prompting", async () => {
    const { broker, mcp, confirmCalls } = resolutionBroker({ role: "child" });

    const result = await broker.dispatch(makeInvocation({ name: "unlock_door" }));

    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unlock_door");
    // A model-emitted tool call is never itself an authorization decision, and
    // a prompt here would be a way to talk a person past their own role.
    expect(confirmCalls()).toBe(0);
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("SECURITY: denies a guest a write-tier tool the same way", async () => {
    const { broker, mcp } = resolutionBroker({ role: "guest" });

    const result = await broker.dispatch(makeInvocation({ name: "add_todo" }));

    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(result.isError).toBe(true);
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("still runs the tool the role DOES reach — the gate is a gate, not a wall", async () => {
    const { broker, mcp } = resolutionBroker({ role: "guest" });

    const result = await broker.dispatch(makeInvocation());

    expect(result).toEqual({ content: "result from test-mcp/get_weather", isError: false });
    expect(mcp.callToolCalls).toEqual([{ serverName: "test-mcp", name: "get_weather" }]);
  });
});

// ---------------------------------------------------------------------------
// THE FLOOR. Every profile on disk today has `permissions` UNSET — the key is
// absent, not empty. A copy-only rule strands all of them the moment the
// fallthrough is deleted. The role template answers underneath the stored table
// forever, so "absent" is well-defined rather than a bug.
// ---------------------------------------------------------------------------

describe("ToolBroker — a profile with NO permission table resolves from the role template", () => {
  /** A profile parsed through the REAL schema with no `permissions` key at all
   *  — the literal shape of every account on disk before seeding landed. Built
   *  by omission rather than by writing `permissions: undefined`, because it is
   *  the schema's `.optional()` that has to survive this, and an explicit
   *  `undefined` would pass even if it were `.default({})`. An empty table is a
   *  different answer entirely (every server off), pinned separately below. */
  const unseededProfile: ProfileV1 = profileV1Schema.parse({
    schemaVersion: 1,
    userId: capability.ownerUserId,
    model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
    voice: { provider: "local-tts", id: "default" },
    persona: { template: "default", overrides: "" },
    tools: { toolsets: [] },
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024 },
  });

  function unsetProfileReader() {
    return createToolPermissionsReader({
      profileStore: profileStoreReturning({ ok: true, value: unseededProfile }),
      userId: capability.ownerUserId,
    });
  }

  it("has no permissions key at all — the fixture is the thing being pinned", () => {
    expect("permissions" in unseededProfile.tools).toBe(false);
  });

  it("advertises exactly the tools the role reaches, for every role", async () => {
    expect(await namesFor({ role: "guest", permissions: unsetProfileReader() })).toEqual(["get_weather"]);
    expect(await namesFor({ role: "child", permissions: unsetProfileReader() })).toEqual(["get_weather", "add_todo"]);
    expect(await namesFor({ role: "adult", permissions: unsetProfileReader() })).toEqual([
      "get_weather",
      "add_todo",
      "unlock_door",
    ]);
  });

  it("runs a read-tier tool with no prompt — the template's answer for that tier is Allow", async () => {
    const { broker, mcp, confirmCalls } = resolutionBroker({ role: "adult", permissions: unsetProfileReader() });

    const result = await broker.dispatch(makeInvocation());

    expect(result).toEqual({ content: "result from test-mcp/get_weather", isError: false });
    expect(confirmCalls()).toBe(0);
    expect(mcp.callToolCalls).toHaveLength(1);
  });

  it("prompts on a write-tier tool — the template's answer for that tier is Ask", async () => {
    const { broker, mcp, confirmCalls } = resolutionBroker({ role: "adult", permissions: unsetProfileReader() });

    const result = await broker.dispatch(makeInvocation({ name: "add_todo" }));

    expect(confirmCalls()).toBe(1);
    expect(result).toEqual({ content: "result from test-mcp/add_todo", isError: false });
    expect(mcp.callToolCalls).toHaveLength(1);
  });
});

describe("ToolBroker — the stored table sits ON TOP of the template, never beside it", () => {
  it("lets a stored Deny override the template's Allow for a read-tier tool", async () => {
    const { broker, mcp, confirmCalls } = resolutionBroker({
      role: "adult",
      permissions: permissionsFor("test-mcp", { get_weather: "deny" }),
    });

    const result = await broker.dispatch(makeInvocation());

    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Deny");
    expect(confirmCalls()).toBe(0);
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("answers a tool the stored table does not name from the template, not from nothing", async () => {
    // `add_todo` has no stored entry under a PRESENT server. Pre-task-4 that
    // meant "inherit the operator policy file"; now it means the role template.
    const { broker, confirmCalls } = resolutionBroker({
      role: "adult",
      permissions: permissionsFor("test-mcp", { get_weather: "allow" }),
    });

    await broker.dispatch(makeInvocation({ name: "add_todo" }));

    expect(confirmCalls()).toBe(1);
  });

  it("moves the floor with the ROLE while the stored entries stay put", async () => {
    // One table, two roles. `unlock_door` is confirm-tier: the adult reaches it
    // and gets the template's `ask`; the child's role gate answers first.
    const stored = permissionsFor("test-mcp", { get_weather: "allow" });
    expect(await namesFor({ role: "adult", permissions: stored })).toEqual(["get_weather", "add_todo", "unlock_door"]);
    expect(await namesFor({ role: "child", permissions: stored })).toEqual(["get_weather", "add_todo"]);
  });

  it("reads an EMPTY per-server map as 'no opinion yet', so the template answers", async () => {
    // What `web-tools-migrator.ts` writes for a renamed server. An empty map is
    // a server that IS present with no per-tool opinions — not an absent one.
    const { broker, mcp, confirmCalls } = resolutionBroker({
      role: "adult",
      permissions: async () => ({ "test-mcp": {} }),
    });

    expect((await broker.ready().then(() => broker.definitions())).map((d) => d.name)).toEqual([
      "get_weather",
      "add_todo",
      "unlock_door",
    ]);
    await broker.dispatch(makeInvocation());
    expect(confirmCalls()).toBe(0);
    expect(mcp.callToolCalls).toHaveLength(1);
  });

  it("SECURITY: still reads a server ABSENT from a non-empty table as off, template or no template", async () => {
    // The clients switch a server off by DELETING its key. If the template
    // answered underneath that, every save would silently re-grant the server.
    const { broker, mcp } = resolutionBroker({
      role: "adult",
      permissions: permissionsFor("some-other-server", { whatever: "allow" }),
    });
    await broker.ready();

    expect(broker.definitions()).toEqual([]);
    const result = await broker.dispatch(makeInvocation());
    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(result.isError).toBe(true);
    expect(mcp.callToolCalls).toHaveLength(0);
  });

  it("SECURITY: falls to off for a live tool the catalog does not curate", async () => {
    // Neither table answers, so the fail-closed backstop does. It must never be
    // `allow` — an uncurated tool is one nobody tiered.
    const uncurated: McpToolRef = {
      serverName: "test-mcp",
      name: "search_images",
      description: "searches images",
      inputSchema: {},
      tier: "read",
    };
    const { broker, mcp } = resolutionBroker({ role: "adult", tools: [weatherTool, uncurated] });
    await broker.ready();

    expect(broker.definitions().map((d) => d.name)).toEqual(["get_weather"]);
    const result = await broker.dispatch(makeInvocation({ name: "search_images" }));
    if ("taskId" in result) throw new Error("expected a ToolResult, got a background handle");
    expect(result.isError).toBe(true);
    expect(mcp.callToolCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// `delegateTask` — the one tool no permission table can name. It is
// gateway-native, so `serverOf` answers null STRUCTURALLY and the
// server-addressed template has no key for it. It must not silently become
// `allow` (it spawns an unsupervised agent run), and it must not become
// unreachable for the roles that should have it.
// ---------------------------------------------------------------------------

describe("ToolBroker — a gateway-native tool resolves from its own declared tier", () => {
  const backgroundTools = () => new Map([["delegateTask", delegateRunner()]]);

  it("SECURITY: prompts an adult before an unsupervised delegated run — never a silent allow", async () => {
    const { broker, confirmCalls } = resolutionBroker({
      role: "adult",
      tools: [weatherTool],
      backgroundTools: backgroundTools(),
    });

    const result = await broker.dispatch(makeInvocation({ name: "delegateTask" }));

    expect(confirmCalls()).toBe(1);
    expect(result).toHaveProperty("taskId");
  });

  it("SECURITY: denies a child, whose role never reaches the confirm tier", async () => {
    const { broker, confirmCalls } = resolutionBroker({
      role: "child",
      tools: [weatherTool],
      backgroundTools: backgroundTools(),
    });

    const result = await broker.dispatch(makeInvocation({ name: "delegateTask" }));

    if ("taskId" in result) throw new Error("expected a deny, got a background handle");
    expect(result.isError).toBe(true);
    expect(confirmCalls()).toBe(0);
  });

  it("is NOT switched off by a table that names every other server", async () => {
    // The regression `resolvePermission`'s serverless branch guards:
    // a `?? "off"` backstop applied blindly to a serverless tool would delete
    // delegation from every profile in the product.
    expect(
      await namesFor({
        role: "adult",
        tools: [weatherTool],
        backgroundTools: backgroundTools(),
        permissions: permissionsFor("test-mcp", { get_weather: "allow" }),
      }),
    ).toEqual(["get_weather", "delegateTask"]);
  });
});

// ---------------------------------------------------------------------------
// THE CACHE-STABILITY INVARIANT, re-run against the two-gate resolution.
//
// `tools[]` serializes AHEAD of `messages[]`, so it is part of the provider's
// cached prefix. `allow`, `ask` and `deny` must leave it byte-identical; `off`
// and the ROLE GATE are the only two things permitted to move it.
// ---------------------------------------------------------------------------

describe("ToolBroker — tools[] stays cache-stable under the two-gate resolution", () => {
  async function serializedFor(permission: ToolPermission, role: UserRole = "adult"): Promise<string> {
    const { broker } = resolutionBroker({
      role,
      permissions: permissionsFor("test-mcp", { get_weather: permission }),
    });
    await broker.ready();
    return JSON.stringify(broker.definitions());
  }

  it("INVARIANT: keeps the array byte-identical across allow, ask and deny", async () => {
    const allow = await serializedFor("allow");

    expect(await serializedFor("ask")).toBe(allow);
    expect(await serializedFor("deny")).toBe(allow);
    // …and the two states that ARE allowed to move it, so this test cannot
    // pass by never producing a difference at all.
    expect(await serializedFor("off")).not.toBe(allow);
    expect(await serializedFor("allow", "guest")).not.toBe(allow);
  });
});
