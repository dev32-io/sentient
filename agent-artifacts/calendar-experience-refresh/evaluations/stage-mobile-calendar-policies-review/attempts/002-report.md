# Evaluation Report: stage-mobile-calendar-policies-review

## Boundary

{"workItem":"calendar-experience-refresh"}

## Criteria Evaluated

- Nonblocking adjacent prefetch, transactional twelve-month LRU, explicit cached/unavailable offline states, recovery, and isolation
- mobile-calendar-mutations follows and depends on the finalized retention/offline state in this sequential stage
- Exact V2 create/edit/delete recurrence, revision, raw offset-bearing originalStart, conflict, permission, and temporal semantics
- Offline writes produce no optimistic success, queue row, or hidden retry, and shared state supports sentient-design/design/mobile/calendar.html plus sentient-design/components/mobile/sentient-mobile.js without native policy

## Observations

MERGE: NO

Re-review of the bounded repair on 6278c2fad5ab42e2040ecd5239da015c62d63f85 confirms CAL-POL-001, CAL-POL-002, CAL-POL-003, CAL-POL-004, CAL-POL-005, CAL-POL-007, and CAL-POL-009 are resolved by the repair source/tests. Stage checks pass and the worktree is clean.

Blocking residual finding:
- **Major CAL-POL-008:** Registration is mutex-protected, but cancellation cleanup falls back to an asynchronous scope job when `bookkeepingMutex.tryLock()` fails (`CalendarExperience.kt:2474-2503`). Before that cleanup runs, `loadWindow` can find the old active `inFlightRequests` entry (`:1900-1909`) and re-use it without checking its `bookkeepingGeneration`. Navigation into a prefetched window can therefore coalesce the new foreground load into the predecessor that is about to be canceled, causing the new visible revalidation to receive cancellation instead of issuing a fresh request. This leaves request cancellation/coalescing behavior nondeterministic and blocks merge under the manager decision.

## Evidence

- **EV-001:** Sanitized re-review evidence summary. — Reviewed commit and bounded repair identified; worktree clean; all required stage checks PASS.
- **EV-002:** source scripts/env.sh && ./gradlew :shared:mobile-sdk:allTests :shared:mobile-data:allTests --console=plain — PASS
- **EV-003:** source scripts/env.sh && ./gradlew :shared:mobile-data:assembleMobileDataDebugXCFramework --console=plain — PASS
- **EV-004:** source scripts/env.sh && git diff --check — PASS

## Findings

- **CAL-POL-001** (critical, resolved): Repair clears visible state and purges the forbidden namespace.
- **CAL-POL-002** (critical, resolved): Mutation/reread/revalidation continuations use namespace and mutation fences.
- **CAL-POL-003** (high, resolved): Auth failures route through purge and close.
- **CAL-POL-004** (high, resolved): Occurrence updates omit recurrence, including at the SDK wire boundary.
- **CAL-POL-005** (high, resolved): Parser accepts optional seconds while raw wire values remain unchanged.
- **CAL-POL-007** (high, resolved): Submission requires authoritative reread and explicit rebase/review.
- **CAL-POL-008** (high, open): Asynchronous cancellation cleanup permits stale in-flight registration reuse.
- **CAL-POL-009** (low, resolved): Repair adds coverage for the prior listed seams.

## Verdict

fail

## Residual Risk

- No wider pre-existing Major/Minor issues were reopened under the closure-focused re-review boundary.
- Native/platform E2E remains outside this shared-stage boundary; the passing checks cover the declared shared SDK/data checks only.
