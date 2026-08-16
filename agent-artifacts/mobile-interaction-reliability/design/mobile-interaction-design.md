# Mobile interaction reliability design

## Design Goal

Preserve shared mobile authority and current native design language while making conversation, voice, scrolling, filtering, and navigation behavior explicit and testable without user-assisted workflow execution.

## Chosen Approach

- Replace the overloaded nullable conversation target with explicit shared operations for lifecycle attach/resume, opening an existing conversation, and user-requested New Chat. Carry explicit intent from every native New Chat entry point through the mobile-data boundary to the SDK's existing explicit session.new protocol path.
- Keep TalkModeController as voice semantic authority. Repair native gesture synchronization and shared command-lane interaction so interrupt-induced transient state cannot cancel a pending Idle-to-Hold transition, while genuine external teardown still resets safely.
- Replace follow-latest scrolling with a one-shot send-anchor command keyed by stable pending/message identity. Preserve initial history positioning but remove every assistant-content, token-growth, TTS, and tool-driven scroll trigger.
- Add an SDK-owned MicLevelMeter in commonMain. Existing platform capture paths feed it the same post-conversion, post-gain PCM frames already destined for uplink. It computes RMS, applies shared floor/ceiling normalization and attack/release smoothing, and shifts one bounded value into a rolling 32-value envelope.
- Expose the envelope as a latest-value StateFlow through VoiceAudio, SentientSdk, and ChatComponent. Native ViewModels and UI consume this signal only; PCM remains contained inside the SDK capture/uplink layer.
- Retain the existing waveform composition and visual tokens. Replace its autonomous placeholder pulse driver with the 32 envelope values while preserving the 32 bars, sine contour, full-composer placement, spacing, colors, silence baseline, motion character, and reduced-motion treatment.
- Mirror web Fish facet bucketing, matching, sorting, selection, and reset semantics in mobile state while rendering with existing native settings controls and design tokens.
- Make navigation history authoritative. Parent categories, result pages, and transient editors remain actual stack entries with route-scoped state; all back affordances pop exactly one entry.

## Verification Boundaries

- Shared tests pin explicit versus implicit session-new identity, no phantom restart mint, rapid-tap idempotence, immediate-send isolation, and old/new conversation separation.
- Talk-mode and command-lane tests pin interrupt-before-manual-start ordering; native gesture tests pin survival of transient inactive state and reset on genuine failure without physical microphone input.
- Message-list tests pin one-shot user-row top anchoring, optimistic/committed identity, no assistant-driven scrolling, long-message anchoring, and initial-history positioning.
- MicLevelMeter tests feed deterministic PCM frames and pin RMS mapping, floor/ceiling bounds, attack/release smoothing, exact 32-value history, silence initialization, non-finite clamping, reset, and StateFlow conflation.
- VoiceAudio/ChatComponent boundary tests prove micFrames remain on the SDK uplink path while native-facing micLevels contains no PCM or platform audio types.
- Native rendering tests inject deterministic MicLevelEnvelope values and pin that the existing 32 bars, design tokens, baseline, and reduced-motion treatment remain intact.
- Fish tests mirror web bucketing/filter/sort fixtures and preserve state across editor push/pop.
- Navigation tests pin one-entry Back behavior through representative nested routes and native/custom affordances.
- The approved E2E matrix contains only journeys an agent can drive to completion without user intervention. Physical-device voice and acoustic behavior are omitted rather than represented as manual E2E.

## Components and Interfaces

- Native iOS UserSessionHost/ChatView and Android AppNavHost/ChatHost convey explicit conversation entry intent without owning session semantics.
- Shared mobile-data conversation use cases distinguish resume/attach, existing-session activation, and Explicit New Chat; repositories remain stateless SDK passthroughs.
- SentientSdk and SessionsConnector preserve implicit launch behavior and use intent=explicit only for user-requested New Chat, with one pending draft/mint target for immediate queued sends.
- TalkModeController remains the talk-mode FSM; native MicCorner synchronization responds to authoritative lifecycle/failure transitions rather than a transient inactive Boolean alone.
- Android and iOS MessageList implementations consume a stable send-anchor identity and retain separate initial-history positioning behavior.
- MicLevelMeter is a commonMain SDK component that owns RMS derivation, normalization, smoothing, the fixed 32-value ring, active/reset lifecycle, and the StateFlow value shape.
- Android VoiceAudioRecord and both iOS MicCaptureEngine/DuplexEngine paths feed MicLevelMeter after conversion/resampling and gain, alongside their existing frame delivery. They do not create a second mic tap or UI audio engine.
- VoiceAudio exposes micFrames only to the existing uplink path and exposes micLevels as StateFlow<MicLevelEnvelope>. SentientSdk and ChatComponent provide thin pass-throughs of micLevels to native ViewModels.
- MicLevelEnvelope contains active plus exactly 32 normalized Float values in the range 0 through 1. It contains no ShortArray, ByteArray, platform buffer, audio-engine object, timestamp history, or retained audio.
- Android PttWave and iOS PttBigWave keep their current visual structure and map one envelope value to each existing bar.
- Mobile Fish view-model state owns web-equivalent query, facets, sorting, reset, loaded entries, and restoration; existing mobile components render controls.
- Typed Android and iOS navigation stacks preserve route history and route-scoped filter/scroll/editor state.

## Data and Control Flow

- Explicit New Chat: user action → native route intent → shared explicit-new use case → synchronous local conversation clear and old-anchor drop → session.new(intent=explicit) → draft/new identity attachment → immediate queued sends flush only to that identity → session history exposes the distinct durable conversation.
- Lifecycle entry: app launch/restart → resume/attach operation → existing anchor reestablished without invoking explicit-new or creating a phantom draft.
- Barge-in: pointer down → TalkModeController.pressMic → interrupt active turn/playback → begin hold deferral → enqueue manual capture start → gesture remains Hold through transient interrupt projection → capture becomes active → release ends capture and finalizes the turn.
- Send anchor: outbound cache creates stable pending identity → MessageList performs one top-anchor movement → committed echo reconciles to the same row identity → assistant activity changes content without issuing scroll commands.
- Waveform: existing platform capture frame → existing conversion/resampling and gain → MicLevelMeter computes aggregate RMS → common normalization and attack/release smoothing → shift into fixed 32-value envelope → conflated StateFlow through SDK and ChatComponent → native waveform maps values to its existing bars → capture end resets to the silence baseline.
- Fish: browse/load entries → derive normalized facet options → apply query/facets/sort with web semantics → select entry → push clone editor → one stack pop restores retained results state.
- Settings: every pushed page/editor adds one history entry; native/top-bar Back invokes the same one-entry pop.

## Failure and Recovery

- If explicit-new is requested before transport readiness, retain one pending explicit mint and retry through the established ready edge without falling back to the old conversation; repeated taps remain idempotent.
- If a new-chat mint or attachment cannot complete, queued sends stay associated with the fresh draft boundary and the UI exposes bounded recovery rather than silently appending to the prior session.
- If mic permission is denied, capture startup fails, or transport/audio teardown is authoritative, reset Hold to Idle without emitting duplicate stop intents. An interrupt remains idempotent.
- MicLevelMeter accepts empty or missing frames as no update, clamps non-finite/out-of-range results, fills uninitialized history with the silence baseline, and resets on capture stop. Meter failure cannot stop or alter uplink frame delivery.
- If the mic-level signal is unavailable, waveform rendering degrades to the existing static silence baseline and never creates a second capture path.
- Fish upstream or feature-gate failures retain existing inline failure/retry behavior; local filter state never mutates remote catalog data.
- Navigation back never reconstructs a guessed parent. If restoration state is unavailable after process death, restore the route safely with defaults rather than jumping multiple levels.
- Physical mic routing, acoustic timing, spoken-turn recognition, and subjective waveform response cannot be proven agentically in this workflow. They remain explicit residual risk for eventual owner testing of a completed build outside workflow execution.

## Alternatives Considered

- Continuing to use sessionId=null for both launch and New Chat was rejected because it cannot preserve restart attachment while honoring the user's conversation-boundary request.
- Making every null route explicit-new was rejected because recomposition or launch could mint phantom conversations.
- Fixing voice behavior independently in both native apps was rejected because TalkModeController and shared command ordering are the semantic authority.
- Passing ShortArray/ByteArray PCM buffers into native ViewModels or UI was rejected because the existing SDK capture layer already has the frames and can derive the complete visualization signal without duplicating audio ownership.
- Using only one latest scalar level was rejected because the established waveform has 32 bars; a bounded rolling 32-level envelope maps real recent input to that design directly.
- Creating a second platform microphone tap for visualization was rejected because it duplicates capture ownership and can conflict with the production audio graph.
- Replacing the existing waveform with a new visualization was rejected because current design language is authoritative.
- Hard-coding parent destinations for Back was rejected because it discards actual navigation history and route-scoped state.
- Including manual physical-device steps in the E2E matrix was rejected because workflow E2E must be fully agentic and unattended.
