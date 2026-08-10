// Rendering a moment for the model to read.
//
// EVERY STAMP CARRIES AN EXPLICIT OFFSET, never a bare local time. The zone a
// household is in is a value that will change — location support is coming, and
// a person travels — so a stamp that only says "09:12" is only true until the
// next time the answer to "where" changes, and a history full of them silently
// rewrites itself. `2026-08-05T09:12:03-04:00` stays true forever: an old
// message keeps the offset it happened in while new ones carry the new one, and
// the two are allowed to disagree.
//
// The zone therefore arrives through a provider rather than being read from the
// host clock at the point of use. Today there is one implementation and it
// answers with the host's zone; when the app learns the household's real
// location, that becomes a second implementation and nothing else moves.
//
// ISO 8601 because it is the one format every model has seen a great deal of,
// and the one the temporal-reasoning literature uses when it augments dialogue.

import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "context", "message-time"]);

/** The IANA zone the household's clocks are in. One implementation today
 *  (the host); location-derived zones plug in here without touching callers. */
export interface TimeZoneProvider {
  /** An IANA zone name, e.g. "America/Toronto". */
  zone(): string;
}

/** The zone the gateway process is running in — correct while the household and
 *  its gateway are in the same place, which is the only topology today. */
export function createHostTimeZoneProvider(): TimeZoneProvider {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  log.info("message-time.host-zone", { zone });
  return { zone: () => zone };
}

const STAMP_FIELDS = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "longOffset",
} as const;

function fieldsOf(atMs: number, zone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, ...STAMP_FIELDS });
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(atMs))) out[part.type] = part.value;
  return out;
}

/**
 * `longOffset` renders as "GMT-04:00", and as a bare "GMT" at zero offset.
 * ISO 8601 wants "-04:00" and "+00:00" respectively.
 */
function isoOffset(timeZoneName: string | undefined): string {
  if (timeZoneName === undefined) return "+00:00";
  const stripped = timeZoneName.replace("GMT", "");
  return stripped === "" ? "+00:00" : stripped;
}

/**
 * One moment as ISO 8601 with an explicit offset — `2026-08-05T09:12:03-04:00`.
 *
 * Falls back to UTC rather than throwing on an unusable zone: a message with a
 * slightly less local stamp is worth far more than a turn that cannot be built.
 */
export function formatStamp(atMs: number, zone: string): string {
  try {
    const f = fieldsOf(atMs, zone);
    return `${f.year}-${f.month}-${f.day}T${f.hour}:${f.minute}:${f.second}${isoOffset(f.timeZoneName)}`;
  } catch (err: unknown) {
    log.warn("message-time.zone-unusable", {
      zone,
      reason: err instanceof Error ? err.message : String(err),
      fallback: "UTC",
    });
    return new Date(atMs).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  }
}

/** Long weekday name in [zone] — for the session block, where "Wednesday"
 *  does work that a date alone does not. */
export function formatWeekday(atMs: number, zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(new Date(atMs));
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(new Date(atMs));
  }
}
