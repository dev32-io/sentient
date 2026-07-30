# compaction-continue — second INDEPENDENT live sample → **PASS** (2/2)

Sample 1 (`RE-DRIVE-T9b.md`) resumed the session that had already failed twice. This one grows a
**fresh, empty** session from zero against the real model, so the commit is not an artifact of one
particular transcript. Same stack, same `gpt-oss:20b-cloud`.

Surface `t9b-sample2-fresh` (a new partition on Ada's own user), 9 real turns of 450-word essay
requests, one turn every ~10 s, driven over the real WS seam.

```
+   0s session.ready — fresh surface t9b-sample2-fresh
+   6s turn 1/12 done answerChars=4123 markers=0
…
+  81s turn 9/12 done answerChars=3628 markers=0
+  83s markers=1          ← committed on the turn that crossed the threshold
```
```
03:54:15.859 INFO compaction.summarizing | estimatedTokens=8249 thresholdTokens=8000
03:54:15.860 INFO [provider:openai] stream-start | model="gpt-oss:20b-cloud" messageCount=2 toolCount=0
03:54:17.734 INFO [provider:openai] stream-end   | durationMs=1874 finishReason="stop"
                                                   promptTokens=3749 completionTokens=323
03:54:17.734 INFO compaction.committed | seq=87 compactedThroughSeq=86
```

**Honest weighting of the two samples.** This transcript was the *easier* one: `keep_recent_turns: 4`
held the four newest essays back as verbatim, so the summarizer only digested 3749 prompt tokens and
answered in 323. Sample 1 is the load-bearing one — 7803 prompt tokens in, 935 out, on the exact
transcript shape that failed. Together: 2/2 commit, and the observed summarizer output has ranged
323-935 tokens against a 4000 budget.

## Log trail for the whole drive — clean on compaction

Two WARNs in the window, both pre-existing and unrelated:
`mcp.list-tools.failed serverName="music_assistant"` (addon not up) and
`mcp.entry.stdio-skipped serverName="gateway"` (v1 dials http only). Zero compaction WARN/ERROR.

---

## NEW DEFECT D8 (found by this drive, NOT fixed — out of this review's scope)

**The same reasoning-channel cap that broke compaction also silently ships an EMPTY ASSISTANT
ANSWER on the ordinary turn path.** Turn 5 of 9:

```
03:53:29.161 react-loop.start   | turnId="761ef25e-…"
03:53:36.893 [provider:openai] stream-end | finishReason="length" promptTokens=12297 completionTokens=1024
03:53:36.894 react-loop.completed        ← logged as a NORMAL completion, no WARN
03:53:36.894 turn-emitter.turn-completed
```
Store, that turn:
```
77|user|72 chars
78|assistant|0 chars|cutoff=NULL     ← an empty committed answer, not a cutoff
```
The main loop's `orchestrator.provider.max_output_tokens: 1024` is an ANSWER cap; once the prompt
grows (12297 tokens here) gpt-oss:20b spends the whole 1024 on its Harmony reasoning channel and
never reaches the visible channel. The user gets an empty bubble, `cutoff` is null so nothing marks
it as truncated, and the log records a successful turn. Observed 1/9 turns in this drive, and it
gets more likely as a session grows — i.e. exactly when compaction has not yet fired.

**Deliberately not fixed here.** `max_output_tokens: 1024` is an operator-tuned constant, and the
right remedy is a design decision, not a number bump — candidates: treat
`finishReason === "length"` with empty visible text as a turn failure (retry once, or commit with
`cutoff: "length"` so the client can show it), and/or give the answer path headroom the way
`summarizer_max_output_tokens` gave the summarizer. Needs its own task.
