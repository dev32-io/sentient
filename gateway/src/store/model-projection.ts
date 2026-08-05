// Model projection (spec §3.2, §3.4) — entries → OpenAI chat messages.
//
// Rules earned the hard way (see the pre-Hermes archive):
//  1. The tool round-trip must be COMPLETE. The assistant message carries
//     `tool_calls`; each result rides as a separate role:"tool" message with a
//     matching tool_call_id. Break this and the model never sees its own tool
//     result and re-issues the same call.
//  2. After compaction we replay from the last compaction entry forward.
//  3. OpenAI requires role:"tool" messages to immediately follow the assistant
//     message that declared them, and every id declared in one run to be
//     answered by that SAME run. Set-membership pairing (any call id in the
//     slice intersected with any result id in the slice) is not enough — it
//     lets a tool_result that arrived out of position (before its call, or
//     separated from it by an intervening assistant/system entry) pair with a
//     call it doesn't structurally follow, producing a message array the
//     provider 400s on. This function pairs by BLOCK ADJACENCY instead: a run
//     of tool_call entries is paired with the following run of tool_result
//     entries. Anything unmatched in either direction is dropped and logged —
//     a dropped-but-computed result is real context loss, so it must never be
//     silent.
//  3b. A STIMULUS MAY LAND INSIDE AN OPEN BLOCK, and it does not break the
//     pairing. `dispatchToolCalls` appends the `tool_call`, awaits the tool,
//     then appends the `tool_result` — so the store's tail is split open for
//     the whole duration of the call (an MCP round trip, or a confirm-tier
//     prompt's full `request_timeout_ms`), and that is precisely the window
//     spec §4.5's steer seam appends into: a background `delegateTask`
//     completion, or the user's second message. Strict adjacency read that as
//     "call unreplied, result orphaned" and dropped BOTH halves, so the next
//     iteration's messages[] held no record the tool had ever run and the
//     model re-issued the identical call — the light switched twice, the
//     calendar event written twice. So a `user`/`trigger` entry (the two kinds
//     an external stimulus can append — never the loop's own output) is
//     DEFERRED past the block instead of closing it: the round trip stays
//     contiguous, and the stimulus is emitted immediately after it, which is
//     also when the model genuinely first sees it. Anything else — assistant
//     narration, the next tool_call, a compaction marker — is the loop's own
//     output and does close the block.
//  4. Block adjacency means a result that lands AFTER its block has already
//     closed has nowhere valid to attach: a second tool_result for an
//     id this function already answered is superseded and dropped (logged,
//     never silent), not appended out of position. There is no production
//     caller of a late/out-of-band completion yet, but the rule is fixed now
//     so nobody "fixes" this by reusing the id: a background-task completion
//     that arrives after its block MUST be appended as a new "system" or
//     "trigger" entry, never as a second tool_result for an already-answered
//     id. Reusing the id makes the completion invisible to the model, which
//     then re-issues the same call — the exact failure mode rule 1 exists to
//     prevent.
//  5. A STIMULUS'S ROLE IS WHO SPOKE IT. Only a `user` entry was spoken by the
//     person; a `trigger` is a stimulus nobody typed and projects as
//     role:"system". See `stimulusRole` below for the defect this cost us
//     (D16) and why the rule keys on the entry kind rather than on a recorded
//     stimulus type. It applies on BOTH emission paths — the straight-line
//     branch and rule 3b's deferred one.
//  6. A `trigger` IS FOLLOWED BY AN INSTRUCTION THE MODEL WILL ANSWER. Rule 5
//     is correct and stays, but it is only half of D16: these models do not
//     VOLUNTEER a reply to a system message — they answer users. So each
//     completion is followed by `BACKGROUND_COMPLETION_INSTRUCTION` in the
//     user role. See that constant for the measurements and the trust
//     boundary. Emitted by `emitStimulus`, which both paths call, because
//     rule 5's own one-line fix once covered only one of them.

import { formatStamp } from "../context/message-time.js";
import { getLog } from "../logging/logger.js";
import type { SessionEntry } from "./entry-types.js";

const log = getLog(["sentient", "store", "model-projection"]);

/** The entry kinds an EXTERNAL stimulus can append (`SessionRuntime.submit` —
 *  a person's message, or a background-task completion). They are the only
 *  kinds that may land inside an open tool block without closing it; see
 *  rule 3b in this file's header. Deliberately excludes every kind
 *  react-loop.ts appends itself. */
const DEFERRABLE_STIMULUS_KINDS = new Set<SessionEntry["kind"]>(["user", "trigger"]);

/**
 * Rule 5 (defect D16). A stimulus's role answers exactly one question — WHO
 * SPOKE — and only a `user` entry was spoken by the person. A `trigger` is a
 * stimulus nobody typed: a background task completing today; a sensor reading
 * or a scheduled wake later. Projected as role:"user" the model reads it as
 * the person pasting a result into the chat, so it answers the PERSON
 * ("Great! Let me know if you'd like to use that somewhere.") and never
 * relays what came back — observed live twice, and from outside the whole
 * delegation feature looks broken.
 *
 * Deliberately keyed on the entry KIND rather than on a recorded stimulus
 * type, because the answer to "who spoke" is the same for every
 * non-conversational source: not the person. What differs between a sensor
 * reading and a task completion is the TEXT, and the text is composed at the
 * source, which already knows. Adding a `stimulus_kind` column would mean a
 * forward-only migration over every existing user database (see schema.ts's
 * frozen-baseline header) to carry a discriminator nothing reads.
 */
function stimulusRole(kind: SessionEntry["kind"]): "user" | "system" {
  return kind === "user" ? "user" : "system";
}

/**
 * Rule 6 (defect D16, second half). Rule 5 puts the completion in the system
 * role and that is right — but on its own it produced nothing: 0/9 relays on
 * `gpt-oss:20b` (which acknowledged without ever restating the answer) and
 * `completionTokens=1 textLength=0` on `deepseek-v4-flash` (silence). The
 * content was never lost — asked directly, both models reproduce the payload
 * and the task id verbatim. They see it and decline to speak. Six framing
 * passes over the note moved it 0/6. The defect is not the wording and not the
 * role: THESE MODELS WILL NOT VOLUNTEER A REPLY TO A SYSTEM MESSAGE. They
 * answer users. So the follow-up turn ends with something addressed to them.
 *
 * "Respond accordingly", not "relay the result", is deliberate: a delegation
 * can also fail, or come back needing another tool call before it means
 * anything, and a directive to relay would be wrong for both.
 *
 * THE PAYLOAD DOES NOT MOVE. It stays fenced inside the role:"system" message
 * with its task id and request echo; this line is the HARNESS speaking and
 * carries none of it. Per the Model Spec's chain of command tool output is the
 * lowest-trust input there is, and a delegated agent reads the open web —
 * promoting that content into the user's voice is exactly the injection
 * surface this shape exists to avoid.
 */
export const BACKGROUND_COMPLETION_INSTRUCTION =
  "The background task you dispatched has returned. Respond accordingly.";

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

/**
 * Emits one external stimulus: the entry itself in the role of whoever spoke
 * it (rule 5), plus — for a `trigger` only — the instruction that gets the
 * model to answer it (rule 6).
 *
 * Shared by BOTH emission paths on purpose. Rule 5 first shipped as a one-line
 * change on the straight-line branch alone, which left rule 3b's deferred path
 * — the one every completion takes while another delegation is still
 * mid-dispatch — projecting a task as the person.
 *
 * Appends only, and always immediately after the completion it belongs to, so
 * a second completion landing later extends the array without rewriting a byte
 * of the prefix (spec §3.2 cache stability). One instruction per completion,
 * never one covering several: handed two payloads and one prompt, the model
 * has no way to say which it is answering.
 */
function emitStimulus(messages: ChatMessage[], entry: SessionEntry, stamp: StampFn): void {
  messages.push({ role: stimulusRole(entry.kind), content: stamp(entry) });
  if (entry.kind !== "trigger") return;
  log.debug("projection.background-completion-instruction", {
    reason: "a system-role completion alone is not answered — appending the user-role instruction (rule 6)",
    seq: entry.seq,
  });
  messages.push({ role: "user", content: BACKGROUND_COMPLETION_INSTRUCTION });
}

/** Slice from the latest compaction entry forward; that entry becomes a system summary. */
function sliceFromLatestCompaction(entries: SessionEntry[]): {
  head: ChatMessage[];
  rest: SessionEntry[];
} {
  let lastCompactionIdx = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.kind === "compaction") {
      lastCompactionIdx = i;
      break;
    }
  }
  if (lastCompactionIdx === -1) return { head: [], rest: entries };

  const marker = entries[lastCompactionIdx];
  log.debug("projection.compacted", {
    compactedThroughSeq: marker?.compactedThroughSeq ?? null,
    droppedEntries: lastCompactionIdx + 1,
  });
  return {
    head: [{ role: "system", content: marker?.text ?? "" }],
    rest: entries.slice(lastCompactionIdx + 1),
  };
}

interface ToolBlock {
  calls: SessionEntry[];
  results: SessionEntry[];
  /** Stimuli that landed between the calls and their results. Emitted AFTER
   *  the block so every role:"tool" message stays adjacent to the assistant
   *  message that declared it (rule 3b). */
  deferred: SessionEntry[];
  /** Index of the first entry past this block. */
  next: number;
}

/**
 * Walks one tool block from `start`: its run of tool_call entries, then the
 * results answering them, stepping over any stimulus that landed in between.
 *
 * The scan stops as soon as every declared id is answered, so an already-closed
 * block never swallows later conversation. A run of trailing tool_results is
 * still consumed after that point — a second result for an id already answered
 * belongs to this block's supersede report, not to the orphan branch.
 */
function scanToolBlock(rest: SessionEntry[], start: number): ToolBlock {
  const calls: SessionEntry[] = [];
  const unanswered = new Set<string>();
  let i = start;
  for (let call = rest[i]; call?.kind === "tool_call"; call = rest[i]) {
    calls.push(call);
    if (call.toolCallId) unanswered.add(call.toolCallId);
    i += 1;
  }

  const results: SessionEntry[] = [];
  const deferred: SessionEntry[] = [];
  while (i < rest.length) {
    const entry = rest[i];
    if (!entry) break;
    if (entry.kind === "tool_result") {
      results.push(entry);
      if (entry.toolCallId) unanswered.delete(entry.toolCallId);
      i += 1;
      continue;
    }
    if (unanswered.size === 0 || !DEFERRABLE_STIMULUS_KINDS.has(entry.kind)) break;
    deferred.push(entry);
    i += 1;
  }

  return { calls, results, deferred, next: i };
}

/**
 * Pairs one run of tool_call entries with the run of tool_result entries that
 * answers it and pushes the resulting assistant + tool messages.
 * A call with no reply in this run, or a result with no matching call in
 * this run, is dropped (and logged) rather than emitted out of position.
 */
function emitToolBlock(messages: ChatMessage[], callEntries: SessionEntry[], resultEntries: SessionEntry[]): void {
  const resultById = new Map<string, SessionEntry>();
  const supersededResultIds: string[] = [];
  for (const r of resultEntries) {
    if (!r.toolCallId) continue;
    if (resultById.has(r.toolCallId)) {
      supersededResultIds.push(r.toolCallId); // second-in-block for an id already mapped; first wins
      continue;
    }
    resultById.set(r.toolCallId, r);
  }

  const seen = new Set<string>();
  const toolCalls: ChatToolCall[] = [];
  const droppedCallIds: string[] = [];
  const duplicateCallIds: string[] = [];
  const malformedCallSeqs: number[] = [];
  for (const c of callEntries) {
    const id = c.toolCallId;
    if (!id || !c.toolName) {
      malformedCallSeqs.push(c.seq);
      continue;
    }
    if (seen.has(id)) {
      duplicateCallIds.push(id); // repeat id in this block; first wins
      continue;
    }
    seen.add(id);
    if (!resultById.has(id)) {
      droppedCallIds.push(id);
      continue;
    }
    toolCalls.push({ id, type: "function", function: { name: c.toolName, arguments: c.toolArgs ?? "{}" } });
  }
  const droppedResultIds = [...resultById.keys()].filter((id) => !seen.has(id));

  if (supersededResultIds.length > 0) {
    log.warn("projection.dropped-superseded-tool-results", {
      reason: "superseded-result-in-block",
      toolCallIds: supersededResultIds,
    });
  }
  if (malformedCallSeqs.length > 0) {
    log.warn("projection.dropped-malformed-tool-call", {
      reason: "malformed-tool-call",
      seqs: malformedCallSeqs,
    });
  }
  if (duplicateCallIds.length > 0) {
    log.warn("projection.dropped-duplicate-tool-calls", {
      reason: "duplicate-call-id-in-block",
      toolCallIds: duplicateCallIds,
    });
  }
  if (droppedCallIds.length > 0) {
    log.warn("projection.dropped-unreplied-tool-calls", {
      reason: "unreplied-in-block",
      toolCallIds: droppedCallIds,
    });
  }
  if (droppedResultIds.length > 0) {
    log.warn("projection.dropped-parentless-tool-results", {
      reason: "no-parent-in-block",
      toolCallIds: droppedResultIds,
    });
  }

  if (toolCalls.length === 0) return; // never emit an empty tool_calls array
  messages.push({ role: "assistant", content: null, tool_calls: toolCalls });
  for (const tc of toolCalls) {
    messages.push({ role: "tool", tool_call_id: tc.id, content: resultById.get(tc.id)?.toolArgs ?? "" });
  }
}

/** Renders one stimulus entry's content — its text, wrapped in the envelope
 *  that carries when it was sent. See `stampedContent`. */
type StampFn = (entry: SessionEntry) => string;

/**
 * A stimulus, wrapped in an envelope carrying the moment it was sent.
 *
 * FENCED, not prefixed. The obvious shape — `[2026-08-05T09:12:03-04:00] what's
 * the news` — is what the temporal-reasoning literature uses, and it has one
 * bad property in production: the model reads it as characters the person
 * typed, and starts echoing stamps back into its own replies. An element around
 * the text says "this is an envelope the system put there", which the system
 * prompt's Time section then names explicitly.
 *
 * WHY STAMP AT ALL, given the measured effect is modest: without it the model
 * cannot tell a reply three seconds later from one the next morning, and every
 * dated question ("what's the news") is answered from a training cutoff it
 * cannot locate itself relative to. The stamps are what make the tool-call
 * protocol's "anything dated" rule mean something.
 *
 * Cache-stable: an entry's `createdAt` is fixed when it is appended, so a stamp
 * rendered now is the same one rendered on every later turn. Only the zone
 * could move it, and a zone change legitimately changes only messages that
 * happen after it.
 */
function stampedContent(entry: SessionEntry, zone: string): string {
  const text = entry.text ?? "";
  return `<msg at="${formatStamp(entry.createdAt, zone)}">\n${text}\n</msg>`;
}

export interface ProjectForModelOptions {
  /** The zone every stamp is rendered in. Omitted in tests and in any caller
   *  that does not care — an unstamped projection is still a correct one. */
  readonly timeZone?: string;
}

export function projectForModel(entries: SessionEntry[], options: ProjectForModelOptions = {}): ChatMessage[] {
  const zone = options.timeZone;
  const stamp: StampFn = zone === undefined ? (entry) => entry.text ?? "" : (entry) => stampedContent(entry, zone);
  const { head, rest } = sliceFromLatestCompaction(entries);
  const messages: ChatMessage[] = [...head];

  let i = 0;
  while (i < rest.length) {
    const entry = rest[i];
    if (!entry) {
      i += 1;
      continue;
    }

    if (entry.kind === "tool_call") {
      const block = scanToolBlock(rest, i);
      emitToolBlock(messages, block.calls, block.results);
      if (block.deferred.length > 0) {
        log.debug("projection.stimulus-deferred-past-tool-block", {
          reason: "a stimulus landed between a tool_call and its result — emitted after the round trip",
          seqs: block.deferred.map((s) => s.seq),
        });
      }
      for (const stimulus of block.deferred) {
        emitStimulus(messages, stimulus, stamp);
      }
      i = block.next;
      continue;
    }

    if (entry.kind === "tool_result") {
      // Not immediately preceded by its call block (arrived early, or
      // separated by an intervening entry) — pairing it here would put the
      // tool message out of position. Drop the whole run of consecutive
      // orphans as one batch (matching the in-block reporting shape); the
      // caller already has the computed result on record elsewhere, but the
      // model never sees it.
      const orphanStart = i;
      while (rest[i]?.kind === "tool_result") i += 1;
      const orphanRun = rest.slice(orphanStart, i);
      log.warn("projection.dropped-parentless-tool-results", {
        reason: "orphan-outside-block",
        toolCallIds: orphanRun.flatMap((r) => (r.toolCallId ? [r.toolCallId] : [])),
        seqs: orphanRun.map((r) => r.seq),
      });
      continue;
    }

    if (entry.kind === "user" || entry.kind === "trigger") {
      emitStimulus(messages, entry, stamp);
      i += 1;
      continue;
    }
    if (entry.kind === "assistant") {
      messages.push({ role: "assistant", content: entry.text ?? "" });
      i += 1;
      continue;
    }
    if (entry.kind === "system") {
      messages.push({ role: "system", content: entry.text ?? "" });
      i += 1;
      continue;
    }

    // Unrecognized kind. The store's read path casts `row.kind` with no
    // runtime validation (session-store.ts), so a foreign/corrupt row can
    // reach here. Never drop it silently.
    log.warn("projection.unknown-entry-kind", { kind: entry.kind, seq: entry.seq });
    i += 1;
  }

  return messages;
}
