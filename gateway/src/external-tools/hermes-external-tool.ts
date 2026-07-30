// Hermes as ONE external tool behind the generic configuration handler.
//
// WHAT IT FIXES (defect D11). The gateway renders `mcp_servers` into
// `~/.sentient/gateway/<id>/profiles/<id>/`; hermes reads its own store at
// `~/.hermes/profiles/<id>/`. The `HERMES_HOME` bridge between them was the
// supervisord program env the native cutover deleted, so the render has been
// dead output and every delegated agent on every fresh install had zero
// gateway tools. Setting `HERMES_HOME` cannot fix it — it is ONE process-wide
// variable while the rendered root is per-user — so registration goes through
// hermes's own `mcp add`, which writes the store hermes actually reads.
//
// WHY ONLY THE GATEWAY'S OWN MCP IS REGISTERED. `hermes mcp add` grants a
// server's WHOLE advertised surface: its CLI exposes no non-interactive
// per-tool filter (tool selection lives behind a curses checklist, and
// `hermes config set` cannot write a list — it coerces only bool/int/float).
// The catalog's `tools.include` is a GATEWAY-side filter and never reaches
// hermes, so registering `home_assistant` would hand the delegated agent
// ha-mcp's whole upstream surface — far past the `allow` tier the owner
// scoped. The gateway hosts its own per-user MCP socket and therefore knows
// and controls that surface exactly, so it is the one server that can be
// registered within the tier. The rest are refused, loudly.
// `docs/native-todo.md` § 1 carries the follow-up.

import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import { resolveMcpSocketPath } from "../mcp-host/socket-path.js";
import type { ExternalTool, ExternalToolError } from "./external-tool.js";
import { type CliSpawnFn, HERMES_BIN, defaultCliSpawn, runHermesCli } from "./hermes-cli.js";

const log = getLog(["sentient", "external-tools", "hermes"]);

/** Name the gateway's MCP is registered under in hermes's own store. Matches
 *  the `gateway` key in `gateway/config.yaml#mcp_catalog` so an operator sees
 *  one name on both sides. */
const GATEWAY_SERVER_NAME = "gateway";

/** `nc -U <socket>` bridges hermes's stdio MCP transport onto the gateway's
 *  per-user Unix socket. Hermes gets no shell, so the path must be literal. */
const SOCKET_BRIDGE_COMMAND = "nc";
const SOCKET_BRIDGE_FLAG = "-U";

/** `hermes mcp add` asks "Enable all N tools? [Y/n/select]" after probing.
 *  Answering yes is the only non-interactive path; with no answer the CLI
 *  cancels without saving, which is the fail-closed direction. */
const ENABLE_ALL_ANSWER = "y\n";

export interface HermesExternalToolDeps {
  /** Tool names the gateway's MCP host advertises to a delegated agent —
   *  already narrowed to the `allow` tier by `delegated-tool-tier.ts`. Empty
   *  means there is nothing a delegated agent may hold, so nothing is
   *  registered. */
  readonly delegatedTools: readonly string[];
  /** `orchestrator.delegation.hermes_cli_timeout_ms`. */
  readonly timeoutMs: number;
  /** Operator-configured `hermes.mcp_host.socket_path`; only its directory is
   *  used. Passed straight to the mcp-host's own resolver so both sides of the
   *  socket derive from one function, never two spellings. */
  readonly socketBasePath?: string;
  readonly spawn?: CliSpawnFn;
}

/** Parse `hermes -p <id> config get mcp_servers --json`. Prints a JSON object
 *  when the key is set and a plain "Config key not set: …" line when it is
 *  not, so anything unparseable means "no servers registered". */
export function parseRegisteredServers(stdout: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return new Set();
    return new Set(Object.keys(parsed as Record<string, unknown>));
  } catch {
    return new Set();
  }
}

export function createHermesExternalTool(deps: HermesExternalToolDeps): ExternalTool {
  const spawn = deps.spawn ?? defaultCliSpawn;

  async function readRegistered(userId: string): Promise<Set<string>> {
    const listed = await runHermesCli({
      argv: [HERMES_BIN, "-p", userId, "config", "get", "mcp_servers", "--json"],
      timeoutMs: deps.timeoutMs,
      spawn,
      step: "list",
      userId,
    });
    return listed.ok ? parseRegisteredServers(listed.value.stdout) : new Set();
  }

  async function configure(userId: string): Promise<Result<void, ExternalToolError>> {
    if (deps.delegatedTools.length === 0) {
      log.warn("hermes.register.skipped", {
        userId,
        server: GATEWAY_SERVER_NAME,
        reason: "no tool survives the delegated allow tier, so registering would grant nothing",
      });
      return { ok: false, error: "no-allow-tier-tools" };
    }

    if ((await readRegistered(userId)).has(GATEWAY_SERVER_NAME)) {
      log.debug("hermes.register.already", { userId, server: GATEWAY_SERVER_NAME });
      return { ok: true, value: undefined };
    }

    const socketPath = resolveMcpSocketPath(userId, deps.socketBasePath);
    log.info("hermes.register.start", {
      userId,
      server: GATEWAY_SERVER_NAME,
      socketPath,
      tools: deps.delegatedTools,
    });
    const added = await runHermesCli({
      argv: [
        HERMES_BIN,
        "-p",
        userId,
        "mcp",
        "add",
        GATEWAY_SERVER_NAME,
        "--command",
        SOCKET_BRIDGE_COMMAND,
        "--args",
        SOCKET_BRIDGE_FLAG,
        socketPath,
      ],
      timeoutMs: deps.timeoutMs,
      spawn,
      stdin: ENABLE_ALL_ANSWER,
      step: "add",
      userId,
    });
    if (!added.ok) {
      log.warn("hermes.register.cli-failed", { userId, server: GATEWAY_SERVER_NAME, reason: added.error });
      return { ok: false, error: "cli-error" };
    }

    // Read back rather than trust the exit code: defect D11's predecessor
    // exited 0 while the profile ended up with no tools at all.
    if (!(await readRegistered(userId)).has(GATEWAY_SERVER_NAME)) {
      log.warn("hermes.register.not-registered", {
        userId,
        server: GATEWAY_SERVER_NAME,
        socketPath,
        reason: "hermes exited 0 but the server is absent on read-back; the delegated agent has no gateway tools",
      });
      return { ok: false, error: "not-registered" };
    }

    log.info("hermes.register.ok", { userId, server: GATEWAY_SERVER_NAME, tools: deps.delegatedTools });
    return { ok: true, value: undefined };
  }

  return { name: "hermes", configure };
}
