import { randomBytes } from "node:crypto";
import { chownSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "gateway", "profile-store", "env-writer"]);

// The .env we write lands in ${HERMES_HOME}/profiles/<userId>/, which the
// hermes container's `hermes` user (uid 10000 in deploy/hermes-overlay) reads
// from on `hermes -p X gateway run`. The gateway container runs as root, so
// without an explicit chown the file is root:root 0600 and the hermes process
// crashes with `PermissionError: [Errno 13]` at dotenv load. Override via env
// for non-default deploys. Mirrors gateway/src/admin/chown-hermes.ts.
const DEFAULT_HERMES_UID = 10000;
const DEFAULT_HERMES_GID = 10000;

function hermesUid(): number {
  const raw = process.env.SENTIENT_HERMES_UID;
  if (raw === undefined || raw === "") return DEFAULT_HERMES_UID;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_HERMES_UID;
}

function hermesGid(): number {
  const raw = process.env.SENTIENT_HERMES_GID;
  if (raw === undefined || raw === "") return DEFAULT_HERMES_GID;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_HERMES_GID;
}

export interface SignalEnvValues {
  httpUrl: string;
  account: string;
  allowedUsers: string;
  /** Default delivery target for Hermes cron/scheduled messages. Without it,
   *  Hermes posts a one-time onboarding nag ("📬 No home channel is set …
   *  Type /sethome …") on the user's first message — confusing UX since
   *  Sentient pairing is single-user-Note-to-Self. We default to the user's
   *  own account so cron output and the first reply land in Note to Self. */
  homeChannel: string;
}

const SIGNAL_KEYS = [
  "SIGNAL_HTTP_URL",
  "SIGNAL_ACCOUNT",
  "SIGNAL_ALLOWED_USERS",
  "SIGNAL_ALLOW_ALL_USERS",
  "SIGNAL_HOME_CHANNEL",
];

function readLinesOrEmpty(path: string): string[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (text.length === 0) return [];
  return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
}

function stripSignalLines(lines: string[]): string[] {
  return lines.filter((line) => {
    const eq = line.indexOf("=");
    if (eq < 0) return true;
    const key = line.slice(0, eq);
    return !SIGNAL_KEYS.includes(key);
  });
}

function writeAtomic(path: string, content: string): void {
  const tmp = join(dirname(path), `.env.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmp, content, { mode: 0o600 });
  // Chown the tmp file BEFORE the rename so the visible path never appears
  // momentarily as root-owned. Failures are non-fatal (e.g. macOS Docker
  // Desktop's virtiofs ignores chown, or the gateway is running rootless)
  // — log + continue and let the next reader surface the real EACCES.
  try {
    chownSync(tmp, hermesUid(), hermesGid());
  } catch (err) {
    log.warn("chown.failed-continuing", { path, reason: err instanceof Error ? err.message : String(err) });
  }
  renameSync(tmp, path);
}

export async function mergeSignalEnv(path: string, values: SignalEnvValues): Promise<void> {
  const preserved = stripSignalLines(readLinesOrEmpty(path));
  const signalLines = [
    `SIGNAL_HTTP_URL=${values.httpUrl}`,
    `SIGNAL_ACCOUNT=${values.account}`,
    `SIGNAL_ALLOWED_USERS=${values.allowedUsers}`,
    "SIGNAL_ALLOW_ALL_USERS=false",
    `SIGNAL_HOME_CHANNEL=${values.homeChannel}`,
  ];
  const all = [...preserved, ...signalLines];
  writeAtomic(path, `${all.join("\n")}\n`);
}

export async function clearSignalEnv(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const preserved = stripSignalLines(readLinesOrEmpty(path));
  writeAtomic(path, preserved.length > 0 ? `${preserved.join("\n")}\n` : "");
}
