// ToolBroker (Plan 2 Task 4, spec §5.3) — the single L3 permission-decision
// choke point every tool call passes through, foreground or background,
// before any side effect runs. Prior-art lesson (carried in the plan's
// Global Constraints): two dispatch paths means one silently skips the
// gate. `resolveDecision` below is called from exactly ONE place inside
// `dispatch` — both branches (foreground MCP call, background runner) flow
// through it first, so a `deny` or an unconfirmed `confirm` structurally
// cannot reach `mcp.callTool` or a `BackgroundToolRunner.run`.
//
// TWO GATES, TWO QUESTIONS, applied at BOTH choke points (`definitions()` and
// `resolveDecision()`):
//
//   the ROLE gate    `canExecute(capability.role, tier)` — what this person's
//                    role may EVER reach. The role is baked into the capability
//                    at mint (`AccessManager.grant`, spec §2.1/L1) and held by
//                    value; it is never re-derived here and never cached from
//                    a lookup.
//   the PERMISSION   what this person CHOSE for that tool:
//                      stored[server]?[tool]
//                        ?? defaultPermissionsFor(role, catalog)[server]?[tool]
//                        ?? "off"
//
// Both gates can produce absence from `tools[]`, for the same reason — the
// model must not see, or spend context on, a tool it can never use — but they
// are different questions and the logs say which one fired.
//
// NO FALLTHROUGH, and no operator policy engine behind either gate. There used
// to be one (`security/policy-engine.ts` over `gateway/mcp-policy.yaml`): a
// second, name-keyed spelling of "which tools are safe" that had to agree with
// `config.yaml#mcp_catalog`'s tiers and eventually would not. The tier IS the
// operator's dial now, and the role template built from it (role-defaults.ts)
// is the resolution floor, so every tool has exactly one answer and it comes
// from one file.
//
// Fail-closed at both layers: a tool in neither table resolves `off`, never
// `allow`, and this broker is what makes `ask` mean something — it calls the
// injected `requestConfirm`, which the composition root binds to the SESSION's
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
// A constraint that is conditioned on the SESSION rather than on the person or
// their role belongs to the tool that owns it, not here: no permission table
// can express "only during a voice session". The one such rule the retired
// policy file carried (`no_identify_user_outside_voice`) now lives in
// `mcp-host/tools/identify-user.ts`, which is the only place that knows both
// the channel and what the tool means without one.

import type { McpCatalog, OrchestratorConfig } from "@sentient/config";
import type { ToolPermission, ToolPermissionMap } from "@sentient/config";
import { type ImpactTier, canExecute } from "@sentient/protocol";
import type { Capability } from "../access/capability.js";
import { getLog } from "../logging/logger.js";
import { createPassthroughInboundGate } from "../security/inbound-gate.js";
import type { InboundGate } from "../security/inbound-gate.js";
import type { ScanProvenance } from "../security/injection-scanner.js";
import type { SessionStore } from "../store/session-store.js";
import type { UserId } from "../user-auth/user-id.js";
import { createBackgroundRegistry } from "./background-registry.js";
import type { BackgroundRegistry } from "./background-registry.js";
import type { McpClient } from "./mcp-client.js";
import { type ResolvedPermission, resolveToolPermission } from "./resolve-tool-permission.js";
import { defaultPermissionsFor } from "./role-defaults.js";
import { capToolResult } from "./tool-result-cap.js";
import { ConfirmUnavailableError } from "./tool-types.js";
import type { DelegationProgress, PdpDecision, ToolDefinition, ToolInvocation, ToolResult } from "./tool-types.js";

const log = getLog(["sentient", "tools", "tool-broker"]);

// EVERY log property in this file is a scalar or a pre-joined string, never an
// array of objects. `logging/format.ts`'s `formatValue` stringifies any
// non-string with `String(value)`, so `[{tool, permission}]` renders as the
// literal `[object Object]` — the payload silently disappears at exactly the
// moment somebody is reading the log to find out why a tool vanished. An array
// of STRINGS survives (`String(["a","b"])` is `"a,b"`), but a joined string
// says so explicitly and pairs with a `…Count` field that survives the
// formatter's 200-char truncation.

const TOO_MANY_BACKGROUND_TASKS = "too many running tasks";

/** Client-facing failure-note budget on a `delegation.progress` error frame.
 *  A tile shows a hint, never the delegated worker's full output. */
const NOTE_PREVIEW_LEN = 120;

/** The gateway-native skill tool whose RESULT is a skill body — screened under
 *  the `skill_body` channel (its own operator toggle) rather than the generic
 *  `tool_result` channel, and sourced by the skill it ran rather than the tool
 *  name. Every other tool's result is generic `tool_result` content. */
const SKILL_USE_TOOL_NAME = "skill_use";

/** The gateway-native memory tools whose RESULT is untrusted stored text —
 *  `memory_recall` hit snippets and `memory_read` session excerpts carry
 *  historical, possibly tool-derived content, so they screen on the read-time
 *  `memory_body` channel (spec §7). `memory_write`/`memory_list` produce only
 *  the gateway's own confirmation copy and stay on the generic `tool_result`
 *  channel. */
const MEMORY_BODY_TOOL_NAMES: ReadonlySet<string> = new Set(["memory_recall", "memory_read"]);

/** Impact tiers that DO something — the only tiers an elevated risk level
 *  escalates. `read` is excluded on purpose (see `resolveDecision`). */
const SIDE_EFFECTING_TIERS: ReadonlySet<ImpactTier> = new Set<ImpactTier>(["write", "confirm", "admin"]);

/** Decision-log `source` for a permission the risk accumulator raised from
 *  `allow` to `ask`. Distinct from `resolve-tool-permission.ts`'s
 *  `PermissionSource` literals so the log says the escalation fired, not that a
 *  table answered `ask`. */
const RISK_ESCALATION_SOURCE = "risk-escalation";

/** What the person is told when recent risk — not their own setting — is why a
 *  side-effecting call now needs confirmation. Names the risk, not a policy
 *  rule, for the same reason the other confirm copy names the person. */
function riskEscalationReason(toolName: string): string {
  return `Recent activity in this session looks risky, so this ${toolName} call needs your confirmation.`;
}

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
 *  prompt exists — either an explicit `Ask` in their settings or the role
 *  template's answer for the tool's tier, which they can change to anything
 *  else in the same pane. */
function settingsAskReason(toolName: string): string {
  return `Your settings ask for confirmation before every ${toolName} call.`;
}

/** What the model is told when the ROLE gate refused — a different fact from
 *  every reason above, all of which report a SETTING. Normally unreachable from
 *  the model (`definitions()` never advertised the tool), so reaching it means
 *  either a hallucinated-but-real tool name or a proxied call that never read
 *  this session's `tools[]`.
 *
 *  Deliberately says "this account", not "your role is child": naming the role
 *  taxonomy invites the model to argue with it or to relay it to a person who
 *  cannot change it, and the model's useful move is the same either way. */
function roleDeniedReason(toolName: string): string {
  return `The ${toolName} tool is not available to this account. Do not retry it; say what you could not do and offer an alternative if one exists.`;
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

/** A gateway-native FOREGROUND tool (skill tools, Plan §4) — the gateway runs
 *  it in-process and AWAITS the result, exactly like an MCP call, so its
 *  outcome feeds straight back into the same ReAct turn. It belongs to no MCP
 *  server, but — unlike `delegateTask` — it resolves its stored permission
 *  under the reserved `"native"` namespace (`serverOf` answers
 *  `NATIVE_TOOL_SERVER_KEY` for it), so `stored["native"][tool]` genuinely
 *  overrides the tier default and a parent's `off` bites (spec §4.1). The
 *  definition carries the tier the role gate judges. */
export interface NativeToolRunner {
  definition: ToolDefinition;
  /** Cheap, side-effect-free argument validation, run BEFORE the PDP: a
   *  non-null return is answered to the model as a tool error with NO
   *  `resolveDecision` and NO permission prompt. Invalid input is a model
   *  error, not an authorization question, and prompting to confirm a write
   *  that would be rejected anyway trains the user to click through. */
  validate?(args: Record<string, unknown>): ToolResult | null;
  run(args: Record<string, unknown>, ctx: { signal: AbortSignal }): Promise<ToolResult>;
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
   *  construction; there is no ambient principal dep to fall back to (spec
   *  §3.2). Exposed so a caller can confirm which identity a broker instance
   *  was actually built for, the same confused-deputy check `openSessionStore`
   *  makes for the store. */
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
   *  tools) MINUS everything the owner's ROLE cannot execute and everything
   *  they have switched `off`. Stable within a turn — the MCP list is cached
   *  and the permission snapshot is refreshed once, by `ready()`, at the turn
   *  boundary — so it is never re-derived mid-turn (spec §4.6: hiding a tool is
   *  not a security boundary, L3 at the call is; both gates are re-asked by
   *  `resolveDecision` for a tool that reaches it by any other route).
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
  store: SessionStore;
  /** THE authorization input (spec §3.2). `broker.ownerUserId`, the role gate
   *  and the permission floor all read straight off this value — never an
   *  ambient principal — so the broker's authority is exactly what this
   *  capability grants, nothing threaded in alongside it. `AccessManager.grant`
   *  is the only place a principal becomes this value (task 2026-08-07 #2);
   *  mint from the same `AccessManager` that mints the session's own store
   *  capability. */
  capability: Capability;
  /** `config.yaml#mcp_catalog` — the operator's tool universe and, through each
   *  entry's `tier`, the operator's dial for who may reach what. Read here for
   *  ONE purpose: to build this owner's role template (`role-defaults.ts`),
   *  which is the floor underneath their stored permission table. The same
   *  accessor every account-creation path seeds from, so the floor and the seed
   *  can never disagree about the same account.
   *
   *  Held by value and resolved ONCE at construction: the catalog is startup
   *  config and the role is baked into the capability at mint, so neither can
   *  change under a live broker. A role change rebuilds the capability, which
   *  rebuilds the broker — see mcp-host/delegated-broker.ts's cache note. */
  catalog: McpCatalog;
  /** The CONNECTION id (`ws.data.sessionId`), for log correlation and nothing
   *  else — every `tool-broker.*` line below carries it so a dispatch is
   *  traceable to the one socket that made it. It is NOT the durable
   *  conversation the session store partitions on: two connections to the
   *  same conversation (before and after a reload) must stay distinguishable
   *  here. See `SessionRuntimeRequest` in runtime/session-handles.ts. */
  sessionId: string;
  /** name → runner. `delegateTask` (Task 5) registers itself here. */
  backgroundTools: Map<string, BackgroundToolRunner>;
  /** name → runner for FOREGROUND gateway-native tools (skill tools). Optional
   *  — a broker with none behaves exactly as before. Resolved BEFORE the MCP
   *  index (same as `backgroundTools`) and permission-keyed under the reserved
   *  `"native"` namespace, so a stored `native[tool]` override is honoured. */
  nativeTools?: Map<string, NativeToolRunner>;
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
   * `undefined` means NEVER SET — every tool falls to the role template. An
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
  /** The inbound scanning boundary (security/inbound-gate.ts). OPTIONAL and
   *  defaulting to a disabled passthrough: the REAL gate — scanner + this
   *  session's risk accumulator — is composed by the composition root in a
   *  later task, so a broker built without it behaves exactly as before. It
   *  does two things here: every foreground result is screened through it
   *  before the result cap, and its `getRiskLevel()` feeds the PDP escalation
   *  in `resolveDecision`. */
  inboundGate?: InboundGate;
}

/** What `resolveTarget` found: the lane the call runs on, what it needs to run
 *  there, and the tool's IMPACT TIER — carried alongside so the role gate and
 *  the execution path can never be judging two different tools. */
type ResolvedTarget =
  | { kind: "background"; runner: BackgroundToolRunner; definition: ToolDefinition }
  | { kind: "native"; runner: NativeToolRunner; definition: ToolDefinition }
  | { kind: "foreground"; serverName: string; definition: ToolDefinition };

export function createToolBroker(deps: ToolBrokerDeps): ToolBroker {
  const {
    mcp,
    capability,
    catalog,
    sessionId,
    backgroundTools,
    config,
    requestConfirm,
    toolPermissions,
    onDelegationProgress,
  } = deps;
  // Optional dep: a broker with no native tools behaves exactly as before.
  const nativeTools: Map<string, NativeToolRunner> = deps.nativeTools ?? new Map();
  // Optional dep: a broker with no gate scans nothing and carries no risk, so a
  // caller that never wires one gets the pre-boundary behaviour verbatim.
  const inboundGate: InboundGate = deps.inboundGate ?? createPassthroughInboundGate();
  const ownerUserId = capability.ownerUserId;
  const role = capability.role;
  // THE FLOOR, resolved once. Both inputs are immutable for this broker's life
  // (see `ToolBrokerDeps.catalog`), so recomputing per call would buy nothing
  // and re-walking the catalog per tool call would cost on the hot path.
  const roleTemplate = defaultPermissionsFor(role, catalog);
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
  let mcpDefsByName = new Map<string, ToolDefinition>();
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
            // Straight off the catalog entry that curated this tool — see
            // `filterByAllowlist`. Nothing here decides a tier.
            tier: ref.tier,
            ...(ref.productGroup ? { productGroup: ref.productGroup } : {}),
            ...(ref.defaultExposure ? { defaultExposure: ref.defaultExposure } : {}),
          }));
          mcpDefsByName = new Map(mcpDefs.map((def) => [def.name, def]));
          log.info("tool-broker.mcp-warmup.ok", { sessionId, toolCount: refs.length });
        })
        .catch((err) => {
          mcpIndex = new Map();
          mcpDefs = [];
          mcpDefsByName = new Map();
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
  // first read — and `undefined` is NOT `{}`; see `storedPermissionFor`.
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

  /**
   * THE RESOLUTION, total by construction — every tool has exactly one answer,
   * `undefined` is not one of them, and the answer says WHICH table produced it.
   *
   * ONE FUNCTION FOR BOTH CHOKE POINTS. `definitions()` and `resolveDecision()`
   * both call this, so the permission a tool is advertised under and the one it
   * is dispatched under cannot drift, and the two log lines cannot disagree
   * about where the value came from.
   *
   * DELEGATES TO `resolve-tool-permission.ts` (Task 5) rather than resolving
   * inline — the mcp-catalog API projection needs the EXACT same rule to build
   * the settings screen's read model, and a second inline copy here is exactly
   * the drift class this codebase keeps paying for (`mcp-policy.yaml`, twice).
   * This wrapper supplies the three inputs only a live broker holds — the
   * `serverOf` lookup (backed by a live `mcpIndex`), the per-turn `permissions`
   * snapshot, and this broker's own `roleTemplate` — and the shared function
   * carries the actual precedence rule (profile → role template → fail-closed
   * backstop) plus the gateway-native serverless case (`delegateTask`).
   */
  function resolvePermission(definition: ToolDefinition): ResolvedPermission {
    if (definition.productGroup !== undefined) {
      return resolveToolPermission({
        toolName: definition.name,
        tier: definition.tier,
        productGroup: definition.productGroup,
        defaultExposure: definition.defaultExposure ?? "standard",
        storedPermissions: permissions,
        roleTemplate,
      });
    }
    // Migration compatibility for old third-party/test definitions. Production
    // providers always carry product metadata; this path preserves the retired
    // native/server semantics only while stale definitions are draining.
    const serverName = backgroundTools.has(definition.name)
      ? null
      : nativeTools.has(definition.name)
        ? "native"
        : (mcpIndex?.get(definition.name) ?? null);
    return resolveToolPermission({
      toolName: definition.name,
      tier: definition.tier,
      serverName,
      storedPermissions: permissions,
      roleTemplate,
    });
  }

  /**
   * The ONE place a dispatch decision is made. Both branches (foreground,
   * background) flow through this before any side effect — that is what makes
   * the choke point structural rather than a convention two branches could
   * independently drift from.
   *
   * ORDER, written as control flow rather than as a comment somebody could
   * drift from. The ROLE gate runs FIRST and UNCONDITIONALLY, and it returns
   * before the person's own table is read at all: a permission a person set for
   * themselves must never be able to widen what their role may reach. It is
   * asked again here even though `definitions()` already asked it, because a
   * model can emit a tool name it was never advertised, and a proxied delegated
   * call never read this session's `tools[]` at all. A model-emitted tool call
   * is never itself an authorization decision.
   */
  async function resolveDecision(inv: ToolInvocation, definition: ToolDefinition): Promise<PdpDecision> {
    const { tier } = definition;
    // Per call, never captured: a settings save reaches the very next dispatch
    // rather than waiting for a new broker.
    await refreshPermissions();

    if (!canExecute(role, tier)) {
      log.warn("tool-broker.role-gate.denied", {
        sessionId,
        tool: inv.name,
        toolCallId: inv.toolCallId,
        role,
        tier,
        reason: "this role cannot execute the tool's impact tier — it was never advertised to the model either",
      });
      return { action: "deny", reason: roleDeniedReason(inv.name) };
    }

    const resolved = resolvePermission(definition);
    let permission: ToolPermission = resolved.permission;
    let source: string = resolved.source;

    // RISK ESCALATION (spec §6.2). A STORED `allow` on a side-effecting tool is
    // exactly the case a template-only rule would miss, so the escalation lives
    // at the resolved permission, not in the template: when the inbound gate's
    // accumulated risk is `escalate`/`block`, a `write`/`confirm`/`admin` call
    // that would otherwise run unmediated is turned into a confirm.
    //
    // `read` stays frictionless BY DESIGN — do not extend this to it. A flagged
    // page tends to be read many times in a row, so escalating reads turns one
    // finding into a prompt storm that trains the person to click through; and
    // the read tier's real blast radius (the camera/playback residual) is owned
    // elsewhere, not by this confirm.
    const riskEscalates = permission === "allow" && SIDE_EFFECTING_TIERS.has(tier) && isRiskElevated();
    if (riskEscalates) {
      permission = "ask";
      source = RISK_ESCALATION_SOURCE;
    }

    log.info("tool-broker.pdp.decision", {
      sessionId,
      tool: inv.name,
      toolCallId: inv.toolCallId,
      role,
      tier,
      permission,
      // WHICH table answered — or `risk-escalation` when accumulated risk, not a
      // table, raised an `allow` to `ask`. The difference matters when a person
      // swears they set something: `role-template` means their profile is silent
      // on it, and `catalog-backstop` means nothing answered at all.
      source,
    });

    // The escalation-driven confirm names the risk, not the person's settings —
    // routed here rather than through `applyUserPermission`'s `ask` arm so the
    // prompt copy is honest about why it appeared.
    if (riskEscalates) return runConfirmFlow(inv, riskEscalationReason(inv.name));
    return applyUserPermission(inv, permission);
  }

  /** True when the inbound gate's accumulated risk warrants an extra confirm on
   *  a side-effecting tool. `warn` is intentionally NOT elevated — only
   *  `escalate` and `block` gate a call the person otherwise allowed.
   *
   *  DESIGN INTENT (spec §6.2): `block` and `escalate` are treated IDENTICALLY
   *  here — both raise an otherwise-`allow` side-effecting call to a `confirm`.
   *  `block` is NOT a hard-deny at this layer: the risk accumulator's findings
   *  ANNOTATE and RAISE risk, they never unilaterally refuse. A human confirm is
   *  the strongest verdict risk alone can produce; a real deny only comes from
   *  the role gate or an explicit `deny` permission. Keeping `block` at confirm
   *  avoids a poisoned session silently bricking a tool the person legitimately
   *  wants — the human is always the one who says no. */
  function isRiskElevated(): boolean {
    const level = inboundGate.getRiskLevel();
    return level === "escalate" || level === "block";
  }

  /**
   * The resolved permission, turned into a PDP verdict.
   *
   * EXHAUSTIVE — no `default:` arm. Every member returns, so a fifth member
   * (`auto`) leaves a code path falling off the end of a function declared to
   * return `Promise<PdpDecision>`, which is a compile error rather than a
   * silent fall-through.
   */
  async function applyUserPermission(inv: ToolInvocation, permission: ToolPermission): Promise<PdpDecision> {
    switch (permission) {
      case "allow":
        // No prompt. That is the whole difference from `ask`.
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

  /** The human-in-the-loop half of the PDP, reached whenever the resolution
   *  lands on `ask` — from the person's own stored setting or from the role
   *  template's answer for the tool's tier. One implementation, so the
   *  fail-closed handling below cannot diverge between them. */
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

  /** EXISTENCE — and the tool's TIER, resolved before the PDP ever runs.
   *  Returns null for a tool name that is in neither the MCP catalog nor the
   *  background registry.
   *
   *  The tier travels WITH the resolved target rather than being looked up
   *  again inside the PDP, so the tier the role gate judges is provably the
   *  tier of the tool that would actually run. Two lookups keyed on the same
   *  name are two chances to disagree.
   *
   *  Order is the whole point. Observed live 3× in one day: the model called
   *  `ha_search`, the catalog has `ha_search_entities`, the PDP prompted the
   *  owner to authorize it, they approved — and only then did dispatch log
   *  `unknown-tool`. A permission prompt asserts that the thing being
   *  authorized is real; raising one for a hallucination spends the human's
   *  attention on nothing and teaches them to click through the prompts that
   *  DO guard something. A name that does not exist is a model error the loop
   *  absorbs, not a decision anyone should be asked to make. */
  async function resolveTarget(inv: ToolInvocation): Promise<ResolvedTarget | null> {
    const runner = backgroundTools.get(inv.name);
    if (runner) return { kind: "background", runner, definition: runner.definition };
    // Native foreground tools resolve BEFORE the MCP index, same choke as the
    // background registry — their tier travels with the target so the role gate
    // and the run path judge the same tool.
    const nativeRunner = nativeTools.get(inv.name);
    if (nativeRunner) return { kind: "native", runner: nativeRunner, definition: nativeRunner.definition };
    await ensureMcpWarm();
    const serverName = mcpIndex?.get(inv.name);
    if (!serverName) return null;
    const def = mcpDefsByName.get(inv.name);
    // Unreachable in practice — `serverOf` and `mcpDefsByName` are filled from
    // the same `listTools()` response — but the answer to "a tool with no tier"
    // must be a refusal, never an invented tier. `undefined` is not a tier
    // (@sentient/config's `tierOf` says the same thing at the catalog layer).
    if (!def) {
      log.warn("tool-broker.dispatch.untiered-tool", {
        sessionId,
        tool: inv.name,
        toolCallId: inv.toolCallId,
        serverName,
        reason: "the tool listed a server but carries no definition, so no impact tier — refusing rather than guessing",
      });
      return null;
    }
    return { kind: "foreground", serverName, definition: def };
  }

  /** How a foreground result is labelled to the inbound scanner. A `skill_use`
   *  result IS a skill body — governed by the `skill_body` channel toggle and
   *  sourced by the skill it ran (`args.name`) — so a parent who silenced that
   *  channel silences skill bodies specifically. Every other tool's output is
   *  generic `tool_result` content, sourced by the tool name. Write-time skill
   *  authoring args are NOT screened here: the invisible-char lint and the
   *  confirm dialog already gate authoring, and this use-time screen catches
   *  what a body actually does. */
  function provenanceFor(inv: ToolInvocation): ScanProvenance {
    if (inv.name === SKILL_USE_TOOL_NAME) {
      const skillName = typeof inv.args.name === "string" && inv.args.name.length > 0 ? inv.args.name : inv.name;
      return { channel: "skill_body", source: skillName };
    }
    if (MEMORY_BODY_TOOL_NAMES.has(inv.name)) {
      return { channel: "memory_body", source: inv.name };
    }
    return { channel: "tool_result", source: inv.name };
  }

  /** Runs a foreground result through the inbound gate BEFORE the size cap, so
   *  the model sees the envelope-stripped text and the cap bounds what actually
   *  survives. Annotate-only: the gate never drops a result, it only records
   *  risk and returns sanitized text (identical to the input unless a hostile
   *  envelope was stripped). */
  function screenResult(inv: ToolInvocation, result: ToolResult): ToolResult {
    const screened = inboundGate.screen(result.content, provenanceFor(inv), {
      sessionId,
      toolCallId: inv.toolCallId,
    });
    return screened.text === result.content ? result : { ...result, content: screened.text };
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
      const screened = screenResult(inv, raw);
      const result = capResult(inv, screened, "tool-broker.dispatch.foreground.result-capped");
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

  /** Runs a gateway-native FOREGROUND tool in-process and AWAITS it, exactly
   *  like `dispatchForeground` awaits an MCP call: same in-flight counter (so a
   *  session whose last window closed mid-native-call stays resident) and the
   *  same result cap. The runner receives the args and the turn's `AbortSignal`
   *  directly — it owns no server, no port, no wire. */
  async function dispatchNative(inv: ToolInvocation, runner: NativeToolRunner): Promise<ToolResult> {
    foregroundInFlight += 1;
    try {
      const raw = await runner.run(inv.args, { signal: inv.signal });
      const screened = screenResult(inv, raw);
      const result = capResult(inv, screened, "tool-broker.dispatch.native.result-capped");
      log.info("tool-broker.dispatch.native.done", {
        sessionId,
        tool: inv.name,
        toolCallId: inv.toolCallId,
        isError: result.isError,
        contentLength: result.content.length,
      });
      return result;
    } finally {
      // `finally`, not a decrement after the await: a throwing or aborted
      // native call that left the counter high would pin its session resident.
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

  /** THE SOLE PRODUCER of the model's `tools[]`, and the only place either gate
   *  is allowed to change the array. Everything else about a permission is a
   *  dispatch-time decision, on purpose: `tools[]` is serialized AHEAD of
   *  `messages[]`, so it is part of the provider's cached prefix, and any
   *  per-permission variation in it would silently re-prime the whole system
   *  prompt and history on every settings tweak. `allow`, `ask` and `deny`
   *  therefore leave this array byte-identical — see `isVisibleToModel`.
   *
   *  BOTH GATES DROP, AND FOR THE SAME REASON: the model must not see, or spend
   *  context on, a tool it can never use. They are logged apart because they
   *  answer different questions — "this role may never reach it" is not "this
   *  person switched it off", and only one of them is something the person can
   *  change in Settings. */
  function definitions(): ToolDefinition[] {
    void ensureMcpWarm(); // idempotent kick-off; definitions() itself stays synchronous
    const backgroundDefs = [...backgroundTools.values()].map((runner) => runner.definition);
    const nativeDefs = [...nativeTools.values()].map((runner) => runner.definition);
    const visible: ToolDefinition[] = [];
    const roleWithheld: string[] = [];
    const permissionWithheld: string[] = [];

    for (const def of [...mcpDefs, ...backgroundDefs, ...nativeDefs]) {
      if (!canExecute(role, def.tier)) {
        roleWithheld.push(`${def.name}:${def.tier}`);
        continue;
      }
      const { permission, source } = resolvePermission(def);
      if (!isVisibleToModel(permission)) {
        permissionWithheld.push(`${def.name}:${permission}/${source}`);
        continue;
      }
      visible.push(def);
    }

    if (roleWithheld.length > 0) {
      log.info("tool-broker.definitions.role-withheld", {
        sessionId,
        role,
        toolCount: visible.length,
        withheldCount: roleWithheld.length,
        withheld: roleWithheld.join(" "),
        reason: "this role cannot execute these tools' impact tiers, so the model is never told they exist",
      });
    }
    if (permissionWithheld.length > 0) {
      // Each entry carries its own `source`, because they are not all the same
      // fact: `profile` IS a setting the person made, but `catalog-backstop` is
      // a tool no table answered for — fail-closed, and a sign the live tool
      // surface has drifted from `config.yaml#mcp_catalog`. Reporting the whole
      // set as "switched off in this user's settings" would send somebody
      // hunting through Settings for a toggle that does not exist.
      log.info("tool-broker.definitions.permission-withheld", {
        sessionId,
        toolCount: visible.length,
        withheldCount: permissionWithheld.length,
        withheld: permissionWithheld.join(" "),
        reason: "resolved to a permission that is not advertised to the model — see each entry's source",
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
        reason: "name is in neither the MCP catalog nor the background/native registry — answered before the PDP",
      });
      return { content: `Unknown tool: ${inv.name}`, isError: true };
    }

    // Native argument pre-validation, BEFORE the PDP: an invalid call is a
    // model error the loop absorbs, never an authorization question. Answering
    // it here means no `resolveDecision` runs and no permission prompt is
    // raised — a confirm dialog for a write that would be rejected anyway just
    // teaches the person to click through. Existence is already resolved above,
    // so this cannot fire for a hallucinated name.
    if (target.kind === "native" && target.runner.validate) {
      const invalid = target.runner.validate(inv.args);
      if (invalid) {
        log.warn("tool-broker.dispatch.native.invalid-args", {
          sessionId,
          tool: inv.name,
          toolCallId: inv.toolCallId,
          reason: "native tool rejected its arguments before the PDP — answered as a tool error, no permission prompt",
        });
        return capResult(inv, invalid, "tool-broker.dispatch.native.invalid-args.result-capped");
      }
    }

    // ALLOW-LISTED, not deny-listed. `PdpDecision` still admits
    // `{action: "confirm"}` — `resolveDecision` resolves every confirm itself
    // today, but it is no longer the only producer of a decision, and the
    // natural `auto` implementation (a classifier that answers "ask") would
    // return exactly that. Testing for `deny` would have dispatched it
    // unmediated; testing for `allow` cannot.
    const decision = await resolveDecision(inv, target.definition);
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
    if (target.kind === "native") return dispatchNative(inv, target.runner);
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
