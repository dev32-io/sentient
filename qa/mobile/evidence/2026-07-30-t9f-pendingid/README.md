# NM-T9f — D13 + D14 device evidence (Android emulator-5554, 2026-07-30)

## Store schema after the fix (per-user DB, real path)
```
PRAGMA user_version;            -> 1
pending_id column present?      -> 1
```

## D14 — duplicate user entries, counted (never eyeballed)
```
user entries total / carrying pending_id : 17 / 15
duplicate (session_id, pending_id) groups: 0
```
Same-text groups among post-fix rows, with their DISTINCT pendingId count (proves they are
separate sends, not duplicates):
```
text_len|rows|distinct_pending_ids
72|2|2
25|2|2
16|3|3
18|4|4
18|2|2
```

Pre-fix rows survive in the same table as the control: seq 1 and 2 are ONE message
("turn on the kitchen light") committed TWICE inside ONE turn_id with pending_id NULL,
written by the pre-fix gateway during this same task. Worst group in the pre-reset store
was 30x one message (9 duplicate groups / 53 rows) — the original report said 2-6x.

## D13 — android/12-permission-confirm, flow UNEDITED
```
Assert that id: chat-permission-allow is visible... COMPLETED
Assert that id: chat-permission-description is visible... COMPLETED
Tap on id: chat-permission-allow... COMPLETED
Assert that id: chat-permission-allow is not visible... COMPLETED
Assert that id: assistant-bubble is visible... COMPLETED
```

## Final Android `chat` batch — 6/6 (was 5/6 after 9e, 0/6 at T10)
```
[Passed] 01-chat-send (18s)
[Passed] 01-send-stream (18s)
[Passed] 03-new-chat (11s)
[Passed] verify-newchat (20s)
[Passed] 05-interrupt (30s)
[Passed] 12-permission-confirm (23s)
6/6 Flows Passed in 2m
```

## reload-convergence / restart-persistence — re-driven, counted three ways
```
projectForClient over the live DB          : 25 feed items
device cold relaunch (logcat)              : snapshot-legacy count=25
gateway (LOG_DIR)                          : turn-emitter.conversation-snapshot itemCount=25
```
After a real native gateway process restart (kill + `bun --hot src/main.ts`):
```
[ws:resume] resume.not-recovered  reason="fresh-journal-or-epoch-mismatch"
[ws:turn-emitter] turn-emitter.conversation-snapshot  itemCount=25
[store:session-store] store.opened  userId="u_0417d3b0" schemaVersion=1
```

## Migration proven against a REAL pre-migration artifact
A copy of the QA user's own 166-row `sessions.db`, taken before any change, opened through
`openSessionStore`:
```
BEFORE: PRAGMA user_version=0 · pending_id column absent · 166 rows
AFTER : PRAGMA user_version=1 · pending_id column present · 166 rows · reads still serve
```
