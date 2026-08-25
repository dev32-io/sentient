# Complete design refresh architecture

## Design Goal

Create one durable semantic and visual source with independently native WebUI and iOS component systems, an authored cross-platform identity asset, and bounded behavioral extensions required by the reviewed composer.

## Chosen Approach

- Authority order is DESIGN.md; the additive KMP v2 design contract; reviewed README/handoff files under design/prototype; current production domain/security behavior; then explicit platform-native adaptation. Prototype CSS/JS is reference material, not a production dependency.
- KMP v2 owns exact platform-neutral tokens, units, asset descriptors, motion/effect definitions, component-state vocabulary, contract version, and hash. Generate checked Web CSS/TypeScript projections and use thin Swift adapters. Existing Android v1 imports and UI remain unchanged.
- Locked colors are bg #2B2621, elevated #332D28, sunk #241F1B, paper #39322C, lines #4A4138/#3E362F, ink #F2E8D6/#D7C6AB/#9E907E/#706456, ember #F2A06A/#5A3A28/#402C22, amber #E9B168, sage #B9C8A6, sage-soft #3A4232, clay #9A5A3E, ok #5F8A5B, warn #C2892F, and stop #B8442E.
- Locked scales are typography 11/12.5/15/18/22/44; line heights 1.25/1.55/1.6; spacing 4/8/12/18/26/32/40; radii 8/12/18/26 plus genuine pills; direct feedback 150ms; surface/state changes 250ms; responding cadence 1.55s. Exact material recipes start at design/prototype/foundation-components/sentient-components.css and later tasks must quote task-relevant recipe values and sections.
- Build platform-local adapters, primitives, applicable common composites, product composites, then pages. Pages may use structural containers and native route/navigation composition but may not create styled controls or introduce unauthorized design literals. Route-specific geometry must be named and derived from the contract.
- Maintain a closed reachability/state inventory rooted at gateway/webui/src/app.tsx and at ios/App/RootView.swift, ios/App/Nav/UserSessionHost.swift, and ios/App/Nav/Route.swift. Every entry maps to a prototype authority, DESIGN.md, or an explicit native adaptation. Migrate reachable legacy systems rather than running old and new skins together.
- Use static analysis and CI allowlists to constrain raw controls and design literals to approved component locations. Generated artifacts are freshness-checked rather than hand-edited.
- Use one repository-governed Rive authoring source and one checksummed .riv runtime artifact. Rive owns idle/thinking/responding artwork, all ordered and interruptible transitions, entry/exit poses, startup thinking, and authored reduced-motion/static paths. Thin Web and iOS wrappers own semantic mapping, sizing, lifecycle, native labels, and static fallback. Existing SVG/JS artwork becomes migration reference and authority documents are updated.
- Keep Rive limited to authored identity assets. All interactive application UI—including composer, microphone, bubbles, navigation, settings, and Calendar—remains native Preact/CSS or SwiftUI.
- Implement additive capture-aware voice semantics: audio.start(captureId, manual|semantic), audio.end(captureId) commits, and audio.cancel(captureId) discards. Manual STT output is gated until commit; first terminal outcome wins; stale IDs cannot affect newer captures; no binary follows End/Cancel; Cancel is mediated per authenticated connection/attachment and is never authority by itself.
- Preserve old-client behavior temporarily when captureId is absent for existing start/end. New Cancel requires an ID. Android continues its existing visual and voice path while shared compile/protocol compatibility is verified.
- Remove fabricated device telemetry and keep implementation service names in Diagnostics rather than ordinary household navigation. Preserve visible unfinished controls as intentionally unavailable without implementing their future behavior.

## Verification Boundaries

- Critical-path E2E is text-only and uses artifact:design-refresh-e2e. No evaluator manipulates Wi-Fi/network adapters or runs microphone, STT, TTS playback, acoustic, or audio-route E2E.
- Contract and static checks prove exact tokens, generated freshness, KMP/iOS/Web version/hash agreement, prohibited literals, and component-location boundaries.
- Voice reducer, SDK, protocol, gateway, STT-session, ordering, race, and integration tests prove Send, Cancel, Auto, first-terminal-wins, no-frames-after-terminal, stale isolation, and no submission from canceled captures. Voice end-to-end acceptance remains user-owned.
- Rive checksum, adapter names, state mapping, transition interruption, lifecycle, fallback, and startup-clock behavior are proven through asset/adapter/state-machine tests plus structured visual review.
- A closed surface/state inventory and structured screenshots/previews cover every reachable surface at canonical Web viewports and iOS device/text-size configurations; intentional native deviations are recorded rather than pixel-compared.
- Existing Calendar suites continue to prove recurrence, DST, conflict, isolation, and offline behavior; refresh E2E covers representative visible navigation and CRUD only.
- Android compilation and shared regression tests prove additive compatibility without Android visual work.
- All evidence is local, sanitized, disposable, and production-free.

## Components and Interfaces

- Platform adapters project KMP v2 values into generated Web CSS/TypeScript and Swift design types.
- Foundation primitives include plates/wells, action and icon buttons, inputs, selection controls, progress/divider, Sentient identity, and user avatar.
- Common composites include native page/pane chrome, settings rows, validated/secret fields, identity/PIN entry, search/filter compositions, notices/async states, dialogs/sheets/alerts/menus, and staged save/apply feedback where currently used.
- Chat Composer owns DraftEditor, TaskShelf, ComposerActions, and internal VoiceCaptureControl. VoiceCaptureControl owns the reviewed waveform-pod morph, Auto/Cancel/Send crown, target geometry, haptics, announcements, and gesture state while rendering authoritative SDK talk state.
- Message Bubble owns role rhythm, grouping, Markdown, streaming growth, interruption presentation, and Rive placement. Tool activity remains outside bubbles in the server-owned composer task shelf.
- History Drawer remains product-specific but uses reviewed primitives, explicit dismissal, and native focus behavior.
- Calendar retains its reviewed complete workspace, views, filters, dense-day behavior, preview/editor overlays, and native platform adaptation without reopening domain contracts.
- Setup, voice library, models, tools, account, members, secrets, diagnostics, update, and permission flows are product compositions built from the shared layers.
- iOS keeps native NavigationStack, navigation bars, back behavior, sheets, alerts, menus, safe areas, keyboard behavior, scrolling, and platform semantics.

## Data and Control Flow

- Startup prebinds the Rive avatar to thinking before first visible rendering. The static launch screen matches its first frame. Dismiss only when elapsed time is at least 1500ms and active-root readiness is resolved; reveal setup, login success/empty/actionable failure, or authenticated usable/actionable-recovery content. Never mask failure indefinitely.
- Avatar mapping is exactly idle, thinking, and responding. Cognition/acting/processing/startup use thinking; streaming text and assistant speech use responding; voice capture does not drive avatar mode. New state requests interrupt and converge without stale choreography.
- Voice pointer-down begins manual Hold. Send is the default release and commits. Cancel and pointer/system cancellation discard. Quick activation enters Auto. Hold-to-Auto commits the manual segment then opens fresh semantic capture. Active Auto finalizes its current semantic segment and exits when activated again.
- The UI emits semantic intents; KMP/SDK owns talk authority; serialized uplink stops before End/Cancel; gateway attributes delayed STT events to capture IDs and never submits uncommitted or canceled manual output.
- Capture Cancel stops only identified user input. Assistant Interrupt remains foreground cognition/playback cancellation; background task cancellation remains separate. Cancel cannot restore assistant output already interrupted at mic onset.
- Existing session, message, task, settings, authorization, Calendar, optimistic-send, and recovery flows continue through the refreshed components without UI ownership moving into pages.

## Failure and Recovery

- Rive load failure renders the static canonical identity and preserves native semantic status without blocking the app.
- Startup failure reveals actionable recovery after the 1500ms floor rather than animating indefinitely; readiness does not require successful network connectivity.
- Capture start failure returns to idle and preserves the text draft. Permission denial remains platform-native.
- Cancel stops locally even if transport disappears and is never replayed. Disconnect, backgrounding, permission loss, or view disappearance during Hold resolves locally as canceled/failed and requires a new capture ID.
- Canceled captures produce no store entry, model turn, tool call, TTS, or late barge-in. Duplicate or stale terminal outcomes are no-ops.
- At larger Dynamic Type and 200% Web zoom, critical content reflows; native actions, focus, labels, targets, and sheet controls remain reachable. Reduced Motion uses immediate/static authored states.
- Logs use identifiers, types, sizes, transitions, and sanitized reasons only; never raw audio, transcript, message, prompt, secret, or credential content.

## Alternatives Considered

- Native Core Animation or SwiftUI avatar recreation was rejected because it duplicates choreography and prevents one quickly swappable authored source across Web and iOS.
- Traditional Lottie was rejected because host code would own complex transition sequencing; Rive better fits authored interruptible all-pairs transitions.
- WKWebView animation rendering was rejected as an inappropriate native runtime and memory boundary.
- Changing KMP v1 tokens in place was rejected because it would silently alter Android; additive v2 preserves compatibility.
- Buffering an entire held utterance locally was rejected because it adds memory/backpressure and delays STT; streamed manual capture with a gateway commit gate preserves latency and makes Cancel safe.
- A visual-only Cancel was rejected because current audio.end finalizes and may submit speech.
- Exhaustive pixel-oriented E2E was rejected; closed inventory, contracts, static analysis, and structured visual review provide appropriate evidence.
