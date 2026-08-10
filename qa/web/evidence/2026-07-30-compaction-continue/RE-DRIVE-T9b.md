# compaction-continue — RE-DRIVEN against the real model after T9b's D4 fix → **PASS**

T9 left this row with the trigger half PASS and the summarizer half FAIL (`empty-summary`, 2/2).
T9b (`ed286b4`) gave the summarizer its own token budget but shipped only unit-test evidence — a
fake provider cannot prove anything about the behaviour that caused the defect (gpt-oss:20b burning
its whole cap on the Harmony reasoning channel). This is the missing live drive.

## How it was driven

The SAME real session that failed twice — `c::u_0417d3b0::2b9a32f5-292f-4e62-b38b-0502baf96220`,
already grown past `compact_threshold_tokens: 8000` by T9 — resumed over the real gateway WS seam
(`auth` → `session.configure` with that surfaceId → `text.input`) and given ONE more real turn.
Real gateway on `:8888` (started 03:15, i.e. carrying `ed286b4`), real Ollama-Cloud
`gpt-oss:20b-cloud`, real native local-tts. Resuming the already-failed session is deliberate:
it re-runs the exact transcript that produced `empty-summary`, only bigger.

## A `kind:"compaction"` entry IS appended now (was: never, 2/2)

```
03:38:44.315 INFO [runtime:compaction] compaction.summarizing | estimatedTokens=9434 thresholdTokens=8000
                                       boundarySeq=65 olderEntries=57 recentEntries=8 transcriptChars=31632
03:38:44.316 INFO [provider:openai]    stream-start | model="gpt-oss:20b-cloud" messageCount=2 toolCount=0
03:38:49.498 INFO [provider:openai]    stream-end   | durationMs=5182 finishReason="stop"
                                       promptTokens=7803 completionTokens=935
03:38:49.500 INFO [runtime:compaction] compaction.committed | seq=66 compactedThroughSeq=65
                                       estimatedTokens=9434 summaryChars=1207 markerChars=8740
```
Store, same session:
```
$ sqlite3 …/u_0417d3b0/sessions.db "select seq,kind,compacted_through_seq from entries order by seq desc limit 3"
66|compaction|65      ← the marker, 8740 chars
65|assistant|
64|user|
```

**The one number that matters.** Before: `finishReason="length" completionTokens=1024` — the cap hit,
zero visible text, twice. After: `finishReason="stop" completionTokens=935` — the model ended on its
own, on a transcript 16 % LARGER than the one that failed (31632 chars vs 27256). So the reasoning
channel plus the summary fit comfortably; the failure was the cap, exactly as diagnosed.

Note that 935 < the old 1024 cap. The model's reasoning length is not deterministic and appears to
scale with the budget it is given, so the margin is real but not unlimited — which is why the
`empty-summary` path now logs the provider's `finishReason` and names the key to raise (see below),
instead of leaving an operator to guess.

## The model window is bounded — the point of the feature

Measured with the shipped `projectForModel` + `estimateTokens` against the live DB:

| | before the marker | after the marker |
|---|---|---|
| model projection | 65 messages / **9434** est. tokens | **1** message / **2186** est. tokens |
| client feed | 52 items | 54 items (marker skipped) |

Spec §3.4's deliberate divergence, live: the model reads one summarized message, the client still
renders every original entry.

## "the conversation continues coherently" — verified off a marker-ONLY window

One further turn, whose entire model window was the marker (`projectedMessages=1`):

> **user:** Two questions: (1) name the topics of the essays you wrote for me earlier in this
> conversation, and (2) what exact words did I ask you to reply with at the very start?
>
> **assistant:** raven story · lighthouses · tides · telegraph history · postal services (500-word)
> · transatlantic telegraph cable · compass history … **(2)** “NATIVE TURN OK.”

Cross-checked against the real pre-compaction user entries (`seq ≤ 61`): every topic named is a real
earlier request and the opening phrase is exact (`seq=1: Reply with exactly the words: NATIVE TURN
OK`). One omission (printing press), no invented topics. The summary carries the conversation.

## Row result

| Row | T9 | T9b re-drive |
|---|---|---|
| compaction-continue (trigger) | PASS | PASS (`estimatedTokens=9434 > 8000`) |
| compaction-continue (summarizer commits) | **FAIL 2/2** | **PASS** (`compaction.committed seq=66`) |
| compaction-continue (continues coherently) | not observable | **PASS** (marker-only window, topics + exact phrase recalled) |

## Not covered

Driven over the WS seam, not Playwright — browser rendering of a post-compaction feed is unchanged
code (`client-projection.ts` skips markers) and is already covered by `reload-convergence` /
`restart-persistence`. Stated as a limitation, not claimed as browser coverage.

One live sample of the committing path per transcript shape (plus a second, independently grown
session — see `RE-DRIVE-T9b-sample2.md` if present). The residual risk (a transcript whose reasoning
+ summary exceeds 4000) is now diagnosable rather than silent: `compaction.skipped` carries the
provider's `finishReason`, and `compaction.failing-repeatedly` names the impact.
