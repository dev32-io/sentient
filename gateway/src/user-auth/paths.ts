import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the gateway-owned storage root.
 * Defaults to ~/.sentient/gateway. Override via SENTIENT_GATEWAY_ROOT (tests, custom deploy).
 */
export function getGatewayRoot(): string {
  const override = process.env.SENTIENT_GATEWAY_ROOT;
  if (override && override.length > 0) return override;
  return join(homedir(), ".sentient", "gateway");
}

export function getUsersJsonPath(): string {
  return join(getGatewayRoot(), "users.json");
}

export function getAuthSecretPath(): string {
  return join(getGatewayRoot(), "auth-secret.key");
}

export function getUserProfileDir(userId: string): string {
  return join(getGatewayRoot(), userId);
}

/**
 * The gateway-side render target for a user's Hermes profile: config.yaml +
 * SOUL.md land here, and `tools/hermes-runner.ts` spawns `hermes -p <userId>`
 * with this as its `cwd`.
 *
 * It is NOT, currently, the directory hermes reads its config.yaml from. Hermes
 * resolves that from `$HERMES_HOME/profiles/<userId>/`; the bridge used to be
 * `HERMES_HOME` in the supervisord program env, which the native cutover
 * deleted along with the daemon. Open defect D11 — root cause, hand-verified
 * fix route and the reason it is unresolved live in
 * `admin/hermes-profile-bridge.ts`, whose detector logs
 * `hermes-profile.bridge.not-live` on every provision. Do not restate the old
 * claim here: it is what sent two waves of defect-chasing to the wrong layer.
 */
export function getHermesProfileDir(userId: string): string {
  return join(getUserProfileDir(userId), "profiles", userId);
}

export function getSharedTemplatesDir(): string {
  return join(getGatewayRoot(), "shared", "templates");
}

export function getArchiveDir(): string {
  return join(getGatewayRoot(), "_archive");
}
