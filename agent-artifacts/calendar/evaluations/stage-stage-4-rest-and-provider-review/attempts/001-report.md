# Evaluation Report: stage-stage-4-rest-and-provider-review

## Boundary

{"workItem":"calendar"}

## Criteria Evaluated

- REST authority from authenticated principal (configured household), serving-tz rendering, request-scoped close, and golden-fixture wire convergence
- Pre-PDP household-write rejection (no permission.request, zero confirm calls, zero store calls) and tool tier/role reachability

## Observations

MERGE: NO
Fresh typecheck and declared stage tests pass (84 tests, 0 failures), but the bounded REST/provider implementation has five blocking Major defects: REST list wire output leaks Occurrence-only fields and fails the strict shared schema; REST omits required tags filtering; partial REST store opening can leak the first handle before entering finally; malformed/incomplete recurrence data can bypass provider validation on create/update; and calendar_search silently ignores group/tags/importance filters.

## Evidence

- **EV-001:** cd gateway && bun run typecheck — pass
- **EV-002:** Declared stage checks; sanitized summary only. — pass: 84 tests, 0 failures

## Findings

- **CAL-REST-001** (high, open): GET list serializes Occurrence-only fields, violating the strict shared calendar response shape.
- **CAL-REST-002** (high, open): REST list has no tags filter parsing or propagation.
- **CAL-REST-003** (high, open): If the second store open throws, the first opened store is leaked because both opens precede finally.
- **CAL-TOOL-001** (high, open): Nested update recurrence bypasses validation, and create/update accept incomplete raw/parsed recurrence objects.
- **CAL-TOOL-002** (high, open): calendar_search silently ignores group, tags, and importance despite accepting those arguments.

## Verdict

fail

## Residual Risk

- Targeted calendar REST/provider behavioral coverage is largely absent: only the missing-bearer handler test ran in the calendar handler file, and no calendar provider test file was found. Full CRUD, golden-wire, close-on-failure, recurrence, and filter regressions remain unpinned.
