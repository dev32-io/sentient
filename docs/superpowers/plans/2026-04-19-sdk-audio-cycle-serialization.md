# SDK Audio Cycle Serialization + Speaking-State + Task List Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three SDK↔gateway desync bugs surfaced during webui redesign smoke testing:

1. **Task list not rendering.** `ComposerTaskStrip` + per-message tool pills are silent even when the gateway emits `task.update`. Investigate wire-to-UI gap and reconnect.
2. **Speaking / interrupt UI ends too early.** State drops to idle when the gateway finishes producing TTS, while the client's AudioWorklet is still playing buffered audio. Derive "speaking" strictly from the playback drain, not from gateway-side cycle end.
3. **Overlapping TTS across cycles.** When a user queues a second message mid-reply, the gateway eagerly starts cycle N+1 as soon as cycle N's server-side generation ends. Cycle N+1's TTS reaches the client before cycle N's audio buffer drains, and the two streams overlap. Introduce a cycle-aware playback queue with a configurable `minEagerEndMs` preempt cap.

**Architecture decision (for #3):**
- Client playback serializes cycles, gateway keeps running ahead.
- Current cycle's playtime is capped at `minEagerEndMs` (default 3s) **once a newer cycle is waiting to play**.
- Rule:
  - Next cycle's first audio chunk arrives → schedule the preempt at `max(now, currentCycle.startedAt + minEagerEndMs)`.
  - If current cycle drains naturally before the preempt deadline, play the next immediately (zero gap).
  - If the deadline fires first, fade out (~30 ms) and play the next.
  - Buffer holds **at most one** pending cycle; a later arrival replaces the existing pending.
  - Barge-in / Stop / explicit `playback.stop` = instant cut, bypass the cap.
- No "turn" concept. Every cycle is equal. Rapid ReAct chains with short acks work naturally (each ack drains in <3 s, next plays with no gap).

**Tech Stack:** Preact + TypeScript strict, Vitest, existing `@sentient/web-sdk` connectors. No new dependencies.

**Spec:** inline in this plan.

**Branch:** `feature/cerebrum-ux-refresh` (current).

---

## Current State (from `/Users/kevinye/Development/sentient` exploration)

**Wire protocol (`shared/protocol/src/messages.ts`):**
- `connector.audio.start` → `{ cycleId, taskId, encoding, sampleRate }` — start of a TTS stream for a cycle.
- Binary audio frames follow (no per-chunk header; parsed as raw `ArrayBuffer`).
- `connector.audio.done` → `{ cycleId }` — gateway has finished emitting TTS chunks for this cycle.
- `cycle.completed` → `{ cycleId, effectsInvoked }` — cycle fully done server-side.
- `playback.stop` → `{ cycleId, reason }` — gateway instructs client to drop audio.
- `task.update` → `{ taskId, toolName, cycleId, status, argsPreview, startedAtMs, endedAtMs? }` — already emitted.
- `session.ready` → `{ sessionId, audioEncoding, inputSampleRate, outputSampleRate, enabledEffects }`. Does **not** carry playback tunables yet.

**Webui playback (`gateway/webui/src/adapters/web-audio-playback.ts`):**
- `enqueue(samples: Float32Array)` appends to a single `AudioContext` schedule via `scheduleSource()`. No cycle grouping.
- `source.onended` → `notifyState(false)` when the last scheduled buffer ends.
- `clear()` tears down the AudioContext + `<audio>` element (used for barge-in).

**Webui hook (`gateway/webui/src/hooks/use-voice-client.ts`):**
- `AssistantAudioResponseConnector` forwards `onAudioStart` / `onAudioFrame` / `onAudioDone` / `onPlaybackStop` into the playback adapter.
- `cycleId` is carried on `audio.start` but is **not** currently threaded into the playback adapter — the adapter is cycle-agnostic.

**Speaking state (`gateway/webui/src/hooks/voice-status.ts`):**
- `buildVoiceStatus()` returns `assistant-speaking` when `isAudioPlaying || cognition === "acting"`.
- `isAudioPlaying` is set true on first `enqueue`, false on `source.onended` — so it already reflects playback drain. But:
  - `cognition === "acting"` can flip false the moment `cycle.completed` arrives, causing a brief flash in some codepaths.
  - `source.onended` firing logic across multiple scheduled sources needs verification — the adapter may flip `isPlaying=false` between chunks if scheduling has a gap.

**Tasks (`shared/web-sdk/src/connectors/task-status-connector.ts`, `gateway/webui/src/components/dock/composer-task-strip.tsx`):**
- `TaskStatusConnector` exists, attaches to SDK, maps `task.update` → `TaskSnapshotItem[]`.
- `ComposerTaskStrip` consumes the list, filters `status === "running"`, renders via `ToolPillStrip`.
- User reports zero tasks appearing anywhere. Needs investigation: is the connector attached to the new `useVoiceClient`? Is the signal wired into `ComposerTaskStrip`'s props in the redesigned shell?

---

## File Map

### Create

- `gateway/webui/src/adapters/cycle-audio-queue.ts` — cycle-aware queue layer that sits in front of `web-audio-playback.ts`. Owns preempt decision, pending buffer, fade-out, draining.
- `gateway/webui/src/adapters/cycle-audio-queue.test.ts`

### Modify

- `gateway/webui/src/adapters/web-audio-playback.ts` — expose a `fadeOutAndClear(durationMs)` method and more reliable drain event (worklet `underrun` posts to main, or scheduled-source `onended` that survives across chunked enqueues).
- `gateway/webui/src/audio/playback-worklet.ts` — verify / expose `underrun` message so the main thread can distinguish "worklet buffer empty" from "no new samples arrived in the last frame".
- `gateway/webui/src/hooks/use-voice-client.ts` — pass `cycleId` from `onAudioStart` / `onAudioFrame` / `onAudioDone` into the new cycle queue; read `minEagerEndMs` from `session.ready`.
- `gateway/webui/src/hooks/voice-status.ts` — derive `assistant-speaking` from playback-drain signal, not from `cognition`. Keep `cognition === "acting"` only as a fallback for the thinking state.
- `gateway/webui/src/components/dock/composer-task-strip.tsx` / `gateway/webui/src/components/bubble/tool-pill-strip.tsx` — verify `tasks` prop is actually reaching both locations; fix wiring if broken.
- `shared/protocol/src/messages.ts` — extend `sessionReadySchema` with `playback: { minEagerEndMs: number, preemptFadeoutMs: number }`.
- `gateway/src/session-handlers/ws-session-configure.ts` — populate the new `playback` block in the `session.ready` payload from config.
- `gateway/config.yaml` — add:
  ```yaml
  webui:
    playback:
      # Minimum playback duration guaranteed to the current cycle before a
      # newer cycle's audio is allowed to preempt. Covers short acks like
      # "let me check that for you" (~2s). Set to 0 to disable preempt cap.
      min_eager_end_ms: 3000
      # Fade-out ramp when preempting to avoid clicks. Range: 10-100.
      preempt_fadeout_ms: 30
  ```
- `gateway/webui/src/constants.ts` — add fallback defaults used when `session.ready` does not carry the `playback` block (older gateway build): `DEFAULT_MIN_EAGER_END_MS = 3000`, `DEFAULT_PREEMPT_FADEOUT_MS = 30`.

### Delete

None.

---

## Tasks

### Task 0: Diagnose why task list does not render

**Files:**
- Read-only: `gateway/webui/src/hooks/use-voice-client.ts`, `gateway/webui/src/components/dock/composer-task-strip.tsx`, `gateway/webui/src/components/chat/message-bubble.tsx` (tool pill path), `shared/web-sdk/src/connectors/task-status-connector.ts`.

- [ ] **Step 1: Reproduce with a tool-calling prompt.** Send a message that triggers a registered effect (e.g., `cancel_task` won't fire with no active task, so pick something from `gateway/src/effects/` that runs with mic off — `configure` if it accepts a no-op; else add a temporary echo effect for the smoke).
- [ ] **Step 2: Confirm wire emission.** Check `gateway/logs/YYYY-MM-DD.log` for `task.update` lines with matching `cycleId`. If present, bug is client-side. If absent, bug is in `TaskManager` / `cognitive-cycle-dispatch.ts` task-register path.
- [ ] **Step 3: Trace client subscription.** In `use-voice-client.ts`, confirm `TaskStatusConnector` is attached and `tasks` signal updates on each `task.update`. Add a DEBUG log inside the `onList` callback to verify.
- [ ] **Step 4: Trace UI consumption.** In the new `AppShell` / `ChatView` / `Dock` wiring, confirm `tasks` is passed as a prop to `ComposerTaskStrip` **and** grouped-by-cycleId into `MessageBubble` for the inline tool pill.
- [ ] **Step 5: Write the fix.** Likely candidates: (a) `ComposerTaskStrip` not imported in new dock; (b) `tasks` signal not destructured from `useVoiceClient`; (c) `attachToolsToAssistantMessages()` not called after re-render. Apply the minimum fix.
- [ ] **Step 6: Verify.** Dev build (`bun run dev`), send a prompt that invokes a tool, confirm pill appears during `running` and disappears on terminal status.

### Task 1: Derive `speaking` state strictly from playback drain

**Files:**
- Modify: `gateway/webui/src/audio/playback-worklet.ts`
- Modify: `gateway/webui/src/adapters/web-audio-playback.ts`
- Modify: `gateway/webui/src/hooks/voice-status.ts`
- Modify: `gateway/webui/src/adapters/web-audio-playback.test.ts` (create if missing)

- [ ] **Step 1: Worklet posts `underrun` reliably.** In `playback-worklet.ts`, ensure `{ type: "underrun" }` is posted exactly once per queue-drain event (not on every empty process() call). Add DEBUG log in the adapter on receive.
- [ ] **Step 2: Adapter tracks `pendingChunkCount`.** Every `enqueue()` increments; every `underrun` from worklet (when queue length reported as zero) signals "playback fully drained". Replace the current `source.onended`-only heuristic.
- [ ] **Step 3: Expose `onDrain(handler)`.** Adapter fires `onDrain` when both (a) all enqueued samples have been consumed by the worklet AND (b) no new `enqueue` call has happened for one audio-frame (~20 ms). This single event is the ground truth for "audio really stopped".
- [ ] **Step 4: Voice-status rewrite.** `buildVoiceStatus()` treats `isAudioPlaying` as authoritative for `assistant-speaking`. `cognition === "acting"` maps to `assistant-thinking`, not `assistant-speaking`. Thinking → speaking transition is driven by first `enqueue`, not by cycle state.
- [ ] **Step 5: Tests.** Unit test the adapter: enqueue 3 chunks, assert `isPlaying=true` after first, `isPlaying=false` only after the 3rd `onended` + underrun. Simulate `clear()` mid-stream and assert immediate `isPlaying=false`.
- [ ] **Step 6: Smoke test.** Play a long reply, observe the speaking chip stays lit until the last word. Press Stop mid-reply and observe instant transition.

### Task 2: Scaffold `CycleAudioQueue` (single-cycle playback, no preempt yet)

**Files:**
- Create: `gateway/webui/src/adapters/cycle-audio-queue.ts`
- Create: `gateway/webui/src/adapters/cycle-audio-queue.test.ts`

**Rationale:** Build the cycle-aware layer without preempt logic first, verify it's a drop-in replacement for direct `enqueue`, then add preempt in Task 3.

Interface sketch:

```typescript
export interface CycleAudioQueueOptions {
  playback: AudioPlaybackAdapter; // existing web-audio-playback
  minEagerEndMs: number;
  preemptFadeoutMs: number;
}

export interface CycleAudioQueue {
  onAudioStart(cycleId: string): void;
  onAudioFrame(cycleId: string, samples: Float32Array): void;
  onAudioDone(cycleId: string): void;
  cancelAll(): void; // barge-in / Stop
}
```

- [ ] **Step 1: Write failing tests.** Scenarios: (a) single cycle plays end-to-end; (b) `cancelAll` clears everything; (c) frames arriving for `cycleId` other than the active one are held (to be verified by next-cycle-playback, deferred until Task 3).
- [ ] **Step 2: Implement minimum viable.** Maintain `activeCycle: { id, startedAtMs, framesSeen, doneReceived } | null`. Frames for `activeCycle.id` go straight to `playback.enqueue`. Frames for other cycleIds get stored in a pending map keyed by cycleId. When active cycle drains (via `onDrain`) AND `doneReceived`, promote pending's latest cycleId to active (Task 3 will refine this).
- [ ] **Step 3: Wire through `use-voice-client.ts`.** `AssistantAudioResponseConnector` callbacks now go to `cycleAudioQueue` instead of directly to `playback`. Behavior should match current (single-cycle) smoke test.
- [ ] **Step 4: Manual smoke.** One-message-at-a-time, long + short replies, confirm no regression.

### Task 3: Add `minEagerEndMs` preempt cap to `CycleAudioQueue`

**Files:**
- Modify: `gateway/webui/src/adapters/cycle-audio-queue.ts`
- Modify: `gateway/webui/src/adapters/cycle-audio-queue.test.ts`
- Modify: `gateway/webui/src/adapters/web-audio-playback.ts` — add `fadeOutAndClear(durationMs): Promise<void>`.

- [ ] **Step 1: Extend adapter.** `web-audio-playback.fadeOutAndClear(durationMs)` applies a linear gain ramp from current gain → 0 over `durationMs`, then runs the existing `clear()`. Returns when clear completes.
- [ ] **Step 2: Queue state.** Add `pending: { cycleId, queuedFrames: Float32Array[], firstArrivedAtMs } | null`. Replace on newer cycleId arrival.
- [ ] **Step 3: Preempt decision.** When the first audio frame for a new cycleId arrives while `activeCycle` exists:
  - `elapsed = now - activeCycle.startedAtMs`.
  - If `elapsed >= minEagerEndMs` → immediate preempt: call `fadeOutAndClear(preemptFadeoutMs)`, then start pending's cycle.
  - Else → set pending; schedule a timer at `activeCycle.startedAtMs + minEagerEndMs`. If the timer fires and pending still exists and active is still playing, preempt with fade. If active drains naturally before the timer, cancel the timer and promote pending immediately (zero gap).
- [ ] **Step 4: Replacement semantics.** If a newer cycleId arrives while pending exists, discard pending's queued frames (log WARN with `reason="superseded-by-newer-cycle"` and both cycleIds). Keep the newer one, with its own `firstArrivedAtMs`. The scheduled preempt timer does not need to be rearmed — the cap is keyed on `activeCycle.startedAtMs`.
- [ ] **Step 5: Active-cycle drain transitions.** When `activeCycle` drains (all frames played + `doneReceived`), promote pending immediately. If no pending, go idle.
- [ ] **Step 6: Barge-in / Stop.** `cancelAll()` clears both active AND pending queues, calls `playback.clear()` (no fade — Stop is instant by design).
- [ ] **Step 7: Tests.** Matrix:
  - `elapsed < cap` on next arrival → buffered, promoted on natural drain, zero gap.
  - `elapsed >= cap` on next arrival → immediate fade + preempt.
  - `elapsed < cap` on arrival, cap fires while active still playing → fade + preempt at deadline.
  - Pending replaced by newer cycleId → oldest discarded, newest played after preempt.
  - `cancelAll` mid-playback → both cleared.
  - `cancelAll` while pending exists but active drained → pending dropped, no playback.
- [ ] **Step 8: Logging.** DEBUG on every decision: arrival, buffer, promote, preempt-now, preempt-at-deadline, superseded, drain. Per pipeline rules.

### Task 4: Plumb `minEagerEndMs` / `preemptFadeoutMs` through config and `session.ready`

**Files:**
- Modify: `gateway/config.yaml`
- Modify: `shared/protocol/src/messages.ts`
- Modify: `gateway/src/session-handlers/ws-session-configure.ts`
- Modify: `gateway/webui/src/hooks/use-voice-client.ts`
- Modify: `gateway/webui/src/constants.ts`

- [ ] **Step 1: Config keys.** Add `webui.playback.{min_eager_end_ms, preempt_fadeout_ms}` to `gateway/config.yaml` with inline comments per the rules.
- [ ] **Step 2: Schema.** Extend `sessionReadySchema` in `shared/protocol/src/messages.ts` to include optional `playback: { minEagerEndMs: number, preemptFadeoutMs: number }`. Optional so older gateway builds still validate; client falls back to `DEFAULT_*` constants.
- [ ] **Step 3: Emit.** `ws-session-configure.ts` reads the config values and includes them in the `session.ready` payload.
- [ ] **Step 4: Consume.** `use-voice-client.ts` reads `playback` from `session.ready`, falls back to constants, instantiates `CycleAudioQueue` with the resolved values.
- [ ] **Step 5: Tests.** Update `session.ready` schema test; verify ws-session-configure emits the block; verify `use-voice-client` uses the value.

### Task 5: Integration smoke + browser verification

- [ ] **Step 1: Docker build + up.** `source scripts/env.sh && cd deploy/docker && docker compose build gateway && docker compose up -d gateway`.
- [ ] **Step 2: Scenario — overlap avoidance.** Open webui, send "what's the weather". While "let me check that for you" TTS is playing, send "and turn off the light". Verify: no audio overlap. Either the second reply plays after the first drains (natural end, if ack was <3 s) or after a ~30 ms fade (if the first went >3 s).
- [ ] **Step 3: Scenario — rapid short acks.** Construct a prompt that triggers a ReAct chain of short acks. Verify each ack plays through, next one follows with no gap, no double-playback.
- [ ] **Step 4: Scenario — speaking state.** Confirm the speaking indicator stays lit from first audio chunk through the last sample played, drops immediately on barge-in / Stop.
- [ ] **Step 5: Scenario — task list.** Trigger a tool-calling prompt. Verify the running tool pill appears in `ComposerTaskStrip` and in the message bubble's `ToolPillStrip`, and disappears on terminal status.
- [ ] **Step 6: Read gateway logs.** `docker compose logs gateway --tail=200` — scan for any WARN or ERROR from the new cycle-queue path.

### Task 6: Self-review + PR

- [ ] **Step 1: Run `bun run ci`** from repo root. Fix any lint / typecheck / test failures.
- [ ] **Step 2: Check file-length rule.** `cycle-audio-queue.ts` must stay <300 lines; split decision logic into a pure function if needed.
- [ ] **Step 3: Commit per the git-workflow rule.** One commit per logical task. Example split: (a) task-list fix, (b) speaking-state drain, (c) cycle-queue scaffold, (d) preempt cap, (e) config plumbing.
- [ ] **Step 4: PR to develop.** Include before/after notes on the three bugs and a screencast of the weather-and-light scenario if possible.

---

## Open Questions / Follow-Ups

- **What if the LLM produces a refinement reply to a queued message that references the in-flight reply?** ("Here's today's weather… oh, and as for the light, it's off.") The current plan plays these sequentially; user may hear redundancy. A future system-prompt tweak can instruct the model to only speak deltas when it knows a prior reply is still playing, but this is out of scope here.
- **Should `minEagerEndMs` be adjustable per message kind (short ack vs. substantive)?** Not in v1. The 3 s default covers the common case. Revisit if short acks start regularly exceeding 3 s.
- **Crossfade vs. fade-out-then-play?** This plan uses fade-out-then-play (simpler, no simultaneous-playback window). If the seam sounds abrupt in practice, we can upgrade to a 20 ms overlap crossfade in a follow-up.
