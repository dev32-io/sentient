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

Stage checks pass, but the bounded mobile policy/mutation implementation has blocking security, wire-contract, temporal, conflict-recovery, and concurrency defects.

Findings:
- Critical CAL-POL-001: A forbidden visible-window refresh retains and continues exposing the cached projection/occurrences instead of invalidating security-sensitive cache fallback (CalendarExperience.kt:1513-1557).
- Critical CAL-POL-002: Namespace switching cancels mutation/reread jobs without a namespace/generation fence; cancellation-resistant or racing completions can emit old-session outcomes/content into the successor state (CalendarExperience.kt:604-650, 768-864, 2127-2170).
- Major CAL-POL-003: Mutation/create/conflict Auth failures only set a typed error and do not invoke the read path's purge-and-close auth-expiry handling (CalendarExperience.kt:780-850, 987-1002).
- Major CAL-POL-004: Every update emits a recurrence patch, including this_occurrence; the V2 gateway forbids recurrence in occurrence-scoped changes, so single-occurrence edits fail (CalendarMutations.kt:467-480; gateway types.ts:377-386).
- Major CAL-POL-005: kotlin.time.Instant.parse rejects valid V2 offset timestamps without seconds, breaking valid raw timed reads/projections and mutation drafts (CalendarMutations.kt:565-579; CalendarExperience.kt:1816-1822; CalendarProjection.kt:504-508).
- Major CAL-POL-007: Conflict submission is not gated on reread/review, and reread does not replace the stale target revision; UpdateDraft restores the stale revision, leaving no shared intentional retry path (CalendarExperience.kt:420-445, 592-650).
- Major CAL-POL-008: Coalescing/prefetch/access bookkeeping uses unsynchronized mutable maps across Default/UI paths, and a fast foreground completion can trigger a second current-window fetch (CalendarExperience.kt:211-219, 1583-1594, 1888-1934, 1980-1989).
- Minor CAL-POL-009: Mutation tests do not cover the serialized occurrence-update shape, create success, all delete scopes, typed permission/auth/not-found failures, or mutation continuation isolation, allowing these regressions through.

The SQLDelight atomic replacement/LRU tests and stage verification are green, but they do not offset the unmet acceptance requirements above.

## Evidence

- **EV-001:** Sanitized stage verification summary. — Reviewed commit 65ce4fe4a9de11bcffbf3a117f2176ba4b33f1a5; clean worktree; stage tests, XCFramework assembly, and diff check all PASS.
- **EV-002:** Sanitized temporal compatibility probe. — V2 permits optional seconds; Kotlin Instant.parse rejects HH:mm offset values and accepts HH:mm:ss values.
- **EV-003:** source scripts/env.sh && ./gradlew :shared:mobile-sdk:allTests :shared:mobile-data:allTests — PASS
- **EV-004:** source scripts/env.sh && ./gradlew :shared:mobile-data:assembleMobileDataDebugXCFramework — PASS
- **EV-005:** source scripts/env.sh && git diff --check — PASS

## Findings

- **CAL-POL-001** (critical, open): Forbidden refresh retains cached private projection and occurrences.
- **CAL-POL-002** (critical, open): Mutation/conflict continuations have no namespace generation fence.
- **CAL-POL-003** (high, open): Mutation Auth failures do not purge/close the expired session cache.
- **CAL-POL-004** (high, open): this_occurrence updates send forbidden recurrence=null/value fields.
- **CAL-POL-005** (high, open): Valid offset timestamps without seconds are rejected.
- **CAL-POL-007** (high, open): Conflict flow permits blind stale resubmission and cannot adopt authoritative revision.
- **CAL-POL-008** (high, open): Unsynchronized bookkeeping and fast-completion path defeat coalescing/cancellation.
- **CAL-POL-009** (low, open): Critical mutation wire, permission, and isolation seams lack tests.

## Verdict

fail

## Residual Risk

- The explicit CalendarCacheFreshness.UNAVAILABLE_OFFLINE enum is not assigned by the uncached path; it uses legacy OFFLINE while separate offline/error fields carry the unavailable distinction.
- No native/platform E2E was in this stage boundary; later stages must not assume shared mutation/isolation defects are covered by these package checks.
