# Task Brief: Add adjacent prefetch, bounded retention, and offline recovery

## Contribution Goal

Shared CalendarExperience asynchronously prefetches adjacent months, retains the twelve most recently viewed complete months, and exposes correct cached, stale, refreshing, and unavailable-offline states.

## Boundary — Included

- Previous/current/next month prefetch scheduling
- Transactional twelve-month LRU retention
- Cached interval navigation and freshness metadata
- Specific unavailable-offline state for uncached windows
- Connectivity-recovery revalidation
- Namespace disposal/purge ordering and tests

## Required Work

- 1. After visible-window observation begins, schedule previous and next month prefetch without blocking or downgrading visible-window state; reuse request coalescing and complete-page atomic replacement.
- 2. Update last-accessed metadata for viewed complete months and transactionally evict least-recently-viewed complete windows until at most twelve remain per account/backend namespace; never evict the active window during its observation transaction.
- 3. Expose fresh, refreshing, stale, cached-offline, and unavailable-offline states. Cached navigation/filtering stays usable offline; an uncached interval has a specific recoverable unavailable state rather than a generic empty result.
- 4. Treat prefetch failure as non-fatal to the visible interval and retain only sanitized structural diagnostics.
- 5. On connectivity recovery or explicit refresh, revalidate the active stale window through the same shared path and resume adjacent prefetch without native orchestration.
- 6. On logout, account replacement, backend change, or auth expiry, cancel observation/prefetch before transactional purge or namespace switch and close the driver so old private data cannot emit into the next session.
- 7. Add deterministic coroutine/SQLDelight tests for nonblocking prefetch, prefetch failure, request coalescing, twelve-month LRU order, active-window protection, cached offline navigation, uncached state, recovery, and account/backend isolation.

## Integration Expectation

Deliver this contribution for integration in stage mobile-calendar-retention-offline.

## Context

- The shared read coordinator already owns complete visible-window revalidation and SQLDelight observation. This task extends that same shared boundary; native clients must not schedule prefetch or eviction.
- Exact mobile references are sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js. Their visual offline/freshness treatment is adapted later, but the shared state must distinguish every required condition without prototype status strings.
- Offline browsing is included; offline create/edit/delete queueing is explicitly excluded.

## Boundary — Excluded

- Offline mutation queue, retries, or optimistic success
- Native connectivity orchestration
- Platform database path setup
- UI rendering
- Web cache

## Interfaces and Dependencies

- Extends CalendarExperience and CalendarCacheStore metadata/purge operations.
- Produces bounded-cache/freshness/offline state consumed by shared mutations and native clients.
