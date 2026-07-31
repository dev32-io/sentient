import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGatewayServices } from "./bootstrap/create-gateway-services.ts";
import { createMcpHost } from "./bootstrap/create-mcp-host.ts";
import { type SingleInstanceIo, acquireSingleInstance, describeConflict } from "./bootstrap/single-instance.ts";
import { loadLoggingConfig, loadStartupConfig, resolveSentientHome } from "./config/startup-config.ts";
import { createHermesExternalTool } from "./external-tools/hermes-external-tool.ts";
import { createGatewayLogger, getLog } from "./logging/logger.ts";
import { createUnavailableSessionLookup } from "./mcp-host/active-session-lookup.ts";
import type { UpdateUserSettingsPatch } from "./mcp-host/tools/update-user-settings.js";
import { createPolicyEngine } from "./security/policy-engine.js";
import { loadMcpPolicy } from "./security/policy-loader.js";
import { createGatewayServer } from "./server.ts";

/** `~/.sentient/run` — the gateway's own runtime handles: the per-user MCP
 *  sockets, the native services' pid files, and the single-instance claim. */
const RUN_SUBDIR = "run";
const CLAIM_FILE = "gateway.claim";

const loggingConfig = loadLoggingConfig();
await createGatewayLogger({
  ...(loggingConfig.logLevel ? { logLevel: loggingConfig.logLevel } : {}),
  enableFile: true,
  logDir: loggingConfig.logDir,
  retentionDays: loggingConfig.retentionDays,
  levelOverrides: loggingConfig.levelOverrides,
});

const log = getLog(["sentient"]);
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
  log.error("single-instance.refused", { reason: describeConflict(claim.heldBy, config.port, Date.now()) });
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
  const mcpPolicy = loadMcpPolicy();
  const policyEngine = createPolicyEngine(mcpPolicy);

  mcpHost = await createMcpHost({
    config: config.hermes,
    router: activeSessions,
    userStore: services.auth.users,
    audio: stubAudio,
    userSettings: userSettingsControls,
    policy: policyEngine,
    // The proxied tier (task 9g): the delegated agent reaches the operator's
    // `mcp_catalog` through the gateway's own socket, so every one of those
    // calls passes the PDP. Same shared McpClient the gateway's own loop uses —
    // never a second dialer to the same servers.
    ...(config.orchestrator
      ? { proxy: { mcpClient: services.mcpClient, toolsConfig: config.orchestrator.tools } }
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
const server = createGatewayServer({ port: config.port, host: config.host, services });

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
