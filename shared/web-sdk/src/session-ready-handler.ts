import { sessionReadySchema } from "@sentient/protocol";
import type { SessionReadyPayload } from "./connector-types.ts";

// ---------------------------------------------------------------------------
// session-ready-handler — schema-validated parsing of the session.ready message
// ---------------------------------------------------------------------------

/**
 * Parse `msg` against the protocol schema. On success invoke `callback` with
 * the typed payload. On failure log a WARN and return without calling `callback`.
 */
export function handleSessionReady(
  msg: unknown,
  callback: ((payload: SessionReadyPayload) => void) | undefined,
  log: (tag: string, detail: Record<string, unknown>) => void,
): void {
  const parsed = sessionReadySchema.safeParse(msg);
  if (!parsed.success) {
    log("session-ready: schema-validation-failed", { reason: parsed.error.message });
    return;
  }
  if (!callback) return;
  const { type: _type, playback, ...rest } = parsed.data;
  const payload: SessionReadyPayload = playback !== undefined ? { ...rest, playback } : rest;
  callback(payload);
}
