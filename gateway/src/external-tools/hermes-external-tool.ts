// Hermes as ONE external tool behind the `ExternalTool` contract.
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
// registered within the tier. Everything else a delegated agent may reach
// arrives THROUGH that socket, proxied and mediated by the gateway's own PDP —
// see `mcp-host/proxied-tool-surface.ts`.
//
// VERIFY THE CONTENT, NOT THE NAME. Task 9d returned early as soon as the
// `gateway` key existed. An entry whose `args` point at a socket nothing serves
// — a changed `hermes.mcp_host.socket_path`, a hand edit, an older build's
// spelling — then reads as healthy forever while the delegated agent runs
// tool-less. So the comparison is over command + args + enabled, and a mismatch
// is repaired.

import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import { resolveMcpSocketPath } from "../mcp-host/socket-path.js";
import type { ExternalTool, ExternalToolError } from "./external-tool.js";
import { type CliSpawnFn, HERMES_BIN, defaultCliSpawn, runHermesCli } from "./hermes-cli.js";

const log = getLog(["sentient", "external-tools", "hermes"]);

/** Name the gateway's MCP is registered under in hermes's own store. Matches
 *  the `gateway` key in `gateway/config.yaml#mcp_catalog` so an operator sees
 *  one name on both sides. THE ONLY KEY THIS MODULE MAY WRITE. */
const GATEWAY_SERVER_NAME = "gateway";

/** `nc -U <socket>` bridges hermes's stdio MCP transport onto the gateway's
 *  per-user Unix socket. Hermes gets no shell, so the path must be literal. */
const SOCKET_BRIDGE_COMMAND = "nc";
const SOCKET_BRIDGE_FLAG = "-U";

/**
 * Answers for `hermes mcp add`'s interactive prompts, in the order the CLI asks
 * them on the stdio path (`hermes_cli/mcp_config.py#cmd_mcp_add`):
 *
 *   1. `Server 'gateway' already exists. Overwrite? [y/N]` — asked ONLY when the
 *      entry is already there, i.e. on every repair. Default is **No**.
 *   2. `Enable all N tools? [Y/n/select]` — asked once the probe succeeds.
 *
 * Two lines, unconditionally: on a fresh add the first `y` answers prompt 2 and
 * the second line is simply never read. Sending one line instead would make a
 * repair answer prompt 1 and leave prompt 2 at EOF, which the CLI treats as
 * "Cancelled." — and returns, with **exit code 0**. That is NM-T9c's lesson
 * exactly, which is why the read-back below is not optional either.
 */
const PROMPT_ANSWERS = "y\ny\n";

/** Shape of one `mcp_servers` entry, narrowed to the fields this module owns. */
interface GatewayEntry {
  readonly command?: unknown;
  readonly args?: unknown;
  readonly enabled?: unknown;
}

/** Why the entry needs writing — carried into the log so a repair is never
 *  indistinguishable from a first-time registration. */
type EntryVerdict = "ok" | "absent" | "drifted";

export interface HermesExternalToolDeps {
  /** Tool names the gateway's MCP host advertises to a delegated agent from its
   *  OWN hosted set — already narrowed to the `allow` tier by
   *  `delegated-tool-tier.ts`. Empty means the gateway hosts nothing a delegated
   *  agent may hold, so there is nothing to register. Proxied catalog tools are
   *  discovered live on the socket and deliberately not counted here. */
  readonly hostedDelegatedTools: readonly string[];
  /** `orchestrator.delegation.hermes_mcp_register_timeout_ms`. Bounds the WHOLE
   *  provide phase, not each CLI call: this sits on the hot path of a
   *  user-visible action and a hung CLI must not become a hung delegation. */
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
export function parseRegisteredServers(stdout: string): Record<string, GatewayEntry> {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, GatewayEntry>;
  } catch {
    return {};
  }
}

function argsMatch(args: unknown, socketPath: string): boolean {
  if (!Array.isArray(args) || args.length !== 2) return false;
  return args[0] === SOCKET_BRIDGE_FLAG && args[1] === socketPath;
}

/**
 * Classify OUR one entry. Reads the whole map only to look up a single key —
 * every other server in it belongs to the user and is never inspected, ranked,
 * pruned or reported on.
 */
export function verifyGatewayEntry(servers: Record<string, GatewayEntry>, socketPath: string): EntryVerdict {
  const entry = servers[GATEWAY_SERVER_NAME];
  if (!entry) return "absent";
  if (entry.command !== SOCKET_BRIDGE_COMMAND) return "drifted";
  if (!argsMatch(entry.args, socketPath)) return "drifted";
  // `enabled` is absent on some hand-written entries and means enabled; only an
  // explicit false is drift (hermes skips a disabled server outright).
  if (entry.enabled === false) return "drifted";
  return "ok";
}

export function createHermesExternalTool(deps: HermesExternalToolDeps): ExternalTool {
  const spawn = deps.spawn ?? defaultCliSpawn;

  /** Time left in the phase budget. Never below 1ms, so an exhausted budget
   *  fails the next call fast instead of granting it a fresh full timeout. */
  function remainingMs(startedAt: number): number {
    return Math.max(1, deps.timeoutMs - (Date.now() - startedAt));
  }

  async function readServers(userId: string, startedAt: number): Promise<Record<string, GatewayEntry>> {
    const listed = await runHermesCli({
      argv: [HERMES_BIN, "-p", userId, "config", "get", "mcp_servers", "--json"],
      timeoutMs: remainingMs(startedAt),
      spawn,
      step: "list",
      userId,
    });
    return listed.ok ? parseRegisteredServers(listed.value.stdout) : {};
  }

  async function provide(userId: string): Promise<Result<void, ExternalToolError>> {
    if (deps.hostedDelegatedTools.length === 0) {
      log.warn("hermes.register.skipped", {
        userId,
        server: GATEWAY_SERVER_NAME,
        reason: "no gateway-hosted tool survives the delegated allow tier, so registering would grant nothing",
      });
      return { ok: false, error: "no-allow-tier-tools" };
    }

    const startedAt = Date.now();
    const socketPath = resolveMcpSocketPath(userId, deps.socketBasePath);
    const verdict = verifyGatewayEntry(await readServers(userId, startedAt), socketPath);
    if (verdict === "ok") {
      log.debug("hermes.register.already", { userId, server: GATEWAY_SERVER_NAME, socketPath });
      return { ok: true, value: undefined };
    }

    log.info("hermes.register.start", {
      userId,
      server: GATEWAY_SERVER_NAME,
      socketPath,
      verdict,
      hostedTools: deps.hostedDelegatedTools,
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
      timeoutMs: remainingMs(startedAt),
      spawn,
      stdin: PROMPT_ANSWERS,
      step: "add",
      userId,
    });
    if (!added.ok) {
      log.warn("hermes.register.cli-failed", { userId, server: GATEWAY_SERVER_NAME, verdict, reason: added.error });
      return { ok: false, error: "cli-error" };
    }

    // Read back rather than trust the exit code: every cancel path inside
    // `hermes mcp add` returns 0, and defect D11's predecessor exited 0 while
    // the profile ended up with no tools at all.
    const after = verifyGatewayEntry(await readServers(userId, startedAt), socketPath);
    if (after !== "ok") {
      log.warn("hermes.register.not-registered", {
        userId,
        server: GATEWAY_SERVER_NAME,
        socketPath,
        verdict: after,
        reason: "hermes exited 0 but the entry is still wrong on read-back; the delegated agent has no gateway tools",
      });
      return { ok: false, error: "not-registered" };
    }

    log.info("hermes.register.ok", {
      userId,
      server: GATEWAY_SERVER_NAME,
      repairedFrom: verdict,
      elapsedMs: Date.now() - startedAt,
    });
    return { ok: true, value: undefined };
  }

  return { name: "hermes", provide };
}
