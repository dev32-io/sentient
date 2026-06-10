# Device Chat Mirror — Details

The device chat mirror (Slice 4) gives the app instant-paint-on-launch from a local SQLDelight DB, with the SDK/REST refresh layered on. Two stateful caching decorators implement it: `CachingConversationRepository` and `CachingSessionsRepository`. Both sit behind the existing `ConversationRepository` / `SessionsRepository` interfaces; `ChatComponent` wires them in — ViewModels and usecases are unchanged.

**Privacy:** the transcript DB (SQLDelight) + the resume cursor (multiplatform-settings) are UNENCRYPTED on-device. This is acceptable for the family-device threat model — the device itself is the trust boundary. If the threat model ever extends to a lost / unlocked device, move the DB behind SQLCipher (Android) / `NSFileProtectionComplete` (iOS) and encrypt the settings store.

## File Map

| File | Role |
|------|------|
| `shared/mobile-data/.../data/CachingConversationRepository.kt` | DB-backed timeline + write-through + delete-on-switch |
| `shared/mobile-data/.../data/CachingSessionsRepository.kt` | Pull-based cache-then-refresh + smart-async deletion |
| `shared/mobile-data/.../cache/db/ChatDatabase.sq` | SQLDelight schema: `message`, `session` tables + all queries |
| `shared/mobile-data/.../cache/db/DatabaseDriverFactory.kt` | `expect` factory; `actual`s in androidMain + iosMain |
| `shared/mobile-data/.../data/IoDispatcher.kt` | `expect fun ioDispatcher()`: Android → `Dispatchers.IO`; iOS → `newSingleThreadContext("sentient-db-io")` |
| `shared/mobile-data/.../cache/SyncCursorStore.kt` | Durable per-conversation resume cursor over multiplatform-settings |
| `shared/mobile-data/.../cache/SyncCursorStoreResumeAdapter.kt` | Adapts `SyncCursorStore` to the SDK's `ResumeCursorStore` interface |
| `shared/mobile-data/.../di/ChatComponent.kt` | Owns `ChatDatabase` + `mirrorScope`; wires decorators; `close()` teardown |
| `shared/mobile-data/src/androidUnitTest/.../cache/db/InMemoryDatabaseDriverFactory.kt` | In-memory JdbcSqliteDriver for tests |
| `shared/mobile-data/src/androidUnitTest/.../data/CachingConversationRepositoryTest.kt` | Write-through + replace-on-reload contract tests |
| `shared/mobile-data/src/androidUnitTest/.../data/CachingSessionsRepositoryTest.kt` | Cache-then-refresh + smart-async deletion contract tests |

## Instant Paint — Client-Intent Anchor (not the server echo)

The DB-backed `timeline` must paint a conversation's CACHED rows the moment the user opens it — before the SDK connects, before the gateway echoes `session.switched`. So the DB anchor is the **CLIENT switch intent**, not the server echo:

- `ChatComponent` owns a shared `MutableStateFlow<String?> activeConversationIntent`.
- `CachingSessionsRepository.switchTo*` (the fire-and-forget + suspend switch paths, where `ChatViewModel.init → switchConversation(sessionId)` lands) SETS the anchor to the target id BEFORE delegating to the SDK. `newChat*` clears it to null (no id minted yet).
- `CachingConversationRepository.timeline` reads the anchor via `flatMapLatest` → `messagesFor(id)`. On a COLD launch the route's `sessionId` flows straight in → the persisted rows paint INSTANTLY with no network/echo round-trip.

The live `SdkEvent.SessionSwitched` echo no longer drives the paint — it only ARMS the atomic replace below.

## The entryId Namespace Divergence — Why Replace, Not Merge

Live `conversation.entry` frames carry a gateway-minted **UUID** `entryId`. REST history entries carry a deterministic **`${conversationId}:${index}`** `entryId`. These are different namespaces — no shared Hermes message id links a live entry to its REST counterpart (confirmed Task 3.4).

Consequence: cross-path upsert-by-`entryId` is undefined. A REST reload MUST delete the conversation's rows (`deleteConversation`) and repopulate from the REST snapshot. This is the only safe reconcile path on reload.

**Atomic replace — no empty flash.** Because the cached rows are already painted from the client-intent anchor, a bare pre-delete would flash them to empty before the REST rows land. So the delete + reload-insert run in a SINGLE SQLDelight `transaction { }`: the reactive `messagesFor` notifier fires ONCE on commit (cached rows → REST rows, never an intermediate `emptyList`). The replace is ARMED by the live `SessionSwitched` echo and CONSUMED on the first NON-EMPTY snapshot for that conversation — gated on non-empty because a switch passes through an empty `replaceMirror(emptyList())` intermediate while awaiting the REST fetch; deleting on THAT empty snapshot would re-introduce the flash. Live UUID + positional REST namespaces still coexist for live appends after the replaced baseline.

Within each path, `entryId` is a safe dedup key:
- Live path: upsert-by-UUID absorbs replay (the resume cursor keeps live frames monotonic; redundant re-emits are no-ops).
- REST path: the full replace makes per-row upsert irrelevant.

**Ordering key for both paths:** `seq` = list position in the SDK's fused timeline snapshot. The schema indexes `(conversation_id, seq)` for ordered reads.

## Warm vs Cold Cache-Then-Refresh (Sessions)

`CachingSessionsRepository.list(limit, offset)` adapts cache-then-refresh to the pull seam:

```
warm cache (non-empty DB rows)
  → return cached rows instantly
  → fire background refresh (scope.launch { refresh() })

cold cache (empty DB)
  → await refresh() — no empty-flash, first paint matches REST result
  → return from DB
```

`refresh()` fetches `REFRESH_LIMIT = 1000` sessions — a generous window so the smart-async diff sees the full server set. Applying limit/offset to the cached rows preserves the page contract in both branches.

## Smart-Async Deletion

On each `refresh()`, after writing through the server list:

1. `allSessionIds()` — read the full local session id set.
2. Diff against server ids (a `HashSet` built from the REST response).
3. Any local id absent from the server set was pruned by Hermes → `deleteSession` + `deleteConversation` (cascade messages). Runs entirely on `ioDispatcher`.
4. Never blocks the instant paint — runs in the same `refresh()` coroutine, which is either backgrounded (warm) or awaited before returning (cold, but the paint is the REST result, not the stale local rows).

**Eventual-consistency tradeoff:** an in-flight `refresh()` whose REST snapshot predates a local `delete()` can transiently re-insert the deleted session. The discrepancy resolves on the next `list()` call (next drawer open). At family scale this window is invisible; a guard would add complexity without measurable benefit.

## Durable Resume Cursor — Seed / Save / Clear

The SDK's `ResumeCursor` is in-memory and dies with the process. `SyncCursorStore` persists `{epoch, lastSeq}` per conversation in multiplatform-settings.

**Scope — in-process reconnect, NOT cold relaunch (yet).** The persisted cursor seeds on an IN-PROCESS reconnect (a drop / foreground probe where the conversation is ALREADY anchored — spec §6). It does NOT seed on a cold relaunch's first connect: the SDK does not restore its `_currentSessionId` anchor on launch (the anchor is set only from a server frame), so `seedIfEmpty` sees a null `conversationId()` and early-returns → the relaunch takes the recovered:false REST path. Surviving an app kill (restore the SDK session anchor on launch, THEN seed) is a FOLLOW-UP, not delivered here — the seed logic itself is correct for the in-process case and unchanged.

**Dependency inversion:** the SDK (`mobile-sdk`, lowest layer) defines `ResumeCursorStore` (default `NoOpResumeCursorStore`). `SyncCursorStoreResumeAdapter` in `mobile-data` implements it over `SyncCursorStore`. The SDK never imports `mobile-data` — the platform owners (`UserSessionManager` Android / `IosUserSession` iOS) construct the adapter and pass it to `SentientSdk` at construction. `ChatComponent` holds NO cursor logic (the store flows straight into the SDK).

Lifecycle (all inside the SDK's `ResumeCursorPersistence`, NOT `ChatComponent`):

- **Seed:** the orchestrator calls `ResumeCursorPersistence.seedIfEmpty()` at the wire moment (in `resumeParams()`, before building the `stream.resume` frame): if the in-memory cursor is empty AND a conversation is ALREADY anchored, it `store.load(conversationId)`s and resets the in-memory `ResumeCursor` to the persisted `{epoch, lastSeq}`. The reconnect then carries a non-zero cursor → `recovered:true` replays the gap; `recovered:false` means the buffer expired. The anchor guard scopes this to the in-process reconnect (see the scope note above) — on a cold relaunch the anchor is null, so it no-ops.
- **Save (coalesced per cycle):** the SDK's orchestrator calls `ResumeCursorStore.save` at cycle end (not per-frame), so the write is coalesced — one settings write per cycle, not per token.
- **Clear:** on `recovered:false` (buffer expired → start fresh) or conversation delete → `SyncCursorStore.clear(conversationId)` removes the two keys.

**Store is write-through unconditionally** — monotonicity is enforced at the SDK layer (the in-memory cursor only advances); the store stays dumb to avoid duplicating that invariant.

Keys: `cursor.<id>.epoch` / `cursor.<id>.lastSeq` — namespaced per conversation, no collision with other prefs.

## IO Dispatcher expect/actual

`Dispatchers.IO` is JVM-only. `ioDispatcher()` is an `internal expect fun`:

- **Android:** `Dispatchers.IO` — the standard elastic thread pool.
- **iOS (Kotlin/Native):** `newSingleThreadContext("sentient-db-io")` — a dedicated serial background thread. Serial is what SQLite wants (one writer); `@OptIn(DelicateCoroutinesApi::class)` because the context is process-lived and never closed.

The platform owner (`ChatComponent`) calls `ioDispatcher()` once and injects it into both caching decorators. DB writes NEVER run on `Dispatchers.Default` (the `mirrorScope`'s CPU pool).

## ChatComponent Scope Ownership

`ChatComponent` owns:
- `mirrorScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)` — hosts the write-through collectors and the DB-backed `stateIn`.
- `driver` + `database` — opened once per login; the DB schema is migrated at `databaseDriverFactory.create()`.

`close()` (called on logout by the platform DI layer):
1. `mirrorScope.cancel()` — stops all write-through collectors.
2. `driver.close()` — releases the SQLite connection.

Never call `close()` before `disconnect(clearSession = true)` — the SDK's disconnect should precede the scope cancellation so in-flight frames are not written to a dead scope.

## Test Approach

**In-memory SQLite:** `InMemoryDatabaseDriverFactory` (androidUnitTest) creates a real `JdbcSqliteDriver` on `":memory:"`. The full SQLDelight schema is applied. Tests run on the JVM host with no emulator.

**Fake underlying repositories:** `FakeUnderlyingRepository` exposes `MutableStateFlow<List<ChatMessage>>` (timeline) and `MutableSharedFlow<SdkEvent>` (liveEvents) that tests drive directly.

**Scheduler pinning:** tests use `UnconfinedTestDispatcher` for both `backgroundScope` and `ioDispatcher`. `runCurrent()` deterministically flushes write-through + SQLDelight reactive query notifiers.

**Covered contract cases:** write-through (committed entries persisted), in-flight skip (empty `entryId` not written), replace-on-reload (delete-before-repopulate, no merge), namespace independence (live UUID and positional REST entryIds coexist), seq ordering, warm/cold cache branches, smart-async deletion diff, rename optimism skip on missing cache row.

**multiplatform-settings cursor tests:** `MapSettings` (in-memory) — no platform dependency. `SyncCursorStoreTest` + `SyncCursorStoreResumeAdapterTest` in commonTest.

## Gotchas

- **Flush-dirty-only on successful write:** `writeThrough` only logs `write-through` when `committed > 0`. In-flight-only snapshots (all empty `entryId`) produce no log noise and no DB churn. The guard `if (message.entryId.isEmpty()) return@forEachIndexed` ensures the in-flight bubble never creates a phantom row.
- **`REFRESH_LIMIT = 1000` scale assumption:** the smart-async diff is only correct when the REST fetch returns the FULL server set. The constant assumes Hermes' 90-day cleanup keeps the real count well below 1000 at family scale. Revisit if multi-user or export scenarios change the scale.
- **Delete-reinsert eventual consistency:** an in-flight `refresh()` can transiently re-insert a session the user just deleted locally. This resolves on the next drawer open. No guard is present; adding one would introduce a race-condition guard for an invisible window.
- **Replace is armed, not done, in `collectSwitches`:** the live `SessionSwitched` echo only sets `pendingReplaceFor = id`; the actual `deleteConversation` runs INSIDE the write-through transaction on the first non-empty snapshot, atomic with the reload insert. This is what prevents the painted cached rows from flashing to empty (a bare pre-delete would). The DB anchor is the client-intent signal, not this echo.
- **`seq = index` is committed-only-safe:** the SDK `timeline` is committed-only (`StateDeriver.deriveTimeline` passes `inflight = null` and drops empty entries), so no in-flight bubble shifts the index. The `if (message.entryId.isEmpty()) return@forEachIndexed` skip is belt-and-braces against a future upstream change that might leak an empty-entryId entry into the snapshot.
- **Rename optimism skip on cache miss:** if `sessionById` returns null, `CachingSessionsRepository.rename` skips the local upsert (avoids floating a row with `updated_at = 0` to the bottom of the DESC list). A defensive `debug` log is emitted.
- **iOS DB thread is never closed:** `newSingleThreadContext` is `@DelicateCoroutinesApi` and process-lived. This is intentional — releasing it would require coordinating with all in-flight coroutines on that context.
