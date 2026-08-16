# Mobile interaction reliability design

## Design Goal

Preserve shared mobile authority and current native design language while making conversation, voice, scrolling, filtering, and navigation behavior explicit and testable without user-assisted workflow execution.

## Chosen Approach

- Replace the overloaded nullable conversation target with explicit shared operations for lifecycle attach/resume, opening an existing conversation, and user-requested New Chat. Carry explicit intent from every native New Chat entry point through the mobile-data boundary to the SDK's existing explicit session.new protocol path.
- Keep TalkModeController as voice semantic authority. Repair native gesture synchronization and shared command-lane interaction so interrupt-induced transient state cannot cancel a pending Idle-to-Hold transition, while genuine external teardown still resets safely.
- Replace follow-latest scrolling with a one-shot send-anchor command keyed by stable pending/message identity. Preserve initial history positioning but remove every assistant-content, token-growth, TTS, and tool-driven scroll trigger.
- Expose a throttled StateFlow of normalized, smoothed aggregate microphone level through shared audio and ChatComponent boundaries. Platform capture engines compute or forward aggregate energy only; native waveform views consume the scalar level.
- Retain the existing waveform composition and visual tokens. Replace its autonomous placeholder pulse driver with level modulation that preserves the 32 bars, sine contour, full-composer placement, spacing, colors, baseline, motion character, and reduced-motion treatment.
- Mirror web Fish facet bucketing, matching, sorting, selection, and reset semantics in mobile state while rendering with existing native settings controls and design tokens.
- Make navigation history authoritative. Parent categories, result pages, and transient editors remain actual stack entries with route-scoped state; all back affordances pop exactly one entry.

## Verification Boundaries

- Shared tests pin explicit versus implicit session-new identity, no phantom restart mint, rapid-tap idempotence, immediate-send isolation, and old/new conversation separation.
- Talk-mode and command-lane tests pin interrupt-before-manual-start ordering; native gesture tests pin survival of transient inactive state and reset on genuine failure without physical microphone input.
- Message-list tests pin one-shot user-row top anchoring, optimistic/committed identity, no assistant-driven scrolling, long-message anchoring, and initial-history positioning.
- Audio tests pin level bounds, smoothing, throttling, silence baseline, capture-end reset, and absence of PCM on the UI surface; native rendering tests inject deterministic levels into the existing waveform.
- Fish tests mirror web bucketing/filter/sort fixtures and preserve state across editor push/pop.
- Navigation tests pin one-entry Back behavior through representative nested routes and native/custom affordances.
- The approved E2E matrix contains only journeys an agent can drive to completion without user intervention. Physical-device voice and acoustic behavior are omitted rather than represented as manual E2E.

## Components and Interfaces

- Native iOS UserSessionHost/ChatView and Android AppNavHost/ChatHost convey explicit conversation entry intent without owning session semantics.
- Shared mobile-data conversation use cases distinguish resume/attach, existing-session activation, and Explicit New Chat; repositories remain stateless SDK passthroughs.
- SentientSdk and SessionsConnector preserve implicit launch behavior and use intent=explicit only for user-requested New Chat, with one pending draft/mint target for immediate queued sends.
- TalkModeController remains the talk-mode FSM; native MicCorner synchronization responds to authoritative lifecycle/failure transitions rather than a transient inactive Boolean alone.
- Android and iOS MessageList implementations consume a stable send-anchor identity and retain separate initial-history positioning behavior.
- Platform capture engines and shared audio boundaries expose only normalized aggregate level; ChatComponent projects the latest bounded value to native UI.
- Android PttWave and iOS PttBigWave keep their current visual structure and map capture level into bar scale/intensity.
- Mobile Fish view-model state owns web-equivalent query, facets, sorting, reset, loaded entries, and restoration; existing mobile components render controls.
- Typed Android and iOS navigation stacks preserve route history and route-scoped filter/scroll/editor state.

## Data and Control Flow

- Explicit New Chat: user action → native route intent → shared explicit-new use case → synchronous local conversation clear and old-anchor drop → session.new(intent=explicit) → draft/new identity attachment → immediate queued sends flush only to that identity → session history exposes the distinct durable conversation.
- Lifecycle entry: app launch/restart → resume/attach operation → existing anchor reestablished without invoking explicit-new or creating a phantom draft.
- Barge-in: pointer down → TalkModeController.pressMic → interrupt active turn/playback → begin hold deferral → enqueue manual capture start → gesture remains Hold through transient interrupt projection → capture becomes active → release ends capture and finalizes the turn.
- Send anchor: outbound cache creates stable pending identity → MessageList performs one top-anchor movement → committed echo reconciles to the same row identity → assistant activity changes content without issuing scroll commands.
- Waveform: platform capture frame → aggregate energy calculation → bounded normalization and smoothing/throttling → latest-value StateFlow → existing native waveform geometry modulated by the scalar → capture end returns baseline/removes overlay.
- Fish: browse/load entries → derive normalized facet options → apply query/facets/sort with web semantics → select entry → push clone editor → one stack pop restores retained results state.
- Settings: every pushed page/editor adds one history entry; native/top-bar Back invokes the same one-entry pop.

## Failure and Recovery

- If explicit-new is requested before transport readiness, retain one pending explicit mint and retry through the established ready edge without falling back to the old conversation; repeated taps remain idempotent.
- If a new-chat mint or attachment cannot complete, queued sends stay associated with the fresh draft boundary and the UI exposes bounded recovery rather than silently appending to the prior session.
- If mic permission is denied, capture startup fails, or transport/audio teardown is authoritative, reset Hold to Idle without emitting duplicate stop intents. An interrupt remains idempotent.
- Capture-level production failure degrades to the existing baseline waveform state and never affects audio transport or speech submission.
- Fish upstream or feature-gate failures retain existing inline failure/retry behavior; local filter state never mutates remote catalog data.
- Navigation back never reconstructs a guessed parent. If restoration state is unavailable after process death, restore the route safely with defaults rather than jumping multiple levels.
- Physical mic routing, acoustic timing, spoken-turn recognition, and subjective waveform response cannot be proven agentically in this workflow. They remain explicit residual risk for eventual owner testing of a completed build outside workflow execution.

## Alternatives Considered

- Continuing to use sessionId=null for both launch and New Chat was rejected because it cannot preserve restart attachment while honoring the user's conversation-boundary request.
- Making every null route explicit-new was rejected because recomposition or launch could mint phantom conversations.
- Fixing voice behavior independently in both native apps was rejected because TalkModeController and shared command ordering are the semantic authority.
- Exposing PCM or per-frame samples to native UI was rejected for privacy, coupling, and update-rate reasons; a bounded latest-value aggregate is sufficient.
- Replacing the existing waveform with a new visualization was rejected because current design language is authoritative.
- Hard-coding parent destinations for Back was rejected because it discards actual navigation history and route-scoped state.
- Including manual physical-device steps in the E2E matrix was rejected because workflow E2E must be fully agentic and unattended.
