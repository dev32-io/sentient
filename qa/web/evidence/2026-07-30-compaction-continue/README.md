# compaction-continue — trigger mechanism PASS; summarizer FAILS (real defect, 2/2)

## The tuned threshold fires correctly — Step 3's work is validated

Grew a real session (mixed turns, tool calls, several long essays) past
the tuned `compact_threshold_tokens: 8000` using the sqlite session store
to track the real running total directly (`~/.sentient/gateway/users/
<userId>/sessions.db`, `entries` table) rather than guessing from chat
transcripts. Confirmed the estimator crosses the threshold and
`maybeCompact()` correctly triggers at the next turn boundary:
```
compaction.summarizing | estimatedTokens=9306 thresholdTokens=8000 boundarySeq=61 olderEntries=51 recentEntries=10 transcriptChars=23148
```
This is real, live proof the Step-3 tuning works end-to-end for the
trigger half of the feature — 8000 is reachable inside a realistic
agent-driven test session (took ~14 real turns of a mix of essay-length
and short replies, not dozens), exactly the design goal.

## The summarizer call itself fails — every time observed (2/2, two separate gateway processes)

Both times the trigger fired, the actual summarization round-trip failed
with `finishReason="length"` — the summarizer hit
`orchestrator.provider.max_output_tokens` (1024, not owned by this task)
before producing any visible text, so `summary.trim().length === 0`
(`compaction.ts`'s own `empty-summary` guard) and the compaction was
correctly **skipped** rather than committing an empty marker — the guard
itself did its job.
```
Attempt 1: stream-end | finishReason="length" promptTokens=5920  completionTokens=1024
           compaction.skipped | reason="empty-summary" boundarySeq=61
Attempt 2 (fresh gateway process, independent trigger, different turnId):
           stream-end | finishReason="length" promptTokens=6789  completionTokens=1024
           compaction.skipped | reason="empty-summary" boundarySeq=63
```
Full excerpts: `gateway-log-excerpt.txt` (attempt 1).

**Read on this, not fixed (out of T9's ownership — `max_output_tokens`
and `gateway/src/runtime/compaction.ts` are not the one key this task
owns):** gpt-oss:20b uses OpenAI's Harmony response format with a
separate internal reasoning channel before the visible "final" channel.
On a summarization task with a ~6800-token transcript to digest, it looks
like the model spends its entire 1024-token output budget reasoning about
the transcript and never reaches the final-channel text — 1024 tokens is
comfortable for a short chat reply but plausibly too tight for
"read-and-condense a multi-thousand-token transcript" with this
particular model's response style. **Practical consequence: with the
shipped `max_output_tokens: 1024`, compaction is at real risk of never
successfully completing against gpt-oss:20b-cloud** — the conversation
just keeps growing past the threshold, re-attempting (and re-failing) at
every subsequent turn boundary, which is silent (`log.warn`, no user-
visible signal) and defeats the whole point of bounding context growth.
Flagging for whoever owns `orchestrator.provider.max_output_tokens` /
`gateway/src/runtime/compaction.ts` — a plausible fix shape (not applied
here) is a separate, larger `max_tokens` specifically for the summarizer
call, since it is a fundamentally different workload than a normal chat
turn.

## Not retested after fixing (structurally can't be, within T9's ownership)

"conversation stays coherent; full history still visible" — the
CLIENT-side half of this assertion (full history still visible after a
compaction event) is already proven true independent of whether
compaction actually commits, since `client-projection.ts` reads the full
entry stream regardless (see `reload-convergence`, `restart-persistence`
— both already exercise post-many-turns history rendering). The
MODEL-side half ("conversation stays coherent" *because* it was
compacted) could not be observed live since no marker ever committed in
either attempt.
