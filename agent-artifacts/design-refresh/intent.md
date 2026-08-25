# Intent: Complete WebUI and iOS design refresh

## Problem

Sentient's reachable WebUI and iOS surfaces currently use fragmented legacy styles, duplicated or page-local controls, static identity artwork, and platform implementations that do not consistently follow the reviewed Dusk material system and component prototypes.

## Desired Outcome

Every reachable WebUI and iOS surface uses one coherent design contract, platform-native primitive and composite libraries, the shared authored Rive identity, and faithful reviewed motion and effects while preserving established product, security, session, task, calendar, and persistence behavior.

## Scope — Included

- All reachable WebUI and iOS pages, navigation, drawers, overlays, menus, dialogs, sheets, states, and visible unfinished affordances
- All five reviewed prototypes under design/prototype: foundation components, common composites, chat message bubbles, chat composer, and calendar
- A versioned KMP v2 design contract for exact tokens, asset descriptors, motion, and effects, with generated Web projections and thin native iOS projections
- Native Preact/CSS and SwiftUI primitive, common-composite, and product-composite libraries with enforceable no-inline-hardcoded-component boundaries
- One shared Rive avatar asset and state machine for idle, thinking, responding, their interruptible transitions, and iOS startup readiness
- Encapsulated WebUI and iOS chat composers with internal microphone components supporting hold-to-talk, Auto toggle-to-talk, Send, and capture cancellation
- Additive capture-aware SDK, protocol, and gateway behavior required to discard canceled held speech safely
- Dynamic Type, zoom, keyboard, focus, screen-reader semantics, touch targets, and motion adaptations necessary for usable refreshed surfaces
- Removal of fabricated device telemetry and relocation of service implementation names to Diagnostics
- Android compile and old-client compatibility validation for shared KMP/protocol changes without Android visual implementation work

## Success Signals

- Every reachable WebUI and iOS surface is represented in the closed refresh inventory and uses the new component hierarchy
- Generated and native projections match the versioned KMP v2 design contract and exact locked values
- Static checks reject unauthorized design literals and raw visual controls outside approved component locations
- WebUI and iOS consume identical checksummed Rive runtime assets and map product state through thin adapters
- Text chat, navigation, representative settings, calendar, startup readiness, keyboard/zoom, and large Dynamic Type pass the approved critical-path matrix
- Voice capture contract tests prove Send, Cancel, Auto, stale-command isolation, and no submission from canceled captures without relying on automated audio E2E
- Structured visual review confirms prototype-faithful effects, motion, transition, shadows, highlights, responsive composition, and intentional native adaptations
- No production system, private content, raw audio, credentials, or network adapter is touched by verification

## Scope — Excluded

- Android visual refresh or edits to Android UI implementation files
- Production E2E, network-disruption or reconnection E2E, automated microphone/STT/TTS/audio E2E, and automated acoustic-quality validation
- New behavior for visible no-op or coming-soon controls
- Transport, session, authorization, storage, calendar-domain, recurrence, offline-policy, or settings-backend redesign except the approved capture-cancellation protocol extension
- Pixel-identical cross-platform rendering, light mode, speculative unused component families, and developer-only unreachable screens
- Raw audio, transcript, prompt, credential, secret, or private household-content logging or evidence

## Constraints

- DESIGN.MD is the durable design authority; reviewed prototype README and handoff files are scoped visual and interaction authorities
- All currently reachable surfaces must be covered; missing product-specific specimens are composed from approved primitives and common composites rather than left legacy or built inline
- WebUI and iOS share semantic contracts and authored assets but not UI implementation code
- Native iOS NavigationStack, navigation bars, sheets, alerts, menus, safe areas, and platform behavior remain authoritative
- Existing Android v1 design consumers remain behaviorally unchanged; shared additions are additive and compatible
- Startup thinking remains visible until resolved readiness and for at least 1500ms, but never hides actionable failure indefinitely
- Voice Cancel discards only the identified capture; it is distinct from assistant interruption and background-task cancellation
- Tasks produced later must cite exact authority paths, sections or symbols, relevant token/effect values, state contracts, and verification commands; 'match the design' alone is insufficient
- Agents must not manipulate Wi-Fi or local network connectivity for evaluation
