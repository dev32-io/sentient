// Tool-result size cap (task 18, D17) — the broker's own backstop against a
// single foreground tool result crowding the model's ANSWER out of its
// completion budget entirely.
//
// WHY THE BROKER, NOT THE TOOL. `ha_get_history` returning ~81KB was merely
// the first tool result big enough to prove the class: `read_file` and
// `write_file` (any MCP tool whose payload size is not bounded by the tool
// itself) hit the same ceiling next. Capping in ONE place — the broker's
// single dispatch choke point (tool-broker.ts) — means every tool, present
// and future, inherits the guarantee without its own author having to
// remember it.
//
// HEAD-AND-TAIL, NOT HEAD-ONLY. History/log-shaped data (Home Assistant
// history, file tails, search-result pages) carries meaning at both ends —
// truncating only the head silently discards whatever is newest. This is the
// established convention, not a house invention: Codex truncates tool output
// at 10 KiB / 256 lines head-and-tail; Pi caps at 2000 lines / 50 KB and
// tells the model to paginate.
//
// THE MARKER NAMES WHAT HAPPENED. A model handed a silently truncated
// fragment has no way to know its own context is incomplete and will
// confidently reason over a partial result — the same "honesty of a result
// is a property we have to check, not one we can inherit" lesson D18 names
// from the other direction. The marker states that content was cut and
// roughly how much, so the model can narrow its next query instead.

/** Appears in the marker; also what a caller greps for/asserts on to know a
 *  result was NOT returned verbatim. */
const TRUNCATED_WORD = "truncated";

export interface CapToolResultOptions {
  /** `orchestrator.tools.max_tool_result_chars`. */
  limit: number;
}

function truncationMarker(omittedChars: number, originalLength: number): string {
  return `\n\n[... tool result ${TRUNCATED_WORD}: ${omittedChars} of ${originalLength} characters omitted here (kept the start and the end) — narrow your query to see the missing part ...]\n\n`;
}

/**
 * Caps `content` at roughly `limit` characters. A no-op when it already
 * fits. Otherwise keeps the first half and the last half of the budget and
 * splices a marker between them, so the returned string lands a little OVER
 * `limit` (by the marker's own length) rather than under it — the head+tail
 * budget itself is never shorted to make room for the marker.
 */
export function capToolResult(content: string, opts: CapToolResultOptions): string {
  const { limit } = opts;
  if (content.length <= limit) return content;

  const headLen = Math.floor(limit / 2);
  const tailLen = limit - headLen;
  const head = content.slice(0, headLen);
  const tail = tailLen > 0 ? content.slice(content.length - tailLen) : "";
  const omittedChars = content.length - headLen - tailLen;

  return head + truncationMarker(omittedChars, content.length) + tail;
}
