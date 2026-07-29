import { readFileSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Result } from "@sentient/protocol";
import { assetPath } from "../config/asset-root.ts";
import { getLog } from "../logging/logger.js";
import type { ModelProvider } from "../profile-store/profile-types.js";
import { assertUserId } from "../user-auth/user-id.js";
import type { SecretsStore, SecretsStoreError } from "./secrets-store-schema.js";

const log = getLog(["sentient", "gateway", "admin", "supervisord"]);

const DEFAULT_SOCKET_PATH = "/data/supervisor/supervisor.sock";

// ---------------------------------------------------------------------------
// Signal-program template — loaded once at module init.
// Lives at <asset root>/templates/program/program-signal.conf.tmpl; the root
// is resolved (and validated) by config/asset-root.ts.
// ---------------------------------------------------------------------------
const PROGRAM_SIGNAL_TMPL = readFileSync(assetPath("templates", "program", "program-signal.conf.tmpl"), "utf8");
const STDERR_PREVIEW_MAX = 120;

/** Offset added to the per-profile ACP port to derive the per-profile
 *  dashboard sidecar port. ACP at 8643 → dashboard at 9643. Keeps the
 *  two ranges far enough apart that operator-set EXPOSE ranges and
 *  port-range firewall rules can stay obviously distinct. */
export const DASHBOARD_PORT_OFFSET = 1000;

/** Returns the supervisord program names for a user.
 *  Unpaired users have 2 programs (acp + dashboard).
 *  Signal-paired users have 3 programs (acp + dashboard + gateway).
 *  Callers must pass the current pairing state explicitly — never default to
 *  false for a paired user or supervisorctl will silently skip the gateway
 *  program on restart/stop. */
function programNames(userId: string, signalPaired: boolean): string[] {
  const base = [`hermes-${userId}-acp`, `hermes-${userId}-dashboard`];
  return signalPaired ? [...base, `hermes-${userId}-gateway`] : base;
}

/** Resolved once at module load — the supervisord socket path. */
const SUPERVISORD_SOCKET = process.env.SENTIENT_SUPERVISORD_SOCKET ?? DEFAULT_SOCKET_PATH;

export type SupervisordError = { kind: "shell-failed" | "io-failed"; reason: string };

type ShellOk = { ok: true; value: string };
type ShellErr = { ok: false; error: { kind: string; reason: string } };
export type ShellResult = ShellOk | ShellErr;

/** A shell runs an argv vector — no string interpolation, no shell expansion. */
export type Shell = (argv: readonly string[]) => Promise<ShellResult>;

/** Per-provider env fragments. Each value is the raw template string for
 *  that provider (e.g. the content of env.openrouter.tmpl). */
export type EnvFragments = Record<ModelProvider, string>;

export interface SupervisordControlConfig {
  /** Directory where per-user .conf files are written (e.g. /data/supervisor/programs). */
  programsDir: string;
  /** Contents of program.conf.tmpl — the outer supervisord program template.
   *  Must contain {{env_block}} where the per-provider env fragment is injected. */
  template: string;
  /** Per-provider env fragment templates, keyed by provider name.
   *  Values are template strings containing {{api_key}} and {{base_url}}. */
  envFragments: EnvFragments;
  /** SecretsStore used to read per-provider API keys at upsert time. */
  secretsStore: Pick<SecretsStore, "getProviderSecrets">;
  shell?: Shell;
  writeFile?: (path: string, content: string) => Promise<void>;
  unlinkFile?: (path: string) => Promise<void>;
  /** Creates HERMES_HOME if missing — supervisord refuses to start a program
   *  whose log paths' parent directory doesn't exist yet (first-admin path
   *  hits this before the apply pipeline materializes the user dir). */
  mkdirRecursive?: (path: string) => Promise<void>;
  /** Override SUPERVISORD_SOCKET — primarily for tests. */
  socketPath?: string;
}

export interface UpsertInput {
  userId: string;
  port: number;
  token: string;
  timezone: string;
  /** Active LLM provider for this user — drives which env fragment is
   *  rendered into the supervisord program. Secrets are pulled from
   *  SecretsStore for the given provider at upsert time. */
  provider: ModelProvider;
  /** Absolute path to this user's Hermes home — written into HERMES_HOME and
   *  used for stderr/stdout log paths. MUST resolve to the same path on the
   *  Docker host (so the docker-backend's bind mounts work) and inside
   *  sentient-hermes (so supervisord can write log files). The gateway
   *  computes this from the host data dir + userId. */
  hermesHome: string;
  /** Whether this user has a Signal device paired. When true, the rendered
   *  supervisord conf includes two extra programs: signal-cli (daemon) and
   *  hermes-gateway (IM-platform runner). Defaults to false when omitted. */
  signalPaired?: boolean;
}

export interface SupervisordControl {
  upsertProgram(input: UpsertInput): Promise<Result<void, SupervisordError>>;
  /** Stop the per-user supervisord programs and unlink the conf file.
   *  `signalPaired` must reflect the profile's current pairing state so the
   *  stop command targets the correct set of programs (2 or 4). */
  removeProgram(userId: string, signalPaired: boolean): Promise<Result<void, SupervisordError>>;
  /** Restart the per-user supervisord programs.
   *  `signalPaired` must reflect the profile's current pairing state so the
   *  restart command targets the correct set of programs (2 or 4). */
  restartProfile(userId: string, timeoutMs: number, signalPaired: boolean): Promise<Result<void, SupervisordError>>;
  /** Restart a specific subset of supervisord programs by name.
   *  Used by SignalProvisioner to restart only hermes-<userId>-gateway after
   *  writing SIGNAL_* env without disturbing the ACP + dashboard programs. */
  restartPrograms(programs: readonly string[]): Promise<Result<void, SupervisordError>>;
  /** Stop and remove (via reread+update) a specific subset of supervisord
   *  programs by name. Used by SignalProvisioner to tear down signal-cli +
   *  hermes-gateway without affecting the base ACP + dashboard programs. */
  stopRemovePrograms(programs: readonly string[]): Promise<Result<void, SupervisordError>>;
  status(userId: string): Promise<Result<{ running: boolean; pid: number | null }, SupervisordError>>;
}

/** Render the env fragment for a given provider.
 *  Substitutes {{api_key}} and {{base_url}} in the fragment template. */
export function renderEnvFragment(fragment: string, apiKey: string, baseUrl: string): string {
  return fragment.replaceAll("{{api_key}}", apiKey).replaceAll("{{base_url}}", baseUrl);
}

/** Render the outer program template with a pre-rendered env block.
 *  The envBlock string is injected at {{env_block}} (already 2-space
 *  indented to match the surrounding `environment=` continuation format).
 *
 *  {{dashboardPort}} is derived from {{port}} (+ DASHBOARD_PORT_OFFSET) so
 *  the user-port-store stays the single source of truth for per-profile
 *  port allocation — callers only have to track one port per user.
 *
 *  {{signal_block}} is conditionally rendered: when input.signalPaired is
 *  true the block expands to the hermes-gateway program section; otherwise
 *  it collapses to an empty string. The shared signal-cli sidecar
 *  (sentient-signal-cli) is always-on and managed by the orchestrator —
 *  no per-user signal-cli program is rendered here. */
export function renderProgram(template: string, input: UpsertInput, envBlock: string): string {
  const dashboardPort = input.port + DASHBOARD_PORT_OFFSET;
  const signalBlock = input.signalPaired
    ? PROGRAM_SIGNAL_TMPL.replaceAll("{{hermesHome}}", input.hermesHome)
        .replaceAll("{{timezone}}", input.timezone)
        .replaceAll("{{userId}}", input.userId)
        .replaceAll("{{token}}", input.token)
        .replaceAll("{{env_block}}", envBlock)
    : "";
  return template
    .replaceAll("{{userId}}", input.userId)
    .replaceAll("{{port}}", String(input.port))
    .replaceAll("{{dashboardPort}}", String(dashboardPort))
    .replaceAll("{{token}}", input.token)
    .replaceAll("{{timezone}}", input.timezone)
    .replaceAll("{{hermesHome}}", input.hermesHome)
    .replaceAll("{{env_block}}", envBlock)
    .replace("{{signal_block}}", signalBlock);
}

export function createSupervisordControl(cfg: SupervisordControlConfig): SupervisordControl {
  const sh = cfg.shell ?? defaultShell;
  const wf = cfg.writeFile ?? writeFile;
  const ul = cfg.unlinkFile ?? unlink;
  const mk = cfg.mkdirRecursive ?? ((path: string) => mkdir(path, { recursive: true }).then(() => undefined));
  const socket = cfg.socketPath ?? SUPERVISORD_SOCKET;
  const ctlArgs = ["supervisorctl", "-s", `unix://${socket}`];

  function programPath(userId: string): string {
    return join(cfg.programsDir, `${userId}.conf`);
  }

  return {
    async upsertProgram(input) {
      assertUserId(input.userId);
      const envBlockResult = await resolveEnvBlock(cfg, input.provider);
      if (!envBlockResult.ok) {
        const reason = `secrets-store error: ${envBlockResult.error.kind}`;
        log.warn("upsertProgram.secrets-error", { userId: input.userId, provider: input.provider, reason });
        return { ok: false, error: { kind: "io-failed", reason } };
      }
      const conf = renderProgram(cfg.template, input, envBlockResult.value);
      const wr = await writeProgram(input, conf, wf, mk, programPath(input.userId));
      if (!wr.ok) return wr;
      return rereadAndUpdate(sh, ctlArgs, input.userId);
    },

    async removeProgram(userId, signalPaired) {
      assertUserId(userId);
      // Stop the ACP bridge, dashboard sidecar, and (if signal-paired) the
      // signal-cli + gateway programs in one supervisorctl call. Non-zero exit
      // is benign here (program already stopped or never started); we still
      // proceed to unlink.
      const stop = await sh([...ctlArgs, "stop", ...programNames(userId, signalPaired)]);
      if (!stop.ok) log.debug("removeProgram.stop-nonzero", { userId, reason: stop.error.reason });

      const ur = await unlinkProgram(ul, programPath(userId), userId);
      if (!ur.ok) return ur;
      return rereadAndUpdate(sh, ctlArgs, userId);
    },

    async restartProfile(userId, _timeoutMs, signalPaired) {
      assertUserId(userId);
      const r = await sh([...ctlArgs, "restart", ...programNames(userId, signalPaired)]);
      if (!r.ok) {
        log.warn("restartProfile.failed", { userId, reason: r.error.reason });
        return { ok: false, error: { kind: "shell-failed", reason: r.error.reason } };
      }
      log.info("restartProfile.ok", { userId });
      return { ok: true, value: undefined };
    },

    async restartPrograms(programs) {
      if (programs.length === 0) return { ok: true, value: undefined };
      const r = await sh([...ctlArgs, "restart", ...programs]);
      if (!r.ok) {
        log.warn("restartPrograms.failed", { programs, reason: r.error.reason });
        return { ok: false, error: { kind: "shell-failed", reason: r.error.reason } };
      }
      log.info("restartPrograms.ok", { programs });
      return { ok: true, value: undefined };
    },

    async stopRemovePrograms(programs) {
      if (programs.length === 0) return { ok: true, value: undefined };
      // Stop is best-effort — non-zero exit (already stopped / not found) is benign.
      const stop = await sh([...ctlArgs, "stop", ...programs]);
      if (!stop.ok) log.debug("stopRemovePrograms.stop-nonzero", { programs, reason: stop.error.reason });
      return rereadAndUpdate(sh, ctlArgs, programs.join(","));
    },

    async status(userId) {
      assertUserId(userId);
      // The ACP bridge is the canonical liveness signal — the dashboard
      // sidecar is REST-only and not on the per-cycle hot path. If we ever
      // need the dashboard's own status, take it through a dedicated
      // supervisorctl call rather than overloading this one.
      const r = await sh([...ctlArgs, "status", `hermes-${userId}-acp`]);
      if (!r.ok) return { ok: false, error: { kind: "shell-failed", reason: r.error.reason } };
      const match = /RUNNING\s+pid\s+(\d+)/.exec(r.value);
      return {
        ok: true,
        value: { running: match !== null, pid: match ? Number(match[1]) : null },
      };
    },
  };
}

async function resolveEnvBlock(
  cfg: SupervisordControlConfig,
  provider: ModelProvider,
): Promise<Result<string, SecretsStoreError>> {
  const secretsResult = await cfg.secretsStore.getProviderSecrets(provider);
  if (!secretsResult.ok) return secretsResult;
  const { apiKey, baseUrl } = secretsResult.value;
  // Hermes' provider validator rejects an empty OLLAMA_API_KEY even when the
  // worker is pointed at a local signed-in daemon that needs no auth (the
  // daemon proxies cloud calls using its own stored credentials). Substitute
  // a non-empty placeholder so the validator passes; the daemon ignores the
  // header content.
  const effectiveApiKey = provider === "ollama-cloud" && !apiKey ? "local-daemon" : apiKey;
  const fragment = cfg.envFragments[provider];
  return { ok: true, value: renderEnvFragment(fragment, effectiveApiKey, baseUrl) };
}

async function writeProgram(
  input: UpsertInput,
  renderedConf: string,
  wf: (path: string, content: string) => Promise<void>,
  mk: (path: string) => Promise<void>,
  path: string,
): Promise<Result<void, SupervisordError>> {
  // Supervisord refuses to load a program whose stderr_logfile/stdout_logfile
  // points at a path with a missing parent dir ("CANT_REREAD: directory named
  // as part of the path … does not exist"). For first-admin and any other
  // path that writes a program before the apply pipeline materializes the
  // user dir, ensure HERMES_HOME exists up front.
  try {
    await mk(input.hermesHome);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("upsertProgram.mkdir-failed", { userId: input.userId, hermesHome: input.hermesHome, reason });
    return { ok: false, error: { kind: "io-failed", reason } };
  }
  try {
    await wf(path, renderedConf);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("upsertProgram.write-failed", { userId: input.userId, reason });
    return { ok: false, error: { kind: "io-failed", reason } };
  }
  return { ok: true, value: undefined };
}

async function unlinkProgram(
  ul: (path: string) => Promise<void>,
  path: string,
  userId: string,
): Promise<Result<void, SupervisordError>> {
  try {
    await ul(path);
    return { ok: true, value: undefined };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    if (reason.includes("ENOENT")) {
      log.debug("removeProgram.file-already-gone", { userId });
      return { ok: true, value: undefined };
    }
    log.warn("removeProgram.unlink-failed", { userId, reason });
    return { ok: false, error: { kind: "io-failed", reason } };
  }
}

async function rereadAndUpdate(
  sh: Shell,
  ctlArgs: readonly string[],
  userId: string,
): Promise<Result<void, SupervisordError>> {
  const reread = await sh([...ctlArgs, "reread"]);
  if (!reread.ok) {
    log.warn("supervisord.reread-failed", { userId, reason: reread.error.reason });
    return { ok: false, error: { kind: "shell-failed", reason: reread.error.reason } };
  }
  const update = await sh([...ctlArgs, "update"]);
  if (!update.ok) {
    log.warn("supervisord.update-failed", { userId, reason: update.error.reason });
    return { ok: false, error: { kind: "shell-failed", reason: update.error.reason } };
  }
  log.info("supervisord.reread-update.ok", { userId });
  return { ok: true, value: undefined };
}

async function defaultShell(argv: readonly string[]): Promise<ShellResult> {
  // biome-ignore lint/suspicious/noExplicitAny: Bun namespace not in standard lib
  const bun = (globalThis as any).Bun;
  if (!bun || typeof bun.spawn !== "function") {
    return { ok: false, error: { kind: "spawn-failed", reason: "Bun.spawn unavailable" } };
  }
  const proc = bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const code: number = await proc.exited;
  const stdout: string = await new Response(proc.stdout).text();
  const stderr: string = await new Response(proc.stderr).text();
  if (code !== 0) {
    const reason = (stderr.slice(0, STDERR_PREVIEW_MAX) || stdout.slice(0, STDERR_PREVIEW_MAX)).trim();
    return { ok: false, error: { kind: "exit-non-zero", reason: reason || `exit code ${code}` } };
  }
  return { ok: true, value: stdout };
}
