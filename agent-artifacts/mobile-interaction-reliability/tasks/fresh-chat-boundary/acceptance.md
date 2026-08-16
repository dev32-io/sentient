# Task Acceptance: Make cold launch and New Chat establish a fresh conversation boundary

## Deliverables

- Cold launch and every intentional New Chat eagerly prepare a fresh gateway boundary exactly once, keep the composer immediately usable, and prevent the first queued message from entering the prior conversation.

## Acceptance

- Cold launch immediately issues explicit fresh-chat preparation and shows a clear usable composer rather than reattaching the prior conversation
- Every mobile New Chat entry point uses the same explicit preparation path
- An immediate send queues until the gateway attachment arrives and becomes the first message of a distinct durable conversation
- The prior conversation never receives the new marker or model context
- One route entry cannot issue duplicate preparation through recomposition or ViewModel recreation
- Existing rapid-action idempotence/debounce remains bounded and no manual test step is introduced

## Boundary Proof

- Shared connector/SDK/data tests capture intent=explicit, session.draft attachment, retry, and queue isolation
- Android and iOS route/ViewModel tests prove once-per-entry behavior
- Updated local mobile flows support E2E-001, E2E-002, and E2E-003
