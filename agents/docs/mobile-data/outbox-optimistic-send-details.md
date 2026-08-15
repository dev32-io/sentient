# Outbox and optimistic send details

This file expands `.claude/rules/mobile-shared.md` for optimistic sends.

`OutboundCache` is VM-owned, in-memory state. It is not a repository, durable store, or process-death recovery mechanism. Each entry keeps one stable `pendingId` across enqueue, failure, and retry.

The visible states are `QUEUED` and `FAILED`; there is no `SENT` state. `markSent` records an internal timestamp while the entry remains queued. Current failure transition is timeout-driven through `sweepTimeouts()`; there is no disconnect-wide `failAll()` path. Retry clears the timestamp and queues the entry again.

Flush all queued entries when ready and when sending on an already-ready connection. Reconnect resends are safe because the gateway deduplicates by `pendingId`. Remove an optimistic entry only on the exact echoed id. A cold authoritative history replacement may drop remaining optimistic entries because that snapshot does not carry the pending id. Never reconcile by message text.
