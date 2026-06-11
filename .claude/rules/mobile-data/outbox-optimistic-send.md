---
description: Optimistic send -- in-memory outbox FSM, flush-on-ready, echo reconciliation, per-message retry.
paths:
  - "shared/mobile-data/**/outbox/**"
---

# Outbox & Optimistic Send

A send is optimistic: the user only ever sees "queued → sent", never a spinner on the socket.

- A send enqueues a queued entry with a client-generated id and returns immediately; the bubble renders at once.
- The outbox is an in-memory state machine: `queued → (flushed, internal guard) → removed on committed echo | failed → retry`. There is NO `sent` state. NOT persistent — it dies with the process. Never claim durability.
- Flush is connection-ready-driven, not a background syncer: unflushed QUEUED entries flush on ready; a send while already-ready flushes immediately. The `flushed` guard prevents a reconnect re-fire from re-sending an in-flight entry awaiting its echo.
- Reconcile drops the optimistic copy when the committed echo arrives on the LIVE timeline (still carries `pendingId`). The DB mirror strips `pendingId`; reconcile uses the live echo's `echoedPendingIds`, not the DB.
- Correlate the optimistic entry to its committed echo by the stable client id — exact id match, never text comparison. It is a reconciliation key, NOT a server idempotency key.
- No replay: never re-send a flushed entry, never resurrect a flushed or FAILED id on re-enqueue.
- Failures surface, never silent: disconnect marks UNFLUSHED queued → failed; a flushed (in-flight) entry stays QUEUED — it may already be committed at the gateway. Retry re-queues and clears the flush guard. Keep the id stable across queued → failed → retry.

> When a rule is unclear, read `agents/docs/mobile-data/outbox-optimistic-send-details.md`.
