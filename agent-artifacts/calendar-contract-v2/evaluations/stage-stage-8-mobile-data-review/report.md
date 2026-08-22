# Evaluation Report: stage-stage-8-mobile-data-review

## Boundary

{"workItem":"calendar-contract-v2"}

## Criteria Evaluated

- Stateless repository and exhaustive SentientResult/StateFlow behavior
- One-call mixed-kind V2 reads, cursor propagation, and typed recurring mutation use case
- Untouched platform UI compatibility and content-free diagnostics

## Observations

## Recovery review verdict

Approved after user-directed recovery of the failed fixer work.

CAL-MOBILE-001 is resolved. The legacy id-only delete path now resolves one selected event from current use-case state or an authoritative scope-all get, then issues the whole-series mutation with the event's exact writable scope and current revision. Missing or ambiguous resolution fails before mutation. The event-aware path remains direct, repositories remain stateless, and the net workflow diff leaves Android and iOS ViewModel/UI sources unchanged.

CAL-MOBILE-002 remains resolved: HTTP 401 maps to a stable content-free authentication failure.

During recovery, a JVM erasure clash in two helper overloads and a stale-conflict test fixture were corrected. Focused mobile-data and mobile-sdk tests, shared/Android compilation, root typecheck through commit hooks, secrets checks, and diff checks passed.

## Evidence

- **EV-001:** Calendar mobile-data behavior including id-only household/private resolution, failure-before-mutation, and stale conflict. — pass
- **EV-002:** Calendar SDK and privacy regressions. — pass
- **EV-003:** Shared SDK, mobile-data, and unchanged Android consumer compilation. — pass
- **EV-004:** Whitespace, secret scanning, and root TypeScript typecheck passed. — pass

## Findings

- **CAL-MOBILE-001** (high, resolved): The id-only adapter resolves exact event scope/revision before mutation and fails closed when it cannot do so; platform UI sources remain unchanged in the net workflow diff.
- **CAL-MOBILE-002** (low, resolved): 401 responses map to a stable content-free authentication failure.

## Verdict

pass

## Residual Risk

None recorded.
