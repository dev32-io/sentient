# Evaluation Report: stage-contracts-and-harness-review

## Boundary

{"workItem":"design-refresh"}

## Criteria Evaluated

- Exact v2 values/projection determinism and Android v1 compatibility
- Capture commit/cancel security, terminal races, legacy wire compatibility, and content-free logs
- Closed inventory, loopback-only fixtures, prototype-reference-only enforcement, and text-only E2E safety

## Observations

MERGE: NO

Closure-focused re-review of repair 3f6491bb74dfd51dbd9734c948a6dfaffcccf78c..259d8fff9b94bf087aca87d95370c6e0baac4318.

Prior finding verification:
- STAGE-001: original permanent-wedge trigger resolved, but its repair introduced blocking STAGE-006.
- STAGE-002: resolved; multiline imports and runtime URL/Bundle references are now content-aware and tested.
- STAGE-003: resolved; inventory coverage now comes from platform-owned Web/iOS reachability registries and verifies paths/status.
- STAGE-004: resolved by bounded source evidence; E2E-009 changes and reasserts a persisted representative filter.
- STAGE-005: resolved; the committed JSON Schema is now evaluated with schema-only negative cases.

Blocking result:
- STAGE-006 (Major, blocking): the STT repair clears a committing capture after any post-End callback, including non-terminal turn_started. A subsequent final transcript is therefore dropped. A fresh synthetic ordering probe reproduced zero submissions.

All prescribed stage checks passed, including 40 focused gateway tests, foundation/inventory checks, protocol/Web SDK tests, typecheck, QA/calendar tests, Android KMP compilation, shell syntax, and diff check. Final E2E was not executed or inferred.

## Evidence

- **EV-001:** bun run design:foundation:check; bun run design:inventory:check; protocol/Web SDK tests; focused gateway tests; bun run typecheck; QA/calendar tests; Android KMP compile; shell syntax; diff check — All passed.
- **EV-002:** Sanitized local probe demonstrating the repair-introduced transcript loss. — {"submittedCount":0}

## Findings

- **STAGE-001** (high, resolved): Original semantic stream-failure wedge is terminalized by the repair.
- **STAGE-002** (high, resolved): Content-aware scanner now catches tested multiline imports, URLs, and native bundle references.
- **STAGE-003** (high, resolved): Inventory is now checked against platform-owned source registries with implementation path/status agreement.
- **STAGE-004** (high, resolved): The flow now applies and reasserts a persisted private-scope filter.
- **STAGE-005** (medium, resolved): AJV evaluates the committed schema and schema-only negative cases.
- **STAGE-006** (high, open): Repair treats non-terminal turn_started after End as terminal and drops the later committed transcript.

## Verdict

fail

## Residual Risk

- Final E2E was intentionally not executed in this stage re-review; no matrix case is inferred passed.
- The E2E-009 Maestro selector/state assertion was verified against current Swift accessibility identifiers but not executed on a simulator.
- Existing Gradle cinterop/commonization and configuration-time warnings remain non-blocking; compilation succeeds.
