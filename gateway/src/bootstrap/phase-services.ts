import { join } from "node:path";
import { catalogTools, riskConfigSchema } from "@sentient/config";
import type { InboundScanConfig, McpCatalog, OrchestratorConfig } from "@sentient/config";
import { ensureTlsMaterial } from "@sentient/tls";
import { type AccessManager, createAccessManager } from "../access/access-manager.js";
import { createFileScope } from "../access/file-scope.js";
import { archiveUserDir } from "../admin/archive-user-dir.js";
import { renderConfigsForExistingUsers } from "../admin/boot-migration.js";
import { createHermesProfileProvisioner } from "../admin/hermes-profile-provisioner.js";
import type { SecretsStore } from "../admin/secrets-store.js";
import { createUserLifecycle } from "../admin/user-lifecycle.js";
import type { UserLifecycle } from "../admin/user-lifecycle.js";
import {
  type UserProvisioner,
  createUserProvisioner,
  makeUserId,
  randomAvatarTint,
} from "../admin/user-provisioner.js";
import { migrateWebToolsEnabled } from "../admin/web-tools-migrator.js";
import { createApplyDeps } from "../apply/apply-deps.js";
import type { ApplyDeps } from "../apply/orchestrator.js";
import { renderAndWrite } from "../apply/orchestrator.js";
import { resolveAssetRoot } from "../config/asset-root.ts";
import type { StartupConfig } from "../config/startup-config.ts";
import { resolveTimeZone } from "../context/message-time.js";
import { createSessionBlockRenderer } from "../context/session-block.js";
import { createSituationBlockRenderer } from "../context/situation-block.js";
import {
  DEFAULT_WEB_SUMMARY_PROMPT,
  loadDreamerTemplate,
  loadMemoryPreamble,
  loadSkillIndexPreamble,
  loadSystemPrompt,
} from "../context/system-prompt-loader.ts";
import { type ExternalToolSlot, createExternalToolSlot } from "../external-tools/external-tool-slot.js";
import { type UserPrincipal, createUserPrincipal } from "../identity/user-principal.js";
import { getLog } from "../logging/logger.ts";
import {
  type DeepMemoryApp,
  type ScopeWiring,
  type SessionSpark,
  createDeepMemoryApp,
  createSessionSpark,
  withIndexSync,
} from "../memory/deep-memory-wiring.js";
import { createDreamTransaction } from "../memory/dreamer/dream-transaction.js";
import type { DreamScopeHandle } from "../memory/dreamer/dream-transaction.js";
import { createDreamRunner, readMark } from "../memory/dreamer/dreamer-runner.js";
import { type DreamClock, type DreamScheduler, createDreamScheduler } from "../memory/dreamer/scheduler.js";
import { composeMemoryBlock } from "../memory/memory-prompt.js";
import { createMemoryRetriever } from "../memory/memory-retriever.js";
import { type MemoryStore, openMemoryStore } from "../memory/memory-store.js";
import type { CalendarConfig, CalendarStore } from "../calendar/types.js";
import { openCalendarPersistence, openCalendarStore } from "../calendar/calendar-store.js";
import { capCalendarNudge, composeCalendarNudge } from "../calendar/nudge.js";
import { createPersonalityStore } from "../profile-store/personality-store.js";
import type { PersonalityStore } from "../profile-store/personality-store.js";
import { type ProfileStore, createProfileStore, memoryTogglesFor } from "../profile-store/profile-store.ts";
import { type TemplateLoader, createTemplateLoader } from "../profile-store/template-loader.ts";
import type { CreateSessionRuntime } from "../runtime/session-handles.js";
import { createConfirmHook, createSessionPermissionBroker } from "../runtime/session-permission-broker.js";
import type { SessionWorkSignals } from "../runtime/session-retention.js";
import { type SessionRuntime, createSessionRuntime as buildSessionRuntime } from "../runtime/session-runtime.js";
import { createTurnStateTracker } from "../runtime/turn-state-snapshot.js";
import { createInboundGate } from "../security/inbound-gate.js";
import type { InboundGate } from "../security/inbound-gate.js";
import { scanContent } from "../security/injection-scanner.js";
import { createRiskAccumulator } from "../security/risk-accumulator.js";
import type { SessionRegistry } from "../session-handlers/session-registry.js";
import type { GatewayTlsMaterial } from "../session-handlers/ws-handlers.ts";
import { renderSkillIndex } from "../skills/skill-index.js";
import { createSkillStore } from "../skills/skill-store.js";
import type { SkillMeta } from "../skills/skill-store.js";
import type { SessionEntry } from "../store/entry-types.js";
import { type SessionStore, openSessionStore } from "../store/session-store.js";
import { composeBackgroundCompletionNote } from "../tools/background-completion-note.js";
import { createDelegateTaskRunner, delegateTaskDefinition } from "../tools/delegate-task.js";
import { createDelegationGuard, loadDelegationFrontmatterDir } from "../tools/delegation-guard.js";
import type { DelegationGuard } from "../tools/delegation-guard.js";
import { createHermesRunner } from "../tools/hermes-runner.js";
import type { HermesRunner } from "../tools/hermes-runner.js";
import { createHomeAdapter } from "../tools/home/home-adapter.js";
import type { HomeAdapter } from "../tools/home/home-adapter.js";
import { createMcpClient } from "../tools/mcp-client.js";
import type { McpClient } from "../tools/mcp-client.js";
import { MEMORY_TOOL_NAMES, buildMemoryTools } from "../tools/memory-tools.js";
import type { DeepMemoryDeps } from "../tools/memory-tools.js";
import { NativeMusicAdapter, UnavailableMusicAdapter } from "../tools/music/music-adapter.js";
import type { MusicAdapter } from "../tools/music/music-adapter.js";
import { createPromptClassifier } from "../tools/prompt-classifier.js";
import { SKILL_TOOL_NAMES, createSkillTools } from "../tools/skill-tools.js";
import { createToolBroker } from "../tools/tool-broker.js";
import type { BackgroundToolRunner, NativeToolRunner } from "../tools/tool-broker.js";
import { createToolPermissionsReader } from "../tools/user-tool-permissions.js";
import type { TextStreamSynthesizer } from "../tts/text-stream-synthesizer.ts";
import type { AuthService } from "../user-auth/auth-service.js";
import { getHermesProfileDir } from "../user-auth/paths.js";
import { hashPin } from "../user-auth/pin-service.js";
import { createTextStreamSynthesizer } from "./content-tts-factory.ts";
import { composeProductToolProviders } from "./product-tool-providers.ts";
import { resolveProviderConnection } from "./resolve-provider-connection.ts";
import type { SttService } from "./stt-factory.ts";
import { createSttService } from "./stt-factory.ts";
import type { TTSSessionOpener, TtsService } from "./tts-factory.ts";
import { asStrictFactory, createTtsService } from "./tts-factory.ts";
import { type UserModelProvider, createUserModelProvider } from "./user-model-provider.ts";

const log = getLog(["sentient", "bootstrap", "phase-services"]);

// The harness's own system prompt: `system_prompts/system_prompt.md` for role,
// scope and rules, plus `persona.md` (operator override; baked-in
// `templates/persona/default.md` as the fallback) for character and tone.
//
// This used to be a one-line string literal here, and the .md files — which
// describe a `speak` tool, a `configure` tool and a `[trigger/<source>]`
// format, none of which have existed since the 2.0 purge — were loaded by
// NOTHING. So a prompt rewrite was invisible and the model ran on eleven
// words. Read once per process, matching `loadSystemPrompt`'s own contract:
// dev restarts on save (`bun --watch`) and prod restarts on deploy, so an
// operator edit still lands without a rebuild.
//
// LAZY, not module-scope: the loader's own "which file did I read" INFO lines
// are emitted during the read, and at module-init time the file sink does not
// exist yet — so a module-scope read logs to nowhere and an operator cannot
// confirm from the log which prompt the gateway is running on. Same shape
// `loadCompactionSummarizerPrompt` already has, and its lines DO reach the log.
let systemPrompt: string | null = null;

function resolveSystemPrompt(): string {
  if (systemPrompt !== null) return systemPrompt;
  systemPrompt = loadSystemPrompt({});
  log.info("system-prompt.resolved", { chars: systemPrompt.length });
  return systemPrompt;
}

/**
 * The per-session system prompt (Skill System spec, Task 10): the process-wide
 * `base` followed by this user's rendered skill index. `renderSkillIndex`
 * returns `""` for a user with no skills, and an empty index appends NOTHING —
 * a zero-skill user's prompt is byte-identical to the base. This is composed
 * ONCE at session-services construction (Invariant A: the prefix is byte-stable
 * within a session, so a skill taught mid-session lands in the NEXT session's
 * build and never mutates a live session's cache-stable prefix).
 */
export function composeSessionSystemPrompt(
  base: string,
  skills: SkillMeta[],
  maxIndexEntries: number,
  preamble: string,
): string {
  const index = renderSkillIndex(skills, maxIndexEntries, preamble);
  return index === "" ? base : `${base}\n\n${index}`;
}

/** Scope-label log-field values for `memory.prompt.rendered` — private-only
 *  before the household scope is wired, both once it is (T24). Log fields, not
 *  tunables, so code constants rather than YAML. */
const MEMORY_PROMPT_SCOPES_PRIVATE = "private";
const MEMORY_PROMPT_SCOPES_BOTH = "private,family";

/**
 * Appends the per-scope file-memory block (Memory System spec §4.5) after the
 * skill index, forming the session-stable prefix's memory tier, and emits
 * `memory.prompt.rendered` (chars + scopes, NEVER content — logging rule) once
 * per session build. Composed ONCE at construction, exactly like the skill
 * index: byte-stable within a session, so a `memory_write` mid-turn lands in
 * the NEXT session's build and never mutates this one's cache-stable prefix. A
 * child principal's block omits `@adults`-tagged content. The household scope
 * (T24) renders its `family` envelope after the private one when present; a
 * child's household envelope is audience-filtered.
 */
function composeMemoryPrompt(
  skillPrompt: string,
  store: MemoryStore,
  household: MemoryStore | null,
  memoryCfg: OrchestratorConfig["memory"],
  principal: UserPrincipal,
  ids: { conversationId: string; connectionId: string },
): string {
  const block = composeMemoryBlock({ private: store, ...(household ? { household } : {}) }, memoryCfg, {
    childPrincipal: principal.role === "child",
    preamble: loadMemoryPreamble({}),
  });
  log.info("memory.prompt.rendered", {
    userId: principal.userId,
    conversationId: ids.conversationId,
    connectionId: ids.connectionId,
    chars: block.length,
    scopes: household ? MEMORY_PROMPT_SCOPES_BOTH : MEMORY_PROMPT_SCOPES_PRIVATE,
  });
  return `${skillPrompt}\n\n${block}`;
}

/** The per-session memory wiring the composition root attaches: the memory
 *  tools (merged into the broker's `native` map) and the prompt-augment seam
 *  (appends the memory block after the skill index). Null when memory is off. */
export interface SessionCalendar {
  readonly tools: NativeToolRunner[];
  readonly privateStore: CalendarStore;
  readonly householdStore: CalendarStore;
  /** Composed once at session construction; calendar writes cannot mutate the
   * cache-stable system prompt of an existing session. */
  readonly nudge: string | null;
  close(): void;
}

export interface SessionMemory {
  readonly tools: NativeToolRunner[];
  /** Appends the memory block after `skillPrompt` and emits
   *  `memory.prompt.rendered` — the once-per-session render point. */
  augmentPrompt(skillPrompt: string): string;
  /** Per-turn spark (spec §6), or null when the deep-memory app is not wired
   *  (file memory only). Handed to the runtime (primed at turn start) and read
   *  by the situation block's memory closure. */
  readonly spark: SessionSpark | null;
}

/** Optional deep-memory wiring for ONE session — supplied by the composition
 *  root only when the deep-memory app is live (`memory.enabled` + both env
 *  tokens present). Absent ⇒ file memory only: no spark, no `memory_recall`, no
 *  index sync. Kept out of the T6 tests that call `buildSessionMemory` with the
 *  first four args alone. */
export interface SessionMemoryWiring {
  app: DeepMemoryApp;
  /** The SESSION'S inbound gate — the retriever screens its spark block through
   *  the SAME instance the broker holds, so a hostile indexed memory raises the
   *  risk the PDP escalates on. */
  gate: InboundGate;
  profileStore: ProfileStore;
}

/** Opaque index scope id for a user's PRIVATE scope (S1/S2). Mirrors the
 *  deep-memory service's own fixture shape (`user:alice`). */
function privateScopeId(userId: string): string {
  return `user:${userId}`;
}

/** Opaque index scope id for a household's SHARED scope (T24). Keyed by
 *  `householdId` so every member of one household resolves the same id (and
 *  thus the same registered index), while another household never can. */
function householdScopeId(householdIdValue: string): string {
  return `household:${householdIdValue}`;
}

/** The gateway-side dir holding a scope's sync cursor + the service's index.db
 *  (spec §2, §5.3) — a SIBLING of `memory/`, both under the memory grant root. */
const DEEP_MEMORY_DIRNAME = "deep-memory";
const DEEP_MEMORY_INDEX_FILE = "index.db";

type ReingestResult = { rescanned: string[]; quarantined: string[] };

/** Runs `reingestEdits()` on a freshly-opened store and WARNs (COUNTS only, no
 *  content — logging rule) if a hostile out-of-band edit quarantined. Returns
 *  the result so the caller can wire the clean rescanned files into the index. */
function reingestWithWarn(
  store: MemoryStore,
  scopeLabel: string,
  principal: UserPrincipal,
  ids: { conversationId: string; connectionId: string },
): ReingestResult {
  const reingest = store.reingestEdits();
  if (reingest.quarantined.length > 0) {
    log.warn("memory.reingest.quarantined", {
      userId: principal.userId,
      conversationId: ids.conversationId,
      connectionId: ids.connectionId,
      scope: scopeLabel,
      quarantined: reingest.quarantined.length,
      rescanned: reingest.rescanned.length,
    });
  }
  return reingest;
}

/**
 * Wires ONE memory scope into deep memory (spec §5.6): registers it idempotently
 * (before its first search — `ensureScope` is memoized per scopeId), wraps the
 * store so a successful write enqueues + flushes into the scope's single-writer
 * outbox, and replays any out-of-band edits `reingestEdits` rescanned clean so a
 * directly-edited file's stale prior index entry is superseded (the T16 fix).
 * `authorUserId` stamps SHARED-scope (household) tool writes for attribution
 * (spec §9); the out-of-band reingest enqueue carries no author (the on-disk
 * edit has no known writer). Quarantined files are never enqueued.
 */
function wireScopeIndex(
  app: DeepMemoryApp,
  input: { scopeId: string; rootPath: string; store: MemoryStore },
  reingest: ReingestResult,
  logCtx: { userId: string; conversationId: string },
  authorUserId?: string,
): { scope: ScopeWiring; scopedStore: MemoryStore } {
  const indexDir = join(input.rootPath, DEEP_MEMORY_DIRNAME);
  const scope = app.ensureScope({
    scopeId: input.scopeId,
    indexDir,
    indexPath: join(indexDir, DEEP_MEMORY_INDEX_FILE),
    store: input.store,
  });
  const scopedStore = withIndexSync(input.store, scope.sync, authorUserId !== undefined ? { authorUserId } : {});
  for (const relPath of reingest.rescanned) scope.sync.enqueueFile(relPath);
  if (reingest.rescanned.length > 0) {
    log.info("memory.reingest.enqueued", {
      userId: logCtx.userId,
      conversationId: logCtx.conversationId,
      scopeId: input.scopeId,
      rescanned: reingest.rescanned.length,
    });
    void scope.sync.flush();
  }
  return { scope, scopedStore };
}

/**
 * Builds ONE session's memory wiring, gated on `orchestrator.memory.enabled`
 * (Memory System spec §11, T6). Off ⇒ `null`: no grants, no store, no
 * edit-reingest, no tools, no prompt block. On ⇒ mints the private AND household
 * grants (spec §3.5/§9: EVERY household member's session gets the shared scope —
 * adults and children alike; children READ the family scope, audience-filtered,
 * while the family WRITE gate stays arg-level in memory-tools), opens both
 * stores, runs `reingestEdits()` on each, and builds the four memory tools bound
 * to both scopes. Exported so the composition seam is unit-testable without
 * standing up the whole orchestrator.
 */
export function buildSessionCalendar(
  orchestratorCfg: OrchestratorConfig,
  accessManager: AccessManager,
  principal: UserPrincipal,
): SessionCalendar | null {
  if (!orchestratorCfg.calendar.enabled) return null;
  const configured = orchestratorCfg.calendar.default_event_tz_id;
  // The schema keeps the shipped 20,000-character relationship safe. This
  // second check covers an operator who lowers the generic broker backstop:
  // the calendar must reject proactively, strictly before that backstop.
  if (orchestratorCfg.calendar.output.max_result_chars >= orchestratorCfg.tools.max_tool_result_chars) {
    throw new Error(
      "orchestrator.calendar.output.max_result_chars must be strictly below orchestrator.tools.max_tool_result_chars",
    );
  }
  // Resolve the household zone once and freeze the complete mapping. Every
  // calendar consumer receives the same limits and concrete timezone; no
  // adapter reads the YAML shape or resolves the sentinel independently.
  const householdZone = resolveTimeZone().zone();
  const calendarCfg: CalendarConfig = Object.freeze({
    query: Object.freeze({
      maxDays: orchestratorCfg.calendar.query.max_days,
      maxOccurrences: orchestratorCfg.calendar.query.max_occurrences,
      pageSize: orchestratorCfg.calendar.query.page_size,
    }),
    input: Object.freeze({
      maxTitleChars: orchestratorCfg.calendar.input.max_title_chars,
      maxDescriptionChars: orchestratorCfg.calendar.input.max_description_chars,
      maxQueryChars: orchestratorCfg.calendar.input.max_query_chars,
      maxGroupChars: orchestratorCfg.calendar.input.max_group_chars,
      maxTagChars: orchestratorCfg.calendar.input.max_tag_chars,
      maxTags: orchestratorCfg.calendar.input.max_tags,
    }),
    output: Object.freeze({ maxResultChars: orchestratorCfg.calendar.output.max_result_chars }),
    recurrence: Object.freeze({
      maxOccurrences: orchestratorCfg.calendar.recurrence.max_occurrences,
      maxDays: orchestratorCfg.calendar.recurrence.max_days,
    }),
    nudge: Object.freeze({ maxPerDay: orchestratorCfg.calendar.nudge.max_per_day }),
    defaultEventTimeZoneId: configured === "household" ? householdZone : configured,
  });
  const privateCap = accessManager.grant(principal, "calendar-private");
  const householdCap = accessManager.grant(principal, "calendar-household");
  const privateStore = openCalendarStore(privateCap, calendarCfg);
  const householdStore = openCalendarStore(householdCap, calendarCfg);
  const privatePersistence = openCalendarPersistence(privateCap, calendarCfg);
  const householdPersistence = openCalendarPersistence(householdCap, calendarCfg);
  const tools = composeProductToolProviders(undefined, {
    calendar: { privatePersistence, householdPersistence, calendarConfig: calendarCfg, privateCap, householdCap },
  });
  const nudgeBudget = {
    maxChars: 4000,
    maxLines: Math.max(1, orchestratorCfg.calendar.nudge.max_per_day + 4),
  };
  const privateNudge = composeCalendarNudge(privateStore, principal.role, householdZone, Date.now(), nudgeBudget);
  const householdNudge = composeCalendarNudge(householdStore, principal.role, householdZone, Date.now(), nudgeBudget);
  const nudge = capCalendarNudge(
    [privateNudge, householdNudge].filter((value): value is string => value !== null).join("\n") || null,
    nudgeBudget,
  );
  return {
    privateStore,
    householdStore,
    tools: [...tools.values()],
    nudge: nudge || null,
    close: () => { privateStore.close(); householdStore.close(); privatePersistence.close(); householdPersistence.close(); },
  };
}

export function buildSessionMemory(
  orchestratorCfg: OrchestratorConfig,
  accessManager: AccessManager,
  principal: UserPrincipal,
  ids: { conversationId: string; connectionId: string },
  wiring?: SessionMemoryWiring | null,
  /** `store.db_filename` — undefined in a test harness falls back to the
   *  session-store default; the composition root threads the operator value. */
  dbFileName?: string,
): SessionMemory | null {
  if (!orchestratorCfg.memory.enabled) return null;

  const memoryCap = accessManager.grant(principal, "memory-private");
  const store = openMemoryStore(memoryCap, orchestratorCfg.memory, {
    scan: scanContent,
  });
  const reingest = reingestWithWarn(store, "private", principal, ids);

  // Household (shared family) scope — rooted at the shared, householdId-keyed dir
  // the `memory-household` grant confines to, so every member of one household
  // opens the SAME physical store. Opened for every session (adults and children)
  // — the read side is universal; only the write is adult-gated (memory-tools).
  const householdCap = accessManager.grant(principal, "memory-household");
  const householdStore = openMemoryStore(householdCap, orchestratorCfg.memory, {
    scan: scanContent,
  });
  const householdReingest = reingestWithWarn(householdStore, "family", principal, ids);

  // Deep memory (spark + recall + index sync), only when the app is wired. Each
  // scope's index + cursor live in `<cap.rootPath>/deep-memory`; the household
  // scope's is under the SHARED root, so the whole household shares one index.
  let scopedStore = store;
  let householdScopedStore = householdStore;
  let spark: SessionSpark | null = null;
  let deepMemory: DeepMemoryDeps | undefined;
  let readSession: ((sessionId: string) => SessionEntry[]) | undefined;

  if (wiring) {
    const logCtx = {
      userId: principal.userId,
      conversationId: ids.conversationId,
    };
    const privateId = privateScopeId(principal.userId);
    const familyId = householdScopeId(principal.householdId);

    const wiredPrivate = wireScopeIndex(
      wiring.app,
      { scopeId: privateId, rootPath: memoryCap.rootPath, store },
      reingest,
      logCtx,
    );
    scopedStore = wiredPrivate.scopedStore;

    // Family tool writes carry the writing member's id (spec §9 attribution).
    const wiredHousehold = wireScopeIndex(
      wiring.app,
      {
        scopeId: familyId,
        rootPath: householdCap.rootPath,
        store: householdStore,
      },
      householdReingest,
      logCtx,
      principal.userId,
    );
    householdScopedStore = wiredHousehold.scopedStore;

    // The recall/spark client gates on the PRIVATE scope's registration; the
    // household scope is registered eagerly here (before any turn's first search)
    // and its id is memoized process-wide by `ensureScope`, so a combined search
    // finds both scopes registered. (Per-call gating on BOTH is a later refinement.)
    deepMemory = {
      client: wiredPrivate.scope.client,
      scopeIds: { private: privateId, family: familyId },
    };
    // `memory_read({sessionId})` drill-down — this user's own past sessions,
    // capability-scoped; a short-lived handle per read (the continuity precedent).
    readSession = (sessionId) => {
      const sessionStore = openSessionStore(accessManager.grant(principal, "session-store"), dbFileName);
      try {
        return sessionStore.readSession(sessionId);
      } finally {
        sessionStore.close();
      }
    };
    const retriever = createMemoryRetriever({
      client: wiredPrivate.scope.client,
      gate: wiring.gate,
      profileStore: wiring.profileStore,
      cfg: orchestratorCfg.memory,
    });
    spark = createSessionSpark(retriever, {
      userId: principal.userId,
      // Spark + recall search BOTH scopes in one call; hits label their own scope
      // and a child session's `@adults` household hits are filtered (spec §9).
      scopeIds: [privateId, familyId],
      childPrincipal: principal.role === "child",
      sessionId: ids.conversationId,
    });
  }

  const tools = buildMemoryTools({
    storeFor: storeSelector(scopedStore, householdScopedStore),
    scan: scanContent,
    cfg: orchestratorCfg.memory,
    principal,
    ...(deepMemory ? { deepMemory } : {}),
    ...(readSession ? { readSession } : {}),
  });

  return {
    tools,
    augmentPrompt: (skillPrompt) =>
      composeMemoryPrompt(skillPrompt, store, householdStore, orchestratorCfg.memory, principal, ids),
    spark,
  };
}

/** The `storeFor` the memory tools read: private and family both resolve their
 *  scope's store (family is always present in T24 — the shared household store).
 *  The role gate on a family WRITE lives in memory-tools, not here. */
function storeSelector(
  privateStore: MemoryStore,
  householdStore: MemoryStore,
): (scope: "private" | "family") => MemoryStore | null {
  return (scope) => {
    if (scope === "private") return privateStore;
    if (scope === "family") return householdStore;
    return null;
  };
}

/**
 * Boot/build visibility for the inbound gate (defect D18: a silent passthrough
 * reading as "covered" is a false-green, so the mode is logged, not assumed).
 * `mode` is `"real"` only when scanning actually runs — the master switch is on
 * AND at least one channel is enabled; anything else is an effective
 * passthrough. `channels` is the comma-joined set of enabled channel names, for
 * the log trail.
 */
/** `delegation_prompt` never reaches `inbound-gate.ts` — the delegation prompt
 *  is scanned directly via `prompt-classifier.ts`'s own `scanContent` call, not
 *  the gate (see CLAUDE.md's security bullet and the `delegation_prompt`
 *  comment in `config.yaml#security.inbound_scan.channels`). So it does not
 *  count toward the gate's own "real" mode: a config where it is the ONLY
 *  channel on is gate-passthrough in truth, and reporting `"real"` there would
 *  be a false "the gate is doing something" signal at boot. */
const GATE_CHANNELS = ["tool_result", "background_completion", "skill_body", "memory_body"] as const;

export function describeInboundGateMode(cfg: InboundScanConfig): {
  mode: "real" | "passthrough";
  channels: string;
} {
  const enabledChannels = Object.entries(cfg.channels)
    .filter(([, on]) => on)
    .map(([name]) => name);
  const enabledGateChannels = enabledChannels.filter((name) => (GATE_CHANNELS as readonly string[]).includes(name));
  const mode = cfg.enabled && enabledGateChannels.length > 0 ? "real" : "passthrough";
  return { mode, channels: enabledChannels.join(",") };
}

export interface PhaseServicesInput {
  readonly cfg: StartupConfig;
  readonly auth: AuthService;
  readonly secretsStore: SecretsStore | null;
}

export interface PhaseServicesOutput {
  readonly stt: SttService | null;
  readonly tts: TtsService | null;
  readonly tls: GatewayTlsMaterial | undefined;
  readonly createSynthesizerFor: (getVoiceId: () => Promise<string | null>) => TextStreamSynthesizer | null;
  readonly applyDeps: ApplyDeps;
  readonly profileStore: ProfileStore;
  readonly templateLoader: TemplateLoader;
  readonly userProvisioner: UserProvisioner | null;
  readonly userLifecycle: UserLifecycle;
  readonly buildPersonalityStore: (userId: string) => PersonalityStore;

  // --- Native orchestrator composition root (spec §2.6, Plan 2 Task 9) ------
  // App-lifetime singletons + a per-session factory. See the header comment
  // above `buildOrchestratorServices` below for the full wiring rationale.

  /** L1 capability minter (spec §2.1) — always constructed, independent of
   *  whether the orchestrator itself is enabled. */
  readonly accessManager: AccessManager;
  /** Shared MCP client (spec §5.3) — dials every `mcp_catalog` entry lazily
   *  per-server; always constructed (harmless/no-op with an empty catalog). */
  readonly mcpClient: McpClient;
  /** Mints the native orchestrator's OpenAI-compatible client for ONE user: the
   *  connection (key + base URL) comes from the operator's ACTIVE secrets-store
   *  LLM (never an env var — see resolve-provider-connection.ts), the MODEL from
   *  that user's own `profile.json#model`. A factory rather than one client
   *  because the key is household-wide and the model is not — see
   *  user-model-provider.ts. `null` when `orchestrator:` is absent from config,
   *  OR it's present but no active LLM key is configured yet — either way the
   *  gateway still boots; only a session that actually needs the orchestrator
   *  fails, at construction, with a clear error. */
  readonly provider: UserModelProvider | null;
  /** Per-session runtime factory (`SessionRuntimeRequest` names its two ids
   *  apart — the durable conversation the store partitions on, and the
   *  connection id the logs correlate on). `null` when `orchestrator:` is
   *  absent from config (the whole native-orchestrator feature is off).
   *  Present-but-no-provider is a DIFFERENT state (see `provider` above) —
   *  the factory itself still exists in that case, and throws when actually
   *  invoked. */
  readonly createSessionRuntime: CreateSessionRuntime | null;
  /** Late-bound holder for the delegated worker's own configuration — settled
   *  in `main.ts` once the MCP host exists, before the server accepts its
   *  first connection (task 9g). */
  readonly delegatedExternalTool: ExternalToolSlot;
  /** Authoritative first-class product runners for a delegated user's broker. */
  readonly delegatedNativeTools:
    | ((principal: UserPrincipal, inboundGate: InboundGate) => Map<string, NativeToolRunner>)
    | null;
  /** Binds the live SessionRegistry into the dreamer's yield gate and arms the
   *  nightly scheduler (memory-system spec §8). Null when the dreamer is not
   *  wired. Called by create-gateway-services.ts once the registry exists. */
  readonly startDreamScheduler: ((registry: Pick<SessionRegistry, "hasActiveTurnForUser">) => void) | null;
  /** Disarms the nightly dreamer timer on shutdown. Null when not wired. */
  readonly stopDreamScheduler: (() => void) | null;
}

export async function runPhaseServices(input: PhaseServicesInput): Promise<PhaseServicesOutput> {
  const { cfg, auth, secretsStore } = input;

  const stt = cfg.stt ? createSttService(cfg) : null;
  const tts = createTtsService({ cfg });
  const tls = cfg.tls.enabled
    ? ensureTlsMaterial({
        hostnames: cfg.tls.hostnames,
        certsDir: cfg.tls.certsDir,
        logTag: "gateway",
      })
    : undefined;

  const createSynthesizerFor = (getVoiceId: () => Promise<string | null>): TextStreamSynthesizer | null => {
    const openSession: TTSSessionOpener = asStrictFactory(tts, getVoiceId);
    return createTextStreamSynthesizer(cfg, openSession);
  };

  // BEFORE the orchestrator services: the provider factory resolves each user's
  // selected model out of their profile, so it needs this store.
  const profileStore = createProfileStore();
  const templateLoader = createTemplateLoader();

  const {
    accessManager,
    mcpClient,
    provider,
    createSessionRuntime,
    delegatedExternalTool,
    delegatedNativeTools,
    startDreamScheduler,
    stopDreamScheduler,
  } = await buildOrchestratorServices(cfg, secretsStore, profileStore, auth);

  const applyDeps: ApplyDeps = createApplyDeps({
    profileStore,
    templateLoader,
    mcpCatalog: cfg.mcpCatalog,
    secretsStore: secretsStore ?? null,
  });

  // Two flavors:
  //   - …Config   → config.yaml only; safe for apply + boot-migration.
  //   - …Initial  → config.yaml + SOUL.md; used once at user creation.
  const renderInnerProfileFor = buildRenderInnerProfile(applyDeps, {
    writeSoul: false,
  });
  const renderInitialInnerProfileFor = buildRenderInnerProfile(applyDeps, {
    writeSoul: true,
  });
  const userLifecycle = createUserLifecycle();

  // Registers each new user with the Hermes CLI's own profile store. Separate
  // from renderInnerProfile above: that writes the profile DIR, this makes
  // hermes recognize the profile NAME. Both are required before a delegateTask
  // can run — see admin/hermes-profile-provisioner.ts.
  const hermesProfiles = cfg.orchestrator
    ? createHermesProfileProvisioner({
        sourceProfile: cfg.orchestrator.delegation.hermes_source_profile,
        timeoutMs: cfg.orchestrator.delegation.hermes_profile_create_timeout_ms,
      })
    : null;

  let userProvisioner: UserProvisioner | null = null;
  if (cfg.hermes && secretsStore) {
    userProvisioner = createUserProvisioner({
      userStore: auth.users,
      profileStore,
      argon2Params: {
        memoryKb: cfg.auth.argon2_memory_kb,
        iterations: cfg.auth.argon2_iterations,
        parallelism: cfg.auth.argon2_parallelism,
      },
      hashPin,
      makeUserId,
      randomAvatarTint,
      now: () => new Date(),
      archiveUserDir,
      renderInnerProfile: renderInitialInnerProfileFor,
      // Null when the orchestrator block is absent: there is no native loop, so
      // no delegateTask, so nothing to provision for. Reported as a skip rather
      // than silently succeeding.
      createHermesProfile: hermesProfiles
        ? (userId) => hermesProfiles.create(userId)
        : async (userId) => {
            log.warn("hermes-profile.skipped", {
              userId,
              reason: "orchestrator-not-configured",
            });
            return { ok: false, error: "cli-error" as const };
          },
      userLifecycle,
    });
  }

  // Boot migration from legacy MCP/native permission keys to stable product
  // groups. Authorization is gateway-owned, so this runs even when Hermes is
  // disabled. Idempotent and conservative on collisions.
  await migrateWebToolsEnabled({ userStore: auth.users, profileStore });

  // Re-render the inner Hermes profile (config.yaml + SOUL.md) for every
  // existing user. Idempotent — picks up template changes (e.g. model
  // section schema bumps) without an explicit migration. This is the
  // profile rendering `hermes-runner` depends on: it spawns
  // `hermes -p <userId>` with `cwd` = the profile dir, so the dir must
  // already carry a rendered config.yaml before the first delegation.
  if (cfg.hermes) {
    await renderConfigsForExistingUsers({
      userStore: auth.users,
      renderInnerProfile: renderInnerProfileFor,
      createHermesProfile: hermesProfiles
        ? (userId) => hermesProfiles.create(userId)
        : async () => ({ ok: false, error: "cli-error" as const }),
    });
  }

  const buildPersonalityStore = (userId: string): PersonalityStore =>
    createPersonalityStore({ profileDir: getHermesProfileDir(userId) });

  log.info("phase-services-complete", {
    stt: stt !== null,
    tts: tts !== null,
    tls: tls !== undefined,
    language: cfg.language,
    orchestrator: cfg.orchestrator !== undefined,
    provider: provider !== null,
  });

  return {
    stt,
    tts,
    tls,
    createSynthesizerFor,
    applyDeps,
    profileStore,
    templateLoader,
    userProvisioner,
    userLifecycle,
    buildPersonalityStore,
    accessManager,
    mcpClient,
    provider,
    createSessionRuntime,
    delegatedExternalTool,
    delegatedNativeTools,
    startDreamScheduler,
    stopDreamScheduler,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// SOUL.md is user-editable via the System Prompt pane (writes the file
// directly). Apply + boot-migration paths must regenerate config.yaml only;
// the provisioner is the lone caller that seeds the initial SOUL.md.
function buildRenderInnerProfile(
  applyDeps: ApplyDeps,
  opts: { writeSoul: boolean },
): (userId: string) => Promise<{ ok: true; value: undefined } | { ok: false; error: "render-error" | "write-error" }> {
  return async (userId: string) => {
    const r = await renderAndWrite(applyDeps, userId, opts);
    if (r.ok) return { ok: true, value: undefined };
    if (r.error.kind === "render-error" || r.error.kind === "user-not-found") {
      return { ok: false, error: "render-error" };
    }
    return { ok: false, error: "write-error" };
  };
}

// ---------------------------------------------------------------------------
// Native orchestrator composition root (Plan 2 Task 9, spec §2.6)
// ---------------------------------------------------------------------------
//
// Builds the app-lifetime singletons (AccessManager, McpClient, the shared
// DelegationGuard/HermesRunner) once, resolves the orchestrator's
// ProviderClient from the operator's 1.0 secrets store, and returns a
// per-session `createSessionRuntime` factory closure that mints a fresh
// ToolBroker (+ its own delegateTask runner bound to that session's userId)
// on every call — mirroring `createSynthesizerFor` above. Everything here
// no-ops (`provider: null`, `createSessionRuntime: null`) when
// `cfg.orchestrator` is absent: the native orchestrator is an OPTIONAL
// subsystem and must never block gateway boot.

export interface OrchestratorServices {
  accessManager: AccessManager;
  mcpClient: McpClient;
  provider: UserModelProvider | null;
  createSessionRuntime: CreateSessionRuntime | null;
  /** Settled exactly once at boot by whoever owns the MCP host — see
   *  `external-tools/external-tool-slot.ts` for why this one hop is
   *  late-bound. Resolved per dispatch by `delegateTask`'s setup phase, never
   *  snapshotted at session creation. */
  delegatedExternalTool: ExternalToolSlot;
  delegatedNativeTools: ((principal: UserPrincipal, inboundGate: InboundGate) => Map<string, NativeToolRunner>) | null;
  /** Binds the live SessionRegistry into the dreamer's yield gate and starts the
   *  nightly scheduler + boot catch-up. Null when the dreamer is not wired
   *  (memory or dreamer disabled, or provider / deep-memory app unavailable).
   *  Late-bound because the registry is built AFTER this function returns
   *  (create-gateway-services.ts). */
  startDreamScheduler: ((registry: Pick<SessionRegistry, "hasActiveTurnForUser">) => void) | null;
  /** Disarms the nightly timer on shutdown. Null when the dreamer is not wired. */
  stopDreamScheduler: (() => void) | null;
}

/**
 * Exported (beyond this file's own use in `runPhaseServices`) so
 * `tests/integration/native-brain-text.test.ts` (Plan 2 Task 10's `@live`
 * gate) can construct the exact same real composition-root primitives —
 * `AccessManager`, `McpClient`, the resolved `ProviderClient`, and the
 * per-session `createSessionRuntime` factory — WITHOUT going through the
 * full `createGatewayServices()` boot chain, which (via `runPhaseServices`'s
 * Hermes-migration tail: `migrateUnboundUsers` /
 * `renderConfigsForExistingUsers` / `renderProgramsForExistingUsers`) would
 * mutate this machine's real supervisord/user state as a side effect of
 * running the test suite. This function itself has no such side effect
 * (only `warmMcpClient`'s network I/O, which never throws) — see Task 9's
 * own header comment on `buildOrchestratorServices` below.
 */
export async function buildOrchestratorServices(
  cfg: StartupConfig,
  secretsStore: SecretsStore | null,
  profileStore: ProfileStore,
  /** Names the people the gateway knows about, for the `<session>` block's
   *  "speaking with" / "household" lines. Optional so a headless boot-proof
   *  harness can build the orchestrator without an auth service; the block
   *  then renders without those two lines. */
  auth?: AuthService | null,
): Promise<OrchestratorServices> {
  // `sharedDataRoot` is optional (T24 activates the household scope); when the
  // operator leaves `access.shared_data_root` unset the AccessManager derives it
  // as a sibling of `user_data_root`. Threaded here so a household grant lands
  // under the operator-chosen root the moment T24 mints one.
  const accessManager = createAccessManager({
    userDataRoot: cfg.access.user_data_root,
    // Conditional spread, not `sharedDataRoot: cfg.access.shared_data_root`:
    // under `exactOptionalPropertyTypes` an OPTIONAL field may be absent or a
    // string but never explicitly `undefined`. When the operator leaves the key
    // unset the AccessManager derives the shared root itself.
    ...(cfg.access.shared_data_root !== undefined ? { sharedDataRoot: cfg.access.shared_data_root } : {}),
  });
  const mcpClient = createMcpClient(cfg.mcpCatalog, {});
  const musicSecrets = secretsStore?.loadSync().music_assistant;
  // One persistent native MA connection owner for the app lifetime. Session
  // tools share this adapter; credentials never enter a tool definition/input.
  const musicAdapter: MusicAdapter =
    musicSecrets?.url && musicSecrets.token
      ? new NativeMusicAdapter(musicSecrets.url, musicSecrets.token)
      : new UnavailableMusicAdapter();
  const delegatedExternalTool = createExternalToolSlot();

  // MCP-warm-before-first-call (Task 4 residual — see tool-broker.ts's
  // `ensureMcpWarm` doc comment and Task 4's own report: "a residual for
  // Task 6/9/10 to confirm the composition root gives the warm-up time to
  // land before the very first LLM call"). Chosen fix: warm the SHARED
  // McpClient's per-server transport connections once here, at boot — the
  // slow part (network handshake to each configured MCP server) is done
  // before any session exists. Each session still builds its OWN ToolBroker
  // (spec §5.3: no cross-session tool state), so its own `ensureMcpWarm()`
  // still re-lists tools once — but against already-connected transports, a
  // fast local round trip instead of a cold dial. This narrows the
  // `definitions()` synchronous-read race (Task 4's residual) to something
  // Task 10's real WS round trip (session creation → first user message)
  // comfortably outlasts in practice; a hard guarantee would require making
  // this factory async, which its synchronous contract (`CreateSessionRuntime`
  // in runtime/session-handles.ts) does not allow. Noted as a residual, not
  // silently dropped.
  await warmMcpClient(mcpClient);

  if (!cfg.orchestrator) {
    log.info("orchestrator.disabled", {
      reason: "no orchestrator: block in config.yaml",
    });
    return {
      accessManager,
      mcpClient,
      provider: null,
      createSessionRuntime: null,
      delegatedExternalTool,
      delegatedNativeTools: null,
      startDreamScheduler: null,
      stopDreamScheduler: null,
    };
  }

  const orchestratorCfg = cfg.orchestrator;
  const provider = await buildOrchestratorProvider(orchestratorCfg, secretsStore, profileStore);
  let homeAdapter: HomeAdapter | null = null;
  try {
    const home = secretsStore?.loadSync().home_assistant;
    const readToken = home?.observe_token ?? home?.mcp_server_token;
    if (home?.url && readToken) {
      homeAdapter = createHomeAdapter({
        baseUrl: home.url,
        readToken,
        ...(home.mcp_server_token ? { writeToken: home.mcp_server_token } : {}),
        openWebSocket: (url) => new WebSocket(url),
      });
    }
  } catch {
    log.warn("home.adapter.unavailable", {
      reason: "invalid or unreadable Home Assistant configuration",
    });
  }

  // App-lifetime deep-memory wiring (spec §5/§6) — one client + one per-scope
  // outbox ledger for the whole process. Null when memory is off OR its two env
  // tokens are unset (memory tools + spark degrade to unavailable; file memory
  // still works). See buildDeepMemoryApp.
  const delegatedNativeTools = (principal: UserPrincipal, inboundGate: InboundGate): Map<string, NativeToolRunner> => {
    const webCfg = orchestratorCfg.web ?? {
      worker_url: "http://127.0.0.1:8090",
      request_timeout_ms: 20_000,
      max_compressed_bytes: 2_000_000,
      max_decompressed_bytes: 5_000_000,
      max_redirects: 5,
      initial_extract_chars: 6000,
      artifact_ttl_ms: 86_400_000,
      artifact_max_entries: 100,
      artifact_max_bytes: 50_000_000,
      read_max_chars: 12_000,
      match_max_passages: 5,
      match_context_chars: 500,
      search_max_results: 10,
      grounded_source_count: 5,
      passage_budget_chars: 12_000,
      summary: {
        model: "deepseek-v4-flash:cloud",
        deadline_ms: 30_000,
        max_input_chars: 20_000,
        max_output_tokens: 800,
        max_answer_chars: 6000,
      },
    };
    return composeProductToolProviders(undefined, {
      web: {
        capability: accessManager.grant(principal, "web-artifact"),
        tools: {
          worker: {
            baseUrl: webCfg.worker_url,
            timeoutMs: webCfg.request_timeout_ms,
            maxResponseChars: webCfg.max_decompressed_bytes + 16_384,
            maxCompressedBytes: webCfg.max_compressed_bytes,
            maxDecompressedBytes: webCfg.max_decompressed_bytes,
            maxRedirects: webCfg.max_redirects,
          },
          artifacts: {
            ttlMs: webCfg.artifact_ttl_ms,
            maxEntries: webCfg.artifact_max_entries,
            maxBytes: webCfg.artifact_max_bytes,
            maxSliceChars: webCfg.read_max_chars,
            maxPassages: webCfg.match_max_passages,
            passageContextChars: webCfg.match_context_chars,
          },
          initialExtractChars: webCfg.initial_extract_chars,
          search: {
            maxResults: webCfg.search_max_results,
            sourceCount: webCfg.grounded_source_count,
            passageBudgetChars: webCfg.passage_budget_chars,
            summary: {
              fallbackModel: webCfg.summary.model,
              deadlineMs: webCfg.summary.deadline_ms,
              maxInputChars: webCfg.summary.max_input_chars,
              maxOutputTokens: webCfg.summary.max_output_tokens,
              maxAnswerChars: webCfg.summary.max_answer_chars,
            },
          },
        },
        ...(provider
          ? {
              provider: provider.forUser(principal.userId),
              summaryPrompt: DEFAULT_WEB_SUMMARY_PROMPT,
            }
          : {}),
        screen: (text: string) =>
          inboundGate.screen(
            text,
            { channel: "tool_result", source: "web_search" },
            { sessionId: `delegated:${principal.userId}` },
          ).text,
      },
      home: { ...(homeAdapter ? { adapter: homeAdapter } : {}) },
      music: { adapter: musicAdapter },
    });
  };

  const deepMemoryApp = buildDeepMemoryApp(orchestratorCfg.memory);

  const frontmatterDir = resolveDelegationFrontmatterDir(orchestratorCfg.delegation.frontmatter_dir);
  const delegationFrontmatter = loadDelegationFrontmatterDir(frontmatterDir);
  const promptClassifier = createPromptClassifier();
  const delegationGuard = createDelegationGuard({
    frontmatter: delegationFrontmatter,
    classifier: promptClassifier,
  });
  const hermesRunner = createHermesRunner({
    profile: orchestratorCfg.delegation.hermes_delegation_profile,
    resolveProfileDir: getHermesProfileDir,
    timeoutMs: orchestratorCfg.delegation.hermes_timeout_ms,
  });

  const createSessionRuntime = buildCreateSessionRuntime({
    orchestratorCfg,
    accessManager,
    provider,
    mcpClient,
    mcpCatalog: cfg.mcpCatalog,
    delegationGuard,
    hermesRunner,
    delegatedExternalTool,
    profileStore,
    auth: auth ?? null,
    inboundScan: cfg.inboundScan,
    deepMemoryApp,
    dbFileName: cfg.store.db_filename,
    homeAdapter,
    musicAdapter,
  });

  // Nightly dreamer (memory-system spec §8, S3a). Wired only when memory + the
  // dreamer toggle are both on AND the two collaborators the transaction needs
  // exist — the per-user provider factory and the deep-memory app (its index
  // outbox is where the episode summaries land). `startDreamScheduler` is
  // late-bound: the SessionRegistry the yield gate polls is not built until
  // create-gateway-services.ts, after this returns.
  const dreamWiring = buildDreamScheduler({
    orchestratorCfg,
    accessManager,
    provider,
    deepMemoryApp,
    profileStore,
    auth: auth ?? null,
    dbFileName: cfg.store.db_filename,
  });

  return {
    accessManager,
    mcpClient,
    provider,
    createSessionRuntime,
    delegatedExternalTool,
    delegatedNativeTools,
    startDreamScheduler: dreamWiring?.start ?? null,
    stopDreamScheduler: dreamWiring?.stop ?? null,
  };
}

/** The dreamer's collaborators, all app-lifetime, all resolved before the
 *  SessionRegistry exists. */
interface DreamSchedulerDepsInput {
  orchestratorCfg: OrchestratorConfig;
  accessManager: AccessManager;
  provider: UserModelProvider | null;
  deepMemoryApp: DeepMemoryApp | null;
  profileStore: ProfileStore;
  auth: AuthService | null;
  /** `store.db_filename` (config.yaml#store) — the session-store db this scope's
   *  readback opens. Threaded so an operator override is honoured everywhere. */
  dbFileName: string;
}

/** The dreamer principal's role + household are IMMATERIAL to the two grants it
 *  mints (`memory-private`, `session-store`): both confine to the user's own
 *  home dir (access-manager.ts `rootPathFor` uses `userHomeDir(principal)` for
 *  every class except `memory-household`), and neither the memory store nor the
 *  session store reads `role`/`householdId` on the dreamer write path. A fixed
 *  adult/home principal therefore grants exactly the same authority a
 *  freshly-authed one would, without an async user-record read per user per
 *  night. */
const DREAMER_PRINCIPAL_ROLE = "adult" as const;
const DREAMER_HOUSEHOLD_ID = "home";
/** The scope's memory dir name — sibling constant to memory-store's own
 *  (`<cap.rootPath>/memory`), where the dream mark + status live. */
const MEMORY_DIRNAME = "memory";

/** Resolves the model the dreamer's map/reduce calls send: a non-empty
 *  `memory.dreamer.model` override wins; `""` (the default) inherits the chat
 *  model (`orchestrator.provider.model`). Exported so the fallback — "" must
 *  fall through, not be treated as a real value — is unit-testable on its own,
 *  without composing the rest of `buildDreamScheduler`'s heavy deps (provider,
 *  deep-memory app, profile store, ...). */
export function resolveDreamerModel(
  memoryCfg: OrchestratorConfig["memory"],
  providerCfg: OrchestratorConfig["provider"],
): string {
  return memoryCfg.dreamer.model || providerCfg.model;
}

/**
 * Builds the nightly dreamer scheduler + its S3a transaction, or null when the
 * feature is not wired (memory off, dreamer toggle off, or a missing provider /
 * deep-memory app). Returns `start`/`stop` closures rather than the scheduler
 * itself so the composition root binds the live SessionRegistry (built later)
 * into the yield gate at the moment it arms the timer.
 */
function buildDreamScheduler(deps: DreamSchedulerDepsInput): {
  start: (registry: Pick<SessionRegistry, "hasActiveTurnForUser">) => void;
  stop: () => void;
} | null {
  const memoryCfg = deps.orchestratorCfg.memory;
  if (!memoryCfg.enabled || !memoryCfg.dreamer.enabled) {
    log.info("dreamer.disabled", {
      memoryEnabled: memoryCfg.enabled,
      dreamerEnabled: memoryCfg.dreamer.enabled,
    });
    return null;
  }
  const { provider, deepMemoryApp } = deps;
  if (!provider || !deepMemoryApp) {
    log.warn("dreamer.not-wired", {
      reason: "provider or deep-memory app unavailable — the nightly dreamer stays off (file memory unaffected)",
      hasProvider: provider !== null,
      hasDeepMemoryApp: deepMemoryApp !== null,
    });
    return null;
  }

  // Late-bound yield-gate seam: the runner polls this per provider call; a null
  // registry (before `start`) simply reports no active turn, which is correct at
  // boot when no session exists.
  let registryView: Pick<SessionRegistry, "hasActiveTurnForUser"> | null = null;

  const principalFor = (userId: string): UserPrincipal =>
    createUserPrincipal(userId, DREAMER_PRINCIPAL_ROLE, DREAMER_HOUSEHOLD_ID);

  const memoryDirFor = (userId: string): string =>
    join(deps.accessManager.grant(principalFor(userId), "memory-private").rootPath, MEMORY_DIRNAME);

  const openDreamScope = (userId: string): DreamScopeHandle | null => {
    const principal = principalFor(userId);
    const memoryCap = deps.accessManager.grant(principal, "memory-private");
    // RAW store — writeDreamOutputs enqueues provenance-carrying index ENTRIES,
    // so the store must not also enqueueFile the journal (index-sync header).
    const store = openMemoryStore(memoryCap, memoryCfg, { scan: scanContent });
    const scopeId = privateScopeId(userId);
    const indexDir = join(memoryCap.rootPath, DEEP_MEMORY_DIRNAME);
    const scope = deepMemoryApp.ensureScope({
      scopeId,
      indexDir,
      indexPath: join(indexDir, DEEP_MEMORY_INDEX_FILE),
      store,
    });
    const runner = createDreamRunner({
      provider: provider.forUser(userId),
      loadTemplate: (name) => loadDreamerTemplate(name),
      turnStateFor: (uid) => ({
        hasActiveTurn: () => registryView?.hasActiveTurnForUser(uid) ?? false,
      }),
      cfg: memoryCfg,
      model: resolveDreamerModel(memoryCfg, deps.orchestratorCfg.provider),
    });
    const readWindow = (): { entries: SessionEntry[]; maxSeq: number } => {
      const sessionStore = openSessionStore(deps.accessManager.grant(principal, "session-store"), deps.dbFileName);
      try {
        const entries: SessionEntry[] = [];
        let maxSeq = 0;
        for (const s of sessionStore.listSessions()) {
          for (const entry of sessionStore.readSession(s.sessionId)) {
            entries.push(entry);
            if (entry.seq > maxSeq) maxSeq = entry.seq;
          }
        }
        return { entries, maxSeq };
      } finally {
        sessionStore.close();
      }
    };
    return {
      userId: principal.userId,
      scopeId,
      memoryDir: join(memoryCap.rootPath, MEMORY_DIRNAME),
      store,
      sync: scope.sync,
      runner,
      readWindow,
    };
  };

  const transaction = createDreamTransaction({
    openDreamScope,
    readDreamMark: (userId) => readMark(memoryDirFor(userId)),
    cfg: memoryCfg,
  });

  const hostClock: DreamClock = {
    now: () => new Date(),
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms);
      // A nightly timer must never be the reason the process stays alive.
      t.unref?.();
      return t;
    },
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  };

  const listUsers = async (): Promise<string[]> => {
    if (!deps.auth) return [];
    const listed = await deps.auth.users.list();
    return listed.ok ? listed.value.map((u) => u.userId) : [];
  };

  let scheduler: DreamScheduler | null = null;
  return {
    start(registry): void {
      registryView = registry;
      scheduler = createDreamScheduler({
        runDreamFor: transaction.runDreamFor,
        skipAndAdvance: transaction.skipAndAdvance,
        initialize: transaction.initialize,
        bootDecisionFor: transaction.bootDecisionFor,
        listUsers,
        dreamingEnabledFor: async (userId) => (await memoryTogglesFor(deps.profileStore, userId)).dreaming,
        cfg: memoryCfg,
        clock: hostClock,
      });
      scheduler.start();
    },
    stop(): void {
      scheduler?.stop();
    },
  };
}

/**
 * Builds the app-lifetime deep-memory wiring, or null. Off when memory is
 * disabled, or when either bearer token is unset — the two tokens are gateway
 * PROCESS ENVIRONMENT (deploy/README.md §Token provisioning), never config.yaml
 * or on-disk service config, and an unset one means the service refuses every
 * call, so the honest state is "deep memory unavailable" while file memory
 * (MEMORY.md + topic notes + the prompt block) keeps working. baseUrl +
 * timeout come from `orchestrator.memory.service`.
 */
function buildDeepMemoryApp(memoryCfg: OrchestratorConfig["memory"]): DeepMemoryApp | null {
  if (!memoryCfg.enabled) return null;
  const adminToken = process.env.DEEP_MEMORY_ADMIN_TOKEN ?? "";
  const dataToken = process.env.DEEP_MEMORY_DATA_TOKEN ?? "";
  if (adminToken === "" || dataToken === "") {
    log.warn("deep-memory.app.no-tokens", {
      reason:
        "DEEP_MEMORY_ADMIN_TOKEN / DEEP_MEMORY_DATA_TOKEN unset — spark + memory_recall degrade to unavailable (file memory still works)",
    });
    return null;
  }
  const app = createDeepMemoryApp({
    baseUrl: memoryCfg.service.url,
    adminToken,
    dataToken,
    requestTimeoutMs: memoryCfg.service.request_timeout_ms,
    cfg: memoryCfg,
  });
  log.info("deep-memory.app.ready", {
    baseUrlHost: safeUrlHost(memoryCfg.service.url),
  });
  return app;
}

/** Warms the shared MCP client's per-server transport connections. Never
 *  throws — `McpClient.listTools()` already catches/logs/skips a single
 *  unreachable server internally; this try/catch is belt-and-braces against
 *  a future change to that contract, not a sign it can currently reject. */
async function warmMcpClient(mcpClient: McpClient): Promise<void> {
  try {
    const tools = await mcpClient.listTools();
    log.info("mcp-client.warmup.ok", { toolCount: tools.length });
  } catch (err) {
    log.warn("mcp-client.warmup.failed", {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/** `orchestrator.delegation.frontmatter_dir` ships relative
 *  (`./config/delegation`) — resolve against the runtime asset root, not
 *  `process.cwd()` (which varies by launcher) and not `import.meta.dir`
 *  (which is the embedded bundle inside a compiled binary). Absolute
 *  overrides pass through untouched. */
function resolveDelegationFrontmatterDir(frontmatterDir: string): string {
  return frontmatterDir.startsWith("/") ? frontmatterDir : join(resolveAssetRoot(), frontmatterDir);
}

/** Resolves the orchestrator's live provider CONNECTION from the operator's 1.0
 *  secrets store — see resolve-provider-connection.ts's header for why this
 *  is NEVER `process.env` — and wraps it in the per-user model factory.
 *
 *  A factory, not one client, because the MODEL is per user: it lives in
 *  `profile.json#model`, written by Settings → Model, while the secrets store
 *  supplies only provider + key + base URL. Boot picking one model for the whole
 *  household is the defect (see user-model-provider.ts's header).
 *
 *  `null` covers every "not ready yet" case: no secrets store at all (hermes not
 *  configured), an unreadable keys.yaml, or an active provider with no key set —
 *  the gateway boots regardless; only a session that actually needs the
 *  orchestrator fails later, loudly, at construction
 *  (`buildCreateSessionRuntime` below). */
async function buildOrchestratorProvider(
  orchestratorCfg: OrchestratorConfig,
  secretsStore: SecretsStore | null,
  profileStore: ProfileStore,
): Promise<UserModelProvider | null> {
  if (!secretsStore) {
    log.warn("orchestrator.provider.no-secrets-store", {
      reason: "secrets store absent (hermes not configured) — orchestrator provider unavailable",
    });
    return null;
  }

  const activeLlm = await secretsStore.getActiveLlm();
  if (!activeLlm.ok) {
    log.warn("orchestrator.provider.secrets-read-failed", {
      reason: activeLlm.error.kind,
    });
    return null;
  }

  const conn = resolveProviderConnection(activeLlm.value, orchestratorCfg.provider);
  if (!conn) {
    log.warn("orchestrator.provider.no-active-key", {
      activeProvider: activeLlm.value.provider,
      hasKey: activeLlm.value.apiKey !== "",
      hasSecretsBaseUrl: activeLlm.value.baseUrl !== "",
      hasConfigBaseUrl: orchestratorCfg.provider.base_url !== "",
    });
    return null;
  }

  // The MODEL is deliberately absent here. This line says which endpoint and
  // credential the household will dial; `orchestrator.provider.resolved` — the
  // line that names the model actually in use — is emitted per user by
  // user-model-provider.ts, because that is the only place the answer exists.
  log.info("orchestrator.provider.connected", {
    provider: conn.provider,
    baseUrlHost: safeUrlHost(conn.baseUrl),
    hasKey: true, // presence only — NEVER log conn.apiKey
    fallbackModel: orchestratorCfg.provider.model,
  });
  return createUserModelProvider({
    providerCfg: orchestratorCfg.provider,
    connection: conn,
    profileStore,
  });
}

/** Host only — never log a full URL that might (in a future provider) carry
 *  query-string credentials. */
function safeUrlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

interface CreateSessionRuntimeFactoryDeps {
  orchestratorCfg: OrchestratorConfig;
  accessManager: AccessManager;
  provider: UserModelProvider | null;
  mcpClient: McpClient;
  /** `config.yaml#mcp_catalog`. Threaded through to every session broker, which
   *  builds its owner's role permission template from it — the floor underneath
   *  their stored table (tools/role-defaults.ts). */
  mcpCatalog: McpCatalog;
  delegationGuard: DelegationGuard;
  hermesRunner: HermesRunner;
  delegatedExternalTool: ExternalToolSlot;
  /** Supplies each session broker's per-tool permission reader — the person's
   *  `profile.tools.permissions`, re-read per turn and per dispatch rather
   *  than snapshotted at session construction (see
   *  tools/user-tool-permissions.ts). */
  profileStore: ProfileStore;
  /** Names the household for the `<session>` block; null in a headless
   *  harness, which then renders the block without those lines. */
  auth: AuthService | null;
  /** Operator's `security.inbound_scan` block (T1), threaded from config.yaml
   *  through StartupConfig so a disabled channel actually reaches the gate — no
   *  code-side `parse({})` that would silently ignore the operator's YAML. */
  inboundScan: InboundScanConfig;
  /** App-lifetime deep-memory wiring (spec §5/§6), or null when memory is off /
   *  tokens unset. Each session's memory build threads its private scope through
   *  `ensureScope` for spark + recall + index sync. */
  deepMemoryApp: DeepMemoryApp | null;
  /** `store.db_filename` (config.yaml#store) — the session-store db every
   *  runtime + memory readback in this factory opens. Threaded so an operator
   *  override is honoured, not silently replaced by the "sessions.db" default. */
  dbFileName: string;
  /** Credential-owning app adapter; null still contributes definitions whose
   * calls degrade locally without disturbing the session. */
  homeAdapter: HomeAdapter | null;
  /** App-lifetime native Music Assistant connection owner. */
  musicAdapter: MusicAdapter;
}

/** The per-session factory itself. Synchronous (matches the locked
 *  `GatewayServices.createSessionRuntime` signature) — everything it does is
 *  either pure construction or fire-and-forget (`broker.definitions()`'s
 *  warm-up kick-off). Throws when `provider` is null: `cfg.orchestrator` was
 *  present at boot but no active LLM key resolved — a genuine misconfig for
 *  a caller that specifically asked for a session runtime, never a reason to
 *  fail the whole gateway boot (that check lives HERE, at the point of
 *  actual use, not in `buildOrchestratorServices` above). */
function buildCreateSessionRuntime(deps: CreateSessionRuntimeFactoryDeps): CreateSessionRuntime {
  const { orchestratorCfg, accessManager, provider, mcpClient, mcpCatalog, delegationGuard, hermesRunner } = deps;
  const {
    delegatedExternalTool,
    profileStore,
    auth,
    inboundScan: inboundScanCfg,
    deepMemoryApp,
    dbFileName,
    homeAdapter,
    musicAdapter,
  } = deps;

  // Inbound-scan boundary config (T1), threaded from the operator's
  // `security.inbound_scan` YAML through StartupConfig — so a channel the
  // operator disabled in config.yaml reaches `createInboundGate` and the
  // `inbound-gate.composed` log line, never silently overridden by a code-side
  // default. The risk config has NO operator YAML surface (no `security.risk`
  // key exists in the schema), so `riskConfigSchema.parse({})` here is a true
  // code default, not an ignored knob — nothing to thread. Config and the log
  // descriptor are shared across sessions; each session gets its OWN risk
  // accumulator + gate below, since injection risk is per-session.
  const riskCfg = riskConfigSchema.parse({});
  const gateMode = describeInboundGateMode(inboundScanCfg);

  return ({
    principal,
    conversationId,
    connectionId,
    emitter: rawEmitter,
    attachedWindows,
    audioPolicy,
    voice,
    onWorkSettled,
  }) => {
    if (!provider) {
      log.error("session-runtime.factory.no-provider", {
        userId: principal.userId,
        conversationId,
        connectionId,
        reason: "orchestrator configured but no active LLM key resolved from the secrets store",
      });
      throw new Error(
        "orchestrator provider unavailable — no active LLM key configured in the secrets store (admin > secrets)",
      );
    }

    // ONE turn-state tracker for the whole session, wrapping the emitter BEFORE
    // anything else takes it. This is the only scope that holds both the
    // runtime and the permission broker, and both emit through this seam — so
    // wrapping here is what puts open PROMPTS into a joining window's turn-state
    // snapshot alongside the turn's text and tool tiles (session-model spec
    // §7.2). Wrapping inside `createSessionRuntime` instead would see the
    // runtime's frames and none of the broker's.
    const turnState = createTurnStateTracker(conversationId);
    const emitter = turnState.wrap(rawEmitter);

    // The broker's authorization input (spec §3.2) — minted from the SAME
    // AccessManager that grants the store's own capability in
    // session-runtime.ts, just a different resource class. Fixes the second
    // of the two L2 holes CLAUDE.md claimed were already closed: the broker
    // used to authorize off the ambient `principal` directly.
    const capability = accessManager.grant(principal, "tool-broker");

    // Permission mediation (spec §5.3/§7.1, session-model spec §2.4). Created
    // here because this is the only scope holding BOTH the session's emitter
    // and the orchestrator config; the broker comes back on
    // `SessionRuntimeHandles` and is kept by the SESSION registry — it is not
    // parked on any socket, because since task 7 the prompt map belongs to the
    // session and a `permission.response` is routed by the session the
    // answering window is attached to (ws-handlers.ts).
    //
    // Keyed on `conversationId`, not `connectionId`: the prompts are the
    // session's, so the id in their log lines has to be the one every attached
    // window shares. The answering window is named by `attachmentId` on the
    // settle line instead — which is the id that actually answers "who
    // approved this" when N windows can.
    const permissions = createSessionPermissionBroker({
      emitter,
      sessionId: conversationId,
      userId: principal.userId,
      attachedWindows,
    });

    // The per-user SKILL STORE, rooted THROUGH the user's FileScope grant
    // rather than a bare `join(userDir, "skills")`: `AccessManager.grant(...,
    // "file-scope")` mints the capability, and `createFileScope(...).resolve`
    // confines the root to that grant (and, since this task, refuses a
    // capability of the wrong resource class). One store per session — a mkdir
    // and a realpath, cheap — mirroring the per-session ToolBroker beside it.
    //
    // `knownTools` is the universe a skill's `tools:` frontmatter may name:
    // every catalog tool ∪ the five native skill tools ∪ `delegateTask`. The
    // SAME set is handed to `createSkillTools` so its `validate` hook can answer
    // `unknown_tools` before the PDP, not only inside `store.write`.
    //
    // `skillStore` is kept in this factory scope on purpose: Task 10 (system
    // prompt) reads it here to render the skills index — no new services-bag
    // type is introduced.
    //
    // The per-user memory master switch (Memory System spec §11, T1). Off ⇒ no
    // grant, no store, no reingest, no tools, no prompt block — every memory
    // effect below is gated on this one flag.
    const memoryEnabled = orchestratorCfg.memory.enabled;

    const skillsRoot = createFileScope(accessManager.grant(principal, "file-scope")).resolve("skills");
    const knownTools = new Set<string>([
      ...catalogTools(mcpCatalog).map((tool) => tool.name),
      ...SKILL_TOOL_NAMES,
      // The four memory tools join the universe a skill's `tools:` frontmatter
      // may name — only when memory is on, so a skill can't reference a tool
      // this session will never build (memory-tools.ts's MEMORY_TOOL_NAMES doc).
      ...(memoryEnabled ? MEMORY_TOOL_NAMES : []),
      delegateTaskDefinition.name,
    ]);
    const maxBodyChars = orchestratorCfg.skills.max_body_chars;
    const skillStore = createSkillStore(skillsRoot, {
      maxBodyChars,
      knownTools,
    });
    const skillTools = createSkillTools(skillStore, {
      scan: scanContent,
      knownTools,
      maxBodyChars,
    });

    // One inbound gate + risk accumulator PER SESSION (T9/T10). The gate screens
    // every untrusted string on its way into model context — foreground tool
    // results (inside the broker), background-task completions (the
    // completion-note sink below), AND the spark's recalled-memory block (via the
    // retriever, below) — and feeds a per-session risk accumulator the PDP can
    // escalate on. Replaces the broker's disabled passthrough default. Built
    // HERE, before `buildSessionMemory`, because the retriever screens its spark
    // through this SAME instance. The INFO line makes the mode visible in the
    // trail (defect D18): a silent passthrough reading as covered is the
    // false-green this log exists to prevent.
    const riskAccumulator = createRiskAccumulator(riskCfg);
    const inboundGate = createInboundGate(inboundScanCfg, riskAccumulator);
    log.info("inbound-gate.composed", {
      userId: principal.userId,
      conversationId,
      connectionId,
      mode: gateMode.mode,
      channels: gateMode.channels,
    });

    // Per-user memory (Memory System spec §4/§5/§6, T6+T15). `buildSessionMemory`
    // returns null when the master switch is off — no grant, no store, no
    // reingest, no tools, no prompt block, no spark — and otherwise mints the
    // private grant, opens the store, runs edit-reingest, and builds the memory
    // tools + prompt block. When the deep-memory app is wired (memory on + tokens
    // present) it ALSO registers the private scope, sync-wraps the write path,
    // and builds the per-turn spark bound to this session's gate. PRIVATE scope
    // only in S1; the household scope is minted in T24.
    const sessionMemory = buildSessionMemory(
      orchestratorCfg,
      accessManager,
      principal,
      { conversationId, connectionId },
      deepMemoryApp ? { app: deepMemoryApp, gate: inboundGate, profileStore } : null,
      dbFileName,
    );
    const spark = sessionMemory?.spark ?? null;
    const sessionCalendar = buildSessionCalendar(orchestratorCfg, accessManager, principal);

    // The single `native` namespace map the broker resolves under
    // `NATIVE_TOOL_SERVER_KEY`: the skill tools plus (when memory is on) the
    // four memory tools, each keyed by its definition name. `createSkillTools`
    // already returns the map, copied here so we never mutate its result;
    // `buildSessionMemory` hands back an ARRAY of runners.
    const nativeTools = new Map(skillTools);
    for (const runner of sessionMemory?.tools ?? []) nativeTools.set(runner.definition.name, runner);
    for (const runner of sessionCalendar?.tools ?? []) nativeTools.set(runner.definition.name, runner);
    // Product providers are composed once per authenticated session. Web
    // receives a dedicated user capability and operator-owned limits; Home
    // and Music receive only their app-owned credential-bearing adapters.
    const webCfg = orchestratorCfg.web ?? {
      worker_url: "http://127.0.0.1:8090",
      request_timeout_ms: 20_000,
      max_compressed_bytes: 2_000_000,
      max_decompressed_bytes: 5_000_000,
      max_redirects: 5,
      initial_extract_chars: 6000,
      artifact_ttl_ms: 86_400_000,
      artifact_max_entries: 100,
      artifact_max_bytes: 50_000_000,
      read_max_chars: 12_000,
      match_max_passages: 5,
      match_context_chars: 500,
      search_max_results: 10,
      grounded_source_count: 5,
      passage_budget_chars: 12_000,
      summary: {
        model: "deepseek-v4-flash:cloud",
        deadline_ms: 30_000,
        max_input_chars: 20_000,
        max_output_tokens: 800,
        max_answer_chars: 6000,
      },
    };
    for (const [name, runner] of composeProductToolProviders(undefined, {
      web: {
        capability: accessManager.grant(principal, "web-artifact"),
        tools: {
          worker: {
            baseUrl: webCfg.worker_url,
            timeoutMs: webCfg.request_timeout_ms,
            maxResponseChars: webCfg.max_decompressed_bytes + 16_384,
            maxCompressedBytes: webCfg.max_compressed_bytes,
            maxDecompressedBytes: webCfg.max_decompressed_bytes,
            maxRedirects: webCfg.max_redirects,
          },
          artifacts: {
            ttlMs: webCfg.artifact_ttl_ms,
            maxEntries: webCfg.artifact_max_entries,
            maxBytes: webCfg.artifact_max_bytes,
            maxSliceChars: webCfg.read_max_chars,
            maxPassages: webCfg.match_max_passages,
            passageContextChars: webCfg.match_context_chars,
          },
          initialExtractChars: webCfg.initial_extract_chars,
          search: {
            maxResults: webCfg.search_max_results,
            sourceCount: webCfg.grounded_source_count,
            passageBudgetChars: webCfg.passage_budget_chars,
            summary: {
              fallbackModel: webCfg.summary.model,
              deadlineMs: webCfg.summary.deadline_ms,
              maxInputChars: webCfg.summary.max_input_chars,
              maxOutputTokens: webCfg.summary.max_output_tokens,
              maxAnswerChars: webCfg.summary.max_answer_chars,
            },
          },
        },
        ...(provider
          ? {
              provider: provider.forUser(principal.userId),
              summaryPrompt: DEFAULT_WEB_SUMMARY_PROMPT,
            }
          : {}),
        screen: (text: string) =>
          inboundGate.screen(text, { channel: "tool_result", source: "web_search" }, { sessionId: conversationId })
            .text,
      },
      home: { ...(homeAdapter ? { adapter: homeAdapter } : {}) },
      music: { adapter: musicAdapter },
    }))
      nativeTools.set(name, runner);

    const backgroundTools = new Map<string, BackgroundToolRunner>();
    backgroundTools.set(
      delegateTaskDefinition.name,
      createDelegateTaskRunner({
        guard: delegationGuard,
        hermesRunner,
        userId: capability.ownerUserId, // the delegated-agent socket path — spec §3.2.
        // The SLOT, not its value. This closure runs on every WS connect,
        // which is not ordered against boot filling the slot — snapshotting it
        // here would hand a session that connected inside the boot window a
        // permanent `null` and silently skip verify-and-repair on every one of
        // its delegations. `delegateTask` resolves it per dispatch instead.
        externalTool: delegatedExternalTool,
      }),
    );

    // `ToolBrokerDeps.store` is interface-parity only — tool-broker.ts never
    // reads it (the ReAct loop owns turnId and does all appending). Opening a
    // real per-session SQLite handle for a field that is never touched would
    // leak one fd triple (db + WAL + SHM) per session for the process lifetime
    // — unbounded on a long-running family gateway. Pass a stub that throws if
    // anything ever calls it, so a future read surfaces loudly instead of
    // silently corrupting isolation. Dropping `store` from ToolBrokerDeps is
    // the real fix, but that is Task 4's locked interface — tracked as a
    // follow-up.
    const brokerStore: SessionStore = {
      append: () => {
        throw new Error("ToolBroker.store is interface-parity only and must not be used");
      },
      readSession: () => {
        throw new Error("ToolBroker.store is interface-parity only and must not be used");
      },
      readSince: () => {
        throw new Error("ToolBroker.store is interface-parity only and must not be used");
      },
      findByPendingId: () => {
        throw new Error("ToolBroker.store is interface-parity only and must not be used");
      },
      listSessions: () => {
        throw new Error("ToolBroker.store is interface-parity only and must not be used");
      },
      createSession: () => {
        throw new Error("ToolBroker.store is interface-parity only and must not be used");
      },
      findSessionByMintKey: () => {
        throw new Error("ToolBroker.store is interface-parity only and must not be used");
      },
      getSession: () => {
        throw new Error("ToolBroker.store is interface-parity only and must not be used");
      },
      listSessionsWithMetadata: () => {
        throw new Error("ToolBroker.store is interface-parity only and must not be used");
      },
      setTitle: () => {
        throw new Error("ToolBroker.store is interface-parity only and must not be used");
      },
      close: () => {},
    };

    // Forward reference: `createToolBroker` (immediately below) needs
    // `onDelegationProgress` NOW, but the runtime whose task-list projector
    // that callback must also feed does not exist until `buildSessionRuntime`
    // returns, several statements later — the broker is one of ITS
    // constructor arguments, not the other way around. Both statements live
    // in this one function body, so a plain mutable slot closes the loop: the
    // callback captures `runtimeRef` by reference and reads it lazily, well
    // after `runtimeRef = runtime` (below) has filled it in. A DELEGATION
    // dispatch is asynchronous by construction (fire-and-steer — see
    // tool-broker.ts's `dispatchBackground`), so this callback can never fire
    // before the assignment; the only caller who could observe `null` here is
    // one invoking it synchronously during construction, and nothing does.
    let runtimeRef: SessionRuntime | null = null;

    const broker = createToolBroker({
      mcp: mcpClient,
      store: brokerStore,
      capability,
      catalog: mcpCatalog,
      // Log correlation only (see `ToolBrokerDeps.sessionId`) — the CONNECTION,
      // so a tool dispatch stays traceable to the one socket that made it.
      sessionId: connectionId,
      backgroundTools,
      // The gateway-native FOREGROUND tools — the five skill tools plus (when
      // memory is on) the four memory tools — keyed under the reserved
      // `"native"` namespace by the broker's `serverOf`, so a stored
      // `native[tool]` override bites and a parent's `off` is honoured.
      nativeTools,
      // The per-session inbound gate (T10): every foreground tool result is
      // screened through it before the result cap, and its risk level feeds the
      // PDP's escalation on side-effecting tools.
      inboundGate,
      config: orchestratorCfg.tools,
      // Real L3 confirm round-trip (spec §5.3): fans `permission.request` to
      // EVERY window attached to this session and blocks the dispatch until
      // the first of them answers, the config timeout fires (auto-deny), or
      // the session is torn down. The hook owns both conversions — minting the
      // session-global requestId, and turning an unanswerable decision back
      // into the `ConfirmUnavailableError` this seam is contracted on.
      requestConfirm: createConfirmHook(permissions, orchestratorCfg.permission.request_timeout_ms),
      // The person's own per-tool settings. A READER, not the map: it is
      // consulted per turn and per dispatch, so a Settings save lands on the
      // next turn without reopening the WS — the same reason
      // user-model-provider.ts resolves the model per request. Bound to the
      // CAPABILITY's owner, never the ambient principal (spec §3.2).
      toolPermissions: createToolPermissionsReader({
        profileStore,
        userId: capability.ownerUserId,
      }),
      // BOTH sides, always — the projector's row lifetime (runtime/task-list.ts)
      // and the wire frame (turn-emitter.ts's `delegationProgress`) are two
      // independent consumers of the same event, neither a replacement for the
      // other. Dropping the emitter call would silently stop `delegation.progress`
      // reaching the client; dropping the runtime call is the bug this round
      // fixes (a background row that never leaves the strip).
      onDelegationProgress: (p) => {
        runtimeRef?.noteDelegationProgress(p);
        emitter.delegationProgress(p);
      },
    });
    // Kick off this session's own MCP list-tools warm-up AND its first
    // permission read now, not on the first turn. `ready()` resolves both;
    // the ReAct loop awaits it again at every turn boundary.
    void broker.ready();

    log.info("session-runtime.factory.build", {
      userId: principal.userId,
      conversationId,
      connectionId,
    });

    // Per-session system prompt = process-wide base + THIS user's skill index,
    // composed ONCE here (Invariant A: byte-stable within a session). `list()`
    // is read now, at construction — NOT per turn; a skill written mid-session
    // is picked up by the NEXT session's build, keeping the cache-stable prefix
    // fixed for every turn of this one.
    const skillPrompt = composeSessionSystemPrompt(
      resolveSystemPrompt(),
      skillStore.list(),
      orchestratorCfg.skills.max_index_entries,
      loadSkillIndexPreamble({}),
    );
    // The memory block (Memory System spec §4.5) sits AFTER the skill index in
    // the session-stable prefix, composed ONCE here (same Invariant A: byte-
    // stable within a session, so a memory_write mid-turn lands in the NEXT
    // session's build, never mutating this one's cache-stable prefix). A child
    // principal never sees `@adults`-tagged content. Private scope only in S1.
    // Null `sessionMemory` (master switch off) leaves the skill prompt as-is.
    const memoryPrompt = sessionMemory ? sessionMemory.augmentPrompt(skillPrompt) : skillPrompt;
    const sessionSystemPrompt = sessionCalendar?.nudge
      ? `${memoryPrompt}\n\n${sessionCalendar.nudge}`
      : memoryPrompt;

    const runtime = buildSessionRuntime({
      principal,
      // The store's own vocabulary for a partition is `sessionId`; the value
      // is the DURABLE conversation, never this socket. See that field's doc
      // comment in session-runtime.ts.
      sessionId: conversationId,
      accessManager,
      // `store.db_filename` (config.yaml#store) — the live session-store db this
      // runtime opens. Threaded so an operator override is honoured.
      dbFileName,
      // Bound to THIS session's user, so every request runs the model that user
      // selected in Settings rather than one config.yaml value for the whole
      // household. See user-model-provider.ts.
      provider: provider.forUser(principal.userId),
      broker,
      emitter,
      // Already wrapping `emitter` above — handed in so the runtime does not
      // wrap a second time and double every delta into `textSoFar`.
      turnState,
      systemPrompt: sessionSystemPrompt,
      timeZone: resolveTimeZone(),
      // Prompt tiers 3 and 5 (context/session-block.ts, situation-block.ts).
      // Composed HERE because this is the only scope holding all of their
      // collaborators — the principal, the household roster, this session's
      // window set, its background registry and its audio authority.
      sessionBlock: createSessionBlockRenderer({
        clock: { nowMs: () => Date.now() },
        timeZone: resolveTimeZone(),
        identity: {
          async describe() {
            if (!auth) return { speaking: principal.userId, household: [] };
            const listed = await auth.listUsersPublic();
            const users = listed.ok ? listed.value : [];
            const me = users.find((u) => u.userId === principal.userId);
            return {
              speaking: me?.displayName ?? principal.userId,
              household: users.filter((u) => u.userId !== principal.userId).map((u) => u.displayName),
            };
          },
        },
        // A conversation the store already has entries for is one the person is
        // picking back up; `lastActiveAtMs` is what makes "hours ago" legible.
        continuity: {
          describe() {
            // Short-lived by design, matching session-binding's own rule: a
            // second live handle on the same WAL for the life of the session
            // is not worth a question asked once.
            const store = openSessionStore(accessManager.grant(principal, "session-store"), dbFileName);
            try {
              const prior = store.readSession(conversationId);
              const last = prior[prior.length - 1];
              return last === undefined ? { kind: "new" } : { kind: "resumed", lastActiveAtMs: last.createdAt };
            } finally {
              store.close();
            }
          },
        },
        sessionId: conversationId,
      }),
      situationBlock: createSituationBlockRenderer({
        speech: {
          spoken: async () => (audioPolicy ? audioPolicy.shouldSpeak() : false),
        },
        surfaces: { count: attachedWindows },
        work: { backgroundTaskCount: () => broker.background.count() },
        sessionId: conversationId,
        // The per-turn spark's memory closure — reads THIS turn's cached recall
        // synchronously (primed by the runtime at turn start). Omitted when the
        // deep-memory app is not wired, so the block renders exactly as before.
        ...(spark ? { memory: () => spark.current() } : {}),
      }),
      config: orchestratorCfg,
      voice: voice ?? null,
      // Primed at turn start, before the first provider call, feeding the memory
      // closure above. Null when the deep-memory app is not wired.
      spark,
      onWorkSettled,
      onDispose: () => sessionCalendar?.close(),
    });
    // Fills the slot `onDelegationProgress` above closed over — see that
    // comment for why this is safe despite running after the broker (and its
    // callback) already exist.
    runtimeRef = runtime;

    // The session's OBSERVABLE WORK (task 8), assembled here because this is
    // the only scope holding all three producers. Every member a GETTER: the
    // retention policy re-reads them on every evaluation and again immediately
    // before disposing, so a latched value would be exactly the "a check that
    // passed at time T" bug the policy exists to avoid.
    const work: SessionWorkSignals = {
      get isTurnInFlight() {
        return runtime.running;
      },
      get hasPendingForegroundTool() {
        return broker.foregroundInFlight > 0;
      },
      get hasOutstandingPrompt() {
        return permissions.pendingCount > 0;
      },
      get newestBackgroundTaskStartedAtMs() {
        return broker.background.newestStartedAtMs();
      },
      // Session titling (spec §6) — the auxiliary-task seam's first producer.
      // A titling round trip starts AFTER the turn that triggered it settled,
      // so `isTurnInFlight` is already false and this is the only term holding
      // the session: without it, the last window closing between the reply and
      // the title's arrival disposes the runtime and the title lands nowhere.
      get hasAuxiliaryTaskInFlight() {
        return runtime.hasAuxiliaryTaskInFlight;
      },
    };

    // Closes the delegateTask fire-and-steer loop (spec §5.2/§5.4): the
    // broker is necessarily built BEFORE this runtime (it's a runtime
    // constructor dep), so the completion sink can't be wired until now,
    // right after `runtime` exists. A background tool's settled result
    // (e.g. delegateTask's Hermes one-shot output) becomes a
    // `background-completion` stimulus — SessionRuntime maps that to a
    // fresh `trigger` entry and fires/steers the next turn. See
    // tool-broker.ts's `setBackgroundCompletionSink` doc comment and
    // delegate-task.ts's file header for the full mechanism.
    broker.setBackgroundCompletionSink((result) => {
      const note = composeBackgroundCompletionNote({
        taskId: result.taskId,
        toolName: result.toolName,
        request: result.request,
        output: result.content,
        isError: result.isError,
        requestEchoChars: orchestratorCfg.tools.background_completion_request_echo_chars,
        // The SAME per-session gate the broker screens tool results with:
        // a delegated payload is the lowest-trust input there is (spec §5.3),
        // so it is screened under the `background_completion` channel before it
        // is fenced into the note.
        inboundGate,
        sessionId: conversationId,
      });
      runtime.submit({ kind: "background-completion", note });
    });

    return { runtime, permissions, work };
  };
}
