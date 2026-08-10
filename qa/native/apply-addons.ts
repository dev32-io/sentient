/** Drives the REAL system orchestrator against the shipped config + templates,
 *  so an addon-topology change can be verified through the production path
 *  (docker-driver, its publish/network guards, the health probes) instead of
 *  through hand-written `docker run` commands that prove only what the author
 *  remembered to type.
 *
 *  Usage, from the repo root, with the gateway NOT running (one owner per
 *  container set):
 *
 *      HOST_CONFIG_DIR=~/.sentient/gateway/config \
 *        bun qa/native/apply-addons.ts egress-proxy ingress-proxy searxng searxng-mcp fetch-mcp
 *
 *  Named services are applied as a subset in dependency order. With no
 *  arguments it applies everything in `managed_services`, native services
 *  included — which is rarely what you want on a dev box.
 *
 *  Exits non-zero unless every applied non-optional service reached `ready`.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createInternalSecretsStore } from "../../gateway/src/admin/internal-secrets-store.js";
import { makeSecretAccessor } from "../../gateway/src/bootstrap/secret-accessor.js";
import { loadGatewayConfig } from "../../gateway/src/config/gateway-config.js";
import { createGatewayLogger, getLog } from "../../gateway/src/logging/logger.js";
import { defaultHealthIO } from "../../gateway/src/system-orchestrator/health-io.js";
import { createSystemOrchestratorService } from "../../gateway/src/system-orchestrator/index.js";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SENTIENT_HOME = join(homedir(), ".sentient");
/** Where the gateway itself keeps internal-secrets.json (`~/.sentient/gateway/
 *  data`). Pointing anywhere else makes the store GENERATE a fresh searxng
 *  secret instead of loading the live one, which then recreates searxng with a
 *  secret the gateway does not know. */
const GATEWAY_DATA_DIR = join(SENTIENT_HOME, "gateway", "data");
/** Matches the gateway's own poll cadence + apply budget (phase-orchestrator). */
const POLL_INTERVAL_MS = 1000;
const APPLY_TIMEOUT_MS = 5 * 60 * 1000;

const log = getLog(["sentient", "qa", "apply-addons"]);

async function main(): Promise<number> {
  await createGatewayLogger({ logLevel: "info" });

  const hostConfigDir = process.env.HOST_CONFIG_DIR;
  if (!hostConfigDir) {
    // Fail loudly: templates bind-mount ${HOST_CONFIG_DIR}/<svc>/<file>, and an
    // empty value resolves to an absolute path outside the operator's tree that
    // docker would happily auto-create as an empty directory.
    log.error("apply.missing-host-config-dir", { reason: "HOST_CONFIG_DIR is required" });
    return 1;
  }

  // The gateway's own loader, so this also proves config.yaml still validates
  // under the shipped schema rather than merely parsing as YAML.
  const managedServicesConfig = loadGatewayConfig(join(REPO_ROOT, "gateway", "config.yaml")).managed_services;
  if (!managedServicesConfig) {
    log.error("apply.no-managed-services", { reason: "config.yaml has no managed_services block" });
    return 1;
  }

  // Same store the gateway uses, so searxng is recreated with the secret it
  // already has rather than a fresh one. Never read into a log line.
  const internalStore = createInternalSecretsStore(GATEWAY_DATA_DIR);
  const loaded = await internalStore.loadOrInit();
  if (!loaded.ok) {
    log.error("apply.internal-secrets-failed", { reason: loaded.error.kind });
    return 1;
  }

  const orchestrator = await createSystemOrchestratorService({
    managedServicesConfig,
    templateDir: join(REPO_ROOT, "gateway", "templates", "services"),
    secrets: makeSecretAccessor(null, internalStore),
    healthIO: defaultHealthIO,
    pollIntervalMs: POLL_INTERVAL_MS,
    applyTimeoutMs: APPLY_TIMEOUT_MS,
    nativeRunDir: join(SENTIENT_HOME, "run"),
    hostEnv: {
      HOST_HOME: homedir(),
      HOST_CONFIG_DIR: hostConfigDir,
      TZ: process.env.TZ ?? "",
      HOST_DOCKER_GID: process.env.HOST_DOCKER_GID ?? "",
      SENTIENT_CODE: process.env.SENTIENT_CODE ?? "",
    },
  });

  const targets = process.argv.slice(2);
  log.info("apply.begin", { targets: targets.length > 0 ? targets : "ALL" });
  const status = targets.length > 0 ? await orchestrator.applySubset(new Set(targets)) : await orchestrator.applyAll();

  const applied = targets.length > 0 ? status.services.filter((s) => targets.includes(s.name)) : status.services;
  for (const s of applied) {
    log.info("apply.result", { service: s.name, state: s.state, optional: s.optional, lastError: s.lastError });
  }
  const failed = applied.filter((s) => s.state !== "ready" && !s.optional);
  log.info("apply.done", { state: status.state, applied: applied.length, failedRequired: failed.length });
  return failed.length > 0 ? 1 : 0;
}

process.exit(await main());
