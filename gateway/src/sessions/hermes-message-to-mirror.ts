import type { MirrorEntry } from "../cerebrum/conversation-mirror.ts";
import type { HermesRawMessage } from "../hermes-adapter-client/sessions-client.ts";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "sessions", "hermes-message-to-mirror"]);

// ---------------------------------------------------------------------------
// HermesRawMessage → MirrorEntry — minimal role mapping for session resume.
//
// Used by SwitchFlow.fetchHistory to project the wire shape returned by
// Hermes' /api/sessions/:id/messages endpoint into the gateway's internal
// MirrorEntry shape. Only user + assistant entries are rehydrated.
//
// Tools (tool_call / tool_result / tool) are intentionally dropped:
//   Hermes' raw schema does not always carry the gateway-internal fields
//   (toolName, status, summary) cleanly. For v1 of session resume the
//   transcript renders user/assistant only; tool spans recover when the
//   user resumes interaction. A follow-up ticket can enrich tool entries
//   once Hermes' wire schema stabilises.
//
// system entries are also dropped — they're agent-internal and never
// surfaced to the SDK feed.
// ---------------------------------------------------------------------------

const TS_MS_THRESHOLD = 1e12;

// Last-resort timestamp for a rehydrated entry whose Hermes row carried no
// usable `ts` (missing, null, non-finite, or negative). MirrorEntry.ts feeds
// the wire feed's `ts` (protocol: non-negative int — see
// shared/protocol/src/conversation.ts) and the SDK's date-grouping/ordering.
// 0 is chosen over Date.now() so a timestamp-less rehydrated entry sorts to
// the START of history (before any live entry), never into the future. This
// is a degraded path: it's logged at WARN so the condition is observable.
const TS_FALLBACK_MS = 0;

/**
 * Coerce a raw Hermes message timestamp to a non-negative integer ms value.
 *
 * The plugin-sidecar response is untrusted external input (no zod gate on the
 * messages array), so `ts` may be missing/null/NaN at runtime despite its
 * `number` TS type. We backfill the real value when present and fall back to
 * TS_FALLBACK_MS (with a WARN) when it isn't — never emit NaN, which would
 * serialise to `null` on the wire and break strict SDK clients.
 */
function tsToMs(ts: unknown): number {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts < 0) {
    log.warn("ts-fallback", {
      reason: "missing-or-invalid-ts",
      rawTs: typeof ts === "number" ? ts : String(ts),
      fallbackMs: TS_FALLBACK_MS,
    });
    return TS_FALLBACK_MS;
  }
  // Hermes uses Unix seconds (float). MirrorEntry.ts is ms (int).
  return ts > TS_MS_THRESHOLD ? Math.round(ts) : Math.round(ts * 1000);
}

export function hermesMessageToMirrorEntry(m: HermesRawMessage): MirrorEntry | null {
  switch (m.role) {
    case "user":
      return {
        kind: "user",
        ts: tsToMs(m.ts),
        channel: "text",
        content: m.content ?? "",
      };
    case "assistant":
      return {
        kind: "assistant",
        ts: tsToMs(m.ts),
        content: m.content ?? "",
      };
    case "tool":
    case "tool_call":
    case "tool_result":
    case "system":
      return null;
    default:
      return null;
  }
}
