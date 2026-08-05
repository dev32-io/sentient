import { join } from "node:path";
import { riskConfigSchema } from "@sentient/config";
import type { OrchestratorConfig } from "@sentient/config";
import { ensureTlsMaterial } from "@sentient/tls";
import { type AccessManager, createAccessManager } from "../access/access-manager.js";
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
import { type TimeZoneProvider, createHostTimeZoneProvider } from "../context/message-time.js";
import { createSessionBlockRenderer } from "../context/session-block.js";
import { createSituationBlockRenderer } from "../context/situation-block.js";
import { loadSystemPrompt } from "../context/system-prompt-loader.ts";
import { type ExternalToolSlot, createExternalToolSlot } from "../external-tools/external-tool-slot.js";
import { getLog } from "../logging/logger.ts";
import { createPersonalityStore } from "../profile-store/personality-store.js";
import type { PersonalityStore } from "../profile-store/personality-store.js";
import { type ProfileStore, createProfileStore } from "../profile-store/profile-store.ts";
import { type TemplateLoader, createTemplateLoader } from "../profile-store/template-loader.ts";
import type { CreateSessionRuntime } from "../runtime/session-handles.js";
import { createConfirmHook, createSessionPermissionBroker } from "../runtime/session-permission-broker.js";
import type { SessionWorkSignals } from "../runtime/session-retention.js";
import { createSessionRuntime as buildSessionRuntime } from "../runtime/session-runtime.js";
import { createTurnStateTracker } from "../runtime/turn-state-snapshot.js";
import { createPolicyEngine } from "../security/policy-engine.js";
import type { PolicyEngine } from "../security/policy-engine.js";
import { loadMcpPolicy } from "../security/policy-loader.js";
import type { GatewayTlsMaterial } from "../session-handlers/ws-handlers.ts";
import { type SessionStore, openSessionStore } from "../store/session-store.js";
import { composeBackgroundCompletionNote } from "../tools/background-completion-note.js";
import { createDelegateTaskRunner, delegateTaskDefinition } from "../tools/delegate-task.js";
import { createDelegationGuard, loadDelegationFrontmatterDir } from "../tools/delegation-guard.js";
import type { DelegationGuard } from "../tools/delegation-guard.js";
import { createHermesRunner } from "../tools/hermes-runner.js";
import type { HermesRunner } from "../tools/hermes-runner.js";
import { createMcpClient } from "../tools/mcp-client.js";
import type { McpClient } from "../tools/mcp-client.js";
import { createPromptClassifier } from "../tools/prompt-classifier.js";
import { createToolBroker } from "../tools/tool-broker.js";
import type { BackgroundToolRunner } from "../tools/tool-broker.js";
import type { TextStreamSynthesizer } from "../tts/text-stream-synthesizer.ts";
import type { AuthService } from "../user-auth/auth-service.js";
import { getHermesProfileDir } from "../user-auth/paths.js";
import { hashPin } from "../user-auth/pin-service.js";
import { createTextStreamSynthesizer } from "./content-tts-factory.ts";
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

/** One provider for the process: the zone is a property of where the household
 *  is, not of a session, and resolving it per session would re-log it per
 *  socket. Swapped for a location-derived provider when the app learns where
 *  the house actually is — see context/message-time.ts. */
const timeZone: TimeZoneProvider = createHostTimeZoneProvider();

function resolveSystemPrompt(): string {
  if (systemPrompt !== null) return systemPrompt;
  systemPrompt = loadSystemPrompt({});
  log.info("system-prompt.resolved", { chars: systemPrompt.length });
  return systemPrompt;
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
}

export async function runPhaseServices(input: PhaseServicesInput): Promise<PhaseServicesOutput> {
  const { cfg, auth, secretsStore } = input;

  const stt = cfg.stt ? createSttService(cfg) : null;
  const tts = createTtsService({ cfg });
  const tls = cfg.tls.enabled
    ? ensureTlsMaterial({ hostnames: cfg.tls.hostnames, certsDir: cfg.tls.certsDir, logTag: "gateway" })
    : undefined;

  const createSynthesizerFor = (getVoiceId: () => Promise<string | null>): TextStreamSynthesizer | null => {
    const openSession: TTSSessionOpener = asStrictFactory(tts, getVoiceId);
    return createTextStreamSynthesizer(cfg, openSession);
  };

  // BEFORE the orchestrator services: the provider factory resolves each user's
  // selected model out of their profile, so it needs this store.
  const profileStore = createProfileStore();
  const templateLoader = createTemplateLoader();

  const { accessManager, mcpClient, provider, createSessionRuntime, delegatedExternalTool } =
    await buildOrchestratorServices(cfg, secretsStore, profileStore, auth);

  const applyDeps: ApplyDeps = createApplyDeps({
    profileStore,
    templateLoader,
    mcpCatalog: cfg.mcpCatalog,
    secretsStore: secretsStore ?? null,
  });

  // Two flavors:
  //   - …Config   → config.yaml only; safe for apply + boot-migration.
  //   - …Initial  → config.yaml + SOUL.md; used once at user creation.
  const renderInnerProfileFor = buildRenderInnerProfile(applyDeps, { writeSoul: false });
  const renderInitialInnerProfileFor = buildRenderInnerProfile(applyDeps, { writeSoul: true });
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
            log.warn("hermes-profile.skipped", { userId, reason: "orchestrator-not-configured" });
            return { ok: false, error: "cli-error" as const };
          },
      userLifecycle,
    });
  }

  // Boot migration: rename per-user tools.enabled.duckduckgo →
  // tools.enabled.searxng + tools.enabled.fetch. Idempotent.
  if (cfg.hermes) {
    await migrateWebToolsEnabled({ userStore: auth.users, profileStore });
  }

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
// PolicyEngine/DelegationGuard/HermesRunner) once, resolves the orchestrator's
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
  const accessManager = createAccessManager({ userDataRoot: cfg.access.user_data_root });
  const mcpClient = createMcpClient(cfg.mcpCatalog, {});
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
    log.info("orchestrator.disabled", { reason: "no orchestrator: block in config.yaml" });
    return { accessManager, mcpClient, provider: null, createSessionRuntime: null, delegatedExternalTool };
  }

  const orchestratorCfg = cfg.orchestrator;
  const provider = await buildOrchestratorProvider(orchestratorCfg, secretsStore, profileStore);

  const policyEngine = createPolicyEngine(loadMcpPolicy());
  const frontmatterDir = resolveDelegationFrontmatterDir(orchestratorCfg.delegation.frontmatter_dir);
  const delegationFrontmatter = loadDelegationFrontmatterDir(frontmatterDir);
  const promptClassifier = createPromptClassifier({ riskConfig: riskConfigSchema.parse({}) });
  const delegationGuard = createDelegationGuard({ frontmatter: delegationFrontmatter, classifier: promptClassifier });
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
    policyEngine,
    delegationGuard,
    hermesRunner,
    delegatedExternalTool,
    auth: auth ?? null,
  });

  return { accessManager, mcpClient, provider, createSessionRuntime, delegatedExternalTool };
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
    log.warn("mcp-client.warmup.failed", { reason: err instanceof Error ? err.message : String(err) });
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
    log.warn("orchestrator.provider.secrets-read-failed", { reason: activeLlm.error.kind });
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
  policyEngine: PolicyEngine;
  delegationGuard: DelegationGuard;
  hermesRunner: HermesRunner;
  delegatedExternalTool: ExternalToolSlot;
  /** Names the household for the `<session>` block; null in a headless
   *  harness, which then renders the block without those lines. */
  auth: AuthService | null;
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
  const { orchestratorCfg, accessManager, provider, mcpClient, policyEngine, delegationGuard, hermesRunner } = deps;
  const { delegatedExternalTool, auth } = deps;

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

    const broker = createToolBroker({
      mcp: mcpClient,
      policy: policyEngine,
      store: brokerStore,
      principal,
      capability,
      // Log correlation only (see `ToolBrokerDeps.sessionId`) — the CONNECTION,
      // so a tool dispatch stays traceable to the one socket that made it.
      sessionId: connectionId,
      backgroundTools,
      config: orchestratorCfg.tools,
      // Real L3 confirm round-trip (spec §5.3): fans `permission.request` to
      // EVERY window attached to this session and blocks the dispatch until
      // the first of them answers, the config timeout fires (auto-deny), or
      // the session is torn down. The hook owns both conversions — minting the
      // session-global requestId, and turning an unanswerable decision back
      // into the `ConfirmUnavailableError` this seam is contracted on.
      requestConfirm: createConfirmHook(permissions, orchestratorCfg.permission.request_timeout_ms),
      onDelegationProgress: (p) => emitter.delegationProgress(p),
    });
    void broker.definitions(); // kick off this session's own MCP list-tools warm-up now, not on the first turn.

    log.info("session-runtime.factory.build", { userId: principal.userId, conversationId, connectionId });

    const runtime = buildSessionRuntime({
      principal,
      // The store's own vocabulary for a partition is `sessionId`; the value
      // is the DURABLE conversation, never this socket. See that field's doc
      // comment in session-runtime.ts.
      sessionId: conversationId,
      accessManager,
      // Bound to THIS session's user, so every request runs the model that user
      // selected in Settings rather than one config.yaml value for the whole
      // household. See user-model-provider.ts.
      provider: provider.forUser(principal.userId),
      broker,
      emitter,
      // Already wrapping `emitter` above — handed in so the runtime does not
      // wrap a second time and double every delta into `textSoFar`.
      turnState,
      systemPrompt: resolveSystemPrompt(),
      timeZone,
      // Prompt tiers 3 and 5 (context/session-block.ts, situation-block.ts).
      // Composed HERE because this is the only scope holding all of their
      // collaborators — the principal, the household roster, this session's
      // window set, its background registry and its audio authority.
      sessionBlock: createSessionBlockRenderer({
        clock: { nowMs: () => Date.now() },
        timeZone,
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
            const store = openSessionStore(accessManager.grant(principal, "session-store"));
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
        speech: { spoken: async () => (audioPolicy ? audioPolicy.shouldSpeak() : false) },
        surfaces: { count: attachedWindows },
        work: { backgroundTaskCount: () => broker.background.count() },
        sessionId: conversationId,
      }),
      config: orchestratorCfg,
      voice: voice ?? null,
      onWorkSettled,
    });

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
      });
      runtime.submit({ kind: "background-completion", note });
    });

    return { runtime, permissions, work };
  };
}
