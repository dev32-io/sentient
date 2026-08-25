# Task Brief: Refresh the native iOS chat, messages, task shelf, and capture-aware composer

## Contribution Goal

Implement the complete native chat product composition—including reviewed messages and encapsulated composer—while preserving session projection, optimistic outbox, permissions, tasks, playback, and capture semantics.

## Boundary — Included

- Chat loading/empty/content/reconnect/error/reopen states, committed/optimistic/streaming/interrupted messages, chronology/Markdown/Rive placement, permission alert, task shelf, DraftEditor/actions, internal VoiceCaptureControl, text keyboard behavior, TTS/interrupt/no-op controls, accessibility/responsive behavior.

## Required Work

- 1. Migrate Chat composition to iOS foundation/common components and task-owned native product styles. Replicate design/prototype/chat-message-bubbles and chat-composer behavior without importing prototype files or duplicating visual literals.
- 2. Preserve KMP/server session projection as source of truth. Keep committed echo reconciliation, queued/failed optimistic user bubbles and retry, current-conversation identity, history switching, reconnect/error/reopen recovery, and exactly one visible message per logical item. Do not create a retired conversation mirror.
- 3. Implement reviewed message role rhythm, same-speaker grouping/repeated-avatar suppression, day dividers, Markdown, streaming vertical growth, pending/failed status, interruption/cutoff, long token/code handling, and accessible author/chronology. Assistant identity uses exactly idle/thinking/responding: cognition/action/startup thinking; streaming text and assistant speech responding; completion/interruption idle when no newer turn.
- 4. Keep task activity exclusively in ComposerTaskStrip from authoritative full-state tasks, with compact one-at-a-time upward disclosure and sanitized argument summaries. Do not infer task lifetime, render tool results in bubbles, or make Interrupt imply background-task cancellation.
- 5. Encapsulate Composer as DraftEditor, TaskShelf, ComposerActions, and internal VoiceCaptureControl. Preserve optimistic text send, draft through voice/errors, keyboard focus, Send/TTS/attachment no-op/Interrupt behavior, bottom safeAreaInset, and text-only usability when mic permission is denied.
- 6. Implement VoiceCaptureControl states idle, Hold/manual, Auto/semantic, transitioning, denied/failed/disabled. Press begins Hold immediately; sustained release defaults Send; explicit Cancel/system cancellation/view disappearance/backgrounding discard; quick activation enters Auto; Hold-to-Auto commits old manual ID then starts a fresh semantic ID; active Auto activation finalizes/exits. Provide native Button/accessibility alternatives to gestures, announcements, haptics, 44pt targets, 150ms feedback, 250ms structure changes, and Reduced Motion static changes.
- 7. Route only semantic intents through ChatViewModel/ChatComponent/KMP. Screens never construct wire commands. Preserve first-terminal-wins, no frames after terminal, stale isolation, permission flow, and barge-in semantics; Cancel does not restore already interrupted assistant output.
- 8. Preserve ChatPermissionAlert request-ID FSM, Allow/Deny-only native alert, server clear/expiry/stale behavior, and privacy. Preserve keep-screen-on lifecycle with all existing clear paths. Logs/evidence contain only IDs/types/sizes/transitions/reasons.
- 9. Add/update tests: Message projection/outbox reconciliation/grouping/Markdown/stream/interruption/state mapping/no task pills; permission FSM; task shelf; text send; MicCorner gesture replacement; Hold Send/Cancel/Auto transitions through fake KMP; permission denied; teardown/background; terminal races; draft persistence; Dynamic Type; Reduced Motion. E2E-007 remains text-only.

## Integration Expectation

Deliver this contribution for integration in stage ios-chat-integration.

## Context

- Owned paths are ios/App/Chat/ChatView.swift, ChatViewModel.swift, ChatUiState.swift, Chat/message/**, Chat/composer/**, Chat/banner/**, Chat/voice/** except brand and drawer/title files owned by ios-identity-startup-history.
- KMP capture APIs provide Hold/Send/Cancel/Auto intents and authoritative talk state. Rive identity/startup/history are already integrated and consumed through their bounded APIs.
- Task activity is server-owned full-state UI in ComposerTaskStrip, never a message-bubble tool pill. Automated proof is text-only/fake-capture; never activate microphone/STT/TTS/audio.

## Boundary — Excluded

- Rive package/startup/History implementation
- KMP/gateway protocol changes
- Settings/Calendar
- Real microphone/STT/TTS/audio E2E
- Background-task cancellation redesign
- Prototype imports or Android UI

## Interfaces and Dependencies

- Consumes KMP capture/talk APIs, native three-state identity/startup/history APIs, existing session/message/task/outbox projections, and iOS common components.
- Produces the complete refreshed ChatView with bounded composer callbacks and stable text-only E2E selectors.
