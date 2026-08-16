import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createGatewayServices } from "./bootstrap/create-gateway-services.ts";
import { createMcpHost } from "./bootstrap/create-mcp-host.ts";
import { claimSingleEvaluation, describeHotReloadRefusal } from "./bootstrap/single-evaluation.ts";
import { type SingleInstanceIo, acquireSingleInstance, describeConflict } from "./bootstrap/single-instance.ts";
import { loadLoggingConfig, loadStartupConfig, resolveSentientHome } from "./config/startup-config.ts";
import { createHermesExternalTool } from "./external-tools/hermes-external-tool.ts";
import { createGatewayLogger, getLog } from "./logging/logger.ts";
import { createUnavailableSessionLookup } from "./mcp-host/active-session-lookup.ts";
import type { UpdateUserSettingsPatch } from "./mcp-host/tools/update-user-settings.js";
import { createGatewayServer } from "./server.ts";
import { createCredentialRevoker } from "./session-handlers/credential-revocation.ts";

/** `~/.sentient/run` — the gateway's own runtime handles: the per-user MCP
 *  sockets, the native services' pid files, and the single-instance claim. */
const RUN_SUBDIR = "run";
const CLAIM_FILE = "gateway.claim";

// ---------------------------------------------------------------------------
// HOST_HOME must exist BEFORE the first config read, and this is the only place
// early enough.
//
// `config.yaml` resolves every `${VAR}` against `process.env` while it is being
// LOADED (shared/config/src/loader.ts), and a missing var becomes the empty
// string — not a literal left for someone downstream to catch. The native
// addons' paths are all `${HOST_HOME}/.sentient/…`, so with it unset both
// services were launched pointing at `/.sentient/whisper-stt/config/config.yaml`
// and died on `config file not found` within half a second, every boot. The
// prod plist sets HOST_HOME explicitly to exactly this value; defaulting it
// here is what makes a dev shell, a bare `bun src/main.ts` and the compiled
// binary agree with prod instead of silently degrading.
// ---------------------------------------------------------------------------
process.env.HOST_HOME ||= homedir();

const loggingConfig = loadLoggingConfig();
await createGatewayLogger({
  ...(loggingConfig.logLevel ? { logLevel: loggingConfig.logLevel } : {}),
  enableFile: true,
  logDir: loggingConfig.logDir,
  retentionDays: loggingConfig.retentionDays,
  levelOverrides: loggingConfig.levelOverrides,
});

const log = getLog(["sentient"]);

// ---------------------------------------------------------------------------
// Single-EVALUATION guard — before the single-INSTANCE claim, because it is the
// narrower question and the cheaper answer.
//
// The dev command is `bun --watch` (a real restart per change), not `bun --hot`.
// The choice was measured, not assumed:
//
//   * A reload re-runs this whole file, so it re-runs `reconcile()` ->
//     `reapOrphans()` + `applyAll()`, and `applyAll` calls `driver.recreate()`
//     UNCONDITIONALLY for every service. So a `--hot` reload already pays the
//     same ~12-15 s fleet churn a process restart pays (all 7 docker containers
//     recreated, both native addons respawned). Its only saving is Bun's spawn
//     plus module parse — 1.3 s of a ~15 s reload, under 10%.
//   * `--watch` releases everything the kernel and the VM own: measured, its
//     reloads reset `globalThis` and stop the previous evaluation's timers,
//     while `--hot` leaves them all running (three probe timers still ticking
//     concurrently after two reloads).
//   * `--watch` keeps the same OS pid, so the single-instance claim below is a
//     self-match across a reload — no release, no window for a second gateway.
//   * Detached native children, docker containers and the claim are owned by
//     the MACHINE, not by this evaluation, and survive either way.
//
// A teardown registry for `--hot` would have to dispose the watchdog, the MCP
// host's per-user unix listeners, the signal handlers, the provider/STT/TTS
// sockets and every future resource — and anything missed reproduces this
// defect somewhere new. Buying under 10% of one reload with that standing
// obligation is a bad trade for a process that owns unix sockets, detached
// children and docker containers.
//
// This guard is what makes `bun --hot` typed from muscle memory fail loudly
// instead of silently corrupting the machine's addon fleet.
// ---------------------------------------------------------------------------
const evaluation = claimSingleEvaluation(
  globalThis as unknown as Record<PropertyKey, unknown>,
  process.pid,
  Date.now(),
);
if (!evaluation.ok) {
  // ONE LINE PER LINE — same reason as the single-instance conflict below: the
  // formatter caps any single property at the 120-char preview, so a multi-line
  // operator message logged as one `reason` loses its fix commands.
  for (const line of describeHotReloadRefusal(evaluation.previous, Date.now()).split("\n")) {
    if (line.trim().length > 0) log.error("hot-reload.refused", { line });
  }
  process.exit(1);
}

const config = loadStartupConfig();

// ---------------------------------------------------------------------------
// Single-instance claim — FIRST, before anything that owns a machine-wide
// singleton.
//
// `createGatewayServices` below starts the boot reconcile, which spawns and
// supervises the native addons; `Bun.serve` further down opens the per-user
// tool sockets and session stores. A second gateway fights over all three, and
// on the native addons it presents as the defect this claim exists to stop: two
// supervisors racing one port, each adopting the other's process as healthy.
// The claim must therefore be taken before the orchestrator applies, not merely
// before the listener binds.
// ---------------------------------------------------------------------------
const claimIo: SingleInstanceIo = {
  readClaim: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null; // absent is the normal first-boot case, not a failure
    }
  },
  writeClaim: (path, body) => {
    mkdirSync(join(resolveSentientHome(), RUN_SUBDIR), { recursive: true });
    writeFileSync(path, body, "utf8");
  },
  removeClaim: (path) => rmSync(path, { force: true }),
  isAlive: (pid) => {
    try {
      process.kill(pid, 0); // signal 0 = existence check, delivers nothing
      return true;
    } catch {
      return false;
    }
  },
  now: () => Date.now(),
  selfPid: process.pid,
};

const claim = acquireSingleInstance(join(resolveSentientHome(), RUN_SUBDIR, CLAIM_FILE), config.port, claimIo);
if (!claim.ok) {
  log.error("single-instance.refused", {
    heldByPid: claim.heldBy.pid,
    heldByPort: claim.heldBy.port,
    wantedPort: config.port,
    reason: "another sentient gateway already holds this machine's single instance slot",
  });
  // ONE LINE PER LINE, on purpose. describeConflict is a multi-line operator
  // message ending in the two commands that resolve it, and the log formatter
  // caps any single property at the ≤120-char preview — logging the whole block
  // as one `reason` truncated it mid-sentence and the fix commands never
  // printed. Verified by driving a real second instance.
  for (const line of describeConflict(claim.heldBy, config.port, Date.now()).split("\n")) {
    if (line.trim().length > 0) log.error("single-instance.conflict", { line });
  }
  process.exit(1);
}
// Captured here, not read off `claim` inside shutdown(): a hoisted function
// declaration is outside the guard's narrowing, so the union would resurface.
const releaseInstanceClaim = claim.release;

const services = await createGatewayServices(config);

const state = await services.installState.load();
if (!state.bootstrap_complete) {
  await services.unlockCode.ensure();
  log.info("bootstrap-mode", { unlockCodePath: services.unlockCodePath });
} else {
  await services.unlockCode.clear(); // belt-and-braces if leftover
}

// ---------------------------------------------------------------------------
// Credential revocation — a role change or a deletion closes that account's
// live sockets (plan 2026-08-07-tool-permissions task 2c).
//
// The credential floor already makes the account's token stop validating; this
// is what makes the client see it NOW rather than on its next request. Both
// events land on the same revoker because the remedy is the same: destroy the
// authenticated context and let a fresh sign-in rebuild it from the record.
//
// UNCONDITIONAL, and NOT beside the `onCreated`/`onDeleted` lines below —
// those sit inside `if (config.hermes)`, and a security mechanism that a
// missing `hermes:` block silently disables is not a security mechanism.
// ---------------------------------------------------------------------------
const credentialRevoker = createCredentialRevoker({
  registry: services.sessionRegistry,
  sockets: services.authenticatedSockets,
  sessions: services.sessionManager,
});
services.userLifecycle.onRoleChanged((userId) => credentialRevoker.revokeUser(userId, "role-changed"));
services.userLifecycle.onDeleted((userId) => credentialRevoker.revokeUser(userId, "user-deleted"));

// ---------------------------------------------------------------------------
// MCP host server — Phase 1.7+
// ---------------------------------------------------------------------------
// When hermes config is present, start one Unix socket per enabled user
// profile: <hermes.mcp_host.socket_path dir>/mcp-<userId>.sock, resolved by
// mcp-host/socket-path.ts (default `~/.sentient/run/`). Each socket carries a
// userId binding so tools (identify_user, pause_audio, etc.) can resolve
// sessions.
// ---------------------------------------------------------------------------

let mcpHost: Awaited<ReturnType<typeof createMcpHost>> | null = null;

// Gated on `config.hermes` for the socket path (`hermes.mcp_host.socket_path`),
// which is the only thing the MCP host still needs from that block.
if (config.hermes) {
  // Session resolution is unavailable by design, so pause_audio / resume_audio /
  // update_user_settings all fail closed with "no active session". Both consumer
  // sides below are unwired: the audio pipeline has no pause primitive (barge-in
  // cancels, which isn't the same), and nothing registers a session's
  // SessionControls handle (ws-session-configure was stripped to auth+hold in the
  // legacy-brain purge). Plan 2 (SessionRuntime) wires a real resolver together
  // with those producers — never the resolver first, or these tools report
  // success for work that silently did not happen.
  const activeSessions = createUnavailableSessionLookup();
  const stubAudio = {
    async pause(_sessionId: string, _reason?: string) {},
    async resume(_sessionId: string, _reason?: string) {},
  };
  const userSettingsControls = {
    async updateUserSettings(sessionId: string, userId: string, patch: UpdateUserSettingsPatch) {
      const controls = services.sessionControls.get(sessionId);
      if (!controls) {
        log.warn("update_user_settings.unknown-session", { sessionId, userId });
        return;
      }
      await controls.updateUserSettings(sessionId, userId, patch);
    },
  };
  mcpHost = await createMcpHost({
    config: config.hermes,
    router: activeSessions,
    userStore: services.auth.users,
    audio: stubAudio,
    userSettings: userSettingsControls,
    catalog: config.mcpCatalog,
    profileStore: services.profileStore,
    // The proxied tier (task 9g): the delegated agent reaches the operator's
    // `mcp_catalog` through the gateway's own socket, so every one of those
    // calls passes the PDP. Same shared McpClient the gateway's own loop uses —
    // never a second dialer to the same servers.
    ...(config.orchestrator
      ? {
          proxy: {
            mcpClient: services.mcpClient,
            toolsConfig: config.orchestrator.tools,
            accessManager: services.accessManager,
            profileStore: services.profileStore,
            inboundScan: config.inboundScan,
            ...(services.delegatedNativeTools ? { nativeToolsFor: services.delegatedNativeTools } : {}),
          },
        }
      : {}),
  });

  // Keep per-user MCP sockets in lockstep with admin user create/delete.
  // Without this, users provisioned post-boot have no socket and their hermes
  // worker exhausts its MCP retries during startup, running tool-less for life.
  const hostRef = mcpHost;
  services.userLifecycle.onCreated((userId) => hostRef.addUser(userId));
  services.userLifecycle.onDeleted((userId) => hostRef.removeUser(userId));

  await mcpHost.start();

  // -------------------------------------------------------------------------
  // External tools — bound here, RUN at dispatch (defect D11, task 9g).
  //
  // An external tool is one the gateway does not supervise: no lifecycle, no
  // port, no health check. Hermes is the first. Task 9d configured it once per
  // user per boot; that leaves a drift window — the user edits their own hermes
  // profile at 10am and every delegation until the next restart silently gets
  // nothing. So this composition root only BINDS the tool; `delegateTask` runs
  // it in its setup phase, immediately before spawning the delegated agent.
  // There is deliberately no boot-time run and no user-created hook: two
  // writers of one profile entry is a race with no owner.
  //
  // Binding here (and not in `phase-services.ts`) is what the late-bound slot
  // exists for — the tool needs the MCP host's delegated surface, and the host
  // needs the composition root's user store. See external-tool-slot.ts.
  // -------------------------------------------------------------------------
  if (config.orchestrator) {
    services.delegatedExternalTool.set(
      createHermesExternalTool({
        // The profile the delegation RUNS on, so the entry lands where the
        // spawn will read it. The socket inside that entry is still per-user.
        profile: config.orchestrator.delegation.hermes_delegation_profile,
        hostedDelegatedTools: hostRef.delegatedToolNames,
        timeoutMs: config.orchestrator.delegation.hermes_mcp_register_timeout_ms,
        socketBasePath: config.hermes.mcp_host.socket_path,
      }),
    );
  }
}

// Unconditional, and a no-op once a tool was bound above: EVERY boot path must
// settle the slot, or a `delegateTask` on a config with no `hermes:`/
// `orchestrator:` block would wait on a settle that never comes.
services.delegatedExternalTool.sealEmpty(
  "no delegated external tool in this configuration (needs both a hermes: and an orchestrator: block)",
);

// ---------------------------------------------------------------------------
// Accept traffic — LAST, and deliberately so.
//
// `Bun.serve()` starts taking WS connections synchronously, and a connection is
// what builds a SessionRuntime with its `delegateTask` runner. Serving before
// the external-tool slot settled is what let a client that reconnected inside
// the boot window get a delegated agent with no gateway tools (see
// external-tools/external-tool-slot.ts). The slot's settle-gated read already
// makes that self-healing; starting the listener after the settle makes the
// window itself unreachable, which also keeps that read's wait zero-length in
// production.
// ---------------------------------------------------------------------------
const server = createGatewayServer({
  port: config.port,
  host: config.host,
  services,
});

log.info("gateway-started", { host: server.hostname, port: server.port });

// Graceful shutdown. The addon health watchdog is stopped FIRST: a tick that
// fires while the rest of the process is tearing down would re-apply a service
// into a half-dismantled driver.
async function shutdown(signal: string): Promise<never> {
  log.info("shutdown", { signal });
  services.systemOrchestrator?.stopHealthWatch();
  if (mcpHost) await mcpHost.stop();
  // Last, so the slot stays claimed for the whole teardown: a successor that
  // starts while this process is still holding the tool sockets would hit the
  // very conflict the claim exists to name.
  releaseInstanceClaim();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

export { server };
