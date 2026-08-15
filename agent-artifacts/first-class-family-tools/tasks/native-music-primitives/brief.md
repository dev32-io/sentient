# Task Brief: Expose standard Music Assistant discovery and playback primitives

## Contribution Goal

Family members and the model can search, inspect, select, and operate Music Assistant through reliable Sentient-owned standard tools without MA MCP discovery.

## Boundary — Included

- Implement a persistent typed MusicAdapter for the native Music Assistant WebSocket API with authentication, request correlation, cancellation, bounded reconnect, runtime response validation, and per-call degradation
- Register compact standard tools for library search, browse, player/room listing, player and now-playing status, queue inspection, direct play by selected media/player identity, playback transport, volume, queue transfer, and common grouping
- Normalize upstream media, player, queue, and playback records into stable bounded Sentient results
- Resolve natural player/room names to stable IDs with explicit not-found and ambiguity results
- Separate observation from mutation impact and route every tool through product-group permissions
- Return semantic outcomes and accepted_unverified when command acknowledgement or observed state cannot prove completion
- Keep granular queue-item insertion/removal/reordering and administrative player configuration advanced/off by default
- Preserve connection recovery without automatically replaying a possibly completed side effect

## Required Work

- Implement a persistent typed MusicAdapter for the native Music Assistant WebSocket API with authentication, request correlation, cancellation, bounded reconnect, runtime response validation, and per-call degradation
- Register compact standard tools for library search, browse, player/room listing, player and now-playing status, queue inspection, direct play by selected media/player identity, playback transport, volume, queue transfer, and common grouping
- Normalize upstream media, player, queue, and playback records into stable bounded Sentient results
- Resolve natural player/room names to stable IDs with explicit not-found and ambiguity results
- Separate observation from mutation impact and route every tool through product-group permissions
- Return semantic outcomes and accepted_unverified when command acknowledgement or observed state cannot prove completion
- Keep granular queue-item insertion/removal/reordering and administrative player configuration advanced/off by default
- Preserve connection recovery without automatically replaying a possibly completed side effect

## Integration Expectation

Deliver this contribution for integration in stage 02-foundations.

## Context

- Conversational music requests require model judgement: search/browse alternatives, inspect players and current queue, directly play a selected result, and transfer playback are common behavior rather than advanced tooling.
- The repository already stores a Music Assistant URL, local host mapping, and token and currently uses a reconnecting MCP fork because upstream WebSocket connections can die permanently.
- All live MA testing must remain observational: library search/browse, player listing, status, and queue inspection are allowed; playback, volume, queue, transfer, and grouping mutations require controlled doubles.

## Boundary — Excluded

- The composed natural-language music_play intent
- Live playback, volume, queue, transfer, or grouping tests
- Removing ma-mcp before the composed flow and final cutover

## Interfaces and Dependencies

- MusicAdapter owns URL/token and exposes typed domain methods; tool inputs never carry credentials or arbitrary WebSocket commands
- Request correlation must not confuse late responses from an evicted connection with a newer connection
- Read operations may retry only when proven not dispatched and safe; mutating operations are never transparently replayed after ambiguity
- Direct play accepts stable media/player identities returned by search/browse/list operations
- Tool results use bounded stable fields rather than raw MA payloads
- Implement only the pre-wired Music provider contribution and Music-owned configuration fragments established in stage 01; do not modify web or Home contributions

## Constraints

- Never log tokens, music queries, library contents, current media details, queue contents, or household player state
- All external WebSocket messages are unknown until validated
- Cancellation closes or detaches the in-flight request without corrupting the shared connection
- Live tests are read-only even against a local Sentient stack with real MA credentials
- Standard primitives remain visible by default when role and permission permit them
