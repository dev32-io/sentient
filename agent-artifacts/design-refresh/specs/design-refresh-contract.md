# Complete design refresh product contract

## Context

Defines the observable refresh contract for every currently reachable WebUI and iOS surface. It adopts the reviewed prototypes without changing established domain ownership except for the explicitly approved startup, Rive identity, trust cleanup, and voice-capture cancellation behavior.

## Required Behaviors

- Every reachable WebUI and iOS surface adopts the new component hierarchy and Dusk material language; no reachable surface retains a parallel legacy visual system.
- Pages compose approved platform-local primitives, common composites, and product composites. They do not construct raw styled controls or use page-local color, type, radius, spacing, shadow, gradient, or motion literals.
- Product-specific surfaces not directly prototyped—including setup, voice management, model selection, tools, account, members, secrets, diagnostics, update, and permission flows—use the smallest applicable reviewed components while preserving their current domain behavior.
- WebUI and iOS implement UI natively in Preact/CSS and SwiftUI. iOS keeps native NavigationStack, navigation titles, back behavior, sheets, alerts, menus, safe areas, keyboard behavior, and platform accessibility semantics.
- All visible unfinished or no-op controls remain present, adopt the new visual system, and communicate unavailable or coming-soon state without gaining new behavior.
- The shared Rive avatar owns idle, thinking, responding, every ordered transition, interruption/redirection, startup thinking, and reduced-motion/static authored paths. WebUI and iOS consume identical runtime bytes through thin native wrappers.
- Streaming text and assistant speech both map to responding. Cognition, acting, processing, and startup readiness map to thinking. Voice capture never drives avatar mode.
- iOS cold startup shows thinking immediately and dismisses only after both 1500ms and resolved root readiness. Setup may reveal when configuration is ready; login may reveal when the initial user-list result is resolved; authenticated launch may reveal when the KMP session and chat shell can show usable content or actionable recovery. Failure is never hidden by an infinite animation.
- Chat Composer is an encapsulated product composite on each platform. Its internal Voice Capture Control owns the reviewed waveform-pod morph, aperture crown, Auto/Cancel/Send fanout, haptics, announcements, and interaction states.
- Pointer-down starts manual Hold immediately. Send is the default held-release consequence. Cancel and pointer/system cancellation discard. Quick activation enters Auto. Hold-to-Auto commits the held segment before opening semantic capture. Tapping active Auto finalizes the current semantic segment and returns idle.
- A canceled capture cannot produce a persisted user message, model turn, tool call, or TTS. Capture terminal outcomes are correlated and stale End/Cancel actions cannot affect a newer capture.
- Task activity remains server-owned full-state activity in the composer shelf and never moves into message bubbles. Foreground Interrupt does not imply background-task cancellation.
- Current message identity, optimistic send, session ownership, authorization, settings persistence, calendar projection/mutation, and security boundaries remain unchanged by visual composition.
- At larger Dynamic Type and 200% web zoom, critical text and actions reflow rather than clip. Native semantic controls, visible focus, keyboard operation, screen-reader labels, and at least 44pt iOS targets remain usable.
- The hardcoded Web device count is removed until real telemetry exists. Service implementation names and versions are available in Diagnostics but not ordinary household navigation.
- No automated evaluator manipulates Wi-Fi, local network adapters, or connectivity. Automated E2E remains text-only and excludes microphone, STT, TTS playback, and audio quality.

## Acceptance Criteria

- **AC-001:** All current RootView branches and authenticated iOS routes, and all current WebUI gates and authenticated routes/actions, are represented in a closed surface/state inventory with an approved authority or explicit intentional native adaptation.
- **AC-002:** Every inventoried reachable surface uses approved primitives/composites and exact semantic tokens; static checks find no unauthorized page-local visual controls or design literals.
- **AC-003:** The exact locked palette, type scale, line heights, spacing, radii, and motion roles are available from the versioned KMP v2 contract and projected without handwritten Web drift.
- **AC-004:** Material roles preserve the reviewed concave slate faces, wells, contact and directional casts, ember activity, pressed depth, focus treatment, state variants, and measured transitions rather than flattening them into generic dark controls.
- **AC-005:** WebUI and iOS package identical checksummed Rive runtime assets and expose the same idle/thinking/responding adapter contract.
- **AC-006:** Rive state changes always converge to the latest requested mode; startup enters thinking without an idle flash; asset failure leaves the product usable through a static canonical fallback.
- **AC-007:** iOS startup remains visible for at least 1500ms and until resolved readiness, then reveals the correct root surface or actionable failure.
- **AC-008:** Composer public APIs remain bounded; screens provide state and callbacks rather than reconstructing composer or microphone visuals.
- **AC-009:** Contract and integration tests prove manual Send, manual Cancel, Hold-to-Auto, Auto exit, first-terminal-wins, no-frames-after-terminal, stale capture isolation, and no conversational submission for canceled captures.
- **AC-010:** Existing Android UI files remain unchanged; Android and old-client compile/protocol compatibility checks pass for additive shared changes.
- **AC-011:** All approved text-only E2E cases pass on the real local stack without production access, network manipulation, private content, microphone use, or TTS playback.
- **AC-012:** Structured visual review covers every inventoried reachable surface and designated state at canonical Web viewports and iOS device/text-size configurations, recording intentional native deviations rather than relying on pixel-perfect E2E.

## Domain Language

- Design contract v2 is the platform-neutral KMP source for exact semantic tokens, asset descriptors, motion, effects, and stable component state vocabulary.
- Primitive is an indivisible visual control such as a button, icon button, field, textarea, slider, toggle, segmented control, chip, checkbox, avatar, plate, well, progress indicator, or divider.
- Common composite is a reusable platform-local combination such as a settings row, notice, async state, search/filter bar, PIN entry, validated field, dialog, or action row.
- Product composite is a behavior-rich platform-local component such as Chat Composer, Voice Capture Control, Message Bubble, Task Shelf, History Drawer, Calendar workspace, voice library, or setup wizard.
- Page owns route data and composition but does not construct visual controls or introduce design literals.
- Avatar mode has exactly three authored values: idle, thinking, and responding. Voice listening is composer state, not an avatar state.
- Hold is manual capture while physically pressed. Auto is persistent semantic toggle-to-talk. Send commits a held capture. Cancel discards a held capture.
- Capture Cancel discards only the identified microphone capture; assistant Interrupt stops foreground cognition/playback; background task cancellation is a separate capability.
- Ready means the active root can reveal usable content or an actionable failure/recovery state; it does not require network connectivity.
- Reachable surface means a user-visible page, pane, drawer, overlay, dialog, sheet, menu, control, or state reachable from current production entry points. Dormant unreachable exports are not acceptance targets.

## Actors

- Household member using WebUI
- Household member using iOS
- Household administrator using settings and protected management surfaces
- Keyboard, screen-reader, zoom, or larger-text user
- Operator maintaining platform-native component libraries and shared design assets

## Edge Cases

- A new avatar mode arrives during an in-progress Rive transition; the state machine exits and converges to the newest mode without replaying stale choreography.
- Rive cannot load; a static canonical mark and native semantic status remain available.
- Startup resolves quickly; thinking still remains for 1500ms. Startup cannot initialize a usable root; an actionable failure replaces the animation.
- A held gesture is canceled by pointer cancellation, view disappearance, permission failure, backgrounding, or disconnect; the capture is discarded locally and cannot later submit.
- Send, Cancel, and Auto terminal outcomes race; the first accepted outcome for the capture wins and later outcomes are no-ops.
- A stale terminal frame arrives after a newer capture begins; capture identity prevents it affecting the new capture.
- Cancel occurs after microphone press already interrupted assistant output; canceled user speech is discarded but the prior assistant response is not restored.
- A visible no-op control is encountered; it remains visibly intentional and nonfunctional rather than silently disappearing or pretending success.
- Large text, long labels, keyboard visibility, narrow screens, and iPad widths force reflow; essential actions remain reachable and sheets scroll their body while keeping actions available.
- A product-specific current state has no dedicated prototype specimen; it adopts the nearest semantic primitive/composite and records any native adaptation instead of retaining legacy styling.

## Out of Scope

- Android visual implementation and screenshot parity
- Automated voice, microphone, STT, TTS, AEC, acoustic, or audio-route E2E; voice end-to-end acceptance is user-owned
- Reconnection and network-disruption E2E or any Wi-Fi/network-adapter manipulation
- Light mode and pixel-identical cross-platform rendering
- New behavior for notifications, attachments, Voice Print, or other visible unfinished affordances
- Speculative unused composite families and unreachable developer/debug surfaces
- Production mutation or smoke testing
