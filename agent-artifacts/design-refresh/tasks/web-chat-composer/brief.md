# Task Brief: Build the Web ChatComposer and internal capture-aware VoiceCaptureControl

## Contribution Goal

Replace the legacy mic rail/composer visuals with the reviewed native product composite while preserving text, task, playback, interruption, and capture safety semantics.

## Boundary — Included

- DraftEditor, ComposerActions, server-owned TaskShelf, text send/keyboard behavior, TTS toggle presentation, foreground Interrupt, internal VoiceCaptureControl, permission/reconnect/error states, and generation-safe capture adapter wiring.

## Required Work

- 1. Refactor Composer into an encapsulated ChatComposer composed of DraftEditor, TaskShelf, ComposerActions, and a private/internal VoiceCaptureControl. Migrate styles to shared v2 tokens/materials and replicate design/prototype/chat-composer/ behavior without importing prototype code/assets.
- 2. Preserve text behavior: draft survives voice takeover and failures; Enter sends, Shift+Enter inserts newline; send is disabled only by existing connection/empty rules; suggestion chips and visible attachment/no-op controls remain honest; focus returns predictably after actions.
- 3. Keep TaskShelf driven by server-owned full-state tasklist.state. Preserve compact one-at-a-time upward disclosure and sanitized argument previews; do not infer task lifetime, move tasks into bubbles, or render tool results as messages.
- 4. Implement VoiceCaptureControl states idle, Hold/manual, Auto/semantic, transitioning, permission-denied, start-failed, and reconnect-disabled. Pointer-down starts manual Hold immediately. A sustained held release defaults to Send/commit. Explicit Cancel, pointercancel, view teardown, permission failure, and system cancellation discard the identified capture. A quick activation enters Auto according to the reviewed gesture threshold. Provide equivalent keyboard/screen-reader buttons for Hold/Send/Cancel/Auto rather than requiring drag gestures.
- 5. Implement the reviewed waveform-pod/aperture-crown morph and Auto/Cancel/Send fanout as native DOM/CSS using generated tokens: 150ms direct feedback, 250ms structural/state transitions, 44px touch targets, non-color labels/icons, haptics only where browser capability is safely available, announcements, Reduced Motion immediate/static changes. Keep Rive/avatar state independent from capture.
- 6. Hold-to-Auto must commit the held manual ID, await accepted local terminal serialization, then start a fresh semantic ID. Activating Auto again ends/finalizes its semantic ID and returns idle. First terminal wins; stale callbacks/actions cannot affect a newer capture.
- 7. Update use-voice-client/audio capture wiring to follow connector order: invalidate callback generation and stop/settle capture before end/cancel; never send a frame after terminal; detach/disconnect/view disappearance cancels rather than commits active manual capture. Preserve AudioWorklet/Opus/ring-buffer/AEC paths; do not introduce MediaRecorder or WebRTC capture dependency.
- 8. Keep Interrupt separate: it stops foreground cognition/playback and clears buffered playback but does not cancel background tasks. Starting mic may barge in; canceling the capture does not restore prior assistant output.
- 9. Replace mic-corner gesture tests and add composer boundary tests for text send/newline, draft persistence, Hold Send, Hold Cancel, quick Auto, Hold-to-Auto ordering, Auto exit, terminal races, pointercancel/teardown, permission denial, reconnect, task shelf, Interrupt, accessibility announcements, and Reduced Motion—all with fake audio producers/connectors.

## Integration Expectation

Deliver this contribution for integration in stage product-surfaces.

## Context

- Owned UI paths are gateway/webui/src/components/dock/** and composer-specific styles/tests. Voice transport integration is in gateway/webui/src/hooks/use-voice-client.ts and Web audio capture adapters.
- The public ChatComposer boundary receives draft/state/tasks and semantic callbacks; screens must not reconstruct microphone/send/waveform visuals.
- Capture protocol/SDK provides identified start, commit, and cancel. Automated proof must use fakes only—never microphone, STT, TTS playback, audio quality, or network manipulation.

## Boundary — Excluded

- Gateway/STT/protocol changes
- Message bubble implementation
- Real microphone/STT/TTS/audio E2E
- Background task cancellation
- Android/iOS work
- Prototype runtime imports

## Interfaces and Dependencies

- Consumes capture-aware Web SDK methods and current voice/task/cycle state from use-voice-client.
- Produces a bounded ChatComposer API; VoiceCaptureControl remains internal and emits semantic intents only.
