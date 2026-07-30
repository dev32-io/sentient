# steer-midloop — never run before, found a real in-repo defect

**Result: core FSM PROVEN live; a second, distinct, in-repo bug found
alongside it (reproduced twice, deterministic).**

## What's proven

`gateway/src/runtime/session-runtime.ts`'s mid-loop steer path works
exactly as spec'd: a `background-completion` stimulus that lands while a
turn's react-loop is still running gets appended to the store and picked
up by the loop's next iteration, under the SAME `turnId` — it folds into
one reply, one bubble, never a second turn. Confirmed twice live (see
`gateway-log-excerpt-phantom-turn-and-hang.txt`, turn `d7baf654-…`
iterations 1→2→3, each carrying a fresh `background-completion` steer from
a failed `delegateTask` call before the loop's final answer).

## What's broken — `nextTurnTrigger()` re-fires an already-consumed steer

`session-runtime.ts` snapshots `lastProcessedSeq = currentMaxSeq()` **once**,
at `startTurn`. Every entry appended after that — including the `trigger`
entries a mid-loop steer appends, which the loop DOES consume via its own
re-reads — stays "newer than `lastProcessedSeq`" for the rest of the turn's
life. `onTurnSettled`'s post-turn check,
`nextTurnTrigger() { store.readSince(sessionId, lastProcessedSeq)... }`,
therefore sees the SAME steer entries again after the turn completes and
concludes a fresh, unconsumed `background-completion` is waiting — and
fires a whole new back-to-back turn for it, even though nothing new
happened:

```
…iteration 3, finishReason="stop", textLength=428  (turn d7baf654's own real answer)
session-runtime.turn.end | turnId="d7baf654…" completed=true iterations=3
session-runtime.turn.next-turn-trigger | previousTurnId="d7baf654…" nextTurnId="a101306b…" trigger="background-completion"
react-loop.start | turnId="a101306b…"
…iteration 1, finishReason="stop", textLength=0, completionTokens=1   ← wasted LLM call, empty reply
```

Reproduced a second time on a separate turn a few minutes later
(`5a0924ca-…`, same shape, three steers this time) — deterministic, not a
one-off race.

**Cost of this bug, precisely:**
1. One wasted real LLM call per steer-midloop occurrence (the phantom
   turn's own `provider:openai stream-start/stream-end`).
2. The phantom turn's reply text is empty, so `turn-voice`'s TTS pipeline
   opens a WS to local-tts, gets `ready-received`, and then — because
   there is no text to send — never sends anything further. It never
   reaches `started`/`done`. Confirmed via `pgrep local_tts` (process
   stays up, unaffected) and via the gateway log: the WS just sits open,
   no further log line, for 28+ seconds observed (no timeout recovery
   seen in that window). This is a real resource leak: one dangling
   local-tts WebSocket per steer-midloop occurrence, forever, until the
   gateway restarts.
3. **Corrected client-side claim, so this doesn't get overstated:** the
   webui's Send button reads as "disabled" right after this happens, but
   that is the ordinary empty-textbox-disables-Send state (confirmed on
   reload: fresh page load, same empty textbox, same disabled Send — no
   stuck AwaitingTracker lock). The phantom turn produces **no visible
   assistant bubble** (empty text renders nothing) and does not visibly
   wedge the UI. The leak is real but currently silent to the user — it
   would only surface as "TTS got a bit slower/flakier every so often" on
   a long session with many delegated tasks, or as a slow accumulation of
   idle local-tts connections on that service.

## Fix shape (not applied — out of T9's file ownership, `gateway/src/runtime/**` is not owned by this task)

`nextTurnTrigger()` needs to compare against what the JUST-COMPLETED turn's
own iterations actually consumed, not a turn-start snapshot — e.g. advance
`lastProcessedSeq` to the store's current max seq at the START of each
react-loop iteration (not just once at turn start), or have
`onTurnSettled` diff against the entries the loop's own message-projection
already included in its last request. Flagging for whoever owns
`session-runtime.ts` — this is unrelated to the Hermes-credential defects
in `../2026-07-30-delegate-hermes-bg/`, but was found in the same drive.

Files: `gateway-log-excerpt-phantom-turn-and-hang.txt` (raw), screenshot
`desktop-composer-stuck.png` (misleadingly named from the first draft of
this analysis — see the correction above; kept for the visual record of
"no assistant bubble appears", not as evidence of a stuck composer).
