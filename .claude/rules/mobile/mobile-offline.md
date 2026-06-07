---
description: Mobile offline-first -- observable connection, optimistic in-memory outbox, echo reconciliation.
paths:
  - "android/**"
  - "ios/**"
  - "shared/mobile-data/**"
---

# Mobile Offline-First

Connectivity is intermittent. A send must never block on the socket, and a dropped connection must never lose user intent or surface as a dead-end.

## Connection state — observable, every feature branches

- Reachability is a value the UI subscribes to (derived from the SDK connection surface, wrapped in the result envelope). It changes mid-screen.
- Every feature branches on it: loading renders last-known, success renders live, failure renders a banner/affordance.

## Writes — optimistic in-memory outbox

- A send is optimistic: it enqueues a queued entry and returns immediately; the user sees "queued → sent", never a spinner.
- The outbox is an in-memory state machine flushed on connection-ready, not a background syncer. It is NOT persistent — it lives for the chat scope.
- Failures surface, never silent: on disconnect, queued sends fail and stay visible with a per-message retry.

## Reconcile — by echo, not by server idempotency

- Correlate the optimistic entry to its committed echo by a stable client id; drop the optimistic copy on exact id match. No text comparison, no server-side replay contract.

## Reads — cache-then-refresh

- Emit a cached partial first (instant paint), then the refreshed result. The cache is in-memory; it is not yet durable.

## Auth — survives drops

- A drop or idle-disconnect keeps the user in session (token preserved); only logout / auth-expiry clears local state. Sign-out clears credentials immediately.

- Persistence is the principle the details file targets; today the outbox and cache are in-memory. See the details file for the durable-store roadmap.

> When a rule is unclear, read `agents/docs/mobile/mobile-offline-details.md`.
