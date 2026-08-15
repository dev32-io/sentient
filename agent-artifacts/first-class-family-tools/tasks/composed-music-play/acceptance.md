# Task Acceptance: Play natural-language music in a room with one tool call

## Deliverables

- A common request such as “play some lo-fi music in the living room” resolves content and player, starts playback, and reports a verified semantic outcome through one music_play invocation.

## Acceptance

- An unambiguous fake-library request for lo-fi in a uniquely named living-room player completes with one music_play invocation and returns playing after observed verification
- The default starts the selected media now using replace semantics without requiring the model to search, list players, clear a queue, and play as separate calls
- Ambiguous room or media resolution returns bounded candidates and performs no mutation
- Unavailable player or no matching content performs no mutation and returns a specific outcome
- Acknowledged but unverifiable playback returns accepted_unverified and is not retried
- The model can still use standard search/browse/status/queue/direct-play/transfer tools when it needs judgement or refinement

## Boundary Proof

- State-machine tests drive room and media resolution, each queue mode, minimal operation ordering, verification, cancellation windows, all semantic outcomes, and no retry
- Broker tests prove one permission decision, no internal recursive dispatch, off/deny/ask behavior, and accurate permission description
- No live MA write evidence is collected; local real-service checks remain limited to observational primitives
