import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import packageJson from "../../package.json";
import { type InstallState, createInstallState } from "../admin/install-state.js";
import { type InternalSecretsStore, createInternalSecretsStore } from "../admin/internal-secrets-store.js";
import { type SecretsStore, createSecretsStore } from "../admin/secrets-store.js";
import { type SupervisordControl, createSupervisordControl } from "../admin/supervisord-control.js";
import { type UnlockCode, createUnlockCode } from "../admin/unlock-code.js";
import { type UserPortStore, createUserPortStore } from "../admin/user-port-store.js";
import type { StartupConfig } from "../config/startup-config.ts";
import { getLog } from "../logging/logger.ts";
import { getGatewayRoot } from "../user-auth/paths.js";

const log = getLog(["sentient", "bootstrap", "phase-state"]);

export interface PhaseStateOutput {
  readonly installState: InstallState;
  readonly unlockCode: UnlockCode;
  readonly unlockCodePath: string;
  readonly gatewayVersion: string;
  readonly hermesVersionPath: string;
  readonly sentientHome: string;
  readonly gatewayRuntimeDir: string;
  readonly templateDir: string;
  readonly secretsStore: SecretsStore | null;
  readonly internalSecretsStore: InternalSecretsStore;
  readonly userPortStore: UserPortStore | null;
  readonly supervisordControl: SupervisordControl | null;
}

interface SupervisordTemplates {
  program: string;
  envFragments: {
    openrouter: string;
    "ollama-cloud": string;
    custom: string;
  };
}

/** UID/GID hermes overlay container runs as. Same defaults as
 *  admin/chown-hermes.ts — read env overrides for non-default deploys. */
function hermesUid(): number {
  const raw = process.env.SENTIENT_HERMES_UID;
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) ? n : 10000;
}
function hermesGid(): number {
  const raw = process.env.SENTIENT_HERMES_GID;
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) ? n : 10000;
}

/** Hermes (uid=10000) opens /data/supervisor/supervisor.sock on container
 *  boot. With the supervisor dir bind-mounted from ~/.sentient/supervisor,
 *  the host dir is created root-owned by docker — hermes then can't bind()
 *  the socket. Pre-create + chown from the gateway (root in its container)
 *  before any apply spawns hermes. Idempotent + non-fatal on chown error
 *  (rare in docker, but possible on hosts without CAP_CHOWN). */
async function ensureSupervisorDirOwnership(programsDir: string): Promise<void> {
  const supervisorRoot = dirname(programsDir);
  const uid = hermesUid();
  const gid = hermesGid();
  await fs.mkdir(programsDir, { recursive: true });
  for (const path of [supervisorRoot, programsDir]) {
    try {
      await fs.chown(path, uid, gid);
    } catch (err: unknown) {
      log.warn("supervisor-chown.failed", {
        path,
        uid,
        gid,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log.info("supervisor-dir.ready", { programsDir, uid, gid });
}

async function loadSupervisordTemplates(templateDir: string): Promise<SupervisordTemplates> {
  const dir = join(templateDir, "program");
  const [program, openrouter, ollamaCloud, custom] = await Promise.all([
    fs.readFile(join(dir, "program.conf.tmpl"), "utf8"),
    fs.readFile(join(dir, "env.openrouter.tmpl"), "utf8"),
    fs.readFile(join(dir, "env.ollama-cloud.tmpl"), "utf8"),
    fs.readFile(join(dir, "env.custom.tmpl"), "utf8"),
  ]);
  return { program, envFragments: { openrouter, "ollama-cloud": ollamaCloud, custom } };
}

export async function runPhaseState(cfg: StartupConfig): Promise<PhaseStateOutput> {
  // Path constants — derived once so downstream phases use the same values.
  const SENTIENT_HOME = process.env.SENTIENT_HOME ?? join(homedir(), ".sentient");
  // Resolve via GATEWAY_RUNTIME_DIR so the path works under both dev
  // (bun --hot src/main.ts → import.meta.dir = gateway/src/bootstrap) and
  // bundled (bun dist/main.js → import.meta.dir = /app/dist).
  const GATEWAY_RUNTIME_DIR = process.env.GATEWAY_RUNTIME_DIR ?? join(import.meta.dir, "..", "..");
  const TEMPLATE_DIR = join(GATEWAY_RUNTIME_DIR, "templates");
  const gatewayVersion = packageJson.version;
  const hermesVersionPath = cfg.companions.hermes_version_path;

  // Install state — public wizard API, reads/writes ~/.sentient/state.yaml
  const installState = createInstallState({
    statePath: join(SENTIENT_HOME, "state.yaml"),
    templateDir: join(TEMPLATE_DIR, "wizard"),
    gatewayVersion,
  });

  // Unlock code — written to .bootstrap-unlock when bootstrap is incomplete
  const unlockCodePath = join(SENTIENT_HOME, ".bootstrap-unlock");
  const unlockCode = createUnlockCode({ codePath: unlockCodePath });

  // Admin stores — constructed when hermes config is present
  const gatewayRoot = getGatewayRoot();

  const userPortStore: UserPortStore | null = cfg.hermes
    ? createUserPortStore({ rootDir: gatewayRoot, portBase: cfg.hermes.worker.port_base })
    : null;

  // Operator secrets (LLM provider keys, active-provider selection) — NOT
  // hermes-specific. Built UNCONDITIONALLY so the native orchestrator's
  // provider resolves its key via getActiveLlm() even when `hermes:` is absent
  // from config (the whole legacy Hermes fleet off). Was gated on cfg.hermes
  // in 1.0 only because hermes was assumed always present; that gate coupled
  // the native brain's LLM key to the legacy subsystem. keysPath is seeded
  // from the template on first load if missing.
  const secretsStore: SecretsStore = createSecretsStore({
    keysPath: join(SENTIENT_HOME, "secrets", "keys.yaml"),
    templatePath: join(TEMPLATE_DIR, "wizard", "keys.yaml.tmpl"),
    generateAdminToken: () => randomBytes(32).toString("hex"),
  });
  await secretsStore.load();

  const supervisordTemplates = await loadSupervisordTemplates(TEMPLATE_DIR);
  const programsDir = process.env.SENTIENT_SUPERVISORD_PROGRAMS_DIR ?? "/data/supervisor/programs";
  if (cfg.hermes && secretsStore) await ensureSupervisorDirOwnership(programsDir);
  const supervisordControl: SupervisordControl | null =
    cfg.hermes && secretsStore
      ? createSupervisordControl({
          programsDir,
          template: supervisordTemplates.program,
          envFragments: supervisordTemplates.envFragments,
          secretsStore,
        })
      : null;

  // Internal secrets — fail fast.
  const internalSecretsStore = createInternalSecretsStore(gatewayRoot);
  const internalSecretsLoad = await internalSecretsStore.loadOrInit();
  if (!internalSecretsLoad.ok) {
    throw new Error(`internal-secrets: ${internalSecretsLoad.error.kind}: ${internalSecretsLoad.error.reason}`);
  }

  log.info("phase-state-complete", {
    hasSecrets: secretsStore !== null,
    hasUserPortStore: userPortStore !== null,
    hasSupervisordControl: supervisordControl !== null,
  });

  return {
    installState,
    unlockCode,
    unlockCodePath,
    gatewayVersion,
    hermesVersionPath,
    sentientHome: SENTIENT_HOME,
    gatewayRuntimeDir: GATEWAY_RUNTIME_DIR,
    templateDir: TEMPLATE_DIR,
    secretsStore,
    internalSecretsStore,
    userPortStore,
    supervisordControl,
  };
}
