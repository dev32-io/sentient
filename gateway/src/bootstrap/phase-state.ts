import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import packageJson from "../../package.json";
import { type InstallState, createInstallState } from "../admin/install-state.js";
import { type InternalSecretsStore, createInternalSecretsStore } from "../admin/internal-secrets-store.js";
import { type SecretsStore, createSecretsStore } from "../admin/secrets-store.js";
import { type UnlockCode, createUnlockCode } from "../admin/unlock-code.js";
import { assetPath, resolveAssetRoot } from "../config/asset-root.ts";
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
}

export async function runPhaseState(cfg: StartupConfig): Promise<PhaseStateOutput> {
  // Path constants — derived once so downstream phases use the same values.
  const SENTIENT_HOME = process.env.SENTIENT_HOME ?? join(homedir(), ".sentient");
  // Asset root differs per deployment shape (repo checkout vs compiled
  // binary); config/asset-root.ts owns that resolution and validates it.
  const GATEWAY_RUNTIME_DIR = resolveAssetRoot();
  const TEMPLATE_DIR = assetPath("templates");
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

  const gatewayRoot = getGatewayRoot();

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

  // Internal secrets — fail fast.
  const internalSecretsStore = createInternalSecretsStore(gatewayRoot);
  const internalSecretsLoad = await internalSecretsStore.loadOrInit();
  if (!internalSecretsLoad.ok) {
    throw new Error(`internal-secrets: ${internalSecretsLoad.error.kind}: ${internalSecretsLoad.error.reason}`);
  }

  log.info("phase-state-complete", { hasSecrets: secretsStore !== null });

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
  };
}
