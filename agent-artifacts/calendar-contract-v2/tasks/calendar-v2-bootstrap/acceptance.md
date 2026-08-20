# Task Acceptance: Wire calendar V2 services into sessions and REST

## Deliverables

- Session tools, calendar nudge, and HTTP routes receive the same resolved limits, timezone, capability-held stores, query service, and mutation service through existing composition roots.

## Acceptance

- Tools and REST use the same resolved limits/timezone and domain service contracts.
- Private/household authority continues to originate only from AccessManager grants.
- Nudge remains bounded and role-filtered after the store/query refactor.
- Session and request handles close under normal, disabled, and partial-failure paths.
- No legacy database reset or production mutation is introduced.

## Boundary Proof

- Bootstrap and phase-services tests cover config mapping, disabled behavior, capabilities, provider dependencies, nudge behavior, and close/failure cleanup.
- Root typecheck verifies every service/config fixture.
