# Evaluation Report: stage-mobile-calendar-policies-review

## Boundary

{"workItem":"calendar-experience-refresh"}

## Criteria Evaluated

- Nonblocking adjacent prefetch, transactional twelve-month LRU, explicit cached/unavailable offline states, recovery, and isolation
- mobile-calendar-mutations follows and depends on the finalized retention/offline state in this sequential stage
- Exact V2 create/edit/delete recurrence, revision, raw offset-bearing originalStart, conflict, permission, and temporal semantics
- Offline writes produce no optimistic success, queue row, or hidden retry, and shared state supports sentient-design/design/mobile/calendar.html plus sentient-design/components/mobile/sentient-mobile.js without native policy

## Observations

MERGE: YES

Iteration 2 re-review of the bounded repair passes. CAL-POL-008 is resolved: the AtomicReference request registry makes registration, replacement, removal, and cancellation linear; lookup rejects stale/inactive entries; completion removes only the matching Deferred identity. The requested cancel→same-key, namespace away/back, old-finally, and concurrent coalescing tests are present and pass. All prior findings are now resolved. Required stage checks pass and the worktree is clean.

## Evidence

- **EV-001:** Sanitized re-review evidence summary. — Reviewed commit f953e6e625aca1859e02fcddfec04fa3c663ba8e; bounded repair verified; worktree clean; all required checks PASS.
- **EV-002:** source scripts/env.sh && ./gradlew :shared:mobile-sdk:allTests :shared:mobile-data:allTests --console=plain — PASS
- **EV-003:** source scripts/env.sh && ./gradlew :shared:mobile-data:assembleMobileDataDebugXCFramework --console=plain — PASS
- **EV-004:** source scripts/env.sh && git diff --check — PASS

## Findings

- **CAL-POL-001** (critical, resolved): Forbidden refresh clears visible state and purges its namespace.
- **CAL-POL-002** (critical, resolved): Mutation and reread continuations are fenced by namespace and mutation generation.
- **CAL-POL-003** (high, resolved): Auth failures route through invalidation, purge, and close.
- **CAL-POL-004** (high, resolved): Occurrence updates omit recurrence at both builder and SDK wire boundaries.
- **CAL-POL-005** (high, resolved): Optional seconds are accepted while raw wire spelling is preserved.
- **CAL-POL-007** (high, resolved): Submission requires authoritative reread and explicit rebase/review.
- **CAL-POL-008** (high, resolved): Atomic request registry prevents stale reuse and old completion removal of replacements.
- **CAL-POL-009** (low, resolved): Repair coverage includes the required interleavings and prior mutation seams.

## Verdict

pass

## Residual Risk

None recorded.
