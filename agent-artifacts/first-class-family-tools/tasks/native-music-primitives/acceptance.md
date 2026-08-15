# Task Acceptance: Expose standard Music Assistant discovery and playback primitives

## Deliverables

- Family members and the model can search, inspect, select, and operate Music Assistant through reliable Sentient-owned standard tools without MA MCP discovery.

## Acceptance

- Standard music definitions are available with ma-mcp absent
- Search and browse return bounded stable media identities suitable for direct play
- Player listing, status, and queue inspection resolve natural rooms and expose ambiguity rather than guessing
- Direct play, transport, volume, transfer, and grouping produce semantic outcomes under a fake adapter
- A dropped connection can reconnect for later operations without permanently losing the music surface
- An ambiguous mutating call is not replayed and returns accepted_unverified
- Granular queue administration remains off and absent by default

## Boundary Proof

- Protocol tests cover authentication, request IDs, concurrent calls, malformed events, disconnect/reconnect, cancellation, late responses, and bounded failures
- Adapter/tool tests cover search, browse, natural player resolution, status, queue inspection, direct play, transport, volume, transfer, grouping, semantic outcomes, and permission mediation
- Fake write tests prove no replay after ambiguous dispatch
- Optional live evidence uses PIN 1234 only against local Sentient and performs MA search/browse/player/status/queue reads—never playback or mutation
