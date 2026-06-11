---
description: Optimistic send -- in-memory outbox FSM, flush-on-ready, echo reconciliation, per-message retry.
paths:
  - "shared/mobile-data/**/outbox/**"
---

# Outbox & Optimistic Send

A send is optimistic: the user only ever sees "queued → sent", never a spinner on the socket.

- A send enqueues a queued entry with a client-generated id and returns immediately; the bubble renders at once.
- The outbox is an in-memory state machine: `queued → (markSent records sentAtMs, still queued) → removed on committed echo | failed (disconnect OR unacked-timeout) → retry → queued`. There is NO `sent` state and NO flushed guard. NOT persistent — it dies with the process. Never claim durability.
- Flush is connection-ready-AND-id-attached driven, not a background syncer: QUEUED entries flush when the connection is ready and the conversation id is attached; a send while already-ready flushes immediately.
- Resend is safe: the gateway dedups by `pendingId`, so a reconnect re-sends ALL queued entries (including already-sent-but-unechoed ones) without creating duplicates. There is no resend guard.
- `sentAtMs` records when an entry was handed to the transport; it is used ONLY by `sweepTimeouts` — any QUEUED entry whose `sentAtMs` is older than the unacked timeout is swept to FAILED so the user never sees a forever-"Sending".
- Reconcile drops the optimistic copy when the committed echo arrives on the in-memory timeline (carries `pendingId`). Reconcile uses the live echo's `echoedPendingIds` from that in-memory timeline — there is no DB.
- Cold-reconcile: a COLD REST history snapshot (existing-conversation switch reload / `recovered:false` refetch) is authoritative history from Hermes and carries NO `pendingId`, so reconcile-by-pendingId can't drop the optimistic copy → a duplicate bubble. On the cold-replace signal (`ObserveChatUseCase.coldHistoryReplaceSignal`) the usecase drops every still-present optimistic entry (`onColdHistoryReplace`) — they're now in the authoritative history, or were already swept to FAILED by the unacked-timeout.
- Correlate the optimistic entry to its committed echo by the stable client id — exact id match, never text comparison. The same `pendingId` serves double duty: the client reconcile key AND the gateway's server idempotency key (it dedups resends by it).
- Failures surface, never silent: disconnect fails any QUEUED entry (sent or unsent); unacked-timeout sweep fails sent-but-unechoed entries. Retry re-queues and clears `sentAtMs`. Keep the id stable across queued → failed → retry.
- No resurrection: re-enqueuing an existing id (QUEUED or FAILED) is a no-op.

> When a rule is unclear, read `agents/docs/mobile-data/outbox-optimistic-send-details.md`.
