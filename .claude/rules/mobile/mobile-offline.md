---
description: Mobile offline-first -- observable network, local cache, idempotent outbox sync.
paths:
  - "android/**"
  - "ios/**"
  - "shared/mobile-sdk/**"
---

# Mobile Offline-First

Connectivity is intermittent by default. Features that only work online ship broken.

## Network state — observable, every feature branches

- Reachability is a value the UI subscribes to; it changes mid-screen.
- Every feature has an offline branch: cache read, queued write, pending indicator.
- Offline behavior is tested. No test = undefined behavior.

## Reads — cache to a local store

- Server responses written to persistent store on arrival; subsequent reads hit cache first.
- Cache entries carry fetched-at timestamps. UI shows freshness honestly.
- Stale-while-revalidate is the default.

## Writes — queue to a local outbox

- Each write produces two records: optimistic local mutation + outbox entry.
- Outbox is persistent; survives process death; background syncer drains on reconnect.
- Affected items show "pending sync" until success; failures surface, not silently retry-forever.

## Sync — idempotent on reconnect

- Every outbox entry has a stable client-generated operation ID; replays are no-ops server-side.
- Order preserved within a related stream; parallel across unrelated streams.
- Conflicts resolved with a named strategy per resource (LWW, server-wins, surface-to-user); written + tested.

## Auth — survives offline

- Expired token while offline is not fatal: queued writes wait, reads use cache, refresh on reconnect.
- Sign-out works offline: clears local state immediately; queues server revocation.

- Platform storage and sync APIs differ; the principle of local-first cache + idempotent outbox applies on both. See the details file for concrete Android and iOS stacks.

> When a rule is unclear, read `agents/docs/mobile/mobile-offline-details.md`.
