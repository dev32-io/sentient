# Mobile interaction reliability behavior

## Context

Defines observable iOS and Android behavior for conversation identity, voice barge-in, chat scrolling, microphone visualization, Fish catalog filtering, and settings navigation.

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
- While capture is active, the existing mobile waveform responds to the capture-level stream; silence retains a subtle baseline and capture end removes the waveform.
- Waveform rendering preserves the existing full-composer placement, 32-bar structure, sine contour, spacing, colors, and motion character. Reduced-motion remains consistent with current accessibility behavior.
- Fish browsing on mobile mirrors web title, language, gender, age, vibe/tag, sort, active-filter, and reset semantics, using case-normalized web-equivalent facet taxonomy.
- Returning from a Fish clone editor restores the same filtered Fish result page, including query, facets, sort, loaded results, and scroll position.
- All settings navigation uses real history: Back from any page returns to the immediately previous visible page. Top-bar Back, native system Back, and back gestures share this operation.

## Acceptance Criteria

- **AC-001:** A marker sent immediately after Explicit New Chat appears only in a distinct new conversation; the prior conversation does not receive that message or context.
- **AC-002:** Restarting the app does not create an extra empty conversation, while repeated New Chat taps create at most one draft.
- **AC-003:** During assistant TTS, one hold press stops playback and remains in capture until release; release submits the newly spoken turn.
- **AC-004:** A newly sent user row begins at the viewport top and remains anchored while a multi-screen assistant response streams below it.
- **AC-005:** The mobile waveform visibly tracks injected deterministic capture levels in automated rendering checks and real microphone energy in the user's final manual device test without changing the established visual design.
- **AC-006:** Equivalent mobile and web Fish filter selections produce equivalent visible catalog subsets and ordering from the same loaded entries.
- **AC-007:** The sequence Fish results → clone editor → Back restores the same filtered results; subsequent Back returns to Voice, then Settings, then Chat.

## Domain Language

- Explicit New Chat is a user-requested conversation boundary; launch/resume attachment is lifecycle recovery. They are distinct operations even when neither starts from a known session id.
- A draft is the fresh conversation target established by Explicit New Chat before its first durable message.
- Send anchor means positioning the beginning of the newly sent user row at the top of the current viewport exactly when the user sends.
- Barge-in press is one gesture that interrupts the active assistant turn and opens manual capture for the next user turn.
- Capture level is a bounded, normalized, smoothed aggregate derived from microphone PCM; it contains no audio payload.
- Previous page means the immediately preceding visible entry in navigation history, including transient editors within a settings journey.

## Actors

- Authenticated mobile user on iOS or Android
- Local gateway and shared mobile session/audio layers

## Scenarios

- Existing conversation A receives marker A; the user explicitly starts a new chat and immediately sends marker B; history shows distinct conversations and each contains only its own marker.
- The app restarts while attached to an existing conversation and resumes without minting a phantom draft.
- Assistant TTS is playing when the user presses and holds the mic, speaks a follow-up, and releases.
- The user sends short and viewport-taller messages from a long conversation and observes assistant streaming without viewport movement.
- The user applies combined Fish facets, sorting, and search, opens a result, then backs through the exact page history.
- Injected silence, quiet, and louder capture levels drive the existing waveform design; a user repeats this on a physical device at final acceptance.

## Edge Cases

- A user sends immediately while a new draft mint is pending.
- New Chat is tapped repeatedly before any message is sent.
- The optimistic pending message reconciles to its committed echo without changing its scroll identity.
- Assistant output begins before or after the send-anchor movement completes.
- Capture permission is denied or capture startup genuinely fails after an interrupt.
- A Fish facet has no options in the loaded catalog or combined filters produce no matches.
- Back is invoked through platform gesture rather than the custom top bar.

## Out of Scope

- Changing web chat scrolling
- Replacing Fish browsing or changing Fish import/audio bundling for local TTS
- Assistant-playback-reactive visualization
- Settings information-architecture redesign
- Agent-driven physical-microphone or acoustic E2E testing
- Production mutation or smoke testing
