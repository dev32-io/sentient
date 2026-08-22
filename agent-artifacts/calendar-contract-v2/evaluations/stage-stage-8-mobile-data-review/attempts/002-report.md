# Evaluation Report: stage-stage-8-mobile-data-review

## Boundary

{"workItem":"calendar-contract-v2"}

## Criteria Evaluated

- Stateless repository and exhaustive SentientResult/StateFlow behavior
- One-call mixed-kind V2 reads, cursor propagation, and typed recurring mutation use case
- Untouched platform UI compatibility and content-free diagnostics

## Observations

MERGE: NO

Re-review of the bounded repair: CAL-MOBILE-002 is resolved. HTTP 401 responses now map to SentientError.Auth with a content-free message, and focused mobile-data/mobile-sdk tests pass. CAL-MOBILE-001 remains open: Android now uses the scope/revision-carrying delete(event) adapter, but the existing iOS caller still invokes delete(id:), whose command omits both scope and expectedRevision. Household iOS deletes therefore still target private storage and lack stale-write protection. The remaining Major finding blocks merge.

## Evidence

- **EV-001:** Fresh focused mobile-data tests pass. — BUILD SUCCESSFUL
- **EV-002:** Fresh focused mobile-sdk calendar tests pass. — BUILD SUCCESSFUL
- **EV-003:** Fresh declared compile and diff checks pass. — BUILD SUCCESSFUL; diff check clean
- **EV-004:** Prior Major finding remains open for the untouched iOS caller. — iOS calls delete(id:) and the id-only adapter emits ENTIRE_SERIES without scope or expectedRevision.

## Findings

- **CAL-MOBILE-001** (high, open): Repair is partial: iOS still discards the selected event scope and revision and calls the unsafe id-only delete adapter.
- **CAL-MOBILE-002** (low, resolved): 401 Server responses now map to a stable content-free authentication failure.

## Verdict

fail

## Residual Risk

- Fresh checks emit existing Gradle configuration-time and cinterop-commonization warnings; they do not fail the checks.
- No iOS compilation was part of the declared Stage 8 checks, so the repaired Swift/Kotlin interop path was not compiled here.
