# Complete design refresh critical-path E2E matrix

## Cases

### E2E-001 — Web household member authenticates and navigates the refreshed shell and History.

**Classification:** golden-path

#### Setup

- Start the stable real local stack without modifying network connectivity.
- Use a provisioned disposable account and a clean browser profile.

#### Actions

- Authenticate through the current user and PIN flow.
- Navigate Chat, Calendar, and Settings.
- Open and close History.
- Create a new chat and restore the prior chat.

#### Expected Outcomes

- Every visited route and state uses the refreshed component system.
- Route state, drawer dismissal, new-chat behavior, and prior-session restoration remain coherent.

#### Evidence

- Accessibility snapshots and sanitized desktop and narrow screenshots.
- Route and session observations referenced against gateway/webui/src/app.tsx, gateway/webui/src/components/shell/, and gateway/webui/src/components/sessions/.

#### Safety

- Never discover, brute-force, or record credentials.
- Remove disposable session state after the case.
- Do not manipulate Wi-Fi, network adapters, or connectivity.

### E2E-002 — Web household member completes and interrupts a text-only assistant conversation.

**Classification:** golden-path

#### Setup

- Use a disposable conversation and deterministic text response on the stable local stack.
- Keep microphone and TTS playback disabled.

#### Actions

- Send text through the composer.
- Observe the user message, thinking, responding, task shelf, and completed response.
- Interrupt an active text response.

#### Expected Outcomes

- Exactly one user message and corresponding assistant response appear without duplicate projection.
- Rive state progresses through the correct text-driven states and returns to idle.
- Streaming text remains durable and unclipped.
- Task activity remains in the composer shelf and never appears as a message-bubble tool pill.
- Text-response interruption returns the composer to an idle usable state without implying background-task cancellation.

#### Evidence

- Sanitized state-transition evidence and screenshots that contain only disposable test text.
- Source references: gateway/webui/src/components/chat/, gateway/webui/src/components/dock/, design/prototype/chat-message-bubbles/, and design/prototype/chat-composer/.

#### Safety

- Use a read-only disposable prompt and delete the session afterward.
- Do not activate microphone, STT, TTS playback, or audio capture.

### E2E-003 — Web household member changes and restores one harmless setting.

**Classification:** golden-path

#### Setup

- Record the original value of one harmless setting.
- Use the stable local stack and an authenticated disposable browser profile.

#### Actions

- Change the setting.
- Apply the change.
- Reload and verify persistence.
- Restore the original value.

#### Expected Outcomes

- Dirty, applying, and success states use refreshed components.
- The changed value survives reload.
- The original value is restored at case completion.

#### Evidence

- Request result, visible apply state, and sanitized screenshots.
- Source references: gateway/webui/src/components/settings/settings-view.tsx and gateway/webui/src/components/settings/apply-bar/.

#### Safety

- Do not assert or play audio even if the representative setting belongs to Audio.
- Always restore the original value.
- Do not manipulate network connectivity.

### E2E-004 — Web household member uses the refreshed Calendar and manages one disposable event.

**Classification:** golden-path

#### Setup

- Provision a disposable local calendar fixture and unique event identity.

#### Actions

- Visit Day, Week, Month, and Year views.
- Apply representative filters.
- Create, preview, edit, and delete one disposable event.

#### Expected Outcomes

- All Calendar views and overlays use the refreshed composition and remain reachable.
- The disposable event is created, visibly updated, and removed successfully.

#### Evidence

- Calendar request results, sanitized screenshots, and final fixture state.
- Source references: gateway/webui/src/components/calendar/ and design/prototype/calendar/.

#### Safety

- Use only a unique disposable event.
- Always delete fixture data during cleanup.
- Do not touch production calendars.

### E2E-005 — Keyboard and enlarged-content user operates critical refreshed WebUI surfaces.

**Classification:** edge

#### Setup

- Use the stable local stack at approved desktop and narrow viewports.
- Set browser zoom to 200 percent.

#### Actions

- Navigate the shell, History drawer, text composer, one representative dialog, Settings, and Calendar using the keyboard.
- Exercise Enter and Shift+Enter in the text composer.
- Dismiss overlays and return focus to their invoking controls.

#### Expected Outcomes

- Focus remains visible and follows a usable order.
- Dismissed overlays restore focus appropriately.
- Essential actions remain reachable with no page-level horizontal overflow.
- Enter sends text and Shift+Enter inserts a newline.

#### Evidence

- Accessibility tree, focus trace, overflow measurements, and sanitized screenshots.
- Source references: DESIGN.md and all reviewed handoffs under design/prototype/.

#### Safety

- Restore browser zoom and close overlays after the case.
- Do not activate voice controls or manipulate network connectivity.

### E2E-006 — iOS household member cold-launches and navigates the refreshed native shell.

**Classification:** golden-path

#### Setup

- Use the stable local stack and an authenticated disposable simulator fixture.
- Cold-launch the local debug app without changing network state.

#### Actions

- Observe the startup thinking identity.
- Wait for healthy readiness resolution.
- Open History and create a new chat.
- Open Settings and navigate back using native navigation.

#### Expected Outcomes

- Thinking is visible immediately, remains for at least 1500ms, and remains until healthy readiness resolves.
- The correct root surface is revealed without an idle flash.
- Native navigation, back behavior, and the refreshed History drawer remain usable.

#### Evidence

- Timestamped screen recording, sanitized screenshots, and navigation assertions.
- Source references: ios/App/RootView.swift, ios/App/SplashOverlay.swift, ios/App/Nav/UserSessionHost.swift, and ios/App/Chat/drawer/SideDrawer.swift.

#### Safety

- Use the local simulator only.
- Do not interrupt or manipulate network connectivity.

### E2E-007 — iOS household member completes and interrupts a text-only conversation.

**Classification:** golden-path

#### Setup

- Use a disposable local conversation and deterministic text response.
- Keep microphone and TTS playback inactive.

#### Actions

- Send a text message.
- Observe queued-to-echo reconciliation, thinking, responding, task shelf, and completion.
- Interrupt an active text response.

#### Expected Outcomes

- The optimistic message reconciles without duplicate visible messages.
- Rive state reflects text-driven thinking/responding and returns to idle.
- Task activity remains outside message bubbles.
- The composer remains usable after interruption.

#### Evidence

- Maestro assertions, sanitized screenshots, and sanitized state transitions.
- Source references: ios/App/Chat/ and shared mobile message projection/outbox code.

#### Safety

- Use text-only read-only prompts and reset the disposable session.
- Do not use microphone, STT, TTS playback, or network manipulation.

### E2E-008 — Larger-text iOS household member uses refreshed native Settings.

**Classification:** edge

#### Setup

- Set the simulator to one representative accessibility Dynamic Type size.
- Record the original value of one harmless setting.

#### Actions

- Traverse grouped Settings navigation.
- Change, save, and restore the representative setting.
- Open one representative native sheet and alert.

#### Expected Outcomes

- Essential text and actions reflow without clipping.
- Native navigation, back behavior, sheet actions, and alert actions remain reachable.
- The setting persists and is restored.

#### Evidence

- Maestro assertions and reviewed sanitized screenshots.
- Source references: ios/App/Theme/Typo.swift, ios/App/Settings/, and DESIGN.md.

#### Safety

- Restore the simulator text size and original setting.
- Do not play audio or manipulate network connectivity.

### E2E-009 — iOS household member uses the refreshed native Calendar and manages one disposable event.

**Classification:** golden-path

#### Setup

- Provision a disposable local calendar fixture and unique event identity.
- Use a stable simulator locale, time zone, and text-size configuration.

#### Actions

- Visit Day, Week, Month, and Year views.
- Apply representative filters.
- Create, preview, edit, and delete one disposable event.

#### Expected Outcomes

- Native sheets and date controls remain reachable.
- The refreshed Calendar composition matches the reviewed interaction contract.
- The disposable event is created, visibly updated, and removed successfully.

#### Evidence

- Maestro assertions, sanitized screenshots, and final fixture state.
- Source references: ios/App/Settings/Calendar/ and design/prototype/calendar/.

#### Safety

- Restore simulator state and remove the fixture event.
- Never access production calendar data.

## Scope

- Text-only critical user journeys across the refreshed WebUI and iOS clients on the stable real local stack
- Authentication, shell/navigation, History, text conversation lifecycle, representative settings persistence, Calendar CRUD, Web keyboard/zoom, iOS startup readiness, and iOS large Dynamic Type
- Functional and user-visible behavior only; exact visual fidelity is reviewed separately

## Safety

- All E2E uses the stable real local stack; production testing is prohibited.
- E2E remains text-only. Agents do not test microphones, STT, TTS playback, AEC, acoustic quality, or audio routes.
- Agents do not toggle Wi-Fi, network adapters, or connectivity and do not run reconnection/network-disruption tests.
- Voice control end-to-end behavior is user-owned. SDK/protocol/gateway capture semantics are verified with lower-level contract and integration tests.
- Exact shadows, gradients, typography, motion, and Rive fidelity use structured visual review rather than pixel-perfect E2E.
- Token freshness, Rive byte identity, component boundaries, and prohibited literals use static and contract checks.
- Every settings pane and uncommon state uses the closed reachability/state inventory plus component previews and targeted tests rather than bespoke E2E.
- Android receives compile and compatibility checks only; no visual evaluation or Android UI edits.
- Evidence contains no private household content, secrets, credentials, raw audio, transcripts, or production data.
