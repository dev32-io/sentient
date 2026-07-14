/** Format a Date as local-time ISO-ish string: YYYY-MM-DDTHH:mm:ss.mmm */
export function formatLocalTimestamp(d: Date): string {
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, "0");
  const D = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${Y}-${M}-${D}T${h}:${m}:${s}.${ms}`;
}

/** Format a Date as local-time date string: YYYY-MM-DD */
export function formatLocalDate(d: Date): string {
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, "0");
  const D = String(d.getDate()).padStart(2, "0");
  return `${Y}-${M}-${D}`;
}

const LEVEL_PAD_WIDTH = 5;
const MAX_VALUE_LENGTH = 200;

const LEVEL_DISPLAY: Record<string, string> = {
  trace: "TRACE",
  debug: "DEBUG",
  info: "INFO",
  warning: "WARN",
  warn: "WARN",
  error: "ERROR",
  fatal: "FATAL",
};

export interface LogEntryInput {
  level: string;
  category: readonly string[];
  message: string;
  timestamp: Date;
  properties: Record<string, unknown>;
}

/**
 * Joins category elements into a tag string, skipping the root element.
 * `["sentient", "tts", "local-tts"]` becomes `"tts:local-tts"`.
 * Single element returns as-is.
 */
export function formatTag(category: readonly string[]): string {
  if (category.length === 0) return "";
  if (category.length === 1) return category[0] ?? "";
  return category.slice(1).join(":");
}

/**
 * Serializes properties as `key=value` pairs.
 * Strings are quoted and truncated at 200 chars.
 */
export function serializeProperties(props: Record<string, unknown>): string {
  const entries = Object.entries(props);
  if (entries.length === 0) return "";

  return entries.map(([key, value]) => `${key}=${formatValue(value)}`).join(" ");
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    const truncated = value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}...` : value;
    return `"${truncated}"`;
  }
  return String(value);
}

/**
 * Formats a complete log entry line:
 * `{iso-ms} {LEVEL padded} [{tag}] {event} | {key=value pairs}`
 *
 * Omits the `|` separator when no properties are present.
 */
export function formatLogEntry(entry: LogEntryInput): string {
  const iso = formatLocalTimestamp(entry.timestamp);
  const levelRaw = LEVEL_DISPLAY[entry.level] ?? entry.level.toUpperCase();
  const level = levelRaw.padEnd(LEVEL_PAD_WIDTH);
  const tag = formatTag(entry.category);
  const serialized = serializeProperties(entry.properties);

  const base = `${iso} ${level} [${tag}] ${entry.message}`;
  if (serialized === "") return base;
  return `${base} | ${serialized}`;
}
