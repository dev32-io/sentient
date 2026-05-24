import { createGatewayServices } from "./bootstrap/create-gateway-services.ts";
import { createMcpHost } from "./bootstrap/create-mcp-host.ts";
import { loadLoggingConfig, loadStartupConfig } from "./config/startup-config.ts";
import { createGatewayLogger, getLog } from "./logging/logger.ts";
import type { UpdateUserSettingsPatch } from "./mcp-host/tools/update-user-settings.js";
import { createPolicyEngine } from "./security/policy-engine.js";
import { loadMcpPolicy } from "./security/policy-loader.js";
import { createAmbientEventLog } from "./sensors/ambient-event-log.js";
import { HomeAssistantObserver } from "./sensors/home-assistant-observer.js";
import { createGatewayServer } from "./server.ts";

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
const services = await createGatewayServices(config);

const state = await services.installState.load();
if (!state.bootstrap_complete) {
  await services.unlockCode.ensure();
  log.info("bootstrap-mode", { unlockCodePath: services.unlockCodePath });
} else {
  await services.unlockCode.clear(); // belt-and-braces if leftover
}

const server = createGatewayServer({ port: config.port, host: config.host, services });

log.info("gateway-started", { host: server.hostname, port: server.port });

// ---------------------------------------------------------------------------
// MCP host server — Phase 1.7+
// ---------------------------------------------------------------------------
// When hermes config is present, start one Unix socket per enabled user
// profile: /run/sentient/mcp-<userId>.sock. Each socket carries a userId
// binding so tools (identify_user, pause_audio, etc.) can resolve sessions.
// ---------------------------------------------------------------------------

let mcpHost: Awaited<ReturnType<typeof createMcpHost>> | null = null;

if (config.hermes) {
  // pause_audio / resume_audio are still stubs — we don't yet have a
  // pause/resume primitive on the audio pipeline (barge-in cancels, which
  // isn't the same). update_user_settings is real: it delegates to the
  // per-session SessionControls registered by ws-session-configure.
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
    router: services.sessionRouter,
    userStore: services.auth.users,
    audio: stubAudio,
    userSettings: userSettingsControls,
    policy: policyEngine,
  });

  // Keep per-user MCP sockets in lockstep with admin user create/delete.
  // Without this, users provisioned post-boot have no socket and their hermes
  // worker exhausts its MCP retries during startup, running tool-less for life.
  const hostRef = mcpHost;
  services.userLifecycle.onCreated((userId) => hostRef.addUser(userId));
  services.userLifecycle.onDeleted((userId) => hostRef.removeUser(userId));

  await mcpHost.start();
}

// ---------------------------------------------------------------------------
// Home Assistant Observer — Phase 1.5+
// ---------------------------------------------------------------------------
const ambientLog = createAmbientEventLog(config.hermes?.ambient?.event_log?.retention_count ?? 10_000);

let haObserver: HomeAssistantObserver | null = null;
if (config.hermes?.home_assistant_observer?.enabled) {
  const haObs = config.hermes.home_assistant_observer;
  const haToken = process.env[haObs.token_env] ?? "";
  if (!haToken) {
    log.warn("ha-observer.no-token", { env: haObs.token_env });
  } else if (!haObs.url) {
    log.warn("ha-observer.no-url");
  } else {
    haObserver = new HomeAssistantObserver(
      {
        url: haObs.url,
        accessToken: haToken,
        watchDomains: haObs.watch_domains ?? [],
        watchEntities: haObs.watch_entities ?? [],
        ignoreEntities: haObs.ignore_entities ?? [],
        duplicateStateWindowMs: haObs.duplicate_state_window_ms ?? 5000,
      },
      ambientLog,
    );
    haObserver.start();
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  log.info("shutdown", { signal: "SIGINT" });
  haObserver?.stop();
  if (mcpHost) await mcpHost.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  log.info("shutdown", { signal: "SIGTERM" });
  haObserver?.stop();
  if (mcpHost) await mcpHost.stop();
  process.exit(0);
});

export { server };
