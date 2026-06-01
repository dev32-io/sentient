# Mobile Offline-First -- Details & Examples

This file expands `platforms/mobile/rules/mobile-offline.md`.
Examples are pseudocode that translates to iOS (Combine /
async-streams + Core Data / SQLite / SwiftData) and Android
(Flow + Room / SQLDelight / DataStore).

## Observable network state

```pseudocode
# Reachability is a stream the UI subscribes to.
reachability: Stream<Reachability>
    = .online | .offline | .constrained        # constrained = "low-data mode"

# Per-feature view-model reacts to it.
class FeedViewModel:
    init(api, cache, reachability):
        reachability.subscribe(self.onReachabilityChange)

    onReachabilityChange(state):
        match state:
            case .online:      startBackgroundRefresh()
            case .offline:     showOfflineBanner(); useCache()
            case .constrained: skipImageRefresh(); useCache()
```

The "I will check once and assume it stays that way" pattern is
the most common offline bug. State changes mid-screen.

## Cache-first read pattern (stale-while-revalidate)

```pseudocode
loadProduct(id):
    # 1. Emit cached value immediately (if any).
    cached = cacheStore.read(id)
    if cached != nil:
        emit(.loaded(cached, freshness: ageOf(cached)))

    # 2. If online, refresh; emit fresh value on success.
    if reachability.isOnline:
        try:
            fresh = await api.fetchProduct(id)
            cacheStore.write(id, fresh)
            emit(.loaded(fresh, freshness: .now))
        catch:
            # Keep showing cached data; surface the failure quietly.
            emit(.refreshFailed(cached))
    else:
        # Offline; the cached value is what the user gets.
        if cached == nil:
            emit(.offlineNoCachedData)
```

Properties:

- The UI never blocks on the network for data it already has.
- Freshness is a first-class field on the emitted state; the UI
  can show "Updated 5 min ago" rather than pretending live.
- The "no cached data while offline" branch has a real UI, not
  an infinite spinner.

## Writes -- optimistic + outbox

```pseudocode
toggleFavorite(productId):
    # 1. Optimistic local mutation -- UI updates immediately.
    localStore.upsert(Favorite(productId, isFavorite: true))

    # 2. Outbox entry -- durable description of the request.
    outbox.append(OutboxEntry(
        id:        UUID(),                  # client-generated op ID
        kind:      .toggleFavorite,
        productId: productId,
        target:    true,
        createdAt: now(),
    ))

    # 3. Kick the syncer if online. Otherwise it'll drain on reconnect.
    if reachability.isOnline: syncer.kick()
```

When the syncer drains an entry:

```pseudocode
async drainEntry(entry):
    try:
        await api.toggleFavorite(
            productId:    entry.productId,
            target:       entry.target,
            operationId:  entry.id,         # server uses this for idempotency
        )
        outbox.delete(entry.id)
    catch ConflictError as conflict:
        applyConflictStrategy(entry, conflict)
    catch TransientError:
        # Leave the entry; backoff retry on next reachability tick.
        entry.attempts += 1
        scheduleRetry(entry)
    catch PermanentError as p:
        # 4xx that won't get better -- surface to user, do not retry forever.
        outbox.markFailed(entry.id, reason: p)
        localStore.revertOptimistic(entry.productId)
        notifyUser(p)
```

## Idempotency is non-negotiable

The server endpoint MUST accept an `operationId` (or
`Idempotency-Key` header) and treat replays as no-ops. The client
WILL retry -- on reconnect, on app restart, on partial network
failures where the request was sent but the response was lost.

```pseudocode
# Server side -- conceptual.
POST /favorites { operationId, productId, target }
    if seen(operationId):
        return same response as before
    perform mutation
    record seen(operationId, response)
    return response
```

Without idempotency: every flaky network produces double-writes.
The user toggles a favorite once and the server records two
toggles.

## Conflict strategies -- per-resource, written down

| Strategy           | When it fits                                       |
| ------------------ | -------------------------------------------------- |
| Last-writer-wins   | Personal preferences, ephemeral state              |
| Server-wins        | Authoritative records (account email, balance)     |
| Merge fields       | Independent fields edited concurrently (profile)   |
| Surface to user    | Document edits, comments, scheduling collisions    |

The strategy MUST be a documented choice, not an emergent one.
"Whatever the framework does by default" is not a strategy.

## Ordering within a stream

If three edits land on the same record while offline, they
replay in the order they were enqueued. Cross-record edits may
parallelize.

```pseudocode
outbox.byStream(streamKey) -> ordered queue
syncer.drainStream(streamKey):
    while !queue.isEmpty: drainEntry(queue.head); queue.pop()
```

`streamKey` is typically the resource ID (e.g. document ID).

## Auth tokens and offline

- An expired token while offline is fine. The outbox keeps
  entries; reads come from cache. Refresh happens on reconnect.
- Sign-out MUST work offline: clear local PII and tokens
  immediately; enqueue the revocation call for when online. The
  user expects sign-out to feel instantaneous, regardless of the
  network.

## Test matrix for any new offline-capable feature

| Case                                          |
| --------------------------------------------- |
| Cold launch online -- happy path              |
| Cold launch offline -- cached data renders    |
| Cold launch offline -- no cached data         |
| Online, drop connection mid-action            |
| Offline, perform write, reconnect, syncs OK   |
| Offline, perform same write twice (idempotent)|
| Conflict on reconnect -- strategy applied     |
| Sign-out while offline -- local clears, queues|

A feature with no matrix coverage of these rows has an undefined
offline behavior. The undefined behavior will be defined, in
the worst possible way, by your first user on a flaky train.

## Platform mapping (audit M2)

### Android stack

- Local store: Room (typed SQLite) + DataStore Preferences for small kv.
- Outbox: Room table keyed by `operationId` (UUID), processed by a `CoroutineWorker` chained on connectivity constraint.
- Reachability: `ConnectivityManager.NetworkCallback` → `MutableStateFlow<NetworkState>`.
- Auth: `EncryptedSharedPreferences` is **deprecated**; migrate to `androidx.security:security-crypto` replacements (Keystore-backed key wrapping).

### iOS stack

- Local store: SwiftData (iOS 17+) or Core Data; small kv via `UserDefaults` or Keychain for sensitive data.
- Outbox: a `@Model` entity keyed by `operationId`, processed by a `BGProcessingTask` on reconnect.
- Reachability: `NWPathMonitor` → `AsyncStream<NWPath.Status>` (modern) or Combine `Publisher` (legacy).
- Auth: Keychain (`kSecAttrAccessibleAfterFirstUnlock`).

### Cross-platform invariants

- Operation IDs are UUIDs generated client-side.
- Outbox entries serialized with stable schema (Proto / JSON); migration plan when schema changes.
- Sync replay is at-least-once; server enforces idempotency.
