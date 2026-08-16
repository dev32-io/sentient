# Mobile interaction reliability behavior

## Context

Defines observable iOS and Android behavior for conversation identity, voice barge-in, chat scrolling, microphone visualization, Fish catalog filtering, and settings navigation. Physical-device voice behavior remains desired product behavior but is not a user-assisted workflow verification gate.

## Required Behaviors

- Every title-bar, history-drawer, or recovery New Chat action establishes a fresh conversation boundary, clears the visible timeline immediately, and targets subsequent queued or immediate sends exclusively at the new draft/session.
- Launch, restart, recomposition, and duplicate ViewModel initialization never count as Explicit New Chat and never create phantom conversations.
- After the first message in a new chat, history exposes a distinct conversation; reopening either old or new conversation shows only its own messages and context.
- Rapid repeated New Chat actions before a send produce at most one fresh draft.
- Pressing hold-to-talk while assistant cognition or TTS is active interrupts the turn and playback and opens manual capture from that same uninterrupted press without waiting for server acknowledgement.
- A transient interrupt-driven inactive mic projection does not reset a pending hold; genuine capture failure, permission denial, disconnect, or teardown returns the control safely to idle.
- Releasing hold-to-talk finalizes the new manual speech turn normally.
- Sending a user message always anchors the beginning of its stable optimistic/committed row at the viewport top, even after prior user scrolling; assistant creation, token streaming, TTS changes, tool updates, and row growth never initiate programmatic scrolling.
- Initial history/session loading may position at the latest message. A user message taller than the viewport anchors at its beginning and is not subsequently repositioned.
- The SDK capture layer computes one aggregate energy value from each existing capture frame, applies shared bounds and attack/release smoothing, and maintains a rolling 32-value mic level envelope. Capture stop resets the envelope.
- Native ViewModels/UI consume only the mic level envelope. They never receive, copy, retain, or process raw PCM for visualization.
- While capture is active, the existing 32-bar mobile waveform maps each bar to the corresponding envelope value; silence retains a subtle baseline and capture end removes the waveform.
- Waveform rendering preserves the existing full-composer placement, 32-bar structure, sine contour, spacing, colors, and motion character. Reduced-motion remains consistent with current accessibility behavior.
- Fish browsing on mobile mirrors web title, language, gender, age, vibe/tag, sort, active-filter, and reset semantics, using case-normalized web-equivalent facet taxonomy.
- Returning from a Fish clone editor restores the same filtered Fish result page, including query, facets, sort, loaded results, and scroll position.
- All settings navigation uses real history: Back from any page returns to the immediately previous visible page. Top-bar Back, native system Back, and back gestures share this operation.

## Acceptance Criteria

- **AC-001:** A marker sent immediately after Explicit New Chat appears only in a distinct new conversation; the prior conversation does not receive that message or context.
- **AC-002:** Restarting the app does not create an extra empty conversation, while repeated New Chat taps create at most one draft.
- **AC-003:** Deterministic talk-mode, command-lane, and native gesture tests prove interrupt-before-manual-capture ordering, survival of transient inactive state, and safe reset on genuine failure.
- **AC-004:** A newly sent user row begins at the viewport top and remains anchored while a multi-screen assistant response streams below it.
- **AC-005:** SDK tests prove the mic level envelope has exactly 32 bounded values, applies shared normalization/smoothing, advances from existing capture frames, resets on capture end, and exposes no PCM through ChatComponent or native UI state.
- **AC-006:** The existing mobile waveform tracks injected deterministic silence, quiet, and louder 32-value envelopes without changing its established visual design.
- **AC-007:** Equivalent mobile and web Fish filter selections produce equivalent visible catalog subsets and ordering from the same loaded entries.
- **AC-008:** The sequence Fish results → clone editor → Back restores the same filtered results; subsequent Back returns to Voice, then Settings, then Chat.
- **AC-009:** All E2E acceptance is fully agentic. Real microphone routing, acoustic response, spoken-turn recognition, and device timing are not workflow completion gates and remain residual risk for later owner build testing.

## Domain Language

- Explicit New Chat is a user-requested conversation boundary; launch/resume attachment is lifecycle recovery. They are distinct operations even when neither starts from a known session id.
- A draft is the fresh conversation target established by Explicit New Chat before its first durable message.
- Send anchor means positioning the beginning of the newly sent user row at the top of the current viewport exactly when the user sends.
- Barge-in press is one gesture that interrupts the active assistant turn and opens manual capture for the next user turn.
- Mic level envelope is an SDK-owned rolling sequence of exactly 32 normalized, smoothed aggregate energy values derived from existing capture PCM. It contains no PCM samples or audio payload and is the only microphone visualization signal exposed to native ViewModels/UI.
- Previous page means the immediately preceding visible entry in navigation history, including transient editors within a settings journey.

## Actors

- Authenticated mobile user on iOS or Android
- Local gateway and shared mobile session/audio layers

## Scenarios

- Existing conversation A receives marker A; the user explicitly starts a new chat and immediately sends marker B; history shows distinct conversations and each contains only its own marker.
- The app restarts while attached to an existing conversation and resumes without minting a phantom draft.
- Deterministic voice seams exercise an active assistant state, one mic press, transient inactive projection, manual capture start, and release without physical microphone input.
- The user sends short and viewport-taller messages from a long conversation and observes assistant streaming without viewport movement.
- The user applies combined Fish facets, sorting, and search, opens a result, then backs through the exact page history.
- SDK tests feed deterministic PCM frames representing silence, quiet input, and louder input into the meter; native rendering tests consume the resulting or injected 32-value envelopes.

## Edge Cases

- A user sends immediately while a new draft mint is pending.
- New Chat is tapped repeatedly before any message is sent.
- The optimistic pending message reconciles to its committed echo without changing its scroll identity.
- Assistant output begins before or after the send-anchor movement completes.
- Capture permission is denied or capture startup genuinely fails after an interrupt.
- Capture starts or stops before the 32-value envelope has filled; missing history uses the established silence baseline.
- A Fish facet has no options in the loaded catalog or combined filters produce no matches.
- Back is invoked through platform gesture rather than the custom top bar.

## Out of Scope

- Changing web chat scrolling
- Replacing Fish browsing or changing Fish import/audio bundling for local TTS
- Assistant-playback-reactive visualization
- Settings information-architecture redesign
- Passing raw PCM or platform audio-engine objects into native ViewModels/UI
- Physical microphone, acoustic waveform, spoken-turn, or other user-assisted workflow verification
- Production mutation or smoke testing
