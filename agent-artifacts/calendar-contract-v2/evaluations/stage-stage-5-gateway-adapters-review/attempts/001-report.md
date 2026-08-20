# Evaluation Report: stage-stage-5-gateway-adapters-review

## Boundary

{"workItem":"calendar-contract-v2"}

## Criteria Evaluated

- All six tool schemas, stable tiers, pre-PDP household gate, actionable errors, and proactive caps
- REST V2 route replacement, paging, authentication, error mapping, and handle closure
- Tool and REST adapters share domain behavior without loopback or hidden-data leakage

## Observations

## Review verdict

The stage-5 gateway adapter review cannot be approved.

## Major finding

REST paging currently applies the calendar model-result character budget to the count-limited aggregate before returning a deterministic REST page. A valid REST query can therefore return HTTP 413 instead of `events` plus `nextCursor`. The proactive `output.max_result_chars` contract is model-tool-specific; REST must page according to `query.page_size` and must not be rejected because the complete bounded aggregate exceeds the model serialization budget.

## Required correction

Separate tool completeness/serialization enforcement from REST paging. REST should sort the complete bounded aggregate, apply the cursor, serialize at most one configured page, and provide opaque continuation metadata when more events remain. Keep aggregate occurrence limits and generic HTTP safety boundaries intact.

## Evidence

None recorded.

## Findings

- **STAGE5-001** (high, open): REST paging can return 413 instead of events plus nextCursor because the model-result character cap is applied to the full count-limited aggregate.

## Verdict

fail

## Residual Risk

None recorded.
