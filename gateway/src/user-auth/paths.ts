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
 * Hermes-consumed profile dir for a user. Hermes reads SOUL.md + config.yaml
 * from `<HERMES_HOME>/profiles/<userId>/`, where HERMES_HOME equals
 * `getUserProfileDir(userId)` per the supervisord program env. The apply
 * orchestrator writes rendered output here so hermes picks it up on restart.
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
