import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Per-profile .env path used by `hermes -p <profile> ...`. Hermes resolves
// dotenv files at ${HERMES_HOME}/profiles/<profile>/.env when invoked with
// the -p flag (see hermes_cli/env_loader.py + hermes_constants.get_hermes_home).
// Writing to ${HERMES_HOME}/.env instead is silently ignored by the gateway
// runner — that path is only read when -p is absent.
function signalEnvPath(hermesHome: string, userId: string): string {
  return join(hermesHome, "profiles", userId, ".env");
}
import { getLog } from "../../logging/logger.js";
import { clearSignalEnv, mergeSignalEnv } from "../../profile-store/env-writer.js";
import type { ProfileV1 } from "../../profile-store/profile-types.js";
import { SignalCliClient } from "./signal-cli-client.js";

const log = getLog(["sentient", "devices", "signal", "provisioner"]);

const PROVISION_HEALTH_TIMEOUT_MS = 30_000;
const PROVISION_HEALTH_POLL_MS = 1_000;

// URL for the shared signal-cli native daemon sidecar. Both the gateway
// container (for provisioner calls) and the hermes container (for Hermes'
// Signal adapter, written into SIGNAL_HTTP_URL) reach it on the
// sentient-internal docker network by container name.
const SIGNAL_CLI_URL = "http://sentient-signal-cli:8080";

export interface SignalProvisionerDeps {
  readonly getProfile: (userId: string) => Promise<ProfileV1>;
  readonly setProfile: (profile: ProfileV1) => Promise<void>;
  readonly getHermesHome: (userId: string) => string;
}

function maskE164(num: string): string {
  const last4 = num.slice(-4);
  return `${num.slice(0, 2)}•••••${last4}`;
}

export class SignalProvisioner {
  constructor(private readonly deps: SignalProvisionerDeps) {}

  /** Prepare for pairing. The shared signal-cli sidecar (sentient-signal-cli)
   *  is always-on and managed by the orchestrator — no per-user signal-cli
   *  program is rendered or started here.
   *
   *  Critically: we do NOT flip profile.devices.signal.paired = true here.
   *  Setting it would cause the renderer to emit hermes-<uid>-gateway
   *  immediately, and supervisord would autostart that program — but .env
   *  has no SIGNAL_* yet, so Hermes' gateway runner exits cleanly with
   *  "No platforms enabled", supervisord retries 5×, lands in BACKOFF/ERROR.
   *  Then by the time finalize() tries to restart it, the program is
   *  already in error state and the restart aborts.
   *
   *  Instead provision is a no-op for supervisor state. The QR modal's
   *  awaitingScan state lives in the in-memory coordinator. finalize()
   *  flips paired=true after writing SIGNAL_* into .env, so the gateway
   *  program is rendered fresh with the env already in place. */
  async provision(_userId: string): Promise<void> {
    log.info("provision-start", { userId: _userId });
    // No-op — pair state is in-memory in the PairingCoordinator until
    // finalize() persists it.
  }

  /** Poll the shared signal-cli sidecar's HTTP health endpoint until it
   *  responds or the timeout elapses. Throws when the deadline is exceeded. */
  async waitForHealth(_userId: string): Promise<void> {
    const client = new SignalCliClient(SIGNAL_CLI_URL);
    const deadline = Date.now() + PROVISION_HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await client.health()) return;
      await new Promise<void>((r) => setTimeout(r, PROVISION_HEALTH_POLL_MS));
    }
    throw new Error(`signal-cli sidecar did not become healthy within ${PROVISION_HEALTH_TIMEOUT_MS}ms`);
  }

  /** Called when the user's phone has scanned the QR code and a new account
   *  appeared in signal-cli. Writes SIGNAL_* env, updates the profile with
   *  account_masked + linked_at, re-renders the supervisor conf, and restarts
   *  the hermes-gateway program so it picks up the new env. */
  async finalize(userId: string, account: string): Promise<void> {
    const maskedAccount = maskE164(account);
    log.info("finalize", { userId, account_masked: maskedAccount });
    const hermesHome = this.deps.getHermesHome(userId);
    // SIGNAL_HTTP_URL is read by Hermes' Signal adapter from inside the
    // hermes container. The shared sidecar is reachable by container name on
    // the sentient-internal network from both the gateway and hermes containers.
    await mergeSignalEnv(signalEnvPath(hermesHome, userId), {
      httpUrl: SIGNAL_CLI_URL,
      account,
      allowedUsers: account,
      // Single-user Note-to-Self is the Sentient pairing model — bake the
      // user's own number as the home channel so cron/scheduled deliveries
      // land in Note to Self and the first-message onboarding nag does not
      // fire. Per `hermes/gateway/run.py#4450` Hermes only nags when
      // <PLATFORM>_HOME_CHANNEL is unset.
      homeChannel: account,
    });
    const profile = await this.deps.getProfile(userId);
    await this.deps.setProfile({
      ...profile,
      devices: {
        ...profile.devices,
        signal: {
          paired: true,
          account_masked: maskedAccount,
          linked_at: new Date().toISOString(),
        },
      },
    });
    // The SIGNAL_* env is now on disk. Nothing to restart: the per-user
    // `hermes-<uid>-gateway` supervisord program this used to bounce lived in
    // the deleted `sentient-hermes` container. Signal delivery therefore has
    // NO runner in the native stack yet — see this class's header note.
    log.warn("finalize.no-runner-to-restart", {
      userId,
      reason: "per-user hermes-gateway program retired with the sentient-hermes container",
    });
  }

  /** Revert pairing state on failure: roll profile back to paired=false and
   *  clear the SIGNAL_* env. */
  async cleanup(userId: string): Promise<void> {
    log.info("cleanup-on-fail", { userId });
    const profile = await this.deps.getProfile(userId);
    const wasPaired = profile.devices?.signal?.paired === true;
    if (wasPaired) {
      await this.deps.setProfile({
        ...profile,
        devices: { ...profile.devices, signal: { paired: false } },
      });
    }
    const hermesHome = this.deps.getHermesHome(userId);
    await clearSignalEnv(signalEnvPath(hermesHome, userId));
  }

  /** Fully unpair: call signal-cli removeAccount for THIS user's account only,
   *  clear env and roll back the profile. sessions.db is not touched.
   *
   *  Critical: the shared sidecar holds every user's linked Signal account.
   *  We MUST pass this user's specific E.164 (read from their .env before
   *  clearing) — never call removeAccount on every account in listAccounts,
   *  that would unlink every other user. */
  async unpair(userId: string): Promise<void> {
    log.info("unpair-start", { userId });
    const hermesHome = this.deps.getHermesHome(userId);
    const profile = await this.deps.getProfile(userId);
    const envPath = signalEnvPath(hermesHome, userId);
    const account = readSignalAccountFromEnv(envPath);

    if (account) {
      const client = new SignalCliClient(SIGNAL_CLI_URL);
      try {
        await client.removeAccount(account);
      } catch (err) {
        log.warn("removeAccount-failed-continuing", { userId, error: String(err) });
      }
    } else {
      log.warn("unpair-no-account-in-env", { userId });
    }

    await clearSignalEnv(envPath);
    await this.deps.setProfile({
      ...profile,
      devices: { ...profile.devices, signal: { paired: false } },
    });
    log.info("unpair-complete", { userId });
  }
}

function readSignalAccountFromEnv(envPath: string): string | undefined {
  if (!existsSync(envPath)) return undefined;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    if (line.startsWith("SIGNAL_ACCOUNT=")) {
      const v = line.slice("SIGNAL_ACCOUNT=".length).trim();
      if (v.length > 0) return v;
    }
  }
  return undefined;
}
