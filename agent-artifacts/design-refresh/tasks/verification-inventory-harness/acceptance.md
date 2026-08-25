# Task Acceptance: Create the closed refresh inventory and safe text-only verification harness

## Deliverables

- Make every reachable WebUI and iOS surface/state accountable to an implementation owner and provide safe, machine-checkable local evidence infrastructure for the approved text-only E2E matrix.

## Acceptance

- Every reachable WebUI/iOS surface and significant state has exactly one inventory row and planned owner.
- All nine approved E2E cases map exactly once and retain their setup/actions/outcomes/safety contract.
- Fixture setup/cleanup is loopback-only, disposable, idempotent, and leaves no user/session/calendar state after cleanup.
- The iOS text-only path neither grants nor activates microphone and contains no network fault phase.
- The checker rejects production imports from design/prototype and accepts platform-owned copies with recorded canonical hashes.
- No evidence contract permits secrets, private user content, transcript/audio, or production data.

## Boundary Proof

- Schema/checker unit tests include missing row, duplicate case, unsafe target, unsanitized evidence, prototype runtime import, and cleanup-after-failure regressions.
- Fixture tests use temporary local stores or mocked adapter boundaries; no final E2E runs in this task.
