# Client Speech-Gate Latch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the client's per-frame mic gating (which lets transient noise open a 1.5s stream → ghost STT turns, and drops marginal speech frames → fragmentation) with a simple `SpeechGate` latch that opens only on *sustained* speech (200ms) and closes on the server's `connector.transcript.final`.

**Architecture:** `SpeechGate` is a simple latch in `shared/web-sdk` (sibling to `echo-gate.ts`, `audio-pre-roll-ring.ts`). It **composes the existing `AudioPreRollRing`** for onset buffering — no new buffer type. `AudioPreRollRing` is made generic (`<T = ArrayBuffer>`, backward-compatible) so the gate can hold an `AudioPreRollRing<Float32Array>` of pre-encode frames. While closed the gate pushes every frame into the ring (`accepted=false`, buffered as pre-roll); when speech sustains ≥200ms it flips open and the ring flushes the buffered onset; while open it forwards every frame until `close()` (server transcript) or a `maxOpenMs` failsafe. `use-voice-client.ts` feeds frames to the gate, encodes whatever the gate forwards, and calls `gate.close()` + `denoiser.reset()` from the existing `onTranscript`.

**Tech Stack:** TypeScript (strict), Vitest, Preact/Vite webui, RNNoise denoiser (480-sample / 10ms frames @ 48kHz).

**Spec:** `docs/superpowers/specs/2026-05-30-client-speech-gate-latch-design.md`

---

## File Structure

- **Modify** `shared/web-sdk/src/audio-pre-roll-ring.ts` — make generic over frame type `<T = ArrayBuffer>` (backward-compatible).
- **Create** `shared/web-sdk/src/speech-gate.ts` — the `SpeechGate` latch, composing `AudioPreRollRing<Float32Array>`. Pure (caller passes `nowMs`; no clocks inside).
- **Create** `shared/web-sdk/src/speech-gate.test.ts` — FSM contract tests.
- **Modify** `shared/web-sdk/src/index.ts` — export `createSpeechGate` and types.
- **Modify** `gateway/webui/src/constants.ts` — add `SPEECH_GATE_*` constants; remove `RNNOISE_POST_SPEECH_HOLD_MS`.
- **Modify** `gateway/webui/src/hooks/use-voice-client.ts` — feed `handleDenoisedFrame` through the gate; close gate + reset denoiser on `onTranscript`.

---

## Task 1: Make AudioPreRollRing generic over frame type

**Files:**
- Modify: `shared/web-sdk/src/audio-pre-roll-ring.ts`
- Test: `shared/web-sdk/src/audio-pre-roll-ring.test.ts` (add one Float32 case)

- [ ] **Step 1: Add a failing Float32 test**

Append inside the existing `describe("AudioPreRollRing FSM", ...)` block in `audio-pre-roll-ring.test.ts`:

```typescript
  it("works with a non-ArrayBuffer frame type (Float32Array)", () => {
    const ring = createAudioPreRollRing<Float32Array>({ preRollFrames: 2, hangoverFrames: 0 });
    const a = new Float32Array([1]);
    const b = new Float32Array([2]);
    const c = new Float32Array([3]);
    expect(ring.push(a, false)).toEqual([]);     // buffered
    expect(ring.push(b, false)).toEqual([]);     // buffered (ring full: [a,b])
    // accept → flush pre-roll [a,b] + current c
    expect(ring.push(c, true)).toEqual([a, b, c]);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd shared/web-sdk && bun run test audio-pre-roll-ring`
Expected: FAIL — `createAudioPreRollRing<Float32Array>` is not generic (type error) or the existing signature rejects the type parameter.

- [ ] **Step 3: Make the ring generic**

Edit `audio-pre-roll-ring.ts` — replace the `AudioPreRollRing` interface and `createAudioPreRollRing` signature/internals to be generic. Concretely:

```typescript
export interface AudioPreRollRing<T = ArrayBuffer> {
  /**
   * Feed one captured frame with the gate's accept/reject verdict.
   * Returns the frames to forward in order — may be empty (buffering) or
   * contain multiple (the pre-roll flush on a reject→accept transition).
   */
  push(frame: T, accepted: boolean): readonly T[];
  /** Drop the ring and reset to idle. Use on session/utterance boundaries. */
  reset(): void;
}

export function createAudioPreRollRing<T = ArrayBuffer>(
  config: AudioPreRollRingConfig,
): AudioPreRollRing<T> {
  // ...unchanged validation...
  const ring: T[] = [];
  // ...unchanged body, with `ArrayBuffer` occurrences in types replaced by T...
}
```

Replace the internal `const ring: ArrayBuffer[] = [];` with `const ring: T[] = [];`. No logic changes. `AudioPreRollRingConfig` is unchanged.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd shared/web-sdk && bun run test audio-pre-roll-ring`
Expected: PASS — the new Float32 case plus all pre-existing cases (default `T = ArrayBuffer` keeps existing callers compiling).

- [ ] **Step 5: Typecheck (confirm existing ArrayBuffer callers still compile)**

Run: `cd shared/web-sdk && bun run typecheck`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add shared/web-sdk/src/audio-pre-roll-ring.ts shared/web-sdk/src/audio-pre-roll-ring.test.ts
git commit -m "refactor(web-sdk): make AudioPreRollRing generic over frame type"
```

---

## Task 2: SpeechGate — open on sustained speech, flush onset via the ring

**Files:**
- Create: `shared/web-sdk/src/speech-gate.ts`
- Test: `shared/web-sdk/src/speech-gate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { createSpeechGate } from "./speech-gate.ts";

let counter = 0;
function frame(): Float32Array {
  counter += 1;
  return new Float32Array([counter]);
}
function ids(frames: readonly Float32Array[]): number[] {
  return frames.map((f) => f[0] ?? -1);
}

// Realistic shape: 200ms debounce @ 10ms/frame = 20 frames. preRollFrames (24)
// exceeds the debounce window so the onset buffered during debounce survives.
const CFG = {
  openDebounceMs: 200,
  frameDurationMs: 10,
  gapToleranceFrames: 3,
  preRollFrames: 24,
  maxOpenMs: 20_000,
};

describe("SpeechGate latch", () => {
  it("stays closed and buffers while speech has not yet sustained", () => {
    const gate = createSpeechGate(CFG);
    let now = 0;
    const tick = () => (now += 10);
    // 19 speech frames = 190ms < 200ms debounce → still closed, nothing forwarded.
    for (let i = 0; i < 19; i++) {
      const r = gate.process(frame(), true, tick());
      expect(r.opened).toBe(false);
      expect(r.forward).toEqual([]);
    }
    expect(gate.state()).toBe("closed");
  });

  it("opens on the frame that reaches the debounce and flushes the buffered onset", () => {
    const gate = createSpeechGate(CFG);
    let now = 0;
    const tick = () => (now += 10);
    const sent: Float32Array[] = [];
    let opened = false;
    for (let i = 0; i < 20; i++) {            // 20th frame = 200ms → open
      const r = gate.process(frame(), true, tick());
      if (r.opened) opened = true;
      sent.push(...r.forward);
    }
    expect(opened).toBe(true);
    expect(gate.state()).toBe("open");
    // All 20 onset frames flushed in order (preRollFrames 24 ≥ 20, none lost).
    expect(ids(sent)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  it("forwards every frame once open, including non-speech (trailing silence)", () => {
    const gate = createSpeechGate(CFG);
    let now = 0;
    const tick = () => (now += 10);
    for (let i = 0; i < 20; i++) gate.process(frame(), true, tick()); // reach open
    expect(gate.state()).toBe("open");
    const sp = frame();
    expect(ids(gate.process(sp, true, tick()).forward)).toEqual([sp[0]]);
    const sil = frame();
    expect(ids(gate.process(sil, false, tick()).forward)).toEqual([sil[0]]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd shared/web-sdk && bun run test speech-gate`
Expected: FAIL — `createSpeechGate is not a function` / module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// shared/web-sdk/src/speech-gate.ts
// ---------------------------------------------------------------------------
// SpeechGate — client-side mic latch.
//
// Replaces per-frame gating (a single speech-positive frame opened a fixed
// trailing-timer stream → transient noise became ghost STT turns; marginal
// frames were dropped → one utterance fragmented into many turns).
//
// This is a simple latch composed on top of AudioPreRollRing:
//   closed — push every frame into the ring as rejected (buffered pre-roll);
//            count sustained speech. A brief sub-threshold flicker is tolerated
//            (gapToleranceFrames); a longer gap resets the counter.
//   open   — sustained speech reached openDebounceMs: push the triggering frame
//            as accepted so the ring flushes the buffered onset, then forward
//            EVERY subsequent frame until close() or the maxOpenMs failsafe.
//
// Close is server-driven (caller invokes close() on connector.transcript.final),
// NOT a local hangover — so the ring is created with hangoverFrames: 0.
//
// Pure: the caller supplies the per-frame speech verdict and a monotonic nowMs.
// ---------------------------------------------------------------------------

import { createAudioPreRollRing } from "./audio-pre-roll-ring.ts";

export type SpeechGateState = "closed" | "open";

export interface SpeechGateConfig {
  /** Sustained speech (ms) required before the latch opens. */
  readonly openDebounceMs: number;
  /** Duration of one frame (ms). RNNoise = 10. */
  readonly frameDurationMs: number;
  /** Consecutive sub-threshold frames tolerated while closed before the sustain counter resets. */
  readonly gapToleranceFrames: number;
  /** Pre-roll frames retained by the ring; must exceed openDebounceMs/frameDurationMs. */
  readonly preRollFrames: number;
  /** Failsafe: force-close if no transcript arrives within this many ms of opening. */
  readonly maxOpenMs: number;
}

export interface SpeechGateResult {
  /** Frames to forward to the encoder, in order. Empty while buffering. */
  readonly forward: readonly Float32Array[];
  /** True on the single frame that transitioned closed → open. */
  readonly opened: boolean;
}

export interface SpeechGate {
  process(frame: Float32Array, isSpeech: boolean, nowMs: number): SpeechGateResult;
  /** Server signalled STT done — reset to closed. */
  close(): void;
  state(): SpeechGateState;
}

export function createSpeechGate(config: SpeechGateConfig): SpeechGate {
  const ring = createAudioPreRollRing<Float32Array>({
    preRollFrames: config.preRollFrames,
    hangoverFrames: 0,
  });
  let state: SpeechGateState = "closed";
  let sustainedMs = 0;
  let gap = 0;
  let openedAtMs = 0;

  function reset(): void {
    state = "closed";
    sustainedMs = 0;
    gap = 0;
    openedAtMs = 0;
    ring.reset();
  }

  return {
    process(frame, isSpeech, nowMs) {
      if (state === "open") {
        if (nowMs - openedAtMs >= config.maxOpenMs) {
          reset();
          return { forward: [], opened: false };
        }
        return { forward: ring.push(frame, true), opened: false };
      }

      // state === "closed": track sustained speech.
      if (isSpeech) {
        sustainedMs += config.frameDurationMs;
        gap = 0;
      } else {
        gap += 1;
        if (gap > config.gapToleranceFrames) sustainedMs = 0;
      }

      if (sustainedMs >= config.openDebounceMs) {
        state = "open";
        openedAtMs = nowMs;
        // accepted=true flushes the buffered onset (pre-roll) + this frame.
        return { forward: ring.push(frame, true), opened: true };
      }
      // still closed: buffer this frame as pre-roll, forward nothing.
      return { forward: ring.push(frame, false), opened: false };
    },
    close() {
      reset();
    },
    state() {
      return state;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd shared/web-sdk && bun run test speech-gate`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/web-sdk/src/speech-gate.ts shared/web-sdk/src/speech-gate.test.ts
git commit -m "feat(web-sdk): SpeechGate latch over AudioPreRollRing — sustained open + onset flush"
```

---

## Task 3: SpeechGate — reject transients, tolerate brief flicker

**Files:**
- Test: `shared/web-sdk/src/speech-gate.test.ts` (add cases)

- [ ] **Step 1: Write the tests**

```typescript
  it("never opens on a transient shorter than the debounce (cough/knock)", () => {
    const gate = createSpeechGate(CFG); // 200ms debounce, gapTolerance 3
    let now = 0;
    const tick = () => (now += 10);
    // 10 speech frames (100ms) then it stops — well under 200ms.
    for (let i = 0; i < 10; i++) expect(gate.process(frame(), true, tick()).opened).toBe(false);
    // 4 consecutive silence frames exceed gapTolerance(3) → sustain resets.
    for (let i = 0; i < 4; i++) gate.process(frame(), false, tick());
    // A few more isolated speech frames don't reach debounce → still closed.
    for (let i = 0; i < 5; i++) expect(gate.process(frame(), true, tick()).opened).toBe(false);
    expect(gate.state()).toBe("closed");
  });

  it("tolerates a brief sub-threshold flicker and still reaches open", () => {
    const gate = createSpeechGate(CFG);
    let now = 0;
    const tick = () => (now += 10);
    let opened = false;
    // 18 speech, 1 flicker (gap=1, tolerated, sustain preserved), then speech to 200ms.
    for (let i = 0; i < 18; i++) { if (gate.process(frame(), true, tick()).opened) opened = true; }
    gate.process(frame(), false, tick());                    // flicker (190ms still held)
    for (let i = 0; i < 3; i++) { if (gate.process(frame(), true, tick()).opened) opened = true; }
    expect(opened).toBe(true);
    expect(gate.state()).toBe("open");
  });
```

- [ ] **Step 2: Run to verify**

Run: `cd shared/web-sdk && bun run test speech-gate`
Expected: PASS (Task 2's impl already encodes this). If a case FAILS, fix `speech-gate.ts` gap/sustain logic until green.

- [ ] **Step 3: Commit**

```bash
git add shared/web-sdk/src/speech-gate.test.ts
git commit -m "test(web-sdk): SpeechGate transient rejection + flicker tolerance"
```

---

## Task 4: SpeechGate — close/reset, reopen, maxOpen failsafe, export

**Files:**
- Test: `shared/web-sdk/src/speech-gate.test.ts` (add cases)
- Modify: `shared/web-sdk/src/index.ts`

- [ ] **Step 1: Write the tests**

```typescript
  it("close() resets an open gate and clears the ring", () => {
    const gate = createSpeechGate(CFG);
    let now = 0;
    const tick = () => (now += 10);
    for (let i = 0; i < 20; i++) gate.process(frame(), true, tick());
    expect(gate.state()).toBe("open");
    gate.close();
    expect(gate.state()).toBe("closed");
  });

  it("reopens for a fresh utterance after close()", () => {
    const gate = createSpeechGate(CFG);
    let now = 0;
    const tick = () => (now += 10);
    for (let i = 0; i < 20; i++) gate.process(frame(), true, tick());
    gate.close();
    let opened = false;
    for (let i = 0; i < 20; i++) { if (gate.process(frame(), true, tick()).opened) opened = true; }
    expect(opened).toBe(true);
    expect(gate.state()).toBe("open");
  });

  it("force-closes after maxOpenMs when no transcript arrives", () => {
    const gate = createSpeechGate(CFG); // maxOpenMs 20000
    let now = 0;
    const tick = () => (now += 10);
    for (let i = 0; i < 20; i++) gate.process(frame(), true, tick()); // open near now=200
    expect(gate.state()).toBe("open");
    const r = gate.process(frame(), true, 100_000);                   // far past failsafe
    expect(r.forward).toEqual([]);                                    // frame dropped on force-close
    expect(gate.state()).toBe("closed");
  });
```

- [ ] **Step 2: Run to verify**

Run: `cd shared/web-sdk && bun run test speech-gate`
Expected: PASS (Task 2's `reset()` + failsafe cover these). Fix `speech-gate.ts` if any fail.

- [ ] **Step 3: Export from the web-sdk barrel**

Edit `shared/web-sdk/src/index.ts` — add near the existing `echo-gate` / `audio-pre-roll-ring` exports:

```typescript
export {
  createSpeechGate,
  type SpeechGate,
  type SpeechGateConfig,
  type SpeechGateResult,
  type SpeechGateState,
} from "./speech-gate.ts";
```

- [ ] **Step 4: Typecheck the web-sdk**

Run: `cd shared/web-sdk && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/web-sdk/src/speech-gate.test.ts shared/web-sdk/src/index.ts
git commit -m "feat(web-sdk): SpeechGate close/reopen + maxOpen failsafe + barrel export"
```

---

## Task 5: webui constants — add SpeechGate tunables, remove dead hold

**Files:**
- Modify: `gateway/webui/src/constants.ts`

- [ ] **Step 1: Add the constants**

Add near the existing `RNNOISE_BASELINE_SPEECH_PROB` / `RNNOISE_PLAYBACK_SPEECH_PROB` block (around line 156–165):

```typescript
// SpeechGate latch (client mic gate). Opens only after speech is sustained
// for SPEECH_GATE_OPEN_DEBOUNCE_MS, so short transients (coughs, keyboard
// knocks) never open it. One-word commands ("no"/"yes"/"stop") survive
// because the debounce-window frames are buffered in the composed
// AudioPreRollRing and flushed on open. Research range 200–300ms; 200
// catches fast one-word commands while rejecting sub-200ms noise.
export const SPEECH_GATE_OPEN_DEBOUNCE_MS = 200;
// RNNoise emits one frame per 10ms @ 48kHz (480 samples) — fixed by the model.
export const SPEECH_GATE_FRAME_MS = 10;
// Consecutive sub-threshold frames tolerated before the sustain counter
// resets, so a brief RNNoise probability flicker doesn't drop a real utterance.
export const SPEECH_GATE_GAP_TOLERANCE_FRAMES = 3;
// Pre-roll frames the composed ring retains. MUST exceed the debounce window
// (SPEECH_GATE_OPEN_DEBOUNCE_MS / SPEECH_GATE_FRAME_MS = 20) so the onset
// buffered during the debounce is flushed intact on open. 24 ≈ 240ms.
export const SPEECH_GATE_PREROLL_FRAMES = 24;
// Failsafe: if connector.transcript.final never arrives (server hiccup),
// force the latch closed after this long so it can't stream forever.
export const SPEECH_GATE_MAX_OPEN_MS = 20_000;
```

- [ ] **Step 2: Remove the dead constant**

Delete the `RNNOISE_POST_SPEECH_HOLD_MS` declaration from `constants.ts` (superseded by the gate's server-driven close).

Run: `cd /Users/kevinye/Development/sentient && grep -rn "RNNOISE_POST_SPEECH_HOLD_MS" gateway/webui/src`
Expected: only the `use-voice-client.ts` reference remains (removed in Task 6). If any OTHER file references it, stop and report — it is out of scope.

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/constants.ts
git commit -m "feat(webui): SpeechGate tunables; drop dead post-speech-hold const"
```

---

## Task 6: Wire SpeechGate into use-voice-client

**Files:**
- Modify: `gateway/webui/src/hooks/use-voice-client.ts`

Integration wiring (DI) — not unit-tested per project testing rules; verified by typecheck + the operator smoke checklist.

- [ ] **Step 1: Imports**

Add `createSpeechGate` to the existing `@sentient/web-sdk` import. Add the new constants to the `../constants.ts` import. Remove the `RNNOISE_POST_SPEECH_HOLD_MS` import.

```typescript
import { /* …existing… */ createSpeechGate } from "@sentient/web-sdk";
import {
  /* …existing… */
  SPEECH_GATE_OPEN_DEBOUNCE_MS,
  SPEECH_GATE_FRAME_MS,
  SPEECH_GATE_GAP_TOLERANCE_FRAMES,
  SPEECH_GATE_PREROLL_FRAMES,
  SPEECH_GATE_MAX_OPEN_MS,
} from "../constants.ts";
```

- [ ] **Step 2: Construct the gate ABOVE the `UserAudioInputConnector` (so `onTranscript` can reference it)**

Place this just before `const audioInputConnector = new UserAudioInputConnector({` (currently ~line 218):

```typescript
    const speechGate = createSpeechGate({
      openDebounceMs: SPEECH_GATE_OPEN_DEBOUNCE_MS,
      frameDurationMs: SPEECH_GATE_FRAME_MS,
      gapToleranceFrames: SPEECH_GATE_GAP_TOLERANCE_FRAMES,
      preRollFrames: SPEECH_GATE_PREROLL_FRAMES,
      maxOpenMs: SPEECH_GATE_MAX_OPEN_MS,
    });
```

- [ ] **Step 3: Close the gate + reset denoiser on final transcript**

Update the `UserAudioInputConnector` construction:

```typescript
    const audioInputConnector = new UserAudioInputConnector({
      onTranscript: (text) => {
        transcript.value = text;
        speechGate.close();
        denoiser?.reset();
      },
    });
```

(`denoiser` is the `createRnNoiseDenoiser(...)` handle declared ~line 316; it is in scope by the time `onTranscript` fires. Keep the `?.` — the handle may be null when RNNoise is unavailable.)

- [ ] **Step 4: Replace the body of `handleDenoisedFrame`**

Delete the `RNNOISE_POST_SPEECH_HOLD_MS` / `lastSpeechMs` / `inHold` logic (the block at ~lines 277–314, including the `RNNOISE_POST_SPEECH_HOLD_MS` const and `lastSpeechMs` declarations) and replace `handleDenoisedFrame` with:

```typescript
    function handleDenoisedFrame(cleanedSamples: Float32Array, speechProb: number): void {
      denoiseTotalFrames += 1;
      const gateState = echoGate.snapshot().state;
      const threshold = gateState === "baseline" ? RNNOISE_BASELINE_SPEECH_PROB : RNNOISE_PLAYBACK_SPEECH_PROB;
      const isSpeech = speechProb >= threshold;
      // Copy before buffering: the denoiser reuses ONE output buffer across
      // calls, so frames the gate buffers during debounce would be overwritten
      // before flush. encode() copies synchronously, so the copy is only needed
      // for the buffered path, but copying unconditionally keeps it simple.
      const frameCopy = cleanedSamples.slice();
      const { forward, opened } = speechGate.process(frameCopy, isSpeech, Date.now());
      if (opened) {
        log.debug("speech-gate.open", {
          gateState,
          speechProb: Number(speechProb.toFixed(3)),
          flushedFrames: forward.length,
        });
      }
      if (forward.length === 0) {
        denoiseDroppedFrames += 1;
        return;
      }
      for (const f of forward) opusEncoder?.encode(f);
    }
```

- [ ] **Step 5: Typecheck**

Run: `cd gateway/webui && bun run typecheck`
Expected: PASS. Resolve any unused-import / ordering (TDZ) errors here.

- [ ] **Step 6: Run the webui unit suite (no regressions)**

Run: `cd gateway/webui && bun run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add gateway/webui/src/hooks/use-voice-client.ts
git commit -m "feat(webui): drive mic uplink through SpeechGate latch

Open only on sustained speech (200ms); flush buffered onset via the
composed AudioPreRollRing; forward all frames while open; close on
connector.transcript.final. Replaces per-frame gate + 1500ms trailing
hold. Fixes ghost noise turns and single-word fragmentation (spec
2026-05-30)."
```

---

## Task 7: Final verification + operator handoff

- [ ] **Step 1: Full local CI**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run ci`
Expected: lint + typecheck + tests all PASS.

- [ ] **Step 2: Operator smoke checklist (real speech — agent cannot inject mic audio)**

Hand to the operator on a rebuilt local stack (`deploy/macos`):
- Cough / throat-clear → no turn dispatched (no ghost "Yeah.").
- Keyboard knocks / taps → no turn dispatched.
- Normal sentence with inter-word pauses → exactly one turn, full transcript.
- One-word "no" / "yes" / "stop" → captured as a turn.
- Mobile / far-field vs desktop / close-talk → both clean single turns.
- `~/.sentient/gateway/logs/` shows `turnIdx` no longer floods on background noise; `speech-gate.open` DEBUG fires only on real speech.

- [ ] **Step 3: Do NOT auto-merge.** Report results; operator decides merge/PR after smoke passes.

---

## Self-Review

**Spec coverage:**
- Simple latch composing `AudioPreRollRing` (generic) → Tasks 1, 2. ✓
- Open on sustained 200ms debounce; reject transients → Tasks 2, 3. ✓
- Flush onset on open via ring pre-roll (preRollFrames 24 > 20) → Tasks 2, 5. ✓
- Forward all frames while open (incl. trailing silence) → Task 2. ✓
- Close on `connector.transcript.final` + denoiser reset → Task 6 Steps 3. ✓
- `maxOpenMs` failsafe → Task 4. ✓
- Remove `RNNOISE_POST_SPEECH_HOLD_MS` → Tasks 5, 6. ✓
- Tunables as named constants, default 200ms → Task 5. ✓
- Unit tests agent-owned; speech smoke operator-owned → Tasks 1–4, 7. ✓

**Placeholder scan:** No TBD/TODO; every code step has concrete code. ✓
**Type consistency:** `createSpeechGate`/`SpeechGate`/`SpeechGateConfig`/`SpeechGateResult`/`SpeechGateState`, `process(frame,isSpeech,nowMs)`, `forward`/`opened`, `close()`, `state()`, and `createAudioPreRollRing<T>` are consistent across Tasks 1–6 and the barrel export. ✓
**Ring composition:** gate uses `hangoverFrames: 0` and `preRollFrames` from config; close is server-driven. Consistent between spec, Task 2 impl, and Task 5 constants. ✓
