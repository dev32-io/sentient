# Notification inbox retention

Notification cards are durable, user-owned rows in the configured per-user database (`sessions.db` by default), alongside sessions, scheduling and private calendar data. `notification_cards` holds occurrence and session references with foreign keys; previews are read from canonical assistant entries, not copied into an inbox or push store.

## Admission and clear

Scheduled finalization inserts the card in the same transaction as the occurrence terminal outcome, schedule advance/consumption and optional delivery outbox row. Completed, failed and interrupted session-backed outcomes produce cards; expired unexecuted occurrences do not. Finalization replay returns the existing terminal result without inserting another card. Session history alone never recreates dismissed cards.

Bulk clear accepts frozen occurrence IDs selected by the client. Only those rows are removed, so arrivals before or during the request remain eligible. Session-target clear remains available for acknowledged notification navigation; scheduled session provenance cannot be reassigned to a different occurrence. Clearing cards does not delete sessions, entries, schedules, occurrences or delivery receipts.

## Retention

`scheduling.inbox_max_entries` and `scheduling.inbox_retention_ms` bound retained rows. Expiry and count eviction delete notification rows, not source history. Later finalization admits a new card even if its completion timestamp sorts below an earlier card; replay of an already finalized occurrence does not readmit an evicted card. Increasing retention settings cannot resurrect deleted rows.

The former scheduling-database candidate cache, source high-water mark and cross-file history import are not inbox authority. Global push bindings/delivery receipts remain separate from user-visible inbox state. APNs is an invalidation hint; clients silently fetch authoritative REST cards on foreground push, inbox entry and resume.
