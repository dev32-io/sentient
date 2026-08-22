# Evaluation Report: stage-stage-8-mobile-data-review

## Boundary

{"workItem":"calendar-contract-v2"}

## Criteria Evaluated

- Stateless repository and exhaustive SentientResult/StateFlow behavior
- One-call mixed-kind V2 reads, cursor propagation, and typed recurring mutation use case
- Untouched platform UI compatibility and content-free diagnostics

## Observations

MERGE: NO

The focused tests, shared/Android compilation, and diff check pass. However, the existing delete convenience path loses the event's household scope (and revision): current Android callers pass only the ID, while the REST handler defaults omitted mutation scope to private, making household deletes fail as not-found and removing stale-conflict protection. Calendar 401 responses also fall through to a generic protocol error rather than the intended auth failure; this is non-blocking but should be corrected.

## Evidence

- **EV-001:** Focused Calendar mobile-data tests pass. — BUILD SUCCESSFUL
- **EV-002:** Declared shared/Android compile and whitespace checks pass. — BUILD SUCCESSFUL; diff check clean
- **EV-003:** Concrete source evidence for the blocking delete adapter defect. — Delete sends no scope/revision; VM passes only event ID; handler defaults omitted scope to private.

## Findings

- **CAL-MOBILE-001** (high, open): Delete convenience commands omit calendar scope and expected revision, so current household callers target private storage and lose stale conflict protection.
- **CAL-MOBILE-002** (low, open): Calendar 401 responses are AuthError.Server and map to a generic calendar protocol error; the InvalidCredentials branch is unreachable through CalendarHttpClient.

## Verdict

fail

## Residual Risk

- CalendarDataTest does not cover delete scope/revision propagation or session-expiry mapping.
- The Gradle checks emit existing configuration-time resolution and cinterop-commonization warnings, but they do not fail the declared checks.
