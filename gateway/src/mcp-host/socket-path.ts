import { isAbsolute, join } from "node:path";
import { expandHome, resolveSentientHome } from "../config/startup-config.ts";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "mcp-host", "socket-path"]);

/**
 * Kernel ABI limit on a Unix socket address, not a tunable: `sun_path` is
 * 104 bytes on Darwin (108 on Linux). Take the smaller so a path that works in
 * dev cannot overflow on the other platform. Exceeding it makes `bind(2)` fail
 * with a message that names neither the limit nor the path.
 */
const SUN_PATH_MAX_BYTES = 104;

/** Directory holding the per-user sockets, relative to the state root. */
const RUN_DIR = "run";

/**
 * Resolve the Unix socket the gateway's MCP server listens on for `userId`,
 * and that the delegated Hermes dials back into.
 *
 * `basePath` is the operator-configured `hermes.mcp_host.socket_path`; only its
 * DIRECTORY is used, the filename is always `mcp-<userId>.sock`. Both sides of
 * the path must agree — the gateway listens here, and the rendered Hermes
 * profile's `mcp_servers.gateway` entry dials it. A mismatch fails silently:
 * the delegated agent simply gets no gateway tools.
 */
export function resolveMcpSocketPath(userId: string, basePath?: string): string {
  const dir = resolveSocketDir(basePath);
  const socketPath = join(dir, `mcp-${userId}.sock`);
  const byteLength = Buffer.byteLength(socketPath, "utf8");
  if (byteLength >= SUN_PATH_MAX_BYTES) {
    log.error("socket-path.too-long", {
      userId,
      byteLength,
      limit: SUN_PATH_MAX_BYTES,
      reason: "sun_path overflow — bind(2) will fail and this user gets no gateway tools",
    });
  }
  return socketPath;
}

/** Directory the per-user sockets live in, with the unusable-value fallbacks. */
function resolveSocketDir(basePath: string | undefined): string {
  const fallback = join(resolveSentientHome(), RUN_DIR);
  if (basePath === undefined) return fallback;

  const expanded = expandHome(basePath);
  if (!isAbsolute(expanded)) {
    log.warn("socket-path.not-absolute", {
      configured: basePath,
      fallback,
      reason: "hermes.mcp_host.socket_path must be absolute; a relative path resolves against the launchd cwd (/)",
    });
    return fallback;
  }
  // `${HOME}` in operator YAML resolves to "" when the env var is unset (the
  // shared/config loader's documented contract), leaving a root-relative
  // "/.sentient/run/mcp.sock" that is absolute but unwritable.
  if (expanded.startsWith("/.")) {
    log.warn("socket-path.unexpanded-home", {
      configured: basePath,
      fallback,
      reason: "base path starts with '/.', so an ${ENV} placeholder resolved to empty",
    });
    return fallback;
  }
  return dirNameOf(expanded);
}

/** Lexical dirname that keeps a trailing-slash base path usable. */
function dirNameOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}
