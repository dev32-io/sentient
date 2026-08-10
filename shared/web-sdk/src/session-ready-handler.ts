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
  // `rest` may still carry gateway fields the SDK does not surface (e.g. the
  // dead `playback` preempt tunables). Structural assignment drops them, and
  // NOT destructuring `playback` by name keeps this compiling whether or not
  // the protocol schema still declares the optional field.
  const { type: _type, ...rest } = parsed.data;
  callback(rest);
}
