# Task Acceptance: Implement shared cache-first calendar observation and revalidation

## Deliverables

- One shared CalendarExperience loads persisted preferences and complete cached months immediately, then performs explicit authorized-all paginated revalidation and emits fresh state atomically to both native clients.

## Acceptance

- Cached content and preferences emit before a delayed remote response and remain visible during refresh/failure.
- Only complete explicit-all remote intervals replace cache, in one transaction and natural query emission.
- Android and iOS need no native fetch, pagination, filtering, or cache orchestration.
- The shared component API remains source-compatible until platform drivers are wired, and the Android app continues to compile at this stage.
- Errors remain typed and diagnostics contain no event/filter content.

## Boundary Proof

- Shared tests pin CAL-UX-001/002/003 complete reads and preferences plus CAL-UX-008 cache-first sequence.
- Tests prove failed/cancelled aggregation leaves the old snapshot intact and equivalent requests coalesce.
- Android assemble plus XCFramework generation prove the intermediate shared API remains consumable before platform driver tasks.
- State inspection confirms it carries every supported state needed to render the exact mobile reference paths, including freshness, without prototype-only fields.
