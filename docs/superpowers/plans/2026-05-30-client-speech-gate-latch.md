# Client Speech-Gate Latch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the client's per-frame mic gating (which lets transient noise open a 1.5s stream → ghost STT turns, and drops marginal speech frames → fragmentation) with a 3-state `SpeechGate` latch that opens only on *sustained* speech and closes on the server's `connector.transcript.final`.

**Architecture:** A pure, portable `SpeechGate` FSM in `shared/web-sdk` (sibling to `echo-gate.ts` and `audio-pre-roll-ring.ts`). It consumes the per-frame speech verdict the caller already computes (`speechProb >= threshold`), buffers frames during an `opening` debounce window, flushes the buffered onset when it confirms speech (`open`), forwards every frame while open, and resets to `closed` when the server reports a final transcript. `use-voice-client.ts` wires it in: `handleDenoisedFrame` feeds frames to the gate and encodes whatever the gate forwards; the existing `onTranscript` callback also calls `gate.close()`.

**Tech Stack:** TypeScript (strict), Vitest, Preact/Vite webui, RNNoise denoiser (480-sample / 10ms frames @ 48kHz).

**Spec:** `docs/superpowers/specs/2026-05-30-client-speech-gate-latch-design.md`

**Deviation from spec (flagged for reviewer):** The spec said "reuse `audio-pre-roll-ring.ts`, do not introduce a second buffer." That ring is typed to `ArrayBuffer` and uses accept/reject **hangover-latch** semantics that conflict with our *server-driven* close, and our frames are pre-encode `Float32Array`. So `SpeechGate` owns one internal `Float32Array` ring (the opening-window + pre-roll buffer). There is no duplicate buffer in the live path — `AudioPreRollRing` is not currently wired into the denoiser path. `AudioPreRollRing` is left untouched.

---

## File Structure

- **Create** `shared/web-sdk/src/speech-gate.ts` — the `SpeechGate` FSM (pure, no clocks/Date.now; caller passes `nowMs`).
- **Create** `shared/web-sdk/src/speech-gate.test.ts` — FSM contract tests.
- **Modify** `shared/web-sdk/src/index.ts` — export `createSpeechGate` and its types.
- **Modify** `gateway/webui/src/constants.ts` — add `SPEECH_GATE_*` constants; remove `RNNOISE_POST_SPEECH_HOLD_MS`.
- **Modify** `gateway/webui/src/hooks/use-voice-client.ts` — replace the per-frame logic in `handleDenoisedFrame` with the gate; call `gate.close()` from `onTranscript`.

---

## Task 1: SpeechGate — open on sustained speech, flush onset

**Files:**
- Create: `shared/web-sdk/src/speech-gate.ts`
- Test: `shared/web-sdk/src/speech-gate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { createSpeechGate } from "./speech-gate.ts";

// Each frame is one float sample tagged with an id so we can assert order.
let counter = 0;
function frame(): Float32Array {
  counter += 1;
  return new Float32Array([counter]);
}
function ids(frames: readonly Float32Array[]): number[] {
  return frames.map((f) => f[0] ?? -1);
}

const CFG = {
  openDebounceMs: 50,        // 5 frames @ 10ms
  frameDurationMs: 10,
  gapToleranceFrames: 3,
  preRollFrames: 2,
  maxOpenMs: 1000,
};

describe("SpeechGate FSM", () => {
  it("buffers during opening then flushes onset + preroll on open", () => {
    const gate = createSpeechGate(CFG);
    let now = 0;
    const tick = () => (now += 10);

    // 2 sub-threshold frames first — kept as pre-roll while closed.
    const pre1 = frame();
    const pre2 = frame();
    expect(ids(gate.process(pre1, false, tick()).forward)).toEqual([]);
    expect(ids(gate.process(pre2, false, tick()).forward)).toEqual([]);
    expect(gate.state()).toBe("closed");

    // 5 speech frames = 50ms sustained = debounce reached on the 5th.
    const f = [frame(), frame(), frame(), frame(), frame()];
    let opened = false;
    let flushed: number[] = [];
    for (const fr of f) {
      const r = gate.process(fr, true, tick());
      if (r.opened) {
        opened = true;
        flushed = ids(r.forward);
      }
    }
    expect(opened).toBe(true);
    expect(gate.state()).toBe("open");
    // Flush contains the 2 preroll frames + all 5 opening frames, in order.
    expect(flushed).toEqual([
      pre1[0], pre2[0], f[0][0], f[1][0], f[2][0], f[3][0], f[4][0],
    ]);
  });

  it("forwards every frame once open", () => {
    const gate = createSpeechGate(CFG);
    let now = 0;
    const tick = () => (now += 10);
    for (let i = 0; i < 5; i++) gate.process(frame(), true, tick()); // reach open
    expect(gate.state()).toBe("open");
    const next = frame();
    expect(ids(gate.process(next, true, tick()).forward)).toEqual([next[0]]);
    const quiet = frame(); // even a non-speech frame forwards while open
    expect(ids(gate.process(quiet, false, tick()).forward)).toEqual([quiet[0]]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd shared/web-sdk && bun run test speech-gate`
Expected: FAIL — `createSpeechGate is not a function` / module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// shared/web-sdk/src/speech-gate.ts
// ---------------------------------------------------------------------------
// SpeechGate — client-side mic latch.
//
// Replaces per-frame gating (a single speech-positive frame opened a fixed
// trailing-timer stream, so transient noise → ghost STT turns; marginal
// frames were dropped → fragmentation). The latch opens only after speech is
// SUSTAINED for openDebounceMs, streams the whole utterance once open, and
// closes when the server reports a final transcript (close()) — not on a
// local timer. Pure FSM: caller supplies the per-frame speech verdict and a
// monotonic nowMs; no clocks here.
//
// States:
//   closed  — buffering a small pre-roll ring; emit nothing.
//   opening — speech seen; buffering frames; counting sustainedMs. Brief
//             sub-threshold gaps tolerated (gapToleranceFrames). Abort to
//             closed if the gap exceeds tolerance before debounce is met.
//   open    — debounce met; flushed buffered onset; now forward every frame
//             until close() or maxOpenMs failsafe.
// ---------------------------------------------------------------------------

export type SpeechGateState = "closed" | "opening" | "open";

export interface SpeechGateConfig {
  /** Sustained speech (ms) required before the latch opens. */
  readonly openDebounceMs: number;
  /** Duration of one frame (ms). RNNoise = 10. */
  readonly frameDurationMs: number;
  /** Consecutive sub-threshold frames tolerated during `opening` before abort. */
  readonly gapToleranceFrames: number;
  /** Sub-threshold frames retained while `closed` to preserve the onset ramp. */
  readonly preRollFrames: number;
  /** Failsafe: force-close if no transcript arrives within this many ms of opening. */
  readonly maxOpenMs: number;
}

export interface SpeechGateResult {
  /** Frames to forward to the encoder, in order. Empty while buffering. */
  readonly forward: readonly Float32Array[];
  /** True on the single frame that transitioned opening → open. */
  readonly opened: boolean;
}

export interface SpeechGate {
  process(frame: Float32Array, isSpeech: boolean, nowMs: number): SpeechGateResult;
  /** Server signalled STT done — reset to closed. */
  close(): void;
  state(): SpeechGateState;
}

const EMPTY: SpeechGateResult = { forward: [], opened: false };

export function createSpeechGate(config: SpeechGateConfig): SpeechGate {
  let state: SpeechGateState = "closed";
  let preRoll: Float32Array[] = [];
  let opening: Float32Array[] = [];
  let sustainedMs = 0;
  let gap = 0;
  let openedAtMs = 0;

  function reset(): void {
    state = "closed";
    preRoll = [];
    opening = [];
    sustainedMs = 0;
    gap = 0;
    openedAtMs = 0;
  }

  return {
    process(frame, isSpeech, nowMs) {
      if (state === "open") {
        if (nowMs - openedAtMs >= config.maxOpenMs) {
          reset();
          return EMPTY; // failsafe: drop this frame, force closed
        }
        return { forward: [frame], opened: false };
      }

      if (state === "closed") {
        if (!isSpeech) {
          preRoll.push(frame);
          while (preRoll.length > config.preRollFrames) preRoll.shift();
          return EMPTY;
        }
        // First speech frame → opening.
        state = "opening";
        opening = [frame];
        sustainedMs = config.frameDurationMs;
        gap = 0;
        return EMPTY;
      }

      // state === "opening"
      opening.push(frame);
      if (isSpeech) {
        sustainedMs += config.frameDurationMs;
        gap = 0;
      } else {
        gap += 1;
        if (gap > config.gapToleranceFrames) {
          reset();
          return EMPTY; // transient — discard buffered frames
        }
      }
      if (sustainedMs >= config.openDebounceMs) {
        const flush = [...preRoll, ...opening];
        preRoll = [];
        opening = [];
        state = "open";
        openedAtMs = nowMs;
        return { forward: flush, opened: true };
      }
      return EMPTY;
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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd shared/web-sdk && bun run test speech-gate`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/web-sdk/src/speech-gate.ts shared/web-sdk/src/speech-gate.test.ts
git commit -m "feat(web-sdk): SpeechGate FSM — sustained-speech open + onset flush"
```

---

## Task 2: SpeechGate — reject transients, tolerate brief gaps

**Files:**
- Test: `shared/web-sdk/src/speech-gate.test.ts` (add cases)

- [ ] **Step 1: Write the failing tests**

Add inside the `describe` block:

```typescript
  it("rejects a transient shorter than the debounce (cough/knock)", () => {
    const gate = createSpeechGate(CFG); // debounce 50ms = 5 frames
    let now = 0;
    const tick = () => (now += 10);
    // 3 speech frames (30ms) then it stops — below 50ms debounce.
    for (let i = 0; i < 3; i++) {
      expect(gate.process(frame(), true, tick()).opened).toBe(false);
    }
    expect(gate.state()).toBe("opening");
    // gapTolerance is 3; the 4th sub-threshold frame still tolerated...
    for (let i = 0; i < 3; i++) gate.process(frame(), false, tick());
    expect(gate.state()).toBe("opening");
    // 4th consecutive gap frame exceeds tolerance → abort to closed, no open.
    const r = gate.process(frame(), false, tick());
    expect(r.opened).toBe(false);
    expect(r.forward).toEqual([]);
    expect(gate.state()).toBe("closed");
  });

  it("tolerates a brief sub-threshold flicker mid-opening and still opens", () => {
    const gate = createSpeechGate(CFG);
    let now = 0;
    const tick = () => (now += 10);
    gate.process(frame(), true, tick());   // 10ms
    gate.process(frame(), false, tick());  // flicker, gap=1
    gate.process(frame(), true, tick());   // 20ms, gap reset
    gate.process(frame(), true, tick());   // 30ms
    gate.process(frame(), true, tick());   // 40ms
    const r = gate.process(frame(), true, tick()); // 50ms → open
    expect(r.opened).toBe(true);
    expect(gate.state()).toBe("open");
  });
```

- [ ] **Step 2: Run to verify they fail (or pass if behavior already correct)**

Run: `cd shared/web-sdk && bun run test speech-gate`
Expected: PASS — the Task 1 implementation already encodes this behavior. If any case FAILS, fix `speech-gate.ts` (gap counter / abort) until green. (These cases pin the transient-rejection invariant against future drift.)

- [ ] **Step 3: Commit**

```bash
git add shared/web-sdk/src/speech-gate.test.ts
git commit -m "test(web-sdk): SpeechGate transient rejection + gap tolerance"
```

---

## Task 3: SpeechGate — close on transcript, reopen next utterance

**Files:**
- Test: `shared/web-sdk/src/speech-gate.test.ts` (add cases)

- [ ] **Step 1: Write the failing tests**

```typescript
  it("close() resets an open gate to closed", () => {
    const gate = createSpeechGate(CFG);
    let now = 0;
    const tick = () => (now += 10);
    for (let i = 0; i < 5; i++) gate.process(frame(), true, tick());
    expect(gate.state()).toBe("open");
    gate.close();
    expect(gate.state()).toBe("closed");
  });

  it("reopens for a fresh utterance after close()", () => {
    const gate = createSpeechGate(CFG);
    let now = 0;
    const tick = () => (now += 10);
    for (let i = 0; i < 5; i++) gate.process(frame(), true, tick());
    gate.close();
    // Second utterance opens normally.
    let opened = false;
    for (let i = 0; i < 5; i++) {
      if (gate.process(frame(), true, tick()).opened) opened = true;
    }
    expect(opened).toBe(true);
    expect(gate.state()).toBe("open");
  });

  it("close() while opening discards the buffer (no leak into next turn)", () => {
    const gate = createSpeechGate(CFG);
    let now = 0;
    const tick = () => (now += 10);
    gate.process(frame(), true, tick()); // opening, buffered
    gate.close();
    expect(gate.state()).toBe("closed");
    // A lone sub-threshold frame stays closed and is not flushed later.
    expect(gate.process(frame(), false, tick()).forward).toEqual([]);
  });
```

- [ ] **Step 2: Run to verify**

Run: `cd shared/web-sdk && bun run test speech-gate`
Expected: PASS (Task 1's `reset()` covers these). Fix `speech-gate.ts` if any fail.

- [ ] **Step 3: Commit**

```bash
git add shared/web-sdk/src/speech-gate.test.ts
git commit -m "test(web-sdk): SpeechGate close/reset + reopen contract"
```

---

## Task 4: SpeechGate — maxOpenMs failsafe

**Files:**
- Test: `shared/web-sdk/src/speech-gate.test.ts` (add case)

- [ ] **Step 1: Write the failing test**

```typescript
  it("force-closes after maxOpenMs when no transcript arrives", () => {
    const gate = createSpeechGate(CFG); // maxOpenMs 1000
    let now = 0;
    const tick = () => (now += 10);
    for (let i = 0; i < 5; i++) gate.process(frame(), true, tick()); // open at ~now=50
    expect(gate.state()).toBe("open");
    // Jump past the failsafe window.
    const r = gate.process(frame(), true, 5000);
    expect(r.forward).toEqual([]); // frame dropped on force-close
    expect(gate.state()).toBe("closed");
  });
```

- [ ] **Step 2: Run to verify**

Run: `cd shared/web-sdk && bun run test speech-gate`
Expected: PASS (Task 1 handles the failsafe). Fix if needed.

- [ ] **Step 3: Export from the web-sdk barrel**

Edit `shared/web-sdk/src/index.ts` — add alongside the other audio exports (e.g. near the `echo-gate` / `audio-pre-roll-ring` exports):

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
Expected: PASS, no errors.

- [ ] **Step 5: Commit**

```bash
git add shared/web-sdk/src/speech-gate.test.ts shared/web-sdk/src/index.ts
git commit -m "feat(web-sdk): SpeechGate maxOpen failsafe + barrel export"
```

---

## Task 5: webui constants — add SpeechGate tunables, remove dead hold

**Files:**
- Modify: `gateway/webui/src/constants.ts`

- [ ] **Step 1: Add the constants**

Add near the existing `RNNOISE_BASELINE_SPEECH_PROB` / `RNNOISE_PLAYBACK_SPEECH_PROB` block (around line 156–165):

```typescript
// SpeechGate latch (client mic gate). The gate opens only after speech is
// sustained for SPEECH_GATE_OPEN_DEBOUNCE_MS, so short transients (coughs,
// keyboard knocks) never open it. One-word commands ("no"/"yes"/"stop")
// survive because the opening-window frames are buffered and flushed on open.
// Research range for the debounce is 200–300ms; 200 catches fast one-word
// commands while rejecting sub-200ms noise.
export const SPEECH_GATE_OPEN_DEBOUNCE_MS = 200;
// RNNoise emits one frame per 10ms @ 48kHz (480 samples) — fixed by the model.
export const SPEECH_GATE_FRAME_MS = 10;
// Consecutive sub-threshold frames tolerated mid-opening before aborting,
// so a brief RNNoise probability flicker doesn't reset a real utterance.
export const SPEECH_GATE_GAP_TOLERANCE_FRAMES = 3;
// Sub-threshold frames retained while closed to preserve the quiet onset
// ramp ahead of the first speech-positive frame (~80ms at 10ms/frame).
export const SPEECH_GATE_PREROLL_FRAMES = 8;
// Failsafe: if connector.transcript.final never arrives (server hiccup),
// force the latch closed after this long so it can't stream forever.
export const SPEECH_GATE_MAX_OPEN_MS = 20_000;
```

- [ ] **Step 2: Remove the dead constant**

Delete the `RNNOISE_POST_SPEECH_HOLD_MS` declaration from `constants.ts` (it is superseded by the gate's server-driven close). Grep to confirm no other reference remains:

Run: `cd /Users/kevinye/Development/sentient && grep -rn "RNNOISE_POST_SPEECH_HOLD_MS" gateway/webui/src`
Expected: only the `use-voice-client.ts` usage remains (removed in Task 6). If any OTHER file references it, that file is out of scope — stop and report.

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/constants.ts
git commit -m "feat(webui): SpeechGate tunables; drop dead post-speech-hold const"
```

---

## Task 6: Wire SpeechGate into use-voice-client

**Files:**
- Modify: `gateway/webui/src/hooks/use-voice-client.ts`

This is integration wiring (DI), not unit-tested per the project testing rules — verified by typecheck + the operator smoke checklist in the spec.

- [ ] **Step 1: Import the gate and constants**

In the import block, add `createSpeechGate` to the existing `@sentient/web-sdk` import, and add the new constants to the `../constants.ts` import. Example (match the file's actual import style):

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

Remove the `RNNOISE_POST_SPEECH_HOLD_MS` import if present.

- [ ] **Step 2: Construct the gate beside the denoiser setup**

Immediately before `function handleDenoisedFrame(...)` (currently ~line 277), add:

```typescript
    const speechGate = createSpeechGate({
      openDebounceMs: SPEECH_GATE_OPEN_DEBOUNCE_MS,
      frameDurationMs: SPEECH_GATE_FRAME_MS,
      gapToleranceFrames: SPEECH_GATE_GAP_TOLERANCE_FRAMES,
      preRollFrames: SPEECH_GATE_PREROLL_FRAMES,
      maxOpenMs: SPEECH_GATE_MAX_OPEN_MS,
    });
```

- [ ] **Step 3: Replace the body of `handleDenoisedFrame`**

Delete the `RNNOISE_POST_SPEECH_HOLD_MS` / `lastSpeechMs` / `inHold` logic (lines ~277–314) and replace `handleDenoisedFrame` with:

```typescript
    function handleDenoisedFrame(cleanedSamples: Float32Array, speechProb: number): void {
      denoiseTotalFrames += 1;
      const gateState = echoGate.snapshot().state;
      const threshold = gateState === "baseline" ? RNNOISE_BASELINE_SPEECH_PROB : RNNOISE_PLAYBACK_SPEECH_PROB;
      const isSpeech = speechProb >= threshold;
      const before = speechGate.state();
      const { forward, opened } = speechGate.process(cleanedSamples, isSpeech, Date.now());
      if (opened) {
        log.debug("speech-gate.open", { gateState, speechProb: Number(speechProb.toFixed(3)), flushedFrames: forward.length });
      } else if (before === "open" && speechGate.state() === "closed") {
        log.debug("speech-gate.maxopen-close", { droppedFrames: denoiseDroppedFrames, totalFrames: denoiseTotalFrames });
      }
      if (forward.length === 0) {
        denoiseDroppedFrames += 1;
        return;
      }
      // Gate forwards buffered onset on open (>1 frame) then one frame each.
      // The denoiser reuses its output buffer across frames, but encode()
      // copies synchronously, so forwarding these references is safe.
      for (const f of forward) opusEncoder?.encode(f);
    }
```

Note: the buffered-onset frames in `forward` are the SAME `Float32Array` references the denoiser produced across prior frames. The denoiser reuses ONE output buffer per call, so a buffered reference may have been overwritten by a later frame before flush. **To be safe, the gate must store copies.** Add copy-on-buffer in `speech-gate.ts` is wrong (keeps the FSM impure-ish but it's fine) — instead copy at the boundary: in Step 3 above, when pushing into the gate we pass `cleanedSamples` directly. Fix by copying before handing to the gate:

Replace the `speechGate.process(cleanedSamples, ...)` call with:

```typescript
      const frameCopy = cleanedSamples.slice();
      const { forward, opened } = speechGate.process(frameCopy, isSpeech, Date.now());
```

This guarantees buffered frames survive the denoiser's buffer reuse. (When open, the per-frame copy is a tiny ~480-float allocation at 100 fps — acceptable; matches the prior code's safety note.)

- [ ] **Step 4: Close the gate on final transcript**

Update the `UserAudioInputConnector` construction (currently ~line 218) so `onTranscript` also closes the gate:

```typescript
    const audioInputConnector = new UserAudioInputConnector({
      onTranscript: (text) => {
        transcript.value = text;
        speechGate.close();
      },
    });
```

Note: `speechGate` is declared later in the same closure (Step 2). If `onTranscript` is constructed before the gate in source order, hoist the `createSpeechGate(...)` call ABOVE the `new UserAudioInputConnector(...)` line so the reference is initialized when the callback fires. (The callback runs at transcript time, well after construction, but the `const` must be declared earlier to satisfy TDZ — place Step 2's block above line 218.)

- [ ] **Step 5: Typecheck**

Run: `cd gateway/webui && bun run typecheck`
Expected: PASS. Resolve any unused-import / TDZ ordering errors surfaced here.

- [ ] **Step 6: Run the webui unit suite (no regressions)**

Run: `cd gateway/webui && bun run test`
Expected: PASS (no speech-gate unit tests live here; this confirms nothing else broke).

- [ ] **Step 7: Commit**

```bash
git add gateway/webui/src/hooks/use-voice-client.ts
git commit -m "feat(webui): drive mic uplink through SpeechGate latch

Open only on sustained speech (200ms debounce); flush buffered onset;
forward all frames while open; close on connector.transcript.final.
Replaces per-frame gate + 1500ms trailing hold. Fixes ghost noise turns
and single-word fragmentation (spec 2026-05-30)."
```

---

## Task 7: Final verification + operator handoff

- [ ] **Step 1: Full local CI**

Run: `cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run ci`
Expected: lint + typecheck + tests all PASS.

- [ ] **Step 2: Confirm the operator smoke checklist**

Real-speech smoke is operator-owned (Playwright cannot inject mic audio / a cough). Hand the spec's checklist to the operator on a rebuilt local stack (`deploy/macos`):
- Cough / throat-clear → no turn dispatched (no ghost "Yeah.").
- Keyboard knocks / taps → no turn dispatched.
- Normal sentence with inter-word pauses → exactly one turn, full transcript.
- One-word "no" / "yes" / "stop" → captured as a turn.
- Mobile / far-field vs desktop / close-talk → both clean single turns.
- `~/.sentient/gateway/logs/` shows `turnIdx` no longer floods on background noise; `speech-gate.open` DEBUG lines fire only on real speech.

- [ ] **Step 3: Do NOT auto-merge.** Report results; the operator decides on merge/PR after smoke passes.

---

## Self-Review

**Spec coverage:**
- 3-state latch (closed/opening/open) → Tasks 1–4. ✓
- Open on sustained debounce, reject transients → Tasks 1, 2. ✓
- Close on `connector.transcript.final` → Task 6 Step 4. ✓
- Flush pre-roll/onset on open → Task 1 (preRoll + opening flush). ✓
- `maxOpenMs` failsafe → Task 4. ✓
- denoiser reset on close → **see note below.**
- Remove `RNNOISE_POST_SPEECH_HOLD_MS` → Tasks 5–6. ✓
- Tunables as named constants → Task 5. ✓
- Unit tests agent-owned; speech smoke operator-owned → Tasks 1–4, 7. ✓

**Gap found + resolved:** The spec lists `denoiser.reset()` on CLOSED entry. `createRnNoiseDenoiser` exposes `reset()` (`rnnoise-denoiser.ts:52`) but the `SpeechGate` (in web-sdk) must not depend on the webui denoiser. Resolution: the gate stays pure; the *caller* resets the denoiser. Add to Task 6 Step 4 — call `denoiser.reset()` alongside `speechGate.close()` inside `onTranscript`. **Apply this in Task 6 Step 4:**

```typescript
      onTranscript: (text) => {
        transcript.value = text;
        speechGate.close();
        denoiser?.reset();
      },
```

(Confirm the denoiser handle name/null-safety against the actual `createRnNoiseDenoiser` return at implementation time; the handle is created ~line 316 as `denoiser`.)

**Placeholder scan:** No TBD/TODO; every code step has concrete code. ✓
**Type consistency:** `createSpeechGate`/`SpeechGate`/`SpeechGateConfig`/`SpeechGateResult`/`SpeechGateState`, `process(frame,isSpeech,nowMs)`, `forward`/`opened`, `close()`, `state()` are consistent across Tasks 1–6 and the barrel export. ✓
