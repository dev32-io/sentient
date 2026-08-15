# Task Brief: Play natural-language music in a room with one tool call

## Contribution Goal

A common request such as “play some lo-fi music in the living room” resolves content and player, starts playback, and reports a verified semantic outcome through one music_play invocation.

## Boundary — Included

- Register standard music_play with natural-language request, room/player target, and optional replace/add/play-next queue mode
- Resolve room/player using MusicAdapter identities and bounded household aliases; return ambiguity or no-player instead of guessing
- Search/browse the library using the natural request, prefer exact or strong ranked media matches, and return bounded candidates when confidence is insufficient
- Perform the minimum adapter operations required for the requested queue behavior and playback without exposing intermediate model tool calls
- Observe player/queue state after acknowledgement within a bounded verification window
- Return semantic playing, not_found, ambiguous_room, ambiguous_media, no_available_player, rejected, failed, unavailable, or accepted_unverified results with selected media/player identifiers
- Ensure one composed permission decision authorizes only the documented music_play behavior; internal adapter calls do not bypass or recursively reprompt through the broker
- Keep standard primitives available for “find something different,” comparison, direct selection, status, and recovery

## Required Work

- Register standard music_play with natural-language request, room/player target, and optional replace/add/play-next queue mode
- Resolve room/player using MusicAdapter identities and bounded household aliases; return ambiguity or no-player instead of guessing
- Search/browse the library using the natural request, prefer exact or strong ranked media matches, and return bounded candidates when confidence is insufficient
- Perform the minimum adapter operations required for the requested queue behavior and playback without exposing intermediate model tool calls
- Observe player/queue state after acknowledgement within a bounded verification window
- Return semantic playing, not_found, ambiguous_room, ambiguous_media, no_available_player, rejected, failed, unavailable, or accepted_unverified results with selected media/player identifiers
- Ensure one composed permission decision authorizes only the documented music_play behavior; internal adapter calls do not bypass or recursively reprompt through the broker
- Keep standard primitives available for “find something different,” comparison, direct selection, status, and recovery

## Integration Expectation

Deliver this contribution for integration in stage 03-capabilities.

## Context

- The standard Music primitives already provide search/browse, player resolution, direct play, queue inspection, and status verification.
- music_play is the preferred everyday orchestration boundary; primitives remain available for conversational refinement and unusual cases.
- Natural “play X in Y” means play now in the target room. The default queue behavior is replace/start-now; callers can explicitly request add or play-next when they mean it.
- The tool's permission description must disclose that its default may replace the target room's active queue/playback.

## Boundary — Excluded

- Personalized recommendation models beyond MA search/ranking
- Live playback testing on household speakers
- Granular queue editing or administrative player setup
- Removing standard music primitives in favor of the composed tool

## Interfaces and Dependencies

- music_play has one compact stable schema and returns one semantic outcome plus bounded selected/candidate metadata
- Default queueMode is replace/start-now and is visible in schema/permission copy
- Resolution and ranking are deterministic for the same bounded adapter results; uncertain matches are surfaced, not guessed
- Verification uses adapter observations and never equates command acknowledgement alone with playing
- No mutating sub-operation is automatically replayed after ambiguous dispatch
- Extend only the Music-owned provider and adapter surfaces delivered by native-music-primitives; do not modify web or Home contributions

## Constraints

- All tests of playback and queue behavior use a fake MusicAdapter or isolated fixture
- Never log the request text, selected media, player state, queue content, or credentials
- Cancellation before dispatch performs no action; cancellation or timeout after possible dispatch returns accepted_unverified when outcome cannot be established
- The composed tool remains subject to role and per-tool permission at the single execution boundary
