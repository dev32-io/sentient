# Mobile interaction reliability behavior

## Context

Defines observable iOS and Android behavior for fresh-chat lifecycle, voice barge-in, chat scrolling, microphone visualization, Fish catalog filtering, and settings navigation. Physical-device voice behavior remains desired product behavior but is not a user-assisted workflow verification gate.

## Required Behaviors

- Cold app launch intentionally enters a fresh-chat route and immediately sends the gateway preparation request instead of resuming the previous conversation.
- Every title-bar, history-drawer, or recovery New Chat action enters a fresh-chat route, clears the visible timeline immediately, and immediately sends the same explicit gateway preparation request.
- Fresh-chat preparation is fire-and-forget: the composer remains usable, and immediate sends queue locally until the session.draft attachment is ready. The UI never waits for preparation.
- The existing gateway contract allocates no durable session row until the first message reaches the prepared boundary. That first message and all following context belong only to the newly minted conversation.
- A single fresh-chat route entry emits at most one preparation request despite recomposition or duplicate ViewModel observation. Existing rapid-tap idempotence/debounce prevents duplicate preparation for effectively the same action.
- After the first message, history exposes a distinct conversation; reopening old and new conversations shows only their own messages and context.
- TalkModeController is the sole authority for Idle, Hold, and Continuous. Native mic controls consume TalkMode and retain only pointer ownership, drag offset, animation, and haptic state.
- Pressing hold-to-talk while assistant cognition or TTS is active causes shared TalkModeController to interrupt the turn/playback and open manual capture from the same uninterrupted press without waiting for server acknowledgement.
- A transient interrupt-driven inactive audio projection does not change authoritative TalkMode from Hold. Genuine permission denial, capture failure, disconnect, or teardown drives a shared transition back to Idle.
- Releasing Hold finalizes the new manual speech turn normally.
- Sending a user message always anchors the beginning of its stable optimistic/committed row at the viewport top, even after prior user scrolling; assistant creation, token streaming, TTS changes, tool updates, and row growth never initiate programmatic scrolling.
- Initial history/session loading may position at the latest message. A user message taller than the viewport anchors at its beginning and is not subsequently repositioned.
- The SDK capture layer accumulates the existing 16 kHz uplink PCM by sample count into fixed 50 ms windows, computes one aggregate energy value per window, applies shared logarithmic normalization plus fast-attack/modest-release smoothing, and shifts it into a rolling 32-value envelope. Capture stop resets the envelope.
- Native ViewModels/UI consume only the mic level envelope. They never receive, copy, retain, or process raw PCM and never create a second microphone tap.
- While capture is active, the existing 32-bar mobile waveform maps each bar to the corresponding recent envelope value; short utterances occupy several bars and remain visible as they travel through the 1.6-second window.
- Waveform rendering preserves the existing full-composer placement, 32-bar structure, sine contour, spacing, colors, silence baseline, motion character, and reduced-motion treatment. It is not redesigned.
- Fish browsing on mobile mirrors web title, language, gender, age, vibe/tag, sort, active-filter, and reset semantics, using case-normalized web-equivalent facet taxonomy.
- Returning from a Fish clone editor restores the same filtered Fish result page, including query, facets, sort, loaded results, and scroll position.
- All settings navigation uses actual history: Back from any page returns to the immediately previous visible page. Top-bar Back, native system Back, and back gestures share the same one-entry pop; no parent destination is hard-coded.

## Acceptance Criteria

- **AC-001:** On cold launch, the client immediately requests a fresh prepared gateway boundary; an immediate message is queued as needed and becomes the first message of a new durable conversation rather than appending to the prior conversation.
- **AC-002:** A marker sent immediately after user-triggered New Chat appears only in a distinct new conversation; the prior conversation does not receive that message or context.
- **AC-003:** Recomposition or duplicate observation of one fresh-chat route does not issue duplicate preparation requests, and rapid repeated actions remain bounded by the established idempotence/debounce contract.
- **AC-004:** Deterministic shared talk-mode and command-lane tests prove interrupt-before-manual-capture ordering, survival of transient inactive projection, and shared Idle reset on genuine failure. Native controls render shared TalkMode rather than reproducing its FSM.
- **AC-005:** A newly sent user row begins at the viewport top and remains anchored while a multi-screen assistant response streams below it.
- **AC-006:** SDK tests prove the mic level envelope has exactly 32 bounded values representing fixed 50 ms windows, spans 1.6 seconds, applies shared logarithmic normalization and attack/release smoothing, resets on capture end, and exposes no PCM through ChatComponent or native UI state.
- **AC-007:** The existing mobile waveform tracks injected deterministic silence, brief utterance, and sustained-input envelopes without changing its established visual design.
- **AC-008:** Equivalent mobile and web Fish filter selections produce equivalent visible catalog subsets and ordering from the same loaded entries.
- **AC-009:** The sequence Fish results → clone editor → Back restores the same filtered results; subsequent Back returns to Voice, then Settings, then Chat.
- **AC-010:** All E2E acceptance is fully agentic. Real microphone routing, acoustic response, spoken-turn recognition, and device timing are not workflow completion gates and remain residual risk for later owner build testing.

## Domain Language

- Fresh-chat route is the default cold-launch destination and the destination created by a user New Chat action. Entering it eagerly prepares a fresh gateway conversation boundary.
- Gateway draft handshake is the existing session.draft preparation result returned after session.new. It attaches the mobile outbound queue to a fresh gateway key; it is not a client-generated or client-persisted draft model.
- Durable conversation is the server-minted session allocated from that prepared boundary when its first message arrives.
- Send anchor means positioning the beginning of the newly sent user row at the top of the current viewport exactly when the user sends.
- Barge-in press is one gesture interpreted by shared TalkModeController that interrupts the active assistant turn and opens manual capture for the next user turn.
- TalkMode is the shared SDK's sole authoritative Idle/Hold/Continuous mic-control state. Native controls own only gesture presentation state.
- Mic level envelope is an SDK-owned rolling sequence of exactly 32 normalized aggregate energy values, each representing a fixed 50 ms window of the existing uplink PCM. It spans 1.6 seconds, contains no PCM/audio payload, and is the only microphone visualization signal exposed to native ViewModels/UI.
- Previous page means the immediately preceding visible entry in navigation history, including transient editors within a settings journey.

## Actors

- Authenticated mobile user on iOS or Android
- Local gateway and shared mobile session/audio layers

## Scenarios

- Existing conversation A receives marker A; the user explicitly starts a new chat and immediately sends marker B; the eager gateway handshake completes in the background, history shows distinct conversations, and each contains only its own marker.
- The app cold-launches from a previously bound conversation, immediately prepares a fresh boundary, and an immediate message creates a new conversation rather than resuming the prior one.
- Deterministic shared voice seams exercise an active assistant state, one mic press, transient inactive projection, manual capture start, release, and genuine failure reset without physical microphone input.
- The user sends short and viewport-taller messages from a long conversation and observes assistant streaming without viewport movement.
- The user applies combined Fish facets, sorting, and search, opens a result, then backs through the exact page history.
- SDK tests feed deterministic PCM representing silence, a brief 250–500 ms utterance, and sustained input; native rendering tests consume resulting or injected 32-value envelopes.

## Edge Cases

- A user sends immediately before the gateway draft handshake arrives.
- One fresh-chat route is recomposed or its ViewModel is recreated without a new navigation entry.
- New Chat is tapped repeatedly before any message is sent.
- The optimistic pending message reconciles to its committed echo without changing its scroll identity.
- Assistant output begins before or after the send-anchor movement completes.
- Capture permission is denied or capture startup genuinely fails after an interrupt.
- PCM capture callback sizes differ between platforms; fixed 50 ms windows are derived by sample count rather than callback count.
- Capture starts or stops before the 32-value envelope has filled; missing history uses the established silence baseline.
- A Fish facet has no options in the loaded catalog or combined filters produce no matches.
- Back is invoked through platform gesture rather than the custom top bar.

## Out of Scope

- Changing web chat scrolling
- Replacing Fish browsing or changing Fish import/audio bundling for local TTS
- Assistant-playback-reactive visualization
- Settings information-architecture redesign
- A client-generated or client-persisted local draft model
- Passing raw PCM or platform audio-engine objects into native ViewModels/UI
- A second visualization-specific microphone tap
- A waveform redesign
- Hard-coded settings parent destinations
- Physical microphone, acoustic waveform, spoken-turn, or other user-assisted workflow verification
- Production mutation or smoke testing
