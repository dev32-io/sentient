# Task Acceptance: Normalize human calendar time and enforce query/input bounds

## Deliverables

- Calendar boundaries can turn concise model/REST temporal strings into deterministic internal windows or actionable typed failures before any storage work.

## Acceptance

- Every approved temporal precision normalizes deterministically.
- Missing, impossible, offset-free timed, incompatible, inverted, and over-wide values fail before a store is called with an actionable stable code.
- Date-period expansion and recurring wall-clock anchoring use the configured household timezone rather than the host's implicit timezone or a fixed offset.
- No validation message or diagnostic log includes calendar content.

## Boundary Proof

- Pure unit tests exercise all accepted precisions and each failure family with a fake timezone/limit configuration.
- A store spy proves invalid ranges never reach persistence.
