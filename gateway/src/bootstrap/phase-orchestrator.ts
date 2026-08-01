import { promises as fs, accessSync, constants as fsConstants } from "node:fs";
import { dirname, join } from "node:path";
import type { InstallState } from "../admin/install-state.js";
import type { InternalSecretsStore } from "../admin/internal-secrets-store.js";
import type { SecretsStore } from "../admin/secrets-store.js";
import type { StartupConfig } from "../config/startup-config.ts";
import { getLog } from "../logging/logger.ts";
import { defaultHealthIO } from "../system-orchestrator/health-io.js";
import { type SystemOrchestratorService, createSystemOrchestratorService } from "../system-orchestrator/index.js";
import type { OrchestratorStatus } from "../system-orchestrator/types.js";
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
  /**
   * Settles when the boot reconcile — the apply that brings docker and native
   * addons up — has finished. `null` when no reconcile was started at all
   * (orchestrator absent, or a fresh install where the wizard owns the first
   * apply).
   *
   * This is the apply-complete signal any startup step that depends on the
   * internal dependencies being live must wait on. It is deliberately NOT
   * awaited here: boot must not block on container bringup.
   */
  readonly bootReconcile: Promise<OrchestratorStatus> | null;
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

/** `${VAR}` — the one placeholder syntax both the config loader and the
 *  template loader speak. Kept in step with template-loader.ts's own regex. */
const PLACEHOLDER_RE = /\$\{([A-Z][A-Z0-9_]*)\}/g;

/** A substitution variable a docker service's template references that
 *  nothing — not its secret bindings, not the host env — can resolve. */
export interface UnresolvedPlaceholder {
  readonly service: string;
  readonly envVar: string;
  readonly template: string;
}

/** A native service whose interpreter path cannot be launched. */
export interface UnlaunchableNativeService {
  readonly service: string;
  readonly interpreter: string;
}

function referencedVars(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(PLACEHOLDER_RE)) {
    const name = match[1];
    if (name !== undefined) seen.add(name);
  }
  return [...seen];
}

/**
 * Every `${VAR}` a declared DOCKER service's template references that neither
 * its `secrets:` bindings nor `hostEnv` can resolve.
 *
 * This is the gate the `process.env.X ?? ""` default needed. `template-loader`
 * leaves an unresolved placeholder LITERAL on purpose — an operator may rely on
 * the container's own runtime env — so an unset `HOST_CONFIG_DIR` rides
 * verbatim into a bind-mount source and comes back as a Docker 400 five retry
 * attempts later, naming neither the variable nor the service. Secret-bound
 * names are excluded deliberately: a missing secret is the registry's business
 * (it skips optional services and hard-fails required ones, with its own
 * `missing-secret` error), and duplicating that here would refuse to boot a
 * stack whose only fault is an HA token the operator has not entered yet.
 */
export function findUnresolvedPlaceholders(
  managedServices: Record<string, unknown>,
  templateBodies: ReadonlyMap<string, string>,
  hostEnv: Record<string, string>,
): UnresolvedPlaceholder[] {
  const defects: UnresolvedPlaceholder[] = [];
  for (const [service, raw] of Object.entries(managedServices)) {
    const cfg = (raw ?? {}) as Record<string, unknown>;
    if (cfg.launch === "native") continue;
    const template = typeof cfg.template === "string" ? cfg.template : null;
    const body = template === null ? undefined : templateBodies.get(template);
    if (template === null || body === undefined) continue;
    const bound = new Set(Object.keys((cfg.secrets ?? {}) as Record<string, unknown>));
    for (const envVar of referencedVars(body)) {
      if (bound.has(envVar)) continue;
      const value = hostEnv[envVar];
      if (value !== undefined && value.length > 0) continue;
      defects.push({ service, envVar, template });
    }
  }
  return defects;
}

/**
 * Native services whose `exec[0]` is not a launchable file.
 *
 * The template gate above structurally cannot see this one. `config.yaml`'s own
 * `${VAR}`s are resolved by the CONFIG LOADER while the file is read, and an
 * unset variable becomes the EMPTY STRING — it never survives as a literal. So
 * an unset `SENTIENT_CODE` silently rewrites the interpreter to
 * `/whisper-stt/venv/bin/python`, which today is only discovered inside the
 * native driver's `prepare()`, twelve seconds into the apply.
 *
 * It reports the fact and NOT a cause. Listing the host-env variables that
 * happen to be empty reads as a diagnosis and is not one — on this box that
 * list is `HOST_DOCKER_GID,TZ,SUPERVISOR_DIR,MCP_SOCKET_DIR`, four variables
 * with nothing to do with an interpreter path, and pointing an operator at
 * innocent names costs more than saying less.
 */
export function findUnlaunchableNativeServices(
  managedServices: Record<string, unknown>,
  isExecutable: (path: string) => boolean,
): UnlaunchableNativeService[] {
  const defects: UnlaunchableNativeService[] = [];
  for (const [service, raw] of Object.entries(managedServices)) {
    const cfg = (raw ?? {}) as Record<string, unknown>;
    if (cfg.launch !== "native") continue;
    const exec = Array.isArray(cfg.exec) ? cfg.exec : [];
    const interpreter = typeof exec[0] === "string" ? exec[0] : "";
    if (interpreter.length > 0 && isExecutable(interpreter)) continue;
    defects.push({ service, interpreter });
  }
  return defects;
}

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

/** Reads every declared docker service's template body. A template that cannot
 *  be read is NOT a substitution defect — the registry already reports that as
 *  `template-unreadable` — so it is simply absent from the map and skipped. */
async function readTemplateBodies(
  managedServices: Record<string, unknown>,
  templateDir: string,
): Promise<Map<string, string>> {
  const bodies = new Map<string, string>();
  for (const raw of Object.values(managedServices)) {
    const cfg = (raw ?? {}) as Record<string, unknown>;
    if (cfg.launch === "native" || typeof cfg.template !== "string" || bodies.has(cfg.template)) continue;
    try {
      bodies.set(cfg.template, await fs.readFile(join(templateDir, cfg.template), "utf8"));
    } catch {
      /* unreadable — the registry owns that error, not this gate */
    }
  }
  return bodies;
}

/** Boot-time substitution gate. Logs one ERROR per defect — one line each,
 *  because the log formatter caps a single property at the preview length and a
 *  joined list would truncate — then THROWS on an unresolved template
 *  placeholder. A missing native interpreter is loud but not fatal: the native
 *  driver already refuses to spawn it and self-heals once the code tree is
 *  staged, whereas a surviving `${VAR}` becomes a bind-mount source docker
 *  retries five times and can materialise as a directory on the host. */
async function assertSubstitutionsResolve(
  managedServices: Record<string, unknown>,
  templateDir: string,
  hostEnv: Record<string, string>,
): Promise<void> {
  const bodies = await readTemplateBodies(managedServices, templateDir);
  for (const d of findUnlaunchableNativeServices(managedServices, isExecutableFile)) {
    log.error("native-interpreter.unlaunchable", {
      service: d.service,
      interpreter: d.interpreter,
      reason: "exec[0] is not an executable file — an unset config placeholder substitutes to the empty string",
    });
  }
  const unresolved = findUnresolvedPlaceholders(managedServices, bodies, hostEnv);
  for (const d of unresolved) {
    log.error("template-placeholder.unresolved", {
      service: d.service,
      envVar: d.envVar,
      template: d.template,
      reason: "no secret binding and no host-env value — the placeholder would survive into the container spec",
    });
  }
  if (unresolved.length === 0) return;
  const first = unresolved[0];
  throw new Error(
    `unresolved substitution variable \${${first?.envVar}} in ${first?.service}'s template ${first?.template}` +
      ` (${unresolved.length} total) — set it in the environment before starting the gateway`,
  );
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runPhaseOrchestrator(input: PhaseOrchestratorInput): Promise<PhaseOrchestratorOutput> {
  const { cfg, installState, secretsStore, internalSecretsStore, gatewayRuntimeDir, hostConfigDirContainerPath } =
    input;
  const templateDir = `${gatewayRuntimeDir}/templates/services`;

  // Seed default service configs into the host config dir BEFORE the
  // orchestrator's first apply, so bind-mounted files exist as files
  // (not docker-auto-created empty directories). Idempotent — never
  // overwrites operator edits.
  await seedDefaultConfigs(templateDir, hostConfigDirContainerPath);

  const hostEnv = {
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
    // Root of the root-owned release tree that native services launch from
    // (/opt/sentient/current in prod, the staged tree in dev).
    SENTIENT_CODE: process.env.SENTIENT_CODE ?? "",
  };

  // The `?? ""` defaults above are exactly how an unset variable used to reach
  // a container spec as a literal `${VAR}`. Gate them here, at startup, where
  // the message can name the variable and the service — not five docker retries
  // later where it cannot.
  if (cfg.managedServices) {
    await assertSubstitutionsResolve(cfg.managedServices, templateDir, hostEnv);
  }

  // System orchestrator — manages docker containers for managed services
  // (Home Assistant MCP, Music Assistant MCP, etc.) declared in
  // config.yaml#managed_services. null when the block is absent (default):
  // the orchestrator is optional; a missing config is not fatal at boot.
  const systemOrchestrator = cfg.managedServices
    ? await createSystemOrchestratorService({
        managedServicesConfig: cfg.managedServices,
        templateDir,
        secrets: makeSecretAccessor(secretsStore, internalSecretsStore),
        healthIO: defaultHealthIO,
        pollIntervalMs: 1000,
        applyTimeoutMs: 5 * 60 * 1000,
        nativeRunDir: join(input.sentientHome, NATIVE_RUN_SUBDIR),
        // Post-boot crash recovery. Operator-tunable in
        // config.yaml#system_orchestrator; see system-orchestrator/health-watch.ts
        // for why the apply path alone cannot deliver "restart on crash".
        healthWatch: {
          intervalMs: cfg.systemOrchestrator.health_watch_interval_ms,
          maxAttempts: cfg.systemOrchestrator.health_watch_max_attempts,
          backoffFactor: cfg.systemOrchestrator.health_watch_backoff_factor,
        },
        // A signalled process does not release its listening socket the instant
        // it is signalled; launching onto a still-held port is what made both
        // native addons die on EADDRINUSE every boot.
        nativePortSettle: {
          timeoutMs: cfg.systemOrchestrator.native_port_settle_timeout_ms,
          pollMs: cfg.systemOrchestrator.native_port_settle_poll_ms,
        },
        hostEnv,
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
  let bootReconcile: Promise<OrchestratorStatus> | null = null;
  if (systemOrchestrator) {
    const installed = await installState.load();
    if (installed.bootstrap_complete) {
      bootReconcile = systemOrchestrator.reconcile().catch((err: unknown) => {
        log.warn("boot-reconcile.failed", {
          reason: err instanceof Error ? err.message : String(err),
        });
        return systemOrchestrator.getStatus();
      });
    } else {
      log.info("boot-reconcile.skipped", { reason: "bootstrap-incomplete" });
    }
  }

  return { systemOrchestrator, bootReconcile };
}
