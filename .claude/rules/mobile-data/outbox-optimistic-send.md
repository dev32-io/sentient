---
description: Optimistic send -- in-memory outbox FSM, flush-on-ready, echo reconciliation, per-message retry.
paths:
  - "shared/mobile-data/**/outbox/**"
---

# Outbox & Optimistic Send

A send is optimistic: the user only ever sees "queued → sent", never a spinner on the socket.

- A send enqueues a queued entry with a client-generated id and returns immediately; the bubble renders at once.
- The outbox is an in-memory state machine: queued → sent → failed. NOT persistent — it dies with the process. Never claim durability.
- Flush is connection-ready-driven, not a background syncer: queued entries flush on ready, and a send while already-ready flushes immediately.
- Correlate the optimistic entry to its committed echo by the stable client id — exact id match, never text comparison. It is a reconciliation key, NOT a server idempotency key.
- No replay: never re-send a sent entry, never resurrect a non-queued one.
- Failures surface, never silent: disconnect marks queued → failed; retry re-queues. Keep the id stable across queued → failed → retry.

> When a rule is unclear, read `agents/docs/mobile-data/outbox-optimistic-send-details.md`.
