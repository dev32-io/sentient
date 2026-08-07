// ToolBroker (Plan 2 Task 4, spec §5.3) — the single L3 permission-decision
// choke point every tool call passes through, foreground or background,
// before any side effect runs. Prior-art lesson (carried in the plan's
// Global Constraints): two dispatch paths means one silently skips the
// gate. `resolveDecision` below is called from exactly ONE place inside
// `dispatch` — both branches (foreground MCP call, background runner) flow
// through it first, so a `deny` or an unconfirmed `confirm` structurally
// cannot reach `mcp.callTool` or a `BackgroundToolRunner.run`.
//
// Fail-closed at both layers: `policy-engine.ts` classifies a tool that NO
// rule names as side-effecting and returns `confirm` (design §2.2), and this
// broker is what makes `confirm` mean something — it calls the injected
// `requestConfirm`, which the composition root binds to the SESSION's
// permission broker (runtime/session-permission-broker.ts's
// `createConfirmHook`), so an unconfirmed side-effecting tool is BLOCKED,
// never silently run. Three outcomes reach a two-valued seam: an explicit
// human answer from ANY window on the session RESOLVES true/false, and an
// UNANSWERABLE request (timeout, no window open, session teardown, turn abort)
// REJECTS with `ConfirmUnavailableError` whose message is forwarded to the
// model verbatim as the deny reason. Any other throw is a bug in the hook and
// stays opaque ("confirmation error"), so an internal error string never
// enters the model's context.
//
// `store: SessionStore` is accepted for interface parity with the wider
// deps-threading pattern (composition root, Task 9) but is NOT used to
// append tool_call/tool_result here. Per spec §4.3's loop steps and Task
// 6's brief ("for each call, broker.dispatch ... loop appends
// tool_call+tool_result"), that append is the ReAct loop's job — it owns
// turn semantics. `ToolInvocation` now carries `turnId`, but ONLY so
// background dispatch can key its `delegation.progress` frames to a turn;
// that field is read for frame correlation and never for a store write.
// Keeping the append in the loop keeps this file focused on the one thing
// it must get right: the PDP choke point.
//
// `sessionChannel` is hardcoded to "text": Plan 2 walks text-only
// end-to-end (voice/TTS lands in Plan 3). When a session gains a real
// channel, thread it through `createToolBroker`'s deps instead of the
// principal/config shape locked here.

import { ALL_TOOLS_PERMISSION_KEY, type OrchestratorConfig } from "@sentient/config";
import type { ToolPermission, ToolPermissionMap } from "@sentient/config";
import type { Capability } from "../access/capability.js";
import type { UserPrincipal } from "../identity/user-principal.js";
import { getLog } from "../logging/logger.js";
import type { PolicyContext, PolicyEngine } from "../security/policy-engine.js";
import type { SessionStore } from "../store/session-store.js";
import type { UserId } from "../user-auth/user-id.js";
import { createBackgroundRegistry } from "./background-registry.js";
import type { BackgroundRegistry } from "./background-registry.js";
import type { McpClient } from "./mcp-client.js";
import { capToolResult } from "./tool-result-cap.js";
import { ConfirmUnavailableError } from "./tool-types.js";
import type { DelegationProgress, PdpDecision, ToolDefinition, ToolInvocation, ToolResult } from "./tool-types.js";

const log = getLog(["sentient", "tools", "tool-broker"]);

const TOO_MANY_BACKGROUND_TASKS = "too many running tasks";

/** Client-facing failure-note budget on a `delegation.progress` error frame.
 *  A tile shows a hint, never the delegated worker's full output. */
const NOTE_PREVIEW_LEN = 120;

/** `delegateTask`'s worker name; any other background tool reports under its
 *  own tool name. Never throws on a malformed `args` — the guard/runner is
 *  what rejects a bad agent, not this display-only derivation. */
/** What the model is told when a HUMAN answered the confirm prompt with "no".
 *
 *  It used to read `confirmation declined: <policy rationale>` — which names
 *  the policy, not the person, and reads like a rule the model might argue
 *  with or route around. A person said no. The system prompt promises the
 *  model "you receive a tool result saying so"; this is that result, and it
 *  has to be unambiguous about WHO decided. */
function userDeclinedReason(toolName: string): string {
  return `The user declined this ${toolName} call. Do not retry it; offer an alternative if one exists.`;
}

/** What the model is told when the person's own SETTING is `deny` — distinct
 *  from `userDeclinedReason` above, which reports a human answering "no" to a
 *  live prompt. Keeping `deny` legible to the model is the entire reason it is
 *  a separate state from `off`: the tool stays in `tools[]` so the model can
 *  say what it could not do, instead of improvising around a gap it cannot
 *  see. */
function settingsDeniedReason(toolName: string): string {
  return `The ${toolName} tool is set to Deny in this user's settings. Do not retry it; say what you could not do and offer an alternative if one exists.`;
}

/** Fail-closed answer for a tool the person has switched `off`. Normally
 *  UNREACHABLE from the model — `definitions()` never advertises it — but
 *  reachable from a delegated agent's proxied call, or from a settings save
 *  that lands between this turn's `tools[]` and this call. */
function settingsOffReason(toolName: string): string {
  return `The ${toolName} tool is turned off in this user's settings and is not available.`;
}

/** The confirm rationale shown to the person when THEY are the reason the
 *  prompt exists. The operator policy's own rationale is deliberately not
 *  reused here: it explains why a rule tiered the tool, which says nothing
 *  about a setting the person chose themselves. */
function settingsAskReason(toolName: string): string {
  return `Your settings ask for confirmation before every ${toolName} call.`;
}

/** Whether a permission leaves the tool in the model's `tools[]`.
 *
 *  EXHAUSTIVE, no `default:` arm — a fifth member (`auto`) must break here so
 *  somebody decides whether the model can see it, rather than inheriting
 *  "visible" by accident. `off` is the ONLY member that answers false, which
 *  is what keeps the request prefix — and therefore the provider's prompt
 *  cache — byte-identical across `allow`, `ask` and `deny`. */
function isVisibleToModel(permission: ToolPermission): boolean {
  switch (permission) {
    case "allow":
      return true;
    case "ask":
      return true;
    case "deny":
      return true; // legible on purpose: the model must be able to explain the refusal.
    case "off":
      return false;
  }
}

function delegationAgent(inv: ToolInvocation): string {
  const agent = inv.args.agent;
  return typeof agent === "string" && agent.length > 0 ? agent : inv.name;
}

/** A background tool's execution unit (e.g. `delegateTask`, Task 5). `run`
 *  starts the work immediately and returns a cancel handle (registered in
 *  `BackgroundRegistry`, invoked on interrupt) plus a result promise the
 *  broker observes off-turn — it is NEVER awaited before `dispatch`
 *  returns (fire-and-steer). The runner's only job is to settle `result`
 *  faithfully with the tool's final outcome; it does NOT touch the store
 *  itself. Per the late-result constraint (spec §5.2/§5.4), that result
 *  must eventually reach the model as a fresh `system`/`trigger` entry,
 *  never a second `tool_result` for an already-answered call id — the
 *  broker does that by observing this same promise in `dispatchBackground`
 *  and forwarding the settled outcome to `onBackgroundComplete` (see
 *  `setBackgroundCompletionSink` below), which the composition root binds
 *  to `SessionRuntime.submit({ kind: "background-completion", ... })`. */
export interface BackgroundToolRunner {
  definition: ToolDefinition;
  run(inv: ToolInvocation, taskId: string): { cancel: () => void; result: Promise<ToolResult> };
}

/** The settled outcome of a background tool run, handed to whatever sink
 *  `setBackgroundCompletionSink` installed. `toolName` + `taskId` + `request`
 *  let the sink build a stimulus note that identifies itself; `content`/
 *  `isError` are the runner's settled `ToolResult`, normalized (a rejected
 *  `result` promise becomes an `isError: true` entry here — the sink never
 *  has to handle a rejection itself). */
export interface BackgroundCompletionResult {
  taskId: string;
  toolName: string;
  /** The dispatching invocation's arguments, forwarded verbatim so the note
   *  can echo what was asked. Carried because a completion outlives the
   *  context that explains it: compaction summarises the dispatch away, and a
   *  bare taskId then binds to nothing — see background-completion-note.ts.
   *  Forwarded as the raw object rather than a distilled string so this file
   *  stays ignorant of any one tool's argument schema. */
  request: Record<string, unknown>;
  content: string;
  isError: boolean;
}

/** Late-bound completion callback (see `ToolBroker.setBackgroundCompletionSink`). */
export type BackgroundCompletionSink = (result: BackgroundCompletionResult) => void;

export interface ToolBroker {
  /** Whose authority this broker acts under — read from its `Capability` at
   *  construction, never from the `principal` dep (spec §3.2: a capability is
   *  the authorization input, `principal` is log correlation only). Exposed
   *  so a caller can confirm which identity a broker instance was actually
   *  built for, the same confused-deputy check `openSessionStore` makes for
   *  the store. */
  readonly ownerUserId: UserId;
  /**
   * Resolve the MCP half of the vocabulary. Idempotent and memoized, so every
   * call after the first is free.
   *
   * AWAIT THIS BEFORE READING `definitions()` FOR THE MODEL. Listing MCP tools
   * is I/O against every configured server, and it lands ~100ms after a session
   * binds — while the first turn of that session starts in the SAME TICK as
   * `session.configure` on mobile, which carries the first message. So the
   * model's first call went out with only the background tools registered:
   *
   *   react-loop.start   toolCount=1     ← delegateTask, alone
   *   stream-start       toolCount=1
   *   mcp-warmup.ok      toolCount=29    ← 117ms too late
   *
   * A model whose only tool is `delegateTask` delegates. That read as the model
   * being eager to hand work off; it was the tool list being empty.
   *
   * TWO HALVES OF ONE QUESTION. Since per-tool permissions landed this also
   * re-reads the person's permission map, which is what decides which of the
   * listed tools the model is allowed to SEE. The MCP half is memoized (one
   * round trip per broker); the permission half is re-read on EVERY call, so a
   * settings save takes effect on the next turn without rebuilding the broker.
   * Calling this per turn is the contract the ReAct loop already honours.
   */
  ready(): Promise<void>;
  /** The session's tool vocabulary (MCP-catalog tools + registered background
   *  tools) MINUS everything the person has switched `off`. Stable within a
   *  turn — the MCP list is cached and the permission snapshot is refreshed
   *  once, by `ready()`, at the turn boundary — so it is never re-derived
   *  mid-turn (spec §4.6: hiding a tool is not a security boundary, L3 at the
   *  call is; `off` is a prompt-surface decision, and `resolveDecision` still
   *  refuses an `off` tool that reaches it by any other route).
   *  Synchronous, so it reports whatever is resolved NOW: see `ready()` before
   *  handing the result to a provider. */
  definitions(): ToolDefinition[];
  /** foreground → awaits the result; background → returns `{ taskId }`
   *  immediately without blocking on the runner. Every call passes the L3
   *  PDP check first, unconditionally. */
  dispatch(inv: ToolInvocation): Promise<ToolResult | { taskId: string }>;
  /**
   * Foreground calls currently awaiting a result. Read by the session
   * retention predicate (runtime/session-retention.ts): a session whose last
   * window closed mid-tool-call is still working, and a tool round-trip is the
   * one part of a turn that can outlive the socket that provoked it.
   */
  readonly foregroundInFlight: number;
  readonly background: BackgroundRegistry;
  /** Late-bound seam for the chicken-and-egg in the broker/runtime
   *  construction order (the broker is built BEFORE the `SessionRuntime`
   *  that owns `submit`, so the sink can't be a constructor dep). The
   *  composition root calls this once, right after `SessionRuntime` exists,
   *  binding it to `runtime.submit({ kind: "background-completion", ... })`
   *  (see `phase-services.ts`'s `buildCreateSessionRuntime`). Unset is a
   *  safe no-op — `dispatchBackground` just drops the settled result, same
   *  as before this seam existed. Not part of `ToolBrokerDeps`: that
   *  interface is fixed at construction time, before the runtime it would
   *  need to close over exists. */
  setBackgroundCompletionSink(sink: BackgroundCompletionSink): void;
}

export interface ToolBrokerDeps {
  mcp: McpClient;
  policy: PolicyEngine;
  store: SessionStore;
  /** The AUTHORIZATION input (spec §3.2). `broker.ownerUserId` and the PDP's
   *  `PolicyContext.userId` both read `capability.ownerUserId` — never
   *  `principal.userId` — so the broker's authority is exactly what its
   *  capability grants, not whatever principal happened to be threaded in
   *  alongside it. Mint from the same `AccessManager` that mints the
   *  session's own store capability. */
  capability: Capability;
  /** Log correlation ONLY (`role` is useful in a log line) — it must never be
   *  an input to a PDP decision. `mcp-policy.yaml` rules keyed on `role`
   *  (e.g. child/guest tiering) still read `principal.role`: role is not the
   *  identity this task's confused-deputy fix is about (a capability is
   *  always minted from the very principal whose role this is — see
   *  `AccessManager.grant` — so the two cannot diverge), and `Capability`
   *  carries no role of its own to substitute. */
  principal: UserPrincipal;
  /** The CONNECTION id (`ws.data.sessionId`), for log correlation and nothing
   *  else — every `tool-broker.*` line below carries it so a dispatch is
   *  traceable to the one socket that made it. It is NOT the durable
   *  conversation the session store partitions on: two connections to the
   *  same conversation (before and after a reload) must stay distinguishable
   *  here. See `SessionRuntimeRequest` in runtime/session-handles.ts. */
  sessionId: string;
  /** name → runner. `delegateTask` (Task 5) registers itself here. */
  backgroundTools: Map<string, BackgroundToolRunner>;
  config: OrchestratorConfig["tools"];
  /**
   * Reads THIS broker's owner's `profile.tools.permissions` — server name →
   * tool name → `allow | ask | deny | off`.
   *
   * A GETTER, never a value: the map is read at `ready()` (once per turn, for
   * `definitions()`) and again inside `resolveDecision` (per call, for the PDP),
   * so a settings save takes effect on the next turn without rebuilding the
   * broker. Nothing here is captured at construction.
   *
   * `undefined` means NEVER SET — everything inherits `mcp-policy.yaml`. An
   * empty object is a different answer: a table naming no server, so every
   * server is absent and therefore off. Do not collapse the two.
   *
   * ASYNC, unlike the rest of this deps object. The map lives in a file
   * (`profile.json`), and the two ways to make it synchronous are both worse: a
   * blocking `readFileSync` on the WS event loop, or a cached snapshot that is
   * one turn stale — and a stale snapshot means the first turn after a session
   * binds renders `tools[]` from an EMPTY map, which is the exact
   * read-before-resolution bug `ready()`'s own doc comment was written for. The
   * composition root supplies `tools/user-tool-permissions.ts`'s reader.
   */
  toolPermissions: () => Promise<ToolPermissionMap | undefined>;
  /** Resolves an L3 `confirm` decision. The composition root binds this to the
   *  SESSION's permission broker (runtime/session-permission-broker.ts): it
   *  resolves `true`/`false` on the FIRST human answer from any attached
   *  window, and REJECTS with `ConfirmUnavailableError` when the prompt could
   *  not be answered at all — including "no window is open to show it".
   *  Either way the call fails closed — see `resolveDecision` below. */
  requestConfirm: (inv: ToolInvocation, reason: string) => Promise<boolean>;
  /** Fired at both ends of a background task's life (spec §5.4 / §7): once
   *  with `status: "running"` the moment `dispatch` hands back a `{taskId}`,
   *  and once with `done`/`error` when the runner's promise settles. The
   *  composition root binds this to the session's `TurnEmitter`, which puts
   *  it on the wire as `delegation.progress`. Optional for the same reason
   *  `setBackgroundCompletionSink` is late-bound — a headless/dev broker has
   *  no client — but an UNSET sink is logged once per task, never silent. */
  onDelegationProgress?: (p: DelegationProgress) => void;
}

export function createToolBroker(deps: ToolBrokerDeps): ToolBroker {
  const {
    mcp,
    policy,
    principal,
    capability,
    sessionId,
    backgroundTools,
    config,
    requestConfirm,
    toolPermissions,
    onDelegationProgress,
  } = deps;
  const ownerUserId = capability.ownerUserId;
  const background = createBackgroundRegistry();
  // Late-bound (see `ToolBroker.setBackgroundCompletionSink`'s doc comment
  // for why this can't be a constructor dep). `null` until the composition
  // root binds it — dispatchBackground below tolerates that by just not
  // forwarding the settled result.
  let completionSink: BackgroundCompletionSink | null = null;
  // Foreground calls awaiting a result. A COUNTER, not a set: the retention
  // predicate only asks whether any call is outstanding, and the loop dispatches
  // a turn's tool calls concurrently.
  let foregroundInFlight = 0;

  // MCP tool listing is I/O (a round-trip to every configured server), so
  // it can't be resolved synchronously inside `definitions()`. It is
  // fetched exactly once per broker instance (memoized on this promise)
  // and cached; `dispatch` awaits the same promise before routing a
  // foreground call, so execution is always correct even if `definitions()`
  // is read before the very first warm-up completes.
  let mcpIndex: Map<string, string> | null = null; // toolName -> serverName
  let mcpDefs: ToolDefinition[] = [];
  let warmup: Promise<void> | null = null;

  function ensureMcpWarm(): Promise<void> {
    if (!warmup) {
      warmup = mcp
        .listTools()
        .then((refs) => {
          mcpIndex = new Map(refs.map((ref) => [ref.name, ref.serverName]));
          mcpDefs = refs.map((ref) => ({
            name: ref.name,
            description: ref.description,
            parameters: ref.inputSchema,
            category: "foreground" as const,
          }));
          log.info("tool-broker.mcp-warmup.ok", { sessionId, toolCount: refs.length });
        })
        .catch((err) => {
          mcpIndex = new Map();
          mcpDefs = [];
          log.warn("tool-broker.mcp-warmup.failed", {
            sessionId,
            reason: err instanceof Error ? err.message : String(err),
          });
        });
    }
    return warmup;
  }

  // The owner's permission table, as of the last `refreshPermissions()`, or
  // `undefined` for "never set". Held as a snapshot ONLY because
  // `definitions()` is synchronous by contract and the table lives in a file;
  // every asynchronous reader re-reads it first (see `ready` and
  // `resolveDecision`). Starts unset, which is the honest state before the
  // first read — and `undefined` is NOT `{}`; see `permissionFor`.
  let permissions: ToolPermissionMap | undefined;

  async function refreshPermissions(): Promise<void> {
    try {
      permissions = await toolPermissions();
    } catch (err) {
      // Keep the last known table rather than widening to an empty one: a
      // settings read that fails must never grant more than it granted a
      // moment ago.
      log.warn("tool-broker.permissions.refresh-failed", {
        sessionId,
        reason: err instanceof Error ? err.message : String(err),
        servers: permissions === undefined ? 0 : Object.keys(permissions).length,
      });
    }
  }

  /** tool name → its MCP server, or `null` for a tool no server owns. The ONE
   *  mapping used for both existence (`resolveTarget`) and permission lookup,
   *  so the two can never disagree about which server a tool belongs to. */
  function serverOf(toolName: string): string | null {
    // Background tools (`delegateTask`) are gateway-native: no MCP server, so
    // no key in a map that is addressed by server name.
    if (backgroundTools.has(toolName)) return null;
    return mcpIndex?.get(toolName) ?? null;
  }

  /**
   * The person's own setting for a tool, or `undefined` for INHERIT (fall
   * through to `mcp-policy.yaml`, exactly as before this field existed).
   *
   * PRECEDENCE inside a server: the tool's own key, then the server's `"*"`
   * wildcard, then absent.
   *
   * THE SERVER-LEVEL ASYMMETRY, deliberate and load-bearing. A tool absent
   * from a PRESENT server inherits; a whole server absent from a NON-EMPTY
   * table is `off`. That is not a second rule invented here — it is the
   * meaning `tools.enabled` always carried and that every client still
   * encodes: the web and mobile Tools panes switch a server off by DELETING
   * its key. Reading an absent server as "inherit" would show a person "off"
   * in the UI while the model kept the tools, silently, on every save. The
   * asymmetry is confined to the server level and goes away for good once the
   * clients write the explicit `{"*": "off"}` spelling instead of deleting.
   *
   * UNSET IS NOT EMPTY. `undefined` here means the person never set a table,
   * so everything inherits. An empty OBJECT is a table that names no server,
   * i.e. every server off — which is exactly what "turn all five servers off in
   * the UI" produces, and what `user-tool-permissions.ts` reports for a profile
   * it cannot read. `ProfileV1["tools"]["permissions"]` is `.optional()` rather
   * than `.default({})` precisely so these two remain distinguishable all the
   * way down to this line.
   */
  function permissionFor(toolName: string): ToolPermission | undefined {
    const serverName = serverOf(toolName);
    if (serverName === null) return undefined;
    if (permissions === undefined) return undefined;
    const perServer = permissions[serverName];
    if (perServer === undefined) return "off";
    return perServer[toolName] ?? perServer[ALL_TOOLS_PERMISSION_KEY];
  }

  /**
   * The ONE place `policy.evaluate` is called. Both dispatch branches
   * (foreground, background) flow through this before any side effect — that
   * is what makes the choke point structural rather than a convention two
   * branches could independently drift from.
   *
   * ORDER, written as control flow rather than as a comment somebody could
   * drift from. The operator's `mcp-policy.yaml` runs FIRST and
   * UNCONDITIONALLY, and its `deny` returns before the person's own table is
   * read at all. That single early return is what makes "a user's `allow`
   * cannot override an operator `deny`" structurally true: there is exactly
   * one way past it, and taking it has already ruled an operator deny out.
   * Below the guard the person's explicit setting decides; absent one, the
   * operator's verdict carries on exactly as it did before this field existed.
   */
  async function resolveDecision(inv: ToolInvocation): Promise<PdpDecision> {
    // Per call, never captured: a settings save reaches the very next dispatch
    // rather than waiting for a new broker.
    await refreshPermissions();

    const ctx: PolicyContext = {
      tool: inv.name,
      userId: ownerUserId, // capability, not the ambient principal — spec §3.2.
      role: principal.role, // RBAC tier only; see ToolBrokerDeps.principal's doc comment.
      sessionChannel: "text", // Plan 2 is text-only; see file header.
      args: inv.args,
    };
    const decision = policy.evaluate(ctx);
    const userPermission = permissionFor(inv.name);
    log.info("tool-broker.pdp.decision", {
      sessionId,
      tool: inv.name,
      toolCallId: inv.toolCallId,
      action: decision.action,
      reason: decision.reason,
      rule: decision.rule,
      userPermission: userPermission ?? "inherit",
    });

    // THE GUARD. Operator deny is terminal and precedes every user branch.
    if (decision.action === "deny") {
      log.warn("tool-broker.pdp.operator-deny", {
        sessionId,
        tool: inv.name,
        toolCallId: inv.toolCallId,
        rule: decision.rule,
        userPermission: userPermission ?? "inherit",
        reason: "mcp-policy.yaml denied this tool — a user permission cannot widen an operator deny",
      });
      return { action: "deny", reason: decision.reason ?? "denied by policy" };
    }

    if (userPermission !== undefined) {
      log.info("tool-broker.permission.applied", {
        sessionId,
        tool: inv.name,
        toolCallId: inv.toolCallId,
        userPermission,
        policyAction: decision.action,
      });
      return applyUserPermission(inv, userPermission);
    }

    // Absent → inherit: the operator policy decides, exactly as it did before
    // per-tool permissions existed.
    if (decision.action === "allow") return { action: "allow" };
    return runConfirmFlow(inv, decision.reason ?? "confirmation required");
  }

  /**
   * The person's explicit setting, turned into a PDP verdict.
   *
   * EXHAUSTIVE — no `default:` arm. Every member returns, so a fifth member
   * (`auto`) leaves a code path falling off the end of a function declared to
   * return `Promise<PdpDecision>`, which is a compile error rather than a
   * silent fall-through into "inherit".
   */
  async function applyUserPermission(inv: ToolInvocation, permission: ToolPermission): Promise<PdpDecision> {
    switch (permission) {
      case "allow":
        // No prompt. That is the whole difference from `ask`, and from
        // inheriting a policy that classifies unnamed tools as side-effecting.
        return { action: "allow" };
      case "ask":
        return runConfirmFlow(inv, settingsAskReason(inv.name));
      case "deny":
        return { action: "deny", reason: settingsDeniedReason(inv.name) };
      case "off":
        // Normally unreachable — `definitions()` never advertised it — but a
        // proxied delegated call or a mid-turn settings save can still land
        // here, so it fails closed instead of trusting the tool list.
        return { action: "deny", reason: settingsOffReason(inv.name) };
    }
  }

  /** The human-in-the-loop half of the PDP, reached from two places: an
   *  operator `confirm` verdict that the person has not overridden, and the
   *  person's own `ask`. One implementation, so the fail-closed handling
   *  below cannot diverge between them. */
  async function runConfirmFlow(inv: ToolInvocation, reason: string): Promise<PdpDecision> {
    // Fail-closed unless the injected confirm hook says otherwise (Plan 2
    // default: always false). A confirm hook that THROWS (Plan 3's real UI
    // could) must still fail closed, and the broker's contract is "never throw
    // out of dispatch" — so a throw becomes a deny, not a rejected promise the
    // ReAct loop has to catch.
    let confirmed: boolean;
    try {
      confirmed = await requestConfirm(inv, reason);
    } catch (err) {
      // Fail-closed either way — the ONLY difference is what the model is
      // told. `ConfirmUnavailableError` is the confirm hook's deliberate
      // "nobody could answer this" signal (timeout / no window open / session
      // closed / turn aborted, see runtime/permission-prompt.ts) and its message is
      // model-facing copy by design. Every other throw is a bug in the hook:
      // report it opaquely so an internal error string never enters the
      // model's context.
      const denyReason = err instanceof ConfirmUnavailableError ? err.message : "confirmation error";
      log.warn("tool-broker.pdp.confirm-error", {
        sessionId,
        tool: inv.name,
        toolCallId: inv.toolCallId,
        unavailable: err instanceof ConfirmUnavailableError,
        reason: denyReason,
      });
      return { action: "deny", reason: denyReason };
    }
    log.info("tool-broker.pdp.confirm-resolved", {
      sessionId,
      tool: inv.name,
      toolCallId: inv.toolCallId,
      confirmed,
    });
    return confirmed ? { action: "allow" } : { action: "deny", reason: userDeclinedReason(inv.name) };
  }

  /** EXISTENCE, resolved before the PDP ever runs. Returns null for a tool
   *  name that is in neither the MCP catalog nor the background registry.
   *
   *  Order is the whole point. Observed live 3× in one day: the model called
   *  `ha_search`, the catalog has `ha_search_entities`, the PDP prompted the
   *  owner to authorize it, they approved — and only then did dispatch log
   *  `unknown-tool`. A permission prompt asserts that the thing being
   *  authorized is real; raising one for a hallucination spends the human's
   *  attention on nothing and teaches them to click through the prompts that
   *  DO guard something. A name that does not exist is a model error the loop
   *  absorbs, not a decision anyone should be asked to make. */
  async function resolveTarget(
    inv: ToolInvocation,
  ): Promise<{ kind: "background"; runner: BackgroundToolRunner } | { kind: "foreground"; serverName: string } | null> {
    const runner = backgroundTools.get(inv.name);
    if (runner) return { kind: "background", runner };
    await ensureMcpWarm();
    const serverName = serverOf(inv.name);
    return serverName ? { kind: "foreground", serverName } : null;
  }

  /** The ONE place a tool result's size is bounded before it can reach the
   *  model (task 18, D17) — every result flowing through this function,
   *  whatever tool produced it, inherits the cap. See tool-result-cap.ts's
   *  file header for why this lives at the broker and not in any one tool. */
  function capResult(inv: ToolInvocation, result: ToolResult, logEvent: string): ToolResult {
    const limit = config.max_tool_result_chars;
    if (result.content.length <= limit) return result;
    const content = capToolResult(result.content, { limit });
    log.warn(logEvent, {
      sessionId,
      tool: inv.name,
      toolCallId: inv.toolCallId,
      originalLength: result.content.length,
      cappedLength: content.length,
      limit,
      reason:
        "tool result exceeded orchestrator.tools.max_tool_result_chars — truncated head+tail so it cannot alone exhaust the answer budget",
    });
    return { ...result, content };
  }

  async function dispatchForeground(inv: ToolInvocation, serverName: string): Promise<ToolResult> {
    // Plan 2: the foreground deadline is enforced per-server by the MCP client
    // (each catalog entry's `timeout`), which supersedes config.foreground_timeout_ms
    // at this layer. A broker-level per-call deadline (AbortSignal.timeout merged
    // with inv.signal) is a later hardening step if a single per-call bound is wanted.
    foregroundInFlight += 1;
    try {
      const raw = await mcp.callTool(serverName, inv.name, inv.args, inv.signal);
      const result = capResult(inv, raw, "tool-broker.dispatch.foreground.result-capped");
      log.info("tool-broker.dispatch.foreground.done", {
        sessionId,
        tool: inv.name,
        toolCallId: inv.toolCallId,
        isError: result.isError,
        contentLength: result.content.length,
      });
      return result;
    } finally {
      // `finally`, not a decrement after the await: a throwing or aborted call
      // that left the counter high would pin its session resident forever.
      foregroundInFlight -= 1;
    }
  }

  function dispatchBackground(inv: ToolInvocation, runner: BackgroundToolRunner): ToolResult | { taskId: string } {
    const cap = config.max_concurrent_background_tasks;
    const running = background.count();
    if (running >= cap) {
      log.warn("tool-broker.dispatch.background.cap-exceeded", {
        sessionId,
        tool: inv.name,
        toolCallId: inv.toolCallId,
        running,
        cap,
      });
      return { content: TOO_MANY_BACKGROUND_TASKS, isError: true };
    }

    const taskId = crypto.randomUUID();
    const { cancel, result } = runner.run(inv, taskId);
    background.register(taskId, cancel);
    log.info("tool-broker.dispatch.background.started", {
      sessionId,
      tool: inv.name,
      toolCallId: inv.toolCallId,
      taskId,
    });

    const agent = delegationAgent(inv);
    if (onDelegationProgress) {
      onDelegationProgress({ taskId, turnId: inv.turnId, agent, status: "running" });
    } else {
      log.warn("tool-broker.dispatch.background.no-progress-sink", {
        sessionId,
        tool: inv.name,
        taskId,
        reason: "onDelegationProgress was not wired — client sees no delegation tile for this task",
      });
    }

    // Fire-and-steer: never awaited before returning `{ taskId }`. First
    // stage normalizes a rejected `result` into an isError ToolResult (a
    // runner's promise must never reach the second stage as a rejection,
    // per the BackgroundToolRunner contract); second stage always runs with
    // a settled ToolResult, frees the concurrency slot, and — this closes
    // the loop the file header describes — forwards the outcome to whatever
    // `setBackgroundCompletionSink` installed, so the delegated task's
    // output actually reaches the model instead of dead-ending here.
    result
      .then(
        (toolResult) => toolResult,
        (err): ToolResult => {
          const reason = err instanceof Error ? err.message : String(err);
          log.warn("tool-broker.dispatch.background.runner-rejected", {
            sessionId,
            tool: inv.name,
            taskId,
            reason,
          });
          return { content: `Background task failed: ${reason}`, isError: true };
        },
      )
      .then((raw) => {
        // Same cap as the foreground path — a delegated task's own settled
        // output reaches the model too (via the completion sink below), so
        // it can starve the answer just as surely as a big MCP tool result.
        const toolResult = capResult(inv, raw, "tool-broker.dispatch.background.result-capped");
        background.complete(taskId);
        onDelegationProgress?.({
          taskId,
          turnId: inv.turnId,
          agent,
          status: toolResult.isError ? "error" : "done",
          ...(toolResult.isError ? { note: toolResult.content.slice(0, NOTE_PREVIEW_LEN) } : {}),
        });
        log.info("tool-broker.dispatch.background.completed", {
          sessionId,
          tool: inv.name,
          taskId,
          isError: toolResult.isError,
          contentLength: toolResult.content.length,
        });
        if (!completionSink) {
          log.warn("tool-broker.dispatch.background.no-sink", {
            sessionId,
            tool: inv.name,
            taskId,
            reason: "setBackgroundCompletionSink was never bound — settled result dropped",
          });
          return;
        }
        completionSink({
          taskId,
          toolName: inv.name,
          request: inv.args,
          content: toolResult.content,
          isError: toolResult.isError,
        });
      });

    return { taskId };
  }

  /** THE SOLE PRODUCER of the model's `tools[]`, and the only place `off` is
   *  read. Everything else about a permission is a dispatch-time decision, on
   *  purpose: `tools[]` is serialized AHEAD of `messages[]`, so it is part of
   *  the provider's cached prefix, and any per-permission variation in it
   *  would silently re-prime the whole system prompt and history on every
   *  settings tweak. `allow`, `ask` and `deny` therefore leave this array
   *  byte-identical — see `isVisibleToModel`. */
  function definitions(): ToolDefinition[] {
    void ensureMcpWarm(); // idempotent kick-off; definitions() itself stays synchronous
    const backgroundDefs = [...backgroundTools.values()].map((runner) => runner.definition);
    const all = [...mcpDefs, ...backgroundDefs];
    const visible = all.filter((def) => {
      const permission = permissionFor(def.name);
      return permission === undefined || isVisibleToModel(permission);
    });
    if (visible.length !== all.length) {
      log.info("tool-broker.definitions.filtered", {
        sessionId,
        toolCount: visible.length,
        offCount: all.length - visible.length,
        reason: "tools switched off in this user's settings are not advertised to the model",
      });
    }
    return visible;
  }

  async function dispatch(inv: ToolInvocation): Promise<ToolResult | { taskId: string }> {
    const target = await resolveTarget(inv);
    if (!target) {
      log.warn("tool-broker.dispatch.unknown-tool", {
        sessionId,
        tool: inv.name,
        toolCallId: inv.toolCallId,
        reason: "name is in neither the MCP catalog nor the background registry — answered before the PDP",
      });
      return { content: `Unknown tool: ${inv.name}`, isError: true };
    }

    // ALLOW-LISTED, not deny-listed. `PdpDecision` still admits
    // `{action: "confirm"}` — `resolveDecision` resolves every confirm itself
    // today, but it is no longer the only producer of a decision, and the
    // natural `auto` implementation (a classifier that answers "ask") would
    // return exactly that. Testing for `deny` would have dispatched it
    // unmediated; testing for `allow` cannot.
    const decision = await resolveDecision(inv);
    if (decision.action !== "allow") {
      log.warn("tool-broker.dispatch.denied", {
        sessionId,
        tool: inv.name,
        toolCallId: inv.toolCallId,
        action: decision.action,
        reason: decision.reason,
      });
      return { content: decision.reason, isError: true };
    }

    if (target.kind === "background") return dispatchBackground(inv, target.runner);
    return dispatchForeground(inv, target.serverName);
  }

  function setBackgroundCompletionSink(sink: BackgroundCompletionSink): void {
    completionSink = sink;
  }

  /** Both halves of "what does the model see?", resolved together. The MCP
   *  list is memoized (one round trip per broker); the permission table is
   *  re-read on EVERY call, which is what makes a settings save land on the
   *  next turn. In parallel — neither depends on the other, and the turn waits
   *  on both. */
  async function ready(): Promise<void> {
    await Promise.all([ensureMcpWarm(), refreshPermissions()]);
  }

  return {
    ownerUserId,
    ready,
    definitions,
    dispatch,
    get foregroundInFlight() {
      return foregroundInFlight;
    },
    background,
    setBackgroundCompletionSink,
  };
}
