// The `<session>` block — what is true for this whole session and does not
// change while it runs.
//
// TIER 3 OF THE PROMPT. The assembly is a cache cascade, static-to-volatile:
//
//   [1] system_prompt.md   static, shared by every user and every session
//   [2] persona + profile  per-user, stable across sessions
//   [3] THIS BLOCK         per-session, fixed at its start
//   [4] history            append-only, each stimulus stamped
//   [5] <situation>        volatile, re-rendered per turn, always last
//
// Each tier only invalidates the tiers below it, so this one costs a cache miss
// on the session's first turn and nothing after. That is also why it is its own
// message rather than text concatenated onto the system prompt: concatenating
// would make the shared prefix per-session and throw away reuse across every
// session in the household.
//
// COMPOSED FROM COLLABORATORS, each owning one fact and its own formatting.
// The renderer only decides which of them appear and in what order. Adding the
// household's location, its room layout, or an opening sensor read is then a
// new collaborator and one line in `render()` — no signature churn, and each
// piece testable on its own.

import { getLog } from "../logging/logger.js";
import { type TimeZoneProvider, formatStamp, formatWeekday } from "./message-time.js";

const log = getLog(["sentient", "context", "session-block"]);

/** Injected so a session's start time is a value the caller controls — tests
 *  pin it, and nothing here reaches for the wall clock on its own. */
export interface SessionClock {
  nowMs(): number;
}

/** Who the gateway is speaking with, and who else it may be asked about.
 *
 *  The system prompt already promises "any of them may be speaking to you" and
 *  "never another person's private data", but until this block existed it never
 *  said WHO is speaking — an instruction the model had no way to apply. */
export interface SpeakerIdentity {
  describe(): Promise<{ speaking: string; household: readonly string[] }>;
}

/** Whether this conversation is new or picked back up, and when it was last
 *  active. A resumed conversation whose last message is a day old is a
 *  different situation from one three seconds cold, and the difference is not
 *  visible anywhere in the message history itself. */
export interface SessionContinuity {
  describe(): { kind: "new" } | { kind: "resumed"; lastActiveAtMs: number };
}

export interface SessionBlockRenderer {
  /** The block, or null when every collaborator declined — never an empty
   *  element, which reads to the model as "these facts are unknown" rather
   *  than "this harness does not report them". */
  render(): Promise<string | null>;
}

export interface SessionBlockDeps {
  readonly clock: SessionClock;
  readonly timeZone: TimeZoneProvider;
  readonly identity: SpeakerIdentity;
  readonly continuity: SessionContinuity;
  readonly sessionId: string;
}

function continuityLine(deps: SessionBlockDeps, zone: string): string {
  const c = deps.continuity.describe();
  if (c.kind === "new") return "continuity: new conversation";
  return `continuity: resumed, last active ${formatStamp(c.lastActiveAtMs, zone)}`;
}

export function createSessionBlockRenderer(deps: SessionBlockDeps): SessionBlockRenderer {
  return {
    async render() {
      const zone = deps.timeZone.zone();
      const startedMs = deps.clock.nowMs();
      const lines: string[] = [
        `started: ${formatStamp(startedMs, zone)} (${formatWeekday(startedMs, zone)})`,
        `timezone: ${zone}`,
      ];

      // Identity is the one collaborator that does I/O, so it is the one that
      // can decline. Its absence must not take the clock down with it.
      try {
        const who = await deps.identity.describe();
        lines.push(`speaking with: ${who.speaking}`);
        if (who.household.length > 0) lines.push(`household: ${who.household.join(", ")}`);
      } catch (err: unknown) {
        log.warn("session-block.identity-unavailable", {
          sessionId: deps.sessionId,
          reason: err instanceof Error ? err.message : String(err),
          fallback: "the block renders without who is speaking",
        });
      }

      lines.push(continuityLine(deps, zone));

      const block = `<session>\n${lines.join("\n")}\n</session>`;
      log.debug("session-block.rendered", { sessionId: deps.sessionId, lineCount: lines.length });
      return block;
    },
  };
}
