import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { InstallState } from "../admin/install-state.js";
import type { InternalSecretsStore } from "../admin/internal-secrets-store.js";
import type { SecretsStore } from "../admin/secrets-store.js";
import type { StartupConfig } from "../config/startup-config.ts";
import { getLog } from "../logging/logger.ts";
import { defaultHealthIO } from "../system-orchestrator/health-io.js";
import { type SystemOrchestratorService, createSystemOrchestratorService } from "../system-orchestrator/index.js";
import { makeSecretAccessor } from "./secret-accessor.ts";

const log = getLog(["sentient", "bootstrap", "phase-orchestrator"]);

/** ~/.sentient/run — one pid file per native managed service. */
const NATIVE_RUN_SUBDIR = "run";

export interface PhaseOrchestratorInput {
  readonly cfg: StartupConfig;
  readonly installState: InstallState;
  readonly secretsStore: SecretsStore | null;
  readonly internalSecretsStore: InternalSecretsStore;
  readonly gatewayRuntimeDir: string;
  /** Root of the user-owned mutable state tree (~/.sentient). Code is
   *  root-owned and immutable; anything the gateway writes at runtime — pid
   *  files for native services included — lives here. */
  readonly sentientHome: string;
  /** Container-side path that maps to the host's HOST_CONFIG_DIR. The
   *  gateway writes seed defaults here for services whose templates
   *  reference ${HOST_CONFIG_DIR}/* bind mounts (e.g. egress-proxy). */
  readonly hostConfigDirContainerPath: string;
}

export interface PhaseOrchestratorOutput {
  readonly systemOrchestrator: SystemOrchestratorService | null;
}

/** Files under <runtimeDir>/templates/services/<service>/ that need to be
 *  materialized to the host config dir before the orchestrator first
 *  recreates the container. Without this, docker auto-creates an empty
 *  *directory* at the bind-mount source (because the file doesn't exist),
 *  the container starts with /etc/<svc>/<file> as a directory, and the
 *  upstream entrypoint loops on "read-only file system" errors. The host
 *  config dir is owned by the operator — we only seed missing files,
 *  never overwrite. */
const SEED_FILES: ReadonlyArray<{ service: string; files: ReadonlyArray<string> }> = [
  { service: "egress-proxy", files: ["tinyproxy.conf", "filter.txt"] },
  { service: "searxng", files: ["settings.yml"] },
];

async function seedDefaultConfigs(srcRoot: string, dstRoot: string): Promise<void> {
  for (const { service, files } of SEED_FILES) {
    for (const file of files) {
      const dst = join(dstRoot, service, file);
      try {
        await fs.access(dst);
        continue; // exists — never clobber operator edits
      } catch {
        /* missing — seed below */
      }
      const src = join(srcRoot, service, file);
      try {
        await fs.mkdir(dirname(dst), { recursive: true });
        await fs.copyFile(src, dst);
        log.info("seed-default-config", { service, file, dst });
      } catch (err: unknown) {
        log.warn("seed-default-config.failed", {
          service,
          file,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

export async function runPhaseOrchestrator(input: PhaseOrchestratorInput): Promise<PhaseOrchestratorOutput> {
  const { cfg, installState, secretsStore, internalSecretsStore, gatewayRuntimeDir, hostConfigDirContainerPath } =
    input;

  // Seed default service configs into the host config dir BEFORE the
  // orchestrator's first apply, so bind-mounted files exist as files
  // (not docker-auto-created empty directories). Idempotent — never
  // overwrites operator edits.
  await seedDefaultConfigs(`${gatewayRuntimeDir}/templates/services`, hostConfigDirContainerPath);

  // System orchestrator — manages docker containers for managed services
  // (Home Assistant MCP, Music Assistant MCP, etc.) declared in
  // config.yaml#managed_services. null when the block is absent (default):
  // the orchestrator is optional; a missing config is not fatal at boot.
  const systemOrchestrator = cfg.managedServices
    ? await createSystemOrchestratorService({
        managedServicesConfig: cfg.managedServices,
        templateDir: `${gatewayRuntimeDir}/templates/services`,
        secrets: makeSecretAccessor(secretsStore, internalSecretsStore),
        healthIO: defaultHealthIO,
        pollIntervalMs: 1000,
        applyTimeoutMs: 5 * 60 * 1000,
        nativeRunDir: join(input.sentientHome, NATIVE_RUN_SUBDIR),
        hostEnv: {
          HOST_HOME: process.env.HOST_HOME ?? "",
          HOST_DOCKER_GID: process.env.HOST_DOCKER_GID ?? "",
          TZ: process.env.TZ ?? "",
          HOST_CONFIG_DIR: process.env.HOST_CONFIG_DIR ?? "",
          // Source for the hermes /data/supervisor mount. A host path on
          // Linux/Pi (bind-mount), a docker named-volume name on macOS.
          // See gateway/templates/services/sentient-hermes.yaml for context.
          SUPERVISOR_DIR: process.env.SUPERVISOR_DIR ?? "",
          // Source for the hermes /run/sentient mount (gateway's per-user
          // mcp-<userId>.sock unix sockets). Same portability rule as
          // SUPERVISOR_DIR — host path on Linux, named-volume name on macOS.
          MCP_SOCKET_DIR: process.env.MCP_SOCKET_DIR ?? "",
          // Root of the root-owned release tree that native services launch
          // from (/opt/sentient/current in prod, the repo checkout in dev).
          // Left empty until the native cutover sets it, in which case a
          // native service's argv[0] stays a literal ${SENTIENT_CODE}/... and
          // prepare() fails loudly instead of launching something unexpected.
          SENTIENT_CODE: process.env.SENTIENT_CODE ?? "",
        },
      }).catch((err: unknown) => {
        log.warn("system-orchestrator.init-failed", {
          reason: err instanceof Error ? err.message : String(err),
        });
        return null;
      })
    : null;

  // Boot reconcile — replays applyAll once on startup so gateway restarts
  // (after a crash, image rebuild, etc.) repopulate orchestrator status from
  // the live container set. Skip on fresh installs (bootstrap_complete=false)
  // because the wizard owns the first applyAll, and pre-applying here makes
  // the bringup screen flash through too fast for the user to see what's
  // happening. Fire-and-forget once we do run it.
  if (systemOrchestrator) {
    const installed = await installState.load();
    if (installed.bootstrap_complete) {
      void systemOrchestrator.reconcile().catch((err: unknown) => {
        log.warn("boot-reconcile.failed", {
          reason: err instanceof Error ? err.message : String(err),
        });
      });
    } else {
      log.info("boot-reconcile.skipped", { reason: "bootstrap-incomplete" });
    }
  }

  return { systemOrchestrator };
}
