// Session titling (session-model spec §6) — the auxiliary-task seam's FIRST
// USER, and deliberately nothing more than that: a template, a schema, and the
// store write. Tags, follow-up suggestions and summarisation land as siblings
// of this file, each one a `.md` in the auxiliary template dir plus a function
// this size. If a future task needs to change `auxiliary-task.ts` to exist,
// that is the signal the seam was drawn wrong.
//
// TWO INDEPENDENT GUARDS, AND NEITHER IS REDUNDANT (task 2's `setTitle`):
//
//   - THE CAS VERSION is read BEFORE the provider round trip and carried
//     across it. That is the whole point — re-reading it immediately before
//     the write would make the compare-and-set compare against itself and
//     always succeed, i.e. no guard at all. It catches a CONCURRENT write:
//     another titler run, or a rename that landed while the model was
//     thinking.
//   - THE PROVENANCE CHECK catches a LATER write that happens to carry a valid
//     version — a title a person had already set when this run started. The
//     store enforces it inside the same UPDATE (session-metadata.ts); this
//     module ALSO checks it up front, purely so a person's own title never
//     costs a provider call.
//
// A SESSION IS NEVER PERMANENTLY "UNTITLED". Every failure path falls back to
// the truncated first user message, which is a worse title but always a
// readable one, and the WARN names the root cause AND which fallback ran —
// `titler.generation-failed` with neither would be a line that proves nothing.
//
// NOTHING HERE BLOCKS A TURN. The caller (session-runtime.ts) fires this on a
// detached continuation after the reply has already committed and its terminal
// frame has already gone out.

import { z } from "zod";
import { getLog } from "../logging/logger.js";
import type { ProviderClient } from "../provider/provider-client.js";
import type { SessionEntry } from "../store/entry-types.js";
import type { TitleProvenance } from "../store/session-metadata.js";
import type { SessionStore } from "../store/session-store.js";
import type { AuxiliaryFailureReason, AuxiliaryTaskConfig } from "./auxiliary-task.js";
import { runAuxiliaryTask } from "./auxiliary-task.js";

const log = getLog(["sentient", "runtime", "titler"]);

/** Template file name inside the auxiliary template dirs. */
export const TITLE_TEMPLATE = "title.md";

/** The one fallback this task has, named in the WARN so an operator can tell a
 *  generated title from a salvaged one without reading the code. */
export const TITLE_FALLBACK = "truncated-first-message";

/** Ellipsis appended to a title cut at `title_max_chars`. */
const ELLIPSIS = "…";

/** The structured answer. One field, because a title is one field — a schema
 *  is what lets the seam serve tasks whose answers share nothing. */
const titleAnswerSchema = z.object({ title: z.string().min(1) });

/** Entry kinds the opening slice is built from — what was SAID, never the
 *  loop's own tool traffic or a compaction marker. */
const CONVERSATION_KINDS = new Set<SessionEntry["kind"]>(["user", "assistant"]);

export interface TitlerDeps {
  /** This session's store handle. Read for the opening slice + the metadata
   *  row, written through the compare-and-set `setTitle`. */
  readonly store: SessionStore;
  readonly provider: ProviderClient;
  readonly sessionId: string;
  readonly userId: string;
  readonly config: AuxiliaryTaskConfig;
  /** Operator override → baked-in, already resolved (see
   *  context/system-prompt-loader.ts's `loadAuxiliaryTemplate`). */
  readonly loadTemplate: (templatePath: string) => string | null;
  /**
   * Push the accepted title to every attached window. Called ONLY when the
   * store accepted the write — pushing a title the store refused would rename
   * the row in every client's sidebar and leave the durable record disagreeing
   * with all of them until the next reload.
   */
  readonly emitTitle: (title: string, provenance: TitleProvenance) => void;
  /** Aborted when the owning session is disposed. Re-checked before the store
   *  write, because `dispose()` closes the SQLite handle and a write after it
   *  raises "Statement has finalized" on a detached continuation. */
  readonly signal: AbortSignal;
}

export interface TitlerOutcome {
  /** The title that landed, or null when nothing was written. */
  readonly title: string | null;
  /** Whether the store ACCEPTED the write. False covers both guards refusing
   *  and every skip path. */
  readonly applied: boolean;
  /** Why generation failed; null when the model answered usefully or when the
   *  run was skipped before it ever asked. */
  readonly reason: AuxiliaryFailureReason | null;
  /** Which fallback produced `title`; null when the model did. */
  readonly fallback: typeof TITLE_FALLBACK | null;
}

const SKIPPED: TitlerOutcome = { title: null, applied: false, reason: null, fallback: null };

/** The opening of the conversation, as the prompt sees it. Bounded again at
 *  the seam — this is a readability slice, not the safety one. */
function openingSlice(entries: readonly SessionEntry[]): string {
  return entries
    .filter((e) => CONVERSATION_KINDS.has(e.kind) && (e.text ?? "").length > 0)
    .map((e) => `${e.kind === "user" ? "Person" : "Assistant"}: ${e.text ?? ""}`)
    .join("\n");
}

/** The first thing the person said, or null when they said nothing yet. */
function firstUserMessage(entries: readonly SessionEntry[]): string | null {
  const first = entries.find((e) => e.kind === "user" && (e.text ?? "").trim().length > 0);
  return first?.text?.trim() ?? null;
}

/**
 * A title bounded to `title_max_chars`.
 *
 * Applied to the MODEL's answer too, not just the fallback: the wire contract
 * caps a title at 200 characters and a `session.title` frame that exceeds it is
 * validated away before it leaves the gateway (fan-out-emitter.ts), which looks
 * from the outside exactly like the generator never running.
 */
function boundTitle(raw: string, maxChars: number): string {
  const clean = raw.replace(/\s+/gu, " ").trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
}

/**
 * Generate and store this session's title. Resolves with what happened; never
 * throws, and never leaves the session without a title it could have had.
 */
export async function runTitler(deps: TitlerDeps): Promise<TitlerOutcome> {
  const { store, sessionId, userId, config } = deps;

  if (!config.enabled) return SKIPPED;

  const session = store.getSession(sessionId);
  if (session === null) {
    log.warn("titler.no-session-row", {
      userId,
      sessionId,
      reason: "no sessions row for this id — nothing to compare-and-set against, so nothing safe to write",
    });
    return SKIPPED;
  }
  if (session.titleProvenance === "user") {
    log.info("titler.skipped", { userId, sessionId, reason: "the person named this conversation themselves" });
    return SKIPPED;
  }
  if (session.title !== null) {
    log.debug("titler.skipped", { userId, sessionId, reason: "already titled" });
    return SKIPPED;
  }

  // READ BEFORE THE ROUND TRIP, USED AFTER IT. See this file's header — a
  // re-read here is the one change that silently disables the CAS.
  const expectedVersion = session.version;

  const entries = store.readSession(sessionId);
  const opening = firstUserMessage(entries);
  if (opening === null) {
    log.debug("titler.skipped", { userId, sessionId, reason: "nothing the person said to title" });
    return SKIPPED;
  }

  let failure: AuxiliaryFailureReason | null = null;
  const answer = await runAuxiliaryTask(
    {
      templatePath: TITLE_TEMPLATE,
      variables: { conversation: openingSlice(entries), word_target: String(config.title_word_target) },
      schema: titleAnswerSchema,
      maxOutputTokens: config.max_output_tokens,
    },
    {
      provider: deps.provider,
      config,
      loadTemplate: deps.loadTemplate,
      signal: deps.signal,
      taskName: "title",
      sessionId,
      userId,
      onFailure: (reason) => {
        failure = reason;
      },
    },
  );

  const generated = answer === null ? null : boundTitle(answer.title, config.title_max_chars);
  const title = generated ?? boundTitle(opening, config.title_max_chars);
  const fallback = generated === null ? TITLE_FALLBACK : null;
  if (fallback !== null) {
    log.warn("titler.generation-failed", {
      userId,
      sessionId,
      // Both, always: the root cause AND which fallback ran. Either alone is a
      // line that cannot be acted on.
      reason: (failure as AuxiliaryFailureReason | null) ?? "auxiliary task produced no answer",
      fallback,
    });
  }

  // The disposal that closed the store handle can have landed during the round
  // trip above. Writing through a closed bun:sqlite handle throws, and this
  // runs on a detached continuation.
  if (deps.signal.aborted) {
    log.info("titler.abandoned", { userId, sessionId, reason: "session torn down while the title was generating" });
    return { title, applied: false, reason: failure, fallback };
  }

  const applied = store.setTitle(sessionId, title, "generated", expectedVersion);
  if (!applied) {
    // `setTitle` already WARNed with which guard refused it.
    log.info("titler.write-refused", {
      userId,
      sessionId,
      expectedVersion,
      reason: "a concurrent or user-provenance title write won; the generated title is discarded",
    });
    return { title, applied: false, reason: failure, fallback };
  }

  log.info("titler.applied", { userId, sessionId, titleChars: title.length, fallback });
  deps.emitTitle(title, "generated");
  return { title, applied: true, reason: failure, fallback };
}
