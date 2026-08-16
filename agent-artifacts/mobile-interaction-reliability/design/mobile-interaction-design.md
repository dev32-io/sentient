# Mobile interaction reliability design

## Design Goal

Preserve shared mobile authority and current native design language while making fresh-chat preparation, voice, scrolling, filtering, and navigation behavior explicit and testable without user-assisted workflow execution.

## Chosen Approach

- Treat null/default mobile chat navigation as a fresh-chat route by design. Cold launch and every user New Chat entry eagerly invoke the existing explicit session.new preparation path exactly once per route entry.
- Preserve the existing gateway lifecycle: explicit session.new unbinds any prior conversation and returns a fresh session.draft handshake immediately; the durable session is allocated only when the first message arrives. The composer never blocks, and SendMessageUseCase retains outbound content until the handshake supplies an attached key.
- Keep TalkModeController as the sole Idle/Hold/Continuous authority. Native mic controls consume shared TalkMode and emit shared intents while retaining only pointer ownership, drag offset, animation, and haptic presentation state.
- Replace follow-latest scrolling with a one-shot send-anchor command keyed by stable pending/message identity. Preserve initial history positioning but remove every assistant-content, token-growth, TTS, and tool-driven scroll trigger.
- Add an SDK-owned MicLevelMeter in commonMain. Existing platform capture paths feed it the same post-conversion, post-gain 16 kHz PCM already destined for uplink. It frames by sample count into fixed 50 ms windows, computes RMS, applies logarithmic normalization with fast attack/modest release, and shifts one bounded value into a rolling 32-value envelope spanning 1.6 seconds.
- Expose the envelope through VoiceAudio, SentientSdk, and ChatComponent as a latest-value StateFlow. Native ViewModels/UI are pure consumers; PCM remains contained in the SDK and no second capture path exists.
- Retain the existing waveform composition and visual tokens. Replace the autonomous placeholder driver with the 32 real-input envelope values while preserving the current bars, contour, full-composer placement, spacing, colors, silence baseline, motion character, and reduced-motion treatment.
- Mirror web Fish facet bucketing, matching, sorting, selection, and reset semantics in mobile state while rendering with existing native settings controls and design tokens.
- Make actual navigation history authoritative. Parent categories, result pages, and transient editors remain stack entries with route-scoped state; every back affordance pops one entry and no destination hard-codes a parent.

## Verification Boundaries

- Fresh-chat tests pin cold-launch explicit preparation, user New Chat explicit preparation, one request per route entry, pre-READY retry, immediate-send queueing, first-message durable mint, and old/new conversation isolation.
- Navigation/ViewModel tests prove recomposition and recreation within one route identity do not mint again; a newly created route identity does.
- TalkModeController and command-lane tests pin interrupt-before-manual-start ordering, optimistic Hold authority through transient inactive projection, and shared forced-Idle failure handling.
- Native mic-control tests prove pointer outcomes emit shared intents and presentation renders shared TalkMode without maintaining a competing FSM.
- Message-list tests pin one-shot user-row top anchoring, optimistic/committed identity, no assistant-driven scrolling, long-message anchoring, and initial-history positioning.
- MicLevelMeter tests feed deterministic PCM and pin 800-sample/50 ms framing, 32 values/1.6 seconds, logarithmic mapping, attack/release smoothing, brief-word visibility, silence initialization, reset, and bounds.
- VoiceAudio/ChatComponent boundary tests prove micFrames remain SDK/uplink-owned while micLevels exposes no PCM or platform audio types.
- Native rendering tests inject deterministic MicLevelEnvelope values and pin the current 32 bars, design tokens, baseline, and reduced-motion treatment.
- Fish tests mirror web bucketing/filter/sort fixtures and preserve state across editor push/pop.
- Navigation tests pin one-entry Back behavior through representative nested routes and native/custom affordances.
- The approved E2E matrix contains only journeys an agent can drive to completion without user intervention.

## Components and Interfaces

- Native iOS UserSessionHost/ChatView and Android AppNavHost/ChatHost create a distinct fresh-chat route identity for cold launch and each intentional New Chat navigation. Recomposition does not create a new route identity.
- Shared mobile-data exposes an explicit startFreshChat operation separate from opening an existing session. Its fire-and-forget request executes once per fresh route entry and uses existing connector idempotence/debounce as defense in depth.
- SentientSdk and SessionsConnector send session.new with intent=explicit for both cold-launch and user-created fresh routes, clear the old visible/identity state, consume session.draft, and expose the attached gateway key used by the existing outbound queue.
- No client-generated or persisted draft entity is added. The gateway's existing session.draft handshake is only the preparation/attachment boundary before durable first-message minting.
- TalkModeController owns Idle/Hold/Continuous plus the authoritative forced-Idle transition for permission denial, capture failure, disconnect, and teardown.
- Native MicCorner views translate platform pointer/drag outcomes into pressMic, releaseMic, lockMic, and stopContinuous intents; they render shared TalkMode and do not infer mode from micActive.
- Android and iOS MessageList implementations consume a stable send-anchor identity and retain separate initial-history positioning behavior.
- MicLevelMeter is a commonMain SDK component that owns fixed 50 ms framing, RMS derivation, logarithmic normalization, attack/release smoothing, the exact 32-value ring, active/reset lifecycle, and StateFlow value shape.
- Android VoiceAudioRecord and both iOS MicCaptureEngine/DuplexEngine paths feed MicLevelMeter after conversion/resampling and gain, alongside existing uplink delivery. They do not create a second mic tap or UI audio engine.
- VoiceAudio keeps micFrames on the existing uplink path and exposes micLevels as StateFlow<MicLevelEnvelope>. SentientSdk and ChatComponent provide thin pass-throughs to native ViewModels.
- MicLevelEnvelope contains active plus exactly 32 normalized Float values in the range 0 through 1. It contains no PCM arrays, platform buffers, engine objects, timestamps, or retained audio.
- Android PttWave and iOS PttBigWave preserve their current visual structure and map one envelope value to each existing bar.
- Mobile Fish view-model state owns web-equivalent query, facets, sorting, reset, loaded entries, and restoration; existing mobile components render controls.
- Typed Android and iOS navigation stacks preserve real route history and route-scoped filter/scroll/editor state.

## Data and Control Flow

- Cold launch: native host creates one fresh-chat route identity → shared startFreshChat → clear old local timeline/anchor → session.new(intent=explicit) immediately → gateway unbinds prior conversation and returns session.draft → outbound queue attaches → first user message allocates the durable conversation.
- User New Chat: title bar, drawer, or recovery action creates a new fresh-chat route identity → the same eager preparation flow runs once → composer is immediately usable throughout.
- Immediate send: outbound cache accepts the message before preparation settles → flush waits for attached gateway key → first message reaches only the fresh prepared boundary → durable session.created reanchors the client.
- Barge-in: pointer down emits pressMic → TalkModeController enters Hold and interrupts active turn/playback before manual capture → transient micActive changes do not override TalkMode → release finalizes capture; genuine failure drives shared forced Idle.
- Send anchor: outbound cache creates stable pending identity → MessageList performs one top-anchor movement → committed echo reconciles to the same row identity → assistant activity changes content without issuing scroll commands.
- Waveform: existing platform PCM stream → accumulate 800 samples at 16 kHz per 50 ms window → MicLevelMeter RMS/log normalization/attack-release → shift into fixed 32-value envelope → conflated StateFlow through SDK and ChatComponent → native waveform maps values to existing bars → capture end resets to silence baseline.
- Fish: browse/load entries → derive normalized facet options → apply query/facets/sort with web semantics → select entry → push clone editor → one stack pop restores retained results state.
- Settings: every pushed page/editor adds one history entry; native/top-bar Back invokes the same one-entry pop.

## Failure and Recovery

- If eager session.new is issued before transport readiness, retain one pending explicit preparation and retry through the established READY edge without reattaching to the prior conversation.
- If preparation is still pending when the user sends, keep the outbound message queued until session.draft/attachment arrives; never flush it to the previous conversation.
- A route-entry identity or equivalent once token prevents recomposition/ViewModel recreation from issuing another preparation. Connector debounce bounds rapid duplicate requests as defense in depth.
- If preparation fails, preserve the fresh local boundary and expose bounded recovery; do not silently restore or append to the old conversation.
- If mic permission is denied, capture startup fails, or transport/audio teardown is authoritative, TalkModeController transitions to Idle without duplicate stop intents. Native UI follows that shared state.
- MicLevelMeter treats incomplete 50 ms windows according to capture lifecycle, clamps invalid results, initializes missing history to silence, and resets on capture stop. Meter failure cannot alter uplink delivery.
- If the mic-level signal is unavailable, waveform rendering degrades to the existing static silence baseline and never creates another capture path.
- Fish upstream or feature-gate failures retain existing inline failure/retry behavior; local filter state never mutates remote catalog data.
- Navigation Back never reconstructs or guesses a parent. If restoration state is unavailable after process death, restore the retained route safely with defaults rather than popping multiple levels.
- Physical mic routing, acoustic timing, spoken-turn recognition, and subjective waveform response cannot be proven agentically in this workflow and remain residual risk for eventual owner testing of a completed build.

## Alternatives Considered

- Resume-on-cold-launch was rejected because product behavior intentionally prepares a fresh chat on every app relaunch.
- A client-generated/local draft identity and first-message-only preparation were rejected because the existing design eagerly prepares the gateway on route entry so it is ready before a message arrives.
- Blocking the composer on session preparation was rejected because the existing outbound queue provides immediate interaction while attachment settles.
- Keeping a native Idle/Hold/Continuous FSM in each app was rejected because shared TalkModeController is the cross-platform authority; native code retains presentation-only gesture state.
- Passing PCM buffers into native ViewModels/UI was rejected because the SDK capture path already has the exact uplink signal and can derive the complete visualization envelope.
- A single latest scalar was rejected because the current 32-bar design can directly render a rolling 1.6-second envelope, including visible brief utterances.
- A second visualization-specific microphone tap was rejected because native UI must remain a pure consumer and duplicate capture ownership can conflict with the production audio graph.
- A waveform redesign was rejected; the current component and design language remain authoritative.
- Hard-coded parent destinations were rejected because Back must reflect actual route history and restore route-scoped state.
- Manual physical-device steps were rejected from workflow E2E because all workflow cases must run unattended and agentically.
