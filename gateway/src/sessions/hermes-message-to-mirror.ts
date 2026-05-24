import type { MirrorEntry } from "../cerebrum/conversation-mirror.ts";
import type { HermesRawMessage } from "../hermes-adapter-client/sessions-client.ts";

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

function tsToMs(ts: number): number {
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
