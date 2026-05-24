import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLog } from "../../logging/logger.js";
import type { ProfileV1 } from "../../profile-store/profile-types.js";

const log = getLog(["sentient", "devices", "signal", "boot-reconciler"]);

/**
 * If a profile says signal is paired but the on-disk artifact (SIGNAL_ACCOUNT
 * in .env) is missing, clear the paired flag so the supervisor render falls
 * back to 2-programs (acp + dashboard) and the Devices tab in the webui
 * shows the Link Signal button again.
 *
 * Accounts themselves are stored in the shared signal-cli native daemon
 * sidecar's volume (~/.sentient/signal-cli/); this only reconciles the
 * profile flag against the per-profile env that drives Hermes.
 *
 * Pure function: the caller is responsible for persisting the returned profile.
 */
export async function reconcileSignalPaired(profile: ProfileV1, hermesHome: string): Promise<ProfileV1> {
  if (profile.devices?.signal?.paired !== true) return profile;

  // Hermes -p <userId> reads its env from ${HERMES_HOME}/profiles/<userId>/.env
  // (see hermes_cli/env_loader.py + signal-provisioner.signalEnvPath). Older
  // shape used ${HERMES_HOME}/.env, which was silently ignored.
  const envPath = join(hermesHome, "profiles", profile.userId, ".env");
  const envOk = existsSync(envPath) && readFileSync(envPath, "utf8").includes("SIGNAL_ACCOUNT=");

  if (envOk) return profile;

  log.warn("signal-paired-inconsistent", {
    userId: profile.userId,
    envHasAccount: envOk,
  });

  const existingSignal = profile.devices?.signal;
  return {
    ...profile,
    devices: {
      ...profile.devices,
      signal: {
        ...(existingSignal ?? {}),
        paired: false,
      },
    },
  };
}
