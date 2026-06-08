# Mobile Chat — Live Render + Bug-Cluster Fixes (Design)

Date: 2026-06-07 · Branch: `feature/mobile-client` · Platforms: iOS + Android (KMP shared)

Five defects on the native chat surface, diagnosed with runtime evidence. All fixes are **client-side** (no gateway/Hermes protocol change). Each is independently verifiable; sequence in the plan.

---

## Context

The in-flight assistant bubble path is: `SDK events → ChatRepository.reduce → liveState → ChatModel → bubble`. Most of the live-render machinery already exists; the defects are runtime interplay bugs, not missing features. Evidence captured on iPhone 14 Pro (iOS 26.5) sim + the local Docker stack via `log stream`.

---

## Bug 4 — Live text + tool pills don't render during the stream (PRIMARY)

**Evidence (one cycle):**
```
20:42:27.120  cycle.started cycle-1   → cognition IDLE→THINKING
   (8.6s of "...")
20:42:35.759  message.delta cycle-1  delta="<entire answer>"   ← ONE delta = whole answer
20:42:35.761  cycle.completed cycle-1 → cognition THINKING→IDLE  (2ms later)
```

**Root cause (two compounding):**
1. Gateway/Hermes emits the full answer as a **single `message.delta` ~2ms before `cycle.completed`** (Hermes emitted one `text.delta`). Nothing arrives incrementally.
2. The client never animates even that single delta: `ChatRepository.liveState` is a conflating `MutableStateFlow` and `chatStream` is `combine(...)` (also conflating). The `MessageDelta→live=full` state is overwritten by `MessageCommitted→live=null` (2ms later) and conflated away before the UI renders it. iOS *has* a typewriter (`StreamingText`), but only `streaming==true` bubbles use it; committed bubbles render full Markdown instantly. There is **no drain** (webui keeps a typewriter-fed bubble post-commit until the reveal catches up). Violates the project rule *"NEVER stream deltas over a StateFlow — conflation drops tokens."*

**Scope decision:** client-side only, mirror webui. NOT changing the gateway to token-stream (out of scope; webui has the same batched delta + 8.6s think today).

**Fix design (mirror webui):**
- **No-loss live state.** Don't let the populated live bubble + task updates be conflated away. The no-loss guarantee must reach the UI, not die at the `StateFlow` boundary (per `coroutines-flow-surface` + `repositories` rules).
- **Reveal keyed by `cycleId` that survives the live→committed swap (drain).** A typewriter buffer reveals the cumulative content at a rate (webui: ~30 ch/s, adaptive 15–150, sentence/paragraph pauses); the bubble renders the *revealed substring*. On `MessageCommitted`, do **not** drop the bubble + show full committed text — continue revealing the same text (matched by `cycleId`) until `visible ≥ full`, then settle. Recently-finished cycle reveals; older history renders instant.
- **Live tool pills** ride the same no-loss live state — `task.update` arrives mid-cycle (running→finished); once delivery isn't conflated, pills appear/update live on the in-flight bubble.

**Placement (resolve in plan, recommendation):** put the reveal+drain state in **`mobile-data` commonMain** (a session-scoped reveal ticker folded into the live state, clock-injected for tests) so iOS + Android share it and it is unit-testable — mirroring webui's `use-typewriter-buffer` hook. Per-platform bubble renders `live.visibleContent`. Alternative: per-platform VM ticker (duplicated, harder to test).

---

## Bug 3 — In-flight bubble chrome: 1969 date + spurious separator, missing ring

**Root cause A (date/separator):** the live bubble is stamped `ts = 0` in `ChatRepository.reduce` (`MessageStarted`/`MessageDelta`). `ts=0` = Unix epoch → rendered in UTC-8 as **"WEDNESDAY · 4:00 PM"** (1969-12-31). `DayDivider` + `MessageMeta` faithfully render epoch. (Note a second, dead in-flight path exists: `StateDeriver.deriveTimeline` passes `inflight=null`, so its `ts=nowMs` branch never runs — two mechanisms, one dead, one buggy.)

**Root cause B (no ring):** the avatar ring is `AvatarRipple(active: avatarMode != .idle)`; for a streaming bubble `avatarMode = markModeOfConnection(connection)`. `ConnectionState` (`deriveConnection`) projects only the **voice axis** (`isSpeaking`/`audioState`/`voiceMode`) and drops the `cognition` slice. A text response has no voice signal → `.idle` → no ring during the 8.6s think.

**Fix design:**
- Streaming bubble renders **no day-divider and no timestamp**; the timestamp appears only on commit (committed entry carries the authoritative server `ts`). Make `streaming==true` rows divider-exempt + time-hidden (drop the `ts=0` stamp; treat streaming as "no time yet").
- Surface **cognition (THINKING/ACTING)** into `ConnectionState` so `markModeOfConnection` drives the ring during the think (mirrors web-sdk's `CognitionState`→avatar). Fixes the dead "..." period for text + voice responses.

---

## Bug 5 — WS auth rejection leaves a usable, typable chat (SECURITY/UX)

**Root cause:** `RootView` gates on `hasToken` (HTTP-login token presence) per the `mobile-navigation` rule (gate on auth, not transport, so a drop keeps you in chat with a banner). But a **terminal WS auth rejection** (`auth.error` code `auth-required` / `token-validation-failed` / `user-not-found`) is mapped to a retryable connection error (reconnect loop), so the user sits in a typable chat that can never authenticate (`send.optimistic` queues forever).

**Fix design:** in the SDK orchestrator, classify a terminal WS auth rejection as a terminal auth failure (set `authExpired`-style state) rather than looping reconnect — clears token → routes to login with an error. Keep the existing transient-drop behavior (banner, stay in chat) unchanged; only **terminal auth** bounces. Defensive/edge severity: in normal signed operation the token persists and WS auths; the keychain artifact (below) exposed the gap.

> The runtime trigger that surfaced this was a test-harness artifact, not a product bug: building the sim app with `CODE_SIGNING_ALLOWED=NO` stripped the keychain entitlement → `errSecMissingEntitlement (-34018)` on token save/load → empty token → WS auth rejected. The signed build authenticates fine. The gate weakness is still real and worth fixing.

---

## Bug 2 — Composer text not clearing on send (rare)

**Root cause:** `Composer.submit()` sets `draft = ""`, but a focused `TextField(axis: .vertical)` (multiline) can fail to redraw on the binding clear until a focus change (SwiftUI multiline/IME race) — the text lingers until the user taps away (resign → re-sync). State is correct (message sent); only the render is stale.

**Fix design:** make the clear reliable — candidate: resign focus on send, or clear on the next runloop tick, or a field-id bump. Pick the minimal robust option in the plan. iOS-only; confirm the Android composer is unaffected.

---

## Bug 1 — Drawer drag broken (rebuild on a SwiftUI foundation)

**Root cause (confirmed):** the recent UIKit native drawer (`SideDrawerController`, commit `92293a9`) resets the drawer position on **every layout pass** — `viewDidLayoutSubviews` sets `drawerLeading.constant = isOpen ? 0 : -width`. SwiftUI churns layout during the gesture (`SideDrawer.updateUIViewController` reassigns both hosted `rootView`s on every `ChatView` re-render — frequent during a live session), so the in-progress drag offset is overwritten back to the static `isOpen` position. Open-drag jumps; close-drag (`isOpen==true`) snaps back open on every layout pass → backward-drag is impossible.

**Fix design (Approach 1, researched — see Sources):** rebuild drawer **rendering in SwiftUI** (`.offset(x:)` driven by `@State`/`@GestureState` — layout passes can't clobber SwiftUI state), with a thin **`UIPanGestureRecognizerRepresentable`** (iOS 18) for the drag whose `Coordinator` conforms to `UIGestureRecognizerDelegate`:
- `gestureRecognizerShouldBegin`: horizontal-dominance gate by **translation** (not the begin-velocity the old code used, which is ~0 at begin → the close-gate bug) so the panel's vertical scroll passes through.
- `shouldRecognizeSimultaneouslyWith`: coexist with the inner list scroll.
- Edge recognizer (open) + drawer/dim pan (close) both drive the same SwiftUI offset; **velocity** snap on end via `withAnimation(.snappy)`.
- Delete `SideDrawerController` + the `SideDrawer` `UIViewControllerRepresentable`. Keeps the only genuinely-UIKit-needed bit (the gesture delegate) as a ~30-line bridge.

**Decision:** bump deployment target **iOS 17.0 → 18.0** (`ios/project.yml`) — `UIGestureRecognizerRepresentable` is iOS 18+.

Sources: [Swift with Majid — UIGestureRecognizerRepresentable](https://swiftwithmajid.com/2024/12/17/introducing-uigesturerecognizerrepresentable-protocol-in-swiftui/) · [Apple docs](https://developer.apple.com/documentation/swiftui/uigesturerecognizerrepresentable) · [danielsaidi — complex gestures in a ScrollView](https://danielsaidi.com/blog/2022/11/16/using-complex-gestures-in-a-scroll-view).

---

## Out of scope

- Gateway/Hermes token-by-token streaming (true "first char early" instead of an 8.6s think then animate). Webui has the same batched delta today; revisit separately if desired.
- Durable outbox/cache. Drawer drag-to-open from beyond the screen edge.

## Cross-cutting decisions

- iOS deployment target → 18.0.
- Live-render reveal/drain state lives in `mobile-data` commonMain (cross-platform, clock-injected, unit-tested), unless the plan finds a blocker.

## Risks

- Live-render touches `mobile-data` (shared) → re-test Android too; rebuild the KMP XCFramework before iOS sim testing (stale/unsigned framework caused the earlier auth red herring).
- iOS 18 bump: confirm the user's device is on 18+ (confirmed: yes).
- Drawer rebuild deletes a recently-added component; ensure history-panel open/close/select/settings paths still work.

## E2E matrix (inline — per `e2e-testing` rule)

| Case | Platform | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| Live typewriter | iOS+And | READY | Send "write 3 sentences" | `"..."` then text reveals progressively; no jump to committed | `cycle.started`→`message.delta`→`cycle.completed`; reveal advances over time |
| Live tool pill | iOS+And | READY | Send a web-search prompt | pill appears `running`→`done` on the in-flight bubble | `task.update running`→`task.update finished` mid-cycle |
| Think ring | iOS+And | READY | Send anything | avatar ring animates during `"..."` | cognition `IDLE→THINKING→IDLE` |
| No-1969 divider | iOS+And | READY | Observe in-flight bubble | no date separator, no timestamp until commit | live ts not rendered; timestamp appears post-commit |
| Auth-terminal | iOS+And | token rejected at WS (terminal) | connect | error shown, routed to login (not a typable chat) | `auth.error` → terminal → token cleared → login |
| Transient drop | iOS+And | READY then WS drop | drop | stays in chat with reconnect banner (unchanged) | `status→RECONNECTING`; no token clear |
| Composer clear | iOS | focused, text typed | Send | field clears immediately; focus per design | `send.optimistic`; draft empty |
| Drawer open-drag | iOS | chat, closed | left-edge swipe, partial + release | drawer tracks finger; <50% & slow → snaps back closed; >50% or fast → opens | offset follows finger; velocity snap; no layout reset |
| Drawer close-drag | iOS | drawer open | drag drawer left, release | drawer tracks finger leftward; snaps closed | offset follows; close settles; inner list still scrolls vertically |
| Drawer scroll coexist | iOS | drawer open | vertical scroll inside panel | list scrolls; drawer does not move | scroll gesture wins (horizontal gate rejects) |
