# Mobile Design-Polish — Design

- **Date:** 2026-06-04
- **Branch:** `feature/mobile-client`
- **Status:** Approved (design), pending spec review → implementation plan
- **Scope:** iOS (SwiftUI) + Android (Compose) chat + history surfaces, plus one bounded `shared/mobile-sdk` derivation.

## 1. Goal

Bring the iOS and Android clients to **visual + behavioral parity with the current webui**, using the new `Sentient Mobile.html` design as the phone-layout reference. This is a fidelity pass on **existing, working** screens — not a rebuild.

The reference for *behavior* is the **current webui source** (`gateway/webui/src/`), NOT the design mock's React prototype. The design mock (`sentient-webui-design/project/Sentient Mobile.html` + `mobile.css`) is the reference for *phone layout/structure* only.

Both platforms move in lockstep off the shared `mobile-sdk` token layer.

### Ground-truth references

| Concern | webui source (behavior truth) | Design mock (layout ref) |
|---|---|---|
| Typewriter | `gateway/webui/src/hooks/use-typewriter-buffer.ts`, `config/typewriter.ts` | — |
| Bubble speaking-wave | `components/chat/bubble-speaking-wave.tsx`, `styles/components.css` | `mobile.css` |
| Avatar ripple | `components/common/avatar.tsx` + `.avatar--running/--listening` CSS | — |
| Autoscroll | `hooks/use-follow-latest.ts` | — |
| Tools strip | `components/chat/tool-pill-strip.tsx`, `tool-inline-detail.tsx`, `cycle-helpers.ts#attachToolsToAssistantMessages` | `mobile.css` (`.tools-strip`) |
| Message model | `gateway/webui/src/types.ts` (`ChatMessage`), `web-sdk/connectors/task-status-connector.ts` (`TaskSnapshotItem`) | — |
| Topbar / drawer / composer layout | — | `Sentient Mobile.html`, `mobile.css` |
| Design anchor (canonical visual) | — | render `sentient-webui-design/project/Sentient Mobile.html` (serve locally, 390×844). PNGs are gitignored repo-wide (`*.png`) — regenerate on demand; local copies under `sentient-webui-design/anchors/` |

### Current mobile state (already built — being polished)

- iOS: `ios/App/Chat/{ChatView,MessageList,MessageBubble,Composer,SentientMark,SentientMarkAnim}.swift`, `ios/App/History/{HistorySheet,HistoryModel,HistoryRow}.swift`, `ios/App/Theme/{Tokens,Colors,Theme,MarkdownDuskTheme}.swift`.
- Android: `android/src/main/kotlin/io/sentient/android/chat/{ChatScreen,MessageList,MessageBubble,Composer,SentientMark,SentientMarkAnim}.kt`, `.../history/{HistoryDrawer,HistoryViewModel,HistoryRow}.kt`, `.../theme/{Tokens,Theme}.kt`.
- Shared: `shared/mobile-sdk/.../design/DesignTokens.kt`, `.../sdk/{SdkState,StateDeriver}.kt`, `.../connectors/{TaskStatusConnector,InFlightMessageConnector,ConversationHistoryConnector}.kt`.
- Both UIs bind one `StateFlow<SdkState>` and re-derive nothing. Tokens already bridge the Dusk palette/spacing/radius/type-scale/motion. The avatar mark is already a faithful 4-mode port. The prototype's token names (`--bg`, `--terra`…) match the SDK tokens.

## 2. Approach

**Chosen:** Extend the shared token layer, then polish each existing component to webui parity in place; add one bounded `StateDeriver` derivation for tool-pills. Preserves the single-`SdkState` surface, the mirrored-component architecture, and existing tests.

**Rejected:**
- *Rebuild from prototype JSX* — discards the faithful existing port + tests; the prototype is a React mock, not the real architecture.
- *Webview hybrid (render webui in a WebView)* — not native, loses the SDK binding, degrades feel/perf, breaks offline/lifecycle rules.

## 3. Foundation

### 3.1 Fonts (all three, both platforms)

Bundle and apply per webui roles:
- **Fraunces** (display) → brand wordmark, "Past chats" / section titles.
- **DM Sans** (UI) → body text, meta, controls.
- **JetBrains Mono** (mono) → tool `argsPreview` / code.

All OFL/Apache — free to bundle.

- **iOS:** add `.ttf` (or Fraunces variable) under the app, register in `Info.plist` `UIAppFonts`; add a `Typo` font-token layer (`Typo.display(size:)`, `.ui(size:weight:)`, `.mono(size:)`) used everywhere `.system(...)` is today.
- **Android:** add `res/font/*` + `FontFamily`; wire `Type.kt` (`MaterialTheme.typography`) + a `Fonts` token for non-typography uses.
- **Shared:** add font-family **name constants** to `DesignTokens.kt` (`Fonts.display/ui/mono`) so one source drives both platforms (mirrors webui `tokens/typography.css`).

### 3.2 Shared token additions (`mobile-sdk/DesignTokens.kt`)

- `Typewriter` object: `baseRate=30`, `minRate=15`, `maxRate=150`, `gapGain=0.02`, `sentencePauseMs=80`, `paragraphPauseMs=220` — transcribed from `gateway/webui/src/config/typewriter.ts`.
- `Motion.waveMs=3400` already present (reuse for speaking-wave + drives bubble + mark).
- No magic numbers in UI code; both platforms read these via the existing token bridge.

## 4. Behaviors (port webui logic → both platforms)

### 4.1 Typewriter-expand

Port `use-typewriter-buffer.ts`: a pure `time → visible` reveal engine layered on the SDK's streaming text.
- Buffer = `SdkState` streaming bubble content; `visible` = revealed prefix.
- rAF-equivalent loop (iOS `TimelineView(.animation)` / Android `withFrameNanos`), gap-driven rate: `rate = clamp(baseRate*(1+gap*gapGain), minRate, maxRate)`; on stream-complete drain at `maxRate`.
- Semantic pauses: hold `sentencePauseMs` after `.!?`+whitespace, `paragraphPauseMs` after `\n\n`.
- **Drop the ` ▍` block cursor** (webui has none). Empty-stream placeholder = existing 3-dot pulse.
- Bubble height grows by natural text reflow (no explicit height animation).
- **Layer:** UI presentation (the `StateDeriver` comment explicitly flags typewriter/cycleId-stamping as UI concerns) — lives in the app, reads `SdkState`. Reduced-motion: reveal whole text immediately.

### 4.2 Bubble speaking-wave + avatar ripple

- **Move the terra gradient sweep from the mark to the bubble** (absolute fill over the bubble text area, `z` below text), driven by the streaming assistant bubble in **speaking** mode. Keyframe = `Motion.waveMs` left-to-right sweep, matching `.bubble-speaking-wave`.
- **Add avatar ripple:** ring box-shadow + two phased (0 / +0.9s) expanding rings (`scale 1→1.8`, `opacity .7→0`, 1.8s) on the avatar when speaking/listening, matching `.avatar--running/--listening`. Currently missing on mobile.
- The mark keeps its own animated modes; the **wave belongs on the bubble** (per webui), not the mark. Reduced-motion: drop wave + ripple animation, keep static ring.

### 4.3 Autoscroll / follow-latest

Port `use-follow-latest.ts` pin-to-bottom semantics, replacing today's always-yank-to-bottom:
- Pinned = scroll position within an **8px snap zone** of the end.
- **Unpin only on a real user scroll-up** (offset decreased, content stable/growing) landing outside the snap zone — direction-based, to avoid the streaming-growth false-unpin race.
- **Re-pin** when back in the snap zone; **re-pin on content growth** while pinned; tolerate the inflight→committed **shrink** (don't unpin on clamp).
- `jumpToLatest()` affordance (smooth) when unpinned.
- iOS: scroll-offset tracking (`onScrollGeometryChange` iOS 18, GeometryReader/preference fallback iOS 17). Android: derive from `LazyListState` (last-visible index + offset / `canScrollForward`).

## 5. Components (webui parity, iOS + Android)

| Component | Change |
|---|---|
| **Topbar** | hamburger · centered brand (mark + Fraunces "Sentient") · **"+" new chat**. Move **settings into the drawer** account row (kept real, relocated). |
| **Bubble meta row** | Add `name · time` above the bubble. name = "Sentient" / user displayName (from auth profile); time = locale `HH:mm`. Currently absent on mobile. |
| **Day divider** | Add "Today · 7:42 AM"-style separators grouped by day (derive from `ts`). |
| **Tools strip** | Render `message.tools` as flush pills at the bubble bottom: status dot (queued / running-spinner / finished-ok / failed / cancelled) + mono toolName + expand chevron → inline `argsPreview` kv detail (expand up/down). Mirrors `tool-pill-strip.tsx` + `tool-inline-detail.tsx`. *(requires §6)* |
| **Composer** | radius 24; add **attach** button (noop) in the mic/tts/attach left group; **listening-waveform overlay** (11 animated bars + "Listening…") over the empty field when mic active; dynamic placeholder ("Type to interrupt…" while streaming, else "Message Sentient…"); restyle stop as a tinted square. Keep mic-permission gating + send/tts logic untouched. |
| **History → left panel** | iOS converts sheet → **interactive draggable snapping panel** (not a modal drawer component; see §5.1). Android keeps the native `ModalNavigationDrawer`. Account header (terra initial avatar + name + household + settings gear), search pill, Fraunces "Past chats" + uppercase day labels, title-only rows (active = `terra-50` bg + terra text), **"+" FAB**. `HistoryModel`/`HistoryViewModel` data + ops unchanged. |

### 5.1 History panel — interactive draggable snapping (mobile gesture)

The panel opens/closes by **side-swipe**, not only the hamburger. iOS is NOT a modal "drawer" component — it's an **interactive, draggable view that snaps** (the pattern production iOS apps like Claude/ChatGPT use; it feels native because the panel tracks the finger 1:1 and the release is velocity-driven + interruptible).

- **iOS — draggable snapping panel:**
  - Offset-driven: a leading **edge-zone `DragGesture`** (plus a drag on the open panel) updates the panel offset **1:1 in `onChanged`** for immediate feedback; rubber-band past the open/closed bounds.
  - **Snap decided by velocity:** on `onEnded`, project the landing with `DragGesture.Value.predictedEndTranslation` (velocity-aware) — a fast flick opens/closes even on a short drag; otherwise snap to the nearer edge.
  - **Interruptible release:** animate the snap with `withAnimation(.interactiveSpring(...))` (blends smoothly if the user re-grabs mid-animation). iOS 18+ exposes gesture `velocity` directly; `predictedEndTranslation` is the iOS 17 fallback.
  - Backdrop **scrim opacity tracks drag progress** (0→~0.5). Two snap points (closed / open); no detents.
  - **Scroll coexistence:** the chat scrolls vertically; the panel pans horizontally. Use the leading edge-zone + `DragGesture(minimumDistance:)` to disambiguate; fall back to a UIKit pan recognizer (`UIPercentDrivenInteractiveTransition`-style) only if SwiftUI gesture arbitration fights the `ScrollView`.
  - Optional reference lib: `FluidGroup/swiftui-snap-dragging-modifier` — prefer hand-rolled (no new dependency) unless it proves fiddly.
- **Android:** `ModalNavigationDrawer` `gesturesEnabled = true` already gives 1:1 swipe-to-open/close with native snap physics; verify edge-open doesn't fight horizontal content and the drag feels native (no extra work expected).

## 6. The one SDK touch (tool-pills)

`shared/mobile-sdk`:
- Add `cycleId: String?` + `tools: List<TaskSnapshotItem>` to `ChatMessage`.
- In `StateDeriver`: stamp `cycleId` on the in-flight bubble (from `InFlightMessage.cycleId`), retain it across the inflight→committed transition, and attach `SdkState.tasks` grouped by `cycleId` → `message.tools` (mirrors web-sdk `cycle-helpers.ts#attachToolsToAssistantMessages`).
- `TaskSnapshotItem` already matches web-sdk exactly (`taskId, toolName, cycleId, status, argsPreview, startedAtMs, endedAtMs`) — no change.
- **Bound:** the wire feed `ConversationFeedItem.Assistant` carries **no `cycleId`**, so **reloaded historical** assistant messages get no pills — same constraint as webui on reload (committed `ConversationFeedItem.Tool` entries remain on the wire). Live-session cycles get pills.
- **Test:** `StateDeriver` tools-attach test (FSM/contract — worth keeping per testing rule).

## 7. Out of scope (explicit)

- voice-inline "Spoken · 0:08" / replay tag — **mock-only**, not in real webui.
- design's inline "interrupted" pill — user said ignore; keep existing cutoff handling as-is.
- fake device chrome (status bar / dynamic island / home indicator) — real OS draws these.
- tool-pills on reloaded/historical messages (feed lacks `cycleId`) — flagged §6.
- any transport / session / audio-FSM / reconnect change — SDK owns these; untouched.

## 8. Per-platform file map (for the plan)

**Shared (`shared/mobile-sdk`):** `design/DesignTokens.kt` (fonts, typewriter), `sdk/SdkState.kt` (`ChatMessage` fields), `sdk/StateDeriver.kt` (cycleId stamp + tools attach), `+commonTest` StateDeriver tools test.

**iOS (`ios/App`):** `Theme/{Typo(new),Colors,Tokens,Theme}.swift`, `Chat/{ChatView,MessageList,MessageBubble,Composer,SentientMark,SentientMarkAnim}.swift`, new `Chat/{Typewriter,BubbleSpeakingWave,ToolPillStrip,FollowLatest}.swift`, `History/{HistorySidePanel(new draggable-snapping panel, replaces sheet),HistoryRow}.swift`, `Info.plist` (UIAppFonts), `project.yml` (font resources). Split any file approaching 300 lines.

**Android (`android/src/main/kotlin/io/sentient/android`):** `theme/{Type(new),Theme,Tokens}.kt`, `chat/{ChatScreen,MessageList,MessageBubble,Composer,SentientMark,SentientMarkAnim}.kt`, new `chat/{Typewriter,BubbleSpeakingWave,ToolPillStrip,FollowLatest}.kt`, `history/{HistoryDrawer,HistoryRow}.kt`, `res/font/*`.

## 9. E2E matrix (inline — mandatory per e2e rule)

Native UIs can't run under Playwright. The agent drives verification **fully agentically** (no human in the loop):

- **Android:** Android CLI (`adb`) + **Maestro** — boot/install via `adb`, drive flows with Maestro `.yaml` (`qa/android/charters/`), screenshot via `adb exec-out screencap` / Maestro `takeScreenshot`. The agent runs these end to end.
- **iOS:** iOS Simulator via `xcrun simctl` (boot, `io <udid> screenshot`) + **Maestro** (drives the iOS Simulator with the same flow shape). `qa/ios/charters/`.
- Capture **live screenshots** per case (under `.playwright-mcp/` / the feature screenshot dir — gitignored per repo policy) and **visually diff** against the rendered design (`sentient-webui-design/project/Sentient Mobile.html`, served locally) and webui.

**Cost policy (this stack):**
- **Text** chat against the local macOS stack (`deploy/macos`) is **free** — run text-path cases liberally (typewriter, tools, layout, fonts, history, autoscroll, day divider).
- **Voice** interaction is **allowed** for the voice-dependent cases (mic listening, speaking-wave, ripple) **only with short prompts that keep the assistant reply short** — bounds paid TTS/LLM. Never trigger long generations.
- Pi/production out of scope.

| Case | Platform/Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| Fonts applied | iOS 390×844, Android 393×851 | chat loaded | render idle chat | Fraunces brand/titles, DM Sans body, mono tool code; matches anchor | font load; no fallback warn |
| Chat idle | both | history loaded | render | bubbles (paper/sage), meta `name·time`, day divider, avatar mark idle | no streaming/cycle logs |
| Streaming + typewriter | both | send "hi" | assistant streams | text reveals at gap-rate w/ sentence pauses; height grows; pulse-dots before first token; **no cursor** | `cycle.started`; deltas; typewriter ticks |
| Speaking | both | TTS on, assistant speaks | observe streaming bubble | terra wave sweeps **bubble**; avatar ripple rings + ring glow | `isSpeaking=true`; audioState speaking |
| Tools pills | both | cycle w/ tools (live) | tap a pill | flush pills w/ status dots at bubble bottom; expand → `argsPreview` kv | `task.update` (queued→running→finished); tools attached by cycleId |
| Composer listening | both | mic on, field empty | observe | accent border, 11-bar waveform + "Listening…", placeholder hidden | `voiceMode=ACTIVE`; mic permission granted |
| Composer streaming | both | assistant streaming | observe | placeholder "Type to interrupt…"; tinted square stop shown | `canInterrupt=true` |
| History drawer (button) | both | chat | tap hamburger | left drawer slides in; account header + search + day groups + active highlight + "+" FAB; matches drawer anchor | `listSessions` |
| History drawer (edge-swipe) | both | chat | edge-swipe right / swipe-left to close | drawer drags in/out interactively w/ scrim; snaps by velocity | (gesture only) |
| New chat / settings relocation | both | drawer open | tap "+" / gear | new chat starts / settings opens from drawer | `newChat` / settings route |
| Autoscroll pin/unpin | both | long stream | scroll up mid-stream, then back | scroll-up holds position (unpinned); jump-to-latest / re-enter snap re-pins | follow-latest pin transitions |
| Empty + sad paths | both | no messages / interrupted reply | render | "Start a conversation…" empty state; cutoff marker on interrupted reply | empty; cutoff kind logged |

## 10. Risks / open items

- **Tool-pill historical parity** bounded by feed lacking `cycleId` (§6) — accepted; flagged for a future protocol pass if reloaded-history pills are wanted.
- **iOS interactive panel** is hand-rolled (no native left drawer) — a draggable view that snaps (velocity via `predictedEndTranslation`, interruptible `interactiveSpring`; §5.1). Verify gesture arbitration vs the chat `ScrollView` and the system back-edge swipe; UIKit pan hybrid is the fallback.
- **Typewriter vs SDK delta cadence** — ensure the UI buffer never lags far behind on long replies (drain-at-max covers stream-complete).
- **Font licensing/bundling size** — 3 families add app weight; Fraunces variable keeps it bounded.
