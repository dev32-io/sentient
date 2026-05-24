# Cerebrum UX Refresh — Design

**Date:** 2026-04-18
**Status:** Brainstormed, awaiting user approval before plan-writing.
**Scope:** Two-phase work. Phase 1 cleans up the gateway's cancel primitives (barge-in / interrupt / task cancel). Phase 2 rebuilds the web client UI around a new visual design, on top of the clean primitives.

---

## 1 — Motivation

A new visual design for the web UI (`sentient-webui-design/`, variant Image #22) was produced. Adopting it surfaced deeper muddling in the gateway's interrupt/barge-in/cancel concepts:

- The model-callable `interrupt` tool aborts the cycle, TTS, and tasks — but its own description tells the model to "reply with a brief acknowledgement" after calling it. The cycle abort kills the acknowledgement.
- `SessionAudioController` conflates three responsibilities: TTS audio lifecycle, cycle-abort authority (via a mutable `cycleAbortRef`), and cancel-gesture policies.
- Voice barge-in currently aborts only TTS — the cycle's LLM stream keeps running, burning tokens, and delaying the next cycle's dispatch.
- No `cancel_task` tool exists for fine-grained cancellation by the model.

Fixing the UX requires first fixing the primitives they sit on. This spec does both, sequenced.

---

## 2 — Guiding principles

Cross-cutting rules that both phases follow:

- **Three independent cancel primitives**, each doing one thing. Composition happens at the call site, not inside a magic "stop everything" method.
- **No flag-driven mode switching.** Each behaviour maps to a specific signal or slot; there are no boolean modes to reason about.
- **Components never own more than they're named for.** If a file is called `SessionAudioController`, it does not hold cycle-abort authority.
- **Data flows one direction.** Signals ↓ components ↓ callbacks ↑ hook ↑ SDK. Components don't read signals and don't call SDK methods directly.
- **WIP is honest.** A panel that isn't wired shows a visible "WIP" badge and its controls no-op. No fake-working surfaces.
- **Design prototype is reference, not source.** `sentient-webui-design/` is a React UMD mock. Re-implement in Preact + TypeScript against our rules; copy structure and token values, not code.

---

## 3 — Phase 1: Gateway cancel primitives cleanup

### 3.1 — Conceptual model

Three cancel primitives on the session, each with one responsibility:

| Primitive | Cancels cycle LLM stream | Cancels TTS | Cancels tasks | Fired by |
|---|---|---|---|---|
| **`bargeIn`** | yes | yes | no | mic-onset during voice mode |
| **`interrupt`** | yes | yes | yes (interruptable) | UI Interrupt button → wire `{type:"interrupt"}` |
| **`cancelTask` / `cancelAllInterruptable`** | no | no | yes | model-callable effects `cancel_task` / `cancel_all_tasks` |

Cutoff kinds on committed assistant entries: `interrupt | barge-in`. No other kinds.

### 3.2 — Component decomposition

Replace `SessionAudioController` (currently carries the above three responsibilities plus audio lifecycle) with five focused units:

| Unit | Responsibility | File |
|---|---|---|
| `AbortSlot` | Generic single-slot registry holding the current `AbortController` for one resource; exposes `register / complete / cancelCurrent / currentId` | `gateway/src/session-handlers/abort-slot.ts` |
| `cycleSlot` | Instance of `AbortSlot`, holds the active cycle's controller | wired in session bootstrap |
| `ttsSlot` | Instance of `AbortSlot`, holds the active TTS pipeline's controller | wired in session bootstrap |
| `SessionAudioWire` | The only component that emits audio wire messages (`audio.start / frame / done / playback.stop`) | `gateway/src/session-handlers/session-audio-wire.ts` |
| `BargeInController` | Composes cycle cancel + TTS cancel + `playback.stop` emission. Owns the drain-grace window for mic-onset tail coverage. | `gateway/src/session-handlers/barge-in-controller.ts` |
| `InterruptController` | Composes cycle cancel + TTS cancel + task cancel + `playback.stop` emission. Stages cancelled-task-ids for commit cutoff. | `gateway/src/session-handlers/interrupt-controller.ts` |

`TaskManager` is unchanged.

### 3.3 — `AbortSlot` interface

```typescript
export interface AbortSlot {
  register(id: string, controller: AbortController): void;
  complete(id: string): void;
  cancelCurrent(reason: string): string | null;
  currentId(): string | null;
  onComplete(callback: (id: string) => void): () => void;
}
```

`register` / `complete` are called by the resource owner (the cycle runner registers its own controller; the TTS pipeline registers its own). Only the slot mutates its state. `cancelCurrent` returns the cancelled id or null. `onComplete` subscription is used by `BargeInController` to stamp the drain-grace window.

### 3.4 — `BargeInController`

```typescript
interface BargeInControllerDeps {
  cycleSlot: AbortSlot;
  ttsSlot: AbortSlot;
  wire: SessionAudioWire;
  graceWindowMs: number;
}

function createBargeInController(deps: BargeInControllerDeps) {
  let lastTtsEndMs = 0;
  deps.ttsSlot.onComplete(() => { lastTtsEndMs = Date.now(); });

  return {
    trigger(): void {
      const activeTts = deps.ttsSlot.currentId() !== null;
      const withinGrace = Date.now() - lastTtsEndMs < deps.graceWindowMs;
      if (!activeTts && !withinGrace) return;

      const cycleId = deps.ttsSlot.currentId() ?? deps.cycleSlot.currentId();
      deps.cycleSlot.cancelCurrent("barge-in");
      deps.ttsSlot.cancelCurrent("barge-in");
      if (cycleId) deps.wire.sendPlaybackStop(cycleId, "barge-in");
    },
  };
}
```

Grace window value: `config.audio.ttsDrainGraceMs` (already present as `TTS_DRAIN_GRACE_MS = 2000` in current code — move to config per the config rules).

### 3.5 — `InterruptController`

```typescript
interface InterruptControllerDeps {
  cycleSlot: AbortSlot;
  ttsSlot: AbortSlot;
  taskManager: TaskManager;
  wire: SessionAudioWire;
  onInterruptStaged(ids: readonly string[]): void;
}

function createInterruptController(deps: InterruptControllerDeps) {
  return {
    trigger(): void {
      const cycleId = deps.cycleSlot.currentId();
      deps.cycleSlot.cancelCurrent("interrupt");
      deps.ttsSlot.cancelCurrent("interrupt");
      const cancelled = deps.taskManager.cancelInterruptable("interrupt");
      deps.onInterruptStaged(cancelled);
      if (cycleId) deps.wire.sendPlaybackStop(cycleId, "interrupt");
    },
  };
}
```

`onInterruptStaged` is a callback into the cycle commit logic — same staging pattern currently in `SessionAudioController`, pulled out as a callback so the controller doesn't know about commit internals.

### 3.6 — Effect rename + new effect

#### `gateway/src/effects/cancel-all-tasks-effect.ts` (renamed from `interrupt-effect.ts`)

- Effect `name`: `"cancel_all_tasks"`.
- Description: *"Cancel every in-flight task you have running. Use when the user tells you to stop or abandon what's running. Reply with a brief acknowledgement after calling."*
- Dependency: `cancelAllInterruptable: (reason: string) => readonly string[]` — wired to `taskManager.cancelInterruptable`.
- Handler: calls `cancelAllInterruptable("cancel_all_tasks")` and returns `{ ok: true, data: { cancelled_task_ids: [...] } }`.
- `interruptable: false` (unchanged — must not self-cancel if user triggers interrupt concurrently).
- **No cycle abort, no TTS abort.** The model's acknowledgement streams naturally after the tool call returns.

#### `gateway/src/effects/cancel-task-effect.ts` (new)

- Effect `name`: `"cancel_task"`.
- Args: `{ task_id: string }`.
- Description: *"Cancel a specific in-flight task by its `task_id`. Use when you need to abort a single tool call without disturbing others."*
- Dependency: `cancelTask: (taskId: string, reason: string) => boolean` — wired to `taskManager.cancel`.
- Handler: calls `cancelTask(task_id, "cancel_task")`, returns `{ ok: true, data: { task_id, cancelled: <boolean> } }`.
- `interruptable: false`.

#### Registration

Wherever effects are registered (currently the effect list in the session bootstrap), swap the single `triggerInterrupt` injection for two narrower injections: `cancelAllInterruptable` and `cancelTask`. The broad `triggerInterrupt` injection goes away.

### 3.7 — SDK / wire additions

**`TaskSnapshotItem`** (in `@sentient/protocol`):

- Add `cycleId: string`.
- Add `"cancelled"` to the `status` union.
- Optional: `cancelledReason?: string`.

**Emission changes:**

- `TaskManager.register(handle)` stores the owning `cycleId` from the dispatch context and includes it in every snapshot emission.
- `TaskManager.cancel(taskId, reason)` transitions status to `"cancelled"` (not `"failed"`) when user/model-triggered. `"failed"` stays reserved for exceptional completions.

**Wire messages (client → server):** unchanged. `{ type: "interrupt" }` still maps to `interruptController.trigger()`.

**Wire messages (server → client):** no new message types. Existing `cycle.aborted` now fires on barge-in as well (it didn't previously, because the cycle wasn't being aborted).

### 3.8 — File-level changes checklist

- Create `gateway/src/session-handlers/abort-slot.ts` + test.
- Create `gateway/src/session-handlers/session-audio-wire.ts` + test (extract wire-message emission from current `SessionAudioController`).
- Create `gateway/src/session-handlers/barge-in-controller.ts` + test.
- Create `gateway/src/session-handlers/interrupt-controller.ts` + test.
- Delete `gateway/src/session-handlers/session-audio-controller.ts` and its test.
- Update session bootstrap (wherever `SessionAudioController` is constructed) to wire the five new pieces.
- Update `cognitive-cycle.ts` to register its `AbortController` with `cycleSlot` at entry and complete at natural end.
- Update `content-tts-pipeline.ts` (or wherever TTS AbortController is created) to register with `ttsSlot`.
- Rename `gateway/src/effects/interrupt-effect.ts` → `cancel-all-tasks-effect.ts`. Update handler + description + deps.
- Create `gateway/src/effects/cancel-task-effect.ts` + test.
- Update shared protocol types (`shared/protocol/`) for the `TaskSnapshotItem` additions.
- Update `gateway/src/cerebrum/task-manager.ts` to thread `cycleId` + the `"cancelled"` status.
- Update `ws-handlers.ts` and `ws-session-configure.ts` to call the new controllers instead of `SessionAudioController`.
- Update any system-prompt fragment or tool-description copy that references the `interrupt` tool name.
- Search for `TurnController`, `ContinuousSession`, `cycleAbortRef`, `interrupt-effect` imports — clean up dead references.

### 3.9 — Tests

Per the testing rules: one behaviour per `it()`, coverage ≥ 80% statements / 75% branches, unit tests under 100ms.

- `abort-slot.test.ts`: register/complete/cancel happy paths; multiple registers error or overwrite (pick one — overwrite is simpler); `onComplete` fires with correct id.
- `barge-in-controller.test.ts`: no-op when nothing active; cancels cycle + TTS + emits wire when TTS active; grace-window path (recent `onComplete` stamp) cancels TTS slot no-op but still emits wire; stops triggering after disposal.
- `interrupt-controller.test.ts`: cancels in correct order (cycle, TTS, tasks, wire); staging callback receives cancelled ids; idempotent if called with nothing active.
- `session-audio-wire.test.ts`: each send method emits the correct shape; no other side effects.
- `cancel-all-tasks-effect.test.ts`: calls `cancelAllInterruptable` with the right reason; returns ids; does NOT call cycle/TTS abort.
- `cancel-task-effect.test.ts`: calls `cancelTask(task_id, reason)`; returns the boolean outcome; invalid task id surfaces in result.
- `task-manager.test.ts`: extend — assert `cycleId` threads through; `"cancelled"` vs `"failed"` distinction.
- `cognitive-cycle.test.ts`: extend — assert `cycleSlot.register` / `complete` called; aborted cycle flags correctly on barge-in vs interrupt.

### 3.10 — Phase 1 definition of done

- `bun run ci` passes (lint + typecheck + tests).
- No reference to `SessionAudioController`, `triggerInterrupt`, or the old `interrupt-effect` remains in source.
- `.claude/rules/**/pipeline.md` and `agents/docs/**/pipeline-details.md` already reflect the new model (done pre-spec in this conversation). No additional rule updates needed in Phase 1.
- Docker image builds and runs per the project's build flow (check `deploy/docker/`).
- **Implementer runs a manual smoke test** before handing over:
  1. Spin up the gateway in Docker (`deploy/docker`, `compose up -d` with default `LOG_LEVEL=debug`).
  2. Connect a client (the existing webui works unchanged — this phase is wire-compatible).
  3. Send a text message that triggers a long response + tool call, press the Interrupt button mid-stream. Verify: response stops, playback stops, logs show `interrupt-controller` cancelling cycle → TTS → tasks. Committed assistant entry has `cutoff: { kind: "interrupt", cancelledTaskIds: [...] }`.
  4. Enable voice mode, let the assistant speak, barge in by speaking. Verify: TTS stops, logs show `barge-in-controller` cancelling cycle + TTS, tasks continue running if any, next cycle fires from the user's new speech. Commit has `cutoff: { kind: "barge-in" }`.
  5. Prompt the assistant (e.g., via a system-prompt note) to call `cancel_all_tasks`. Verify: in-flight tasks transition to `"cancelled"`, the model emits its acknowledgement text, TTS plays the ack. No cutoff on the commit.
  6. Same with `cancel_task` targeting one task id.
  7. Read `gateway/logs/YYYY-MM-DD.log` — trace each primitive from trigger to wire message. If any step isn't end-to-end traceable, the logging per the logging rule isn't done.

---

## 4 — Phase 2: Webui redesign

### 4.1 — Scope

Rebuild `gateway/webui/` against the new design (Image #22 of `sentient-webui-design/`). Preact + Vite + TypeScript unchanged. New token system, new component inventory, new hook surface, new auto-scroll, new Settings shell.

Locked token variant:

- Theme: **dusk** (warm dark, smoked amber).
- Bubble style: **filled**.
- Layout density: **comfortable**.
- Fonts: **Fraunces + DM Sans** (with JetBrains Mono for code).
- Voice orb / tool card: not applicable — we bake the design's **bars / default** visuals without the `[data-*]` attribute switching system.

No `[data-theme]` / `[data-bubble]` etc. runtime variants. One set of semantic tokens; reskinning is a file replacement.

### 4.2 — Design token system

One file per concern, all aggregated by `styles/tokens/index.css`.

| File | Tokens |
|---|---|
| `tokens/colors.css` | `--color-bg / -bg-elev / -bg-sunk / -paper`, `--color-line / -line-soft`, `--color-ink / -ink-2 / -ink-3 / -ink-4`, `--color-accent` (terra), `--color-accent-soft / -accent-50`, `--color-amber`, `--color-sage / -sage-soft`, `--color-ok / -warn / -stop` |
| `tokens/spacing.css` | `--space-xs / sm / md / lg / xl / 2xl / 3xl` |
| `tokens/radius.css` | `--radius-sm / md / lg / xl / pill` |
| `tokens/typography.css` | `--font-display` (Fraunces), `--font-ui` (DM Sans), `--font-mono`; `--font-size-xs / sm / base / lg / xl / display`; `--line-height-tight / normal / relaxed` |
| `tokens/shadows.css` | `--shadow-1 / 2 / inset`; `--shadow-2` carries the dusk halo (terra outer glow) |
| `tokens/motion.css` | `--motion-fast / normal`; named keyframe durations `--motion-wave / cursor` |
| `tokens/index.css` | `@import`s all the above |

Values are copied from `sentient-webui-design/styles.css`'s `[data-theme="dusk"]` + `[data-fonts="modern"]` blocks, merged into the base `:root`. Drop the attribute-selector override system entirely.

Every component CSS file references semantic tokens only. No raw hex values outside `tokens/`.

### 4.3 — Data model additions

#### `webui/src/types.ts`

```typescript
interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp: number;
  readonly isStreaming: boolean;
  readonly cycleId?: string;                    // NEW
  readonly channel?: ConversationUserChannel;
  readonly cutoff?: ConversationAssistantCutoff;
  readonly pending?: boolean;                   // NEW — client-only optimistic flag
  readonly tools?: readonly TaskSnapshotItem[]; // NEW — grouped inline by cycleId
}
```

`TaskSnapshotItem` follows the shape defined in §3.7.

### 4.4 — Hook interface (`useVoiceClient` extended)

New signals exposed:

- `cycleStatus: Signal<"idle" | "streaming" | "speaking" | "awaiting-tasks">`. Derived pure function from `cognition`, `audioPlaying`, and `runningTasksCount`.
- `currentCycleId: Signal<string | null>`. Latest in-flight `cycleId` or newest committed assistant `cycleId`; null when idle.
- `voiceMode: Signal<"off" | "active">`. The only thing that wires/unwires mic capture and speech-onset → `bargeIn` subscription.

Existing `messages` signal now carries `pending` + `tools[]`. Derivation runs inside the hook — components see a fully-resolved list.

Pending-user buffer:

- `sendText(text)` pushes an optimistic `PendingUserMessage { pendingId, text, createdAtMs }` into an internal buffer and sends over the wire.
- On `ConversationHistoryConnector.onUpdate`, match arriving user entries against buffer entries by text + `ts ≥ createdAtMs`, FIFO. Remove matches.
- `deriveMessages` merges committed + remaining pending (pending rendered with `pending: true`, CSS greys them).

Tool grouping:

- `deriveMessages` indexes `tasks` by `cycleId`, attaches to each assistant entry with matching cycle id, sorted by `startedAtMs`.

No other interface changes. `start/stopVoiceMode`, `sendText`, `interrupt` keep their signatures.

### 4.5 — Component inventory

Under `webui/src/components/`:

- **shell/**: `app-shell.tsx`, `topbar.tsx`.
- **chat/**: `chat-view.tsx`, `message-list.tsx`, `message-bubble.tsx`, `bubble-text.tsx`, `bubble-speaking-wave.tsx`, `tool-pill-strip.tsx`, `tool-inline-detail.tsx`, `day-divider.tsx`, `interrupt-chip.tsx`.
- **dock/**: `composer.tsx`, `composer-task-strip.tsx`, `mic-button.tsx`, `send-button.tsx`, `interrupt-button.tsx`, `suggestion-chips.tsx`.
- **settings/**: `settings-view.tsx`, `settings-tabs.tsx`, `members-panel.tsx`, `permissions-panel.tsx`, `voices-panel.tsx`, `sessions-panel.tsx`, `invites-panel.tsx`, `member-row.tsx`, `permission-grid.tsx`, `session-row.tsx`, `wip-badge.tsx`.
- **common/**: `avatar.tsx`, `icon.tsx`, `icon-button.tsx`, `status-chip.tsx`, `role-pill.tsx`.

Each `.tsx` has a matching `.test.tsx`. Each file < 300 lines per clean-code rules; most < 150.

Props contracts for each component are in §3 of the brainstorming transcript — binding: each component receives plain props, never a signal, never the SDK, never a store.

### 4.6 — Bubble state rendering rules

Four assistant bubble states, keyed off cycle status + cutoff:

| State | Condition | Rendering |
|---|---|---|
| streaming | `isStreaming && !audioPlayingForThisCycle` | text + terra cursor at end |
| speaking | `cycleStatus === "speaking" && cycleId === message.cycleId` | text with animated terra gradient wave overlay on the text-only region; tools strip unaffected |
| played | committed, no cutoff, not currently speaking | plain bubble |
| interrupted | `message.cutoff?.kind === "interrupt" \| "barge-in"` | inline `[• interrupted]` chip at cut point in text + meta-row `interrupted` label after time |

Meta row is uniform across user/assistant/all states: `[avatar] [name] · [time]` — plus the interrupt label after `time` when applicable. No voice-inline "Spoken · 0:08" tag, no replay button.

User bubble states:

- `confirmed` — default, full opacity.
- `pending` — optimistic, reduced opacity (~0.5).

Text and speech channels render identically. No channel indicator.

### 4.7 — Tool pill strip behaviour

- **Inline (inside bubble)**: flush with bubble bottom, full-width, divided by hairlines. Click a pill → opens `ToolInlineDetail` *downward* (below the strip, inside the bubble). Chevron rotates `90deg`. One open at a time per strip.
- **Composer (atop composer)**: same visual, expand *upward* (detail appears above the strip; chevron rotates `-90deg`). Sources from the full session-wide `tasks` snapshot (unfiltered by cycleId).

Status dot variants: `running` (terra spinner), `ok` (sage dot), `err` (stop-red dot), `cancelled` (muted ink-3 × or minus glyph — smaller visual weight than err). Maps 1:1 to `TaskSnapshotItem.status`.

### 4.8 — Auto-scroll hook

`hooks/use-follow-latest.ts`. Pin-to-bottom with a near-bottom threshold (default 100px). Three subscriptions:

1. `scroll` listener on the container updates `pinToBottom` based on distance from bottom.
2. `ResizeObserver` on the content fires on any height change. If pinned, scroll a zero-height sentinel into view with `block: "end"`, `behavior: "auto"` (instant, no animation — prevents jitter during token streaming).
3. `useLayoutEffect` on mount scrolls to bottom instantly.

Returns `{ pinToBottom, jumpToLatest() }`. Components don't read `pinToBottom` in the initial implementation; it's exposed for a future "jump to latest" button.

Integrated in `chat-view.tsx`:

```tsx
const scrollRef = useRef<HTMLElement>(null);
const contentRef = useRef<HTMLElement>(null);
useFollowLatest({ scrollContainerRef: scrollRef, contentRef });

return (
  <section class="chat-view" ref={scrollRef}>
    <div class="chat-content" ref={contentRef}>
      <MessageList messages={messages} />
      {transcript && <LiveTranscript text={transcript} />}
      <div class="chat-sentinel" aria-hidden="true" />
    </div>
  </section>
);
```

### 4.9 — Dock behaviour map

| UI element | Visible when | Action |
|---|---|---|
| Mic button (bottom-left) | always | toggles `voiceMode`; terra-tinted when `active` |
| Send button (bottom-right) | always; disabled iff text empty | `onSendText`; text input stays enabled even during streaming |
| Interrupt button (bottom-right, next to send) | `cycleStatus !== "idle" \|\| runningInterruptableTasks > 0` | `onInterrupt` → wire `{ type: "interrupt" }` |
| Composer task strip (top of composer, flush with top edge, inside composer's border) | any task in session has `status ∈ {running, pending}` | click pill to expand detail upward |
| Suggestion chips (below composer) | always | click → `onSendText(suggestion)` |

Composer border accent: neutral default, terra on `:focus-within`, stronger terra when `voiceMode === "active"`, stop-red tint when `cycleStatus !== "idle"`. Stacked `--shadow-2` (dusk variant) provides the outer glow that visually "floats" the composer.

Keyboard: `Esc` triggers interrupt when `canInterrupt`. Text `Enter` (not Shift) submits.

### 4.10 — Settings WIP structure

`SettingsView` renders five tabs: `Members | Permissions | Voice profiles | Devices & sessions | Invites`. Tab state is local; no URL sync in this spec.

- **Members, Permissions, Devices & sessions** panels render the design's full layout with static fixture data from `webui/src/data/household-fixtures.ts`. Each has a visible `WipBadge` in the header. All interactive controls (kebab menus, invite button, sign-out button, custom-role button) no-op.
- **Voice profiles, Invites** panels render an empty-state card with "Coming soon" copy. No WIP badge (placeholder is already unambiguous).

Fixtures typed against the same shapes a future SDK surface would return. Swap-in path later = one import change.

### 4.11 — File-level changes checklist

- Create `webui/src/styles/tokens/*.css` (7 files).
- Delete `webui/src/styles/tokens.css` (old) and `webui/src/styles/components.css` (will be re-authored as per-component CSS or inline styled).
- Rewrite every file under `webui/src/components/` per the inventory in §4.5. The 9 existing components are either replaced (`chat-screen`, `input-bar`, `voice-mode-button`, `message-bubble`, `message-list`, `interrupt-button`, `live-transcript`, `task-sidebar`, `tool-confirm-dialog`, `auth-gate`) or dropped. `auth-gate.tsx` stays unused until auth work begins.
- Rewrite `webui/src/types.ts` with the new `ChatMessage` shape.
- Extend `webui/src/hooks/use-voice-client.ts` per §4.4.
- Create `webui/src/hooks/use-follow-latest.ts` per §4.8.
- Create `webui/src/data/household-fixtures.ts`.
- Port icon set from `sentient-webui-design/icons.jsx` → `webui/src/components/common/icons/` (one file per icon) + `icon.tsx` wrapper.
- Update `webui/src/app.tsx` to render `AppShell` with route state.
- Update `webui/index.html`: add Fraunces + DM Sans + JetBrains Mono Google Fonts links (copy from `sentient-webui-design/Sentient.html` head block).
- Verify `vitest.config.ts` still covers `src/components/**/*.test.tsx` — should work unchanged.

### 4.12 — Tests

- **Components**: default render, prop-driven state variants, click/input callbacks fired with correct args, accessibility (`role` / `aria-label`). Testing-Library + Vitest. No hook mocks — pass plain values.
- **Hooks**:
  - `use-voice-client.test.ts` extended: pending buffer match behaviour (FIFO on duplicate text); tool grouping by `cycleId`; `cycleStatus` derivation matrix.
  - `use-follow-latest.test.ts`: scroll-event pin-state updates; ResizeObserver-driven scroll when pinned; no-scroll when unpinned; first-paint scroll.
- **Coverage floors** per project rule: ≥ 80% statements, ≥ 75% branches.

### 4.13 — Dependencies on Phase 1

- Phase 2 requires `TaskSnapshotItem.cycleId` and `status: "cancelled"` from Phase 1. If Phase 2 starts before Phase 1 ships, stub with client-side defaults (`cycleId = ""` → tools render unanchored, `"cancelled"` → map to `err` visually); swap when Phase 1 lands.
- Phase 2's `cycleStatus = speaking` transition off barge-in requires Phase 1's barge-in cycle-abort. Without it, the wave keeps animating until natural LLM end.

**Recommended sequencing**: land Phase 1 fully before starting Phase 2. If parallelism is needed, Phase 2 can scaffold against stubbed types, but the integration test at the end of Phase 2 requires Phase 1 to be live on the gateway.

### 4.14 — Phase 2 definition of done

- `cd gateway/webui && bun run ci` passes.
- Every new component under 300 lines. Every file has a matching test.
- Coverage thresholds met.
- Biome lint + format clean.
- No raw hex color, spacing, or font value outside `styles/tokens/`.
- **Implementer runs a manual browser smoke test** before handing over:
  1. Build the webui, run the gateway + webui in Docker via `deploy/docker`.
  2. Open the web UI in a browser. Verify topbar, composer, and an empty conversation render against Image #22 fidelity (spot-check against `sentient-webui-design/screenshots/` if needed).
  3. Type "hello" → send. User bubble appears greyed. Once the assistant's first delta lands, the bubble un-greys (sync confirmed). Assistant bubble streams in; cursor visible; auto-scroll tracks.
  4. Mid-stream, press the Interrupt button. Response cuts off; `[• interrupted]` chip appears at cut point, meta row shows `interrupted` label. Tool pills (if any) that were cancelled show the `cancelled` visual state.
  5. Send another text message during the dying stream (before it fully commits). It appears greyed, waits, then confirms and triggers the next cycle.
  6. Toggle mic on. Composer border shifts to stronger terra. Speak a question; STT finalizes; user bubble lands (no grey state for speech — it's already confirmed by the gateway).
  7. While assistant is speaking, speak again. TTS stops immediately; `playback.stop` with `reason: "barge-in"` in logs; current bubble shows interrupted; new cycle starts from user's new speech. Any in-flight interruptable task shows `running` → eventually its own completion; was NOT cancelled by barge-in.
  8. Click a tool pill inline → detail panel expands downward inside the bubble. Click a different pill → previous closes, new opens. Click same → closes.
  9. With a task still running, look at the composer task strip — pill visible. Click it → detail panel expands upward above the strip.
  10. Switch to Settings. Verify all five tabs render. Members / Permissions / Devices panels show fixture content + WIP badges. Voice profiles / Invites show "Coming soon." Clicks on kebabs, buttons, inputs do nothing destructive.
  11. Check DevTools console for errors or warnings — should be clean.
  12. Resize browser window, verify layout holds at 1280+ widths. Mobile viewport is out of scope for this spec.

---

## 5 — Implementation references

- `sentient-webui-design/` — React UMD prototype. **Reference only.** Read for token values, visual states, interaction patterns. Do not copy-paste into Preact; re-author against our rules.
- `sentient-webui-design/screenshots/` — authoritative visuals for the four assistant bubble states, composer-task-strip behaviour, tool expansion, and listening glow.
- `sentient-webui-design/screenshots/msg-spacing.png` and `tools-expanded.png` — reference for meta row layout, speaking wave, day divider, and tool pill strip.
- `sentient-webui-design/styles.css` `[data-theme="dusk"]` + `[data-fonts="modern"]` blocks — source of truth for token values.
- Image #22 (Tweaks panel state) — documents the locked variant combination.
- Image #24 (composer final) — authoritative dock layout.
- `.claude/rules/` (root + `gateway/`) — binding rules for both phases.
- `agents/docs/pipeline-details.md` and `gateway/agents/docs/pipeline-details.md` — examples supporting the rules.

Implementer may freely look at these while building each phase. Nothing is out-of-bounds to consult.

---

## 6 — Risk / migration / rollback

- **Protocol break.** Phase 1 changes the emitted `TaskSnapshotItem` shape. Current webui will show `undefined` cycleIds until Phase 2 lands — acceptable because we control both ends and versions lock-step.
- **System prompt references.** If any system prompt or example currently references the `interrupt` tool by name, update to `cancel_all_tasks`. Phase 1 checklist covers the grep.
- **Docker-only local dev drift.** Memory flag `check_docker_ps_before_tests`: before running test suites, stop local `sentient-*` containers that may bind test ports. Neither phase should interact with user config at `~/.sentient/`.
- **Rollback.** Each phase lands in its own feature branch → `develop`. Reverting Phase 1 cleanly requires a revert commit; no data migrations. Reverting Phase 2 is a webui-only revert.

---

## 7 — Out of scope (future specs)

- **Auth gate.** Current `PLACEHOLDER_TOKEN = "anonymous"` is preserved. Real auth is a separate spec.
- **User-initiated per-task cancel UI.** The model has `cancel_task`; users don't get a cancel button on task pills in this spec. Additive later.
- **Deep-linking / routing.** `SettingsView` tabs are local state; no URL sync.
- **Notifications panel.** Bell icon in topbar is wired to a no-op.
- **Mobile viewport.** Minimum target is 1280px width; mobile responsive is a later pass.
- **Voice profile enrollment, invites flow, permission editing** — corresponding panel stubs exist; wiring is future work.
- **Jump-to-latest button.** Hook exposes `pinToBottom` for future use.
- **Cerebrum arch doc drift cleanup beyond `.claude/rules/` and `CLAUDE.md`** — specs and plans under `docs/superpowers/` remain historical.
