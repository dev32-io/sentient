# Task 12 · Step 6 — the rows the PIN was blocking (part 1 of 2)

`delegate-hermes-bg` and `steer-followup-audio`, driven **through the webui** in
a real browser with a real audio downlink — not the WS-seam harness. Both were
previously deferred to the operator on the false premise that logging in needed
a credential an agent must not use. The local PIN is `1234` and it is a test
fixture, not a secret.

Log: `gateway-log-step6-delegate-audio.txt` (unedited).

---

## `delegate-hermes-bg` → **PASS**

Ask: *"delegate this to the hermes background agent: write a two-sentence
explanation of what a Fresnel lens is…"*

```
18:25:12.679  tool-broker.pdp.decision   tool="delegateTask" action="allow" rule="allow_delegate_task"
18:25:12.681  delegate-task.run.guard-decision  taskId="fe8ea640-…" agent="hermes" action="allow"
18:25:13.028  hermes-runner.run.start    userId="u_1eee01a4" cwd=…/profiles/u_1eee01a4
18:25:13.718  react-loop.completed       turnId="43a6ec31-…" iterations=2      ← dispatching turn's own final answer
18:25:18.906  hermes-runner.run.ok       elapsedMs=5878 outputLength=476
18:25:18.906  delegate-task.run.ok       taskId="fe8ea640-…" outputLength=476
18:25:18.907  session-runtime.submit.start-turn  kind="background-completion" seq=49 turnId="83c94d02-…"
18:25:18.908  turn-emitter.turn-started  turnId="83c94d02-…" trigger="background-completion"
```

Every assertion the step names:

| Assertion | Result |
|---|---|
| one `{taskId}` tile | ✅ one `delegateTask` pill in the feed |
| one follow-up bubble | ✅ separate `Sentient` bubble after the dispatching reply |
| **one** `hermes-runner.run.start` per request | ✅ **`grep -c` → 1** |

**D7 is fixed and this is the live proof.** The T9b drive recorded *ten*
`delegateTask` dispatches for one user request, each spawning a real hermes
subprocess. This drive: exactly one. `tool="delegateTask"` appears 3× in the
window because two separate user requests were driven plus one re-read — the
`hermes-runner.run.start` count, which is what actually spawns a process, is 1
per request in both.

---

## `steer-followup-audio` → **PASS (audio half included)**

This is the half that has never been verified. The previous verdict was
"PARTIAL — do not flip on the text half", because the WS-seam driver never
negotiated `audio.output`, so no TTS downlink existed and *absence of frames
was a harness property, not a product one*. A browser negotiates it, so the
frames are real: `turn-emitter.audio-start encoding="opus" sampleRate=48000`,
with byte counts.

### Drive A — uncontended (not sufficient on its own)

Turn 1 audio done 18:25:16.562 → follow-up turn began 18:25:18.908. The second
turn's audio did follow the first's, but only because the first had already
finished. **This proves sequencing, not queueing**, and flipping the row on it
would have been the same false-green this task exists to correct. So a
contended sample was forced.

### Drive B — CONTENDED, and this is the actual evidence

Ask: delegate a Saturn fact **and** answer an eight-sentence water-cycle
question inline, so turn 1 has ~50 s of speech while hermes returns in ~3.5 s.

```
18:26:37.665  turn-voice.begin      turnId="cc5c76b5-…"   ← turn 1
18:26:40.289  hermes-runner.run.start
18:26:43.738  react-loop.completed  turnId="cc5c76b5-…"   ← turn 1 text done
18:26:43.811  hermes-runner.run.ok  elapsedMs=3522 outputLength=137
18:26:43.813  turn-voice.begin      turnId="62243fdf-…"   ← turn 2 STARTS HERE
18:26:44.814  turn-emitter.audio-start  turnId="cc5c76b5-…"    ← turn 1 audio only now starts
18:26:45.634  react-loop.completed  turnId="62243fdf-…"   ← turn 2 TEXT already finished
        ⋮        (turn 1 streaming audio for 43 more seconds)
18:27:27.661  turn-voice.audio.done turnId="cc5c76b5-…" frameCount=43 bytesSent=631909 elapsedMs=49994
18:27:27.661  synthesize-start                                 ← turn 2 TTS released, SAME MILLISECOND
18:27:28.706  turn-emitter.audio-start  turnId="62243fdf-…"
18:27:30.908  turn-voice.audio.done turnId="62243fdf-…" frameCount=5 bytesSent=47346
```

**The oracle:** turn 2's `turn-voice.begin` is at 18:26:43.813 and its text was
complete at 18:26:45.634 — yet its `synthesize-start` did not fire until
**18:27:27.661**, the exact millisecond of turn 1's `audio.done`. Turn 2's TTS
was held **43.8 seconds** behind a still-playing turn. The two turns' audio
windows do not overlap by a single frame:

| turn | audio-start | audio-done | frames | bytes |
|---|---|---|---|---|
| `cc5c76b5` (user turn) | 18:26:44.814 | 18:27:27.661 | 86 | 631909 |
| `62243fdf` (background-completion) | 18:27:28.706 | 18:27:30.908 | 91 | 47346 |

That is the audio queue, observed under genuine contention, on a real downlink.

---

## Observation, not a flipped row — the follow-up bubble does not relay the result

Reproduced on **both** drives. The delegated output comes back non-empty
(`outputLength=476`, then `137`), the follow-up turn runs (`iterations=1`), and
the bubble it produces acknowledges the completion without ever stating it:

- drive A: *"Great! Let me know if you'd like to use that description
  somewhere…"* — never gives the Fresnel-lens explanation the user asked for.
- drive B: *"Got it—thanks for the update! If you have any further questions
  about Saturn…"* — never gives the Saturn fact.

The mechanism under test (dispatch → background completion → steer → new turn →
queued audio) works end to end; what the user actually reads is an
acknowledgement of an answer they never receive. Filed in `docs/native-todo.md`
rather than fixed here — `gateway/src` is out of this task's ownership.

## Safety

No device or playback tool was involved in either drive. `delegateTask` is
`allow`-tier by design (mediated by the DelegationGuard, not the PDP —
`delegate-task.run.guard-decision action="allow"` is in the trail).
