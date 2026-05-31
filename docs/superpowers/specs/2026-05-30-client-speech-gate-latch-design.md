# Client Speech-Gate Latch — Design

**Date:** 2026-05-30
**Branch:** `feature/stt-bargein-refinement`
**Scope:** Client-side mic gating only (option "B"). Server VAD/Smart-Turn retune and SenseVoice event-tag rejection are explicitly deferred.

## Problem

The web client over-segments and mis-fires STT. Observed symptoms:

- Coughs, keyboard knocks, and background noise become dispatched LLM turns (transcribed as filler — "Yeah." / "Yes.").
- Real speech fragments into multiple single-word turns, worse on mobile / far-field, better on desktop / close-talk.

### Evidence

Local session `s-mpta4qpi`, `~/.sentient/gateway/logs/2026-05-30.log`, 21:28–21:34:

- ~85 turns in ~6 minutes (`turnIdx` reaches 87).
- Repeated 1-word ghost turns: `turnIdx=2,3,4,22,23,54,77,83,87 → "Yeah."/"Yes."` — coughs/keyboard each opening a turn.
- One 294-char over-merged garbage turn (`turnIdx=69`) — server-side Smart-Turn over-hold (out of scope; see Deferrals).

### Root cause (in code)

`gateway/webui/src/hooks/use-voice-client.ts:288` — `handleDenoisedFrame`:

- `isSpeech = speechProb >= threshold` opens streaming on a **single** speech-positive frame. A transient (cough/keyboard) scores ≥ threshold on RNNoise and opens the gate.
- A fixed `RNNOISE_POST_SPEECH_HOLD_MS = 1500` local timer keeps it open after the last speech frame, streaming ~1.5s of audio to the server regardless of whether it was speech.
- Closes on a **local timer**, never on a server "STT done" signal.

This is per-frame gating with a trailing timer — not the on/off onset-latch the gate was intended to be ("detect speech → open → stream the whole utterance → reset when STT signals done").

## Design

Replace the per-frame logic with a three-state latch.

### Component: `SpeechGate` (FSM)

One file, pure and unit-testable. Lives in `shared/web-sdk/src/` (reusable) or `gateway/webui/src/audio/` — placement decided at plan time per import boundaries.

```
CLOSED ──speechProb ≥ openThreshold sustained ≥ openDebounceMs──▶ OPEN
   while CLOSED: feed frames into the existing pre-roll ring; encode nothing
OPEN   ──connector.transcript.final (server STT-done)──▶ CLOSED
   while OPEN: encode EVERY frame (whole utterance + trailing silence)
   on OPEN entry: flush pre-roll ring so the word onset is not clipped
   OPEN ──maxOpenMs elapsed with no transcript──▶ CLOSED   (failsafe)
on CLOSED entry: denoiser.reset() + pre-roll ring.clear()
```

### Data flow

```
denoiser.onFrame({ speechProb, samples })
    → speechGate.process(frame)
        → CLOSED: ring.push(frame)            // buffered, not sent
        → OPEN  : opusEncoder.encode(frame)   // streamed
sdk.onTranscript (connector.transcript.final)
    → speechGate.close()                      // server-driven close + reset
```

The close signal already exists: `shared/web-sdk/src/connectors/user-audio-input-connector.ts:38` receives `connector.transcript.final` and surfaces it as `onTranscript`. No new wire message.

### Why this fixes the symptoms

- **Cough / keyboard:** a short transient never sustains past `openDebounceMs`, so the latch stays shut — nothing is sent, no ghost turn.
- **Fragmentation:** once open, every frame streams until the server reports done. No mid-word per-frame drops, so server-side Silero sees one continuous utterance instead of chopped fragments.
- **One-word commands ("no" / "yes" / "stop"):** `openDebounceMs` (~200ms) opens partway into the word; the pre-roll ring (~320ms) flushes the clipped onset, so the full word reaches STT.

### Tunables

Named constants with inline comments. Client audio tunables stay in `gateway/webui/src/constants.ts`, consistent with the existing RNNoise/echo-gate constants there.

| Constant | Default | Role |
|---|---|---|
| `openDebounceMs` | 200 | Sustained speech required before the latch opens. Rejects sub-200ms transients while still catching one-word commands via pre-roll. Research range 200–300ms. |
| `openThreshold` (baseline) | 0.6 | Reuse existing `RNNOISE_BASELINE_SPEECH_PROB`. |
| `openThreshold` (playback) | 0.85 | Reuse existing `RNNOISE_PLAYBACK_SPEECH_PROB` — preserves echo rejection during TTS. |
| `maxOpenMs` | 20000 | Failsafe: force-close if `transcript.final` never arrives (server hiccup), so the latch can't stick open streaming forever. |
| ~~`RNNOISE_POST_SPEECH_HOLD_MS`~~ | removed | Superseded by server-driven close. |

### Interaction notes

- **Echo gate / playback:** the higher playback `openThreshold` (0.85) is retained, so assistant audio bleed during playback does not open the latch. Barge-in path is unchanged (out of scope).
- **Pre-roll ring:** reuse `shared/web-sdk/src/audio-pre-roll-ring.ts`; do not introduce a second buffer.
- **Denoiser reset:** call the existing `reset()` on CLOSED entry ("call between separate utterances", `rnnoise-denoiser.ts:52`).

## Testing

### Agent-owned — `SpeechGate` FSM unit tests

The gate is a state machine with a documented invariant, so the unit suite pins the contract (testing-rule compliant). Feed typed frame sequences, assert transitions:

- Transient below `openDebounceMs` → never opens, nothing encoded.
- Sustained speech ≥ `openDebounceMs` → opens once; pre-roll ring flushed on open.
- `transcript.final` while OPEN → closes, denoiser reset, ring cleared.
- `maxOpenMs` elapsed with no transcript → failsafe close.
- Playback state uses the higher threshold (no open on sub-0.85 bleed).
- Re-open after close (next utterance) works.

### User-owned — real-speech smoke (deferred to operator)

Playwright cannot inject mic audio or a cough, so these cases are unreachable by the agent (documented e2e exception — device/mic-only). Operator runs on the real stack, desktop + mobile:

- [ ] Cough / throat-clear → no turn dispatched (no ghost "Yeah.").
- [ ] Keyboard knocks / taps → no turn dispatched.
- [ ] Normal sentence with inter-word pauses → exactly one turn, full transcript.
- [ ] One-word command "no" / "yes" / "stop" → captured as a turn.
- [ ] Mobile / far-field vs desktop / close-talk → both produce clean single turns.
- [ ] Verify via `~/.sentient/gateway/logs/` that `turnIdx` no longer floods on background noise.

## Deferrals (explicit, agreed)

1. **Long sustained cough (> `openDebounceMs`)** can still open the latch. The deferred server-side SenseVoice event-tag rejection ("A") was the safety net for this.
2. **Server-side Smart-Turn over-merge** (the 294-char garbage turn) is untouched — server cascade retune ("C") is out of scope.
3. `min_speech_duration_ms` (server, 200) is left unchanged — it is not a lever for these symptoms.
