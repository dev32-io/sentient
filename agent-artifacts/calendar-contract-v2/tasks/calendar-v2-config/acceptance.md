# Task Acceptance: Add operator-controlled calendar V2 safety limits

## Deliverables

- Operators can tune every calendar query, input, paging, recurrence, and model-output bound through validated YAML while safe defaults remain below the generic tool-result backstop.

## Acceptance

- A config omitting new calendar limit blocks receives the pinned safe defaults.
- Invalid zero, negative, excessive, or generic-cap-defeating values are rejected clearly.
- Calendar-specific model output defaults to 16000 characters, leaving room for an actionable error under the 20000-character broker cap.
- No operator or calendar data migrator is introduced.

## Boundary Proof

- Shared config tests cover defaults, explicit values, boundary rejection, and the proactive-output relationship.
- Root typecheck identifies and updates every direct config fixture.
