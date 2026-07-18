# User-Scope Isolation — PersonSession as the Gateway's Outermost Scope

- **Date:** 2026-07-18
- **Branch:** `feature/user-scope-isolation`
- **Gateway version:** `1.13.0` → `1.13.1`
- **Status:** Design approved; implementation plan pending.

## 1. Problem

A cross-user identity leak: after logging out of account A and into account B **on the
same device / browser tab**, account B's live chat is served by account A's Hermes
worker — A's memory, persona, and name. Reproduced on all platforms. B's own settings
and past chats are correct; only the live chat cycle leaks.

### 1.1 Root cause

The ACP wire pool (`gateway/src/hermes-adapter-client/acp-wire-registry.ts`) is a single
process-global registry keyed by **`surfaceId` alone**:

```ts
const existing = pool.get(surfaceId);
if (existing) {
  existing.refCount += 1;
  const handle = await existing.dialPromise;   // returns the PREVIOUS user's wire
  return handle.acpConn;
}
```

On a cache hit it returns the pooled connection and **never calls `dial()`** — and `dial()`
is the only place the current user's per-user Hermes URL + bearer token are used
(`acquireAcpWireOrFail` computes them from `initialBinding.userId`, but only *inside* the
dial thunk). `surfaceId` is **client-supplied and user-independent**:

- Mobile (`SdkLifecycle.kt`): `surfaceId = deviceId` — a per-install id, stable across logout/login.
- Web (`shared/web-sdk/src/surface-id.ts`): per-tab id in `sessionStorage` — stable across logout/login within the tab.

So a second user on the same surface is handed the first user's live wire. The
`AcpWireRegistry` is a process singleton, so the poisoned entry persists across app
relaunches until its refcount hits zero.

This is a textbook **BOLA / IDOR** (OWASP API Security #1): an object (the Hermes wire)
addressed by a client-controlled reference without scoping to the authenticated owner.

### 1.2 Regression origin

```
9b42d54  gateway(acp-wire): re-key pool userId->surfaceId for surface isolation
```

The pool was previously keyed by `userId` (user isolation intact, but two tabs of one
user shared one Hermes child → the "fork" duplicate-conversation bug). That commit swapped
the key to `surfaceId` **only**, fixing fork but dropping `userId` from the key entirely —
opening the cross-user leak. `9b42d54` is on `develop` and is live in production. This is
**not** related to the macOS docker-sock change (`d9c1cf7`); it is platform- and
deploy-independent gateway logic.

### 1.3 Two latent siblings (same flat-namespace flaw)

Two other registries are keyed by the same client-supplied `surfaceId` in a process-global
namespace. Neither leaks content **today**, but both are cross-user-fragile and rely on a
downstream isolation (per-user Hermes workers) for their safety — exactly the fragility
being removed:

- **`SurfaceCycleRegistry`** (`services.surfaceCycles`): user B's first cycle on a shared
  `surfaceId` sees user A's still-held in-flight lease → B's message queues behind / adopts
  A's cycle instead of dispatching.
- **`SessionRouter` conversation anchors** (`Map<surfaceId, conversationId>`): user B's
  binding reads user A's anchored `conversationId` (harmless only because A's id does not
  exist in B's isolated worker → degrades to fresh).

## 2. Invariant

> **No client-supplied key (`surfaceId`) may address state in a process-global namespace.**

Every `surfaceId`-keyed registry moves inside `PersonSession`, which is per-`userId` and
obtained only via `personSessions.getOrCreate(authUserId)` after auth. A session can only
ever name surfaces inside its own user's namespace, so surface collisions across users
become structurally impossible — not merely avoided.

`PersonSession` becomes the gateway's outermost per-user scope: after auth resolves the
`userId`, the PersonSession is the first thing resolved, and all user-scoped resources hang
off it.

## 3. Scope

**In scope — moves into `PersonSession` (per-user instance, keyed by `surfaceId` within
the user):**

| Registry | Today | After |
|---|---|---|
| `AcpWireRegistry` | global `services.acpWireRegistry` | `personSession.wires` |
| `SurfaceCycleRegistry` | global `services.surfaceCycles` | `personSession.cycles` |
| conversation anchors | `Map` inside `SessionRouter` | `personSession` anchor map + methods |

**Stays global (server-minted `sessionId`, no collision risk):** `SessionManager`,
`SessionControls`, `SessionRouter` bindings. `SessionManager` **must** stay global — it
mints sessionIds and enforces the global session cap *before* auth, when the user is still
unknown.

**Out of scope:** client changes (surfaceId generation is unchanged — only per-user
uniqueness is now required, and UUIDs already satisfy it); Hermes; containment / prod
restart (explicitly deferred by the operator).

## 4. Design

### 4.1 Reuse, don't rewrite

The three registry **classes are unchanged**. Only their instantiation site changes: from
one process-global to one-per-`PersonSession`. `PersonSession` constructs its own
`createAcpWireRegistry()` and `createSurfaceCycleRegistry()`; it holds the anchor map
directly. The call-site swap is mechanical because `session-configure` already holds
`personSession` (from `getOrCreate`) exactly where it currently reaches the globals:

- `services.acpWireRegistry.acquire(surfaceId, dial)` → `personSession.wires.acquire(surfaceId, dial)`
- `services.surfaceCycles.*(surfaceId, …)` → `personSession.cycles.*(surfaceId, …)`
- `services.sessionRouter.updateConversationId(surfaceId, …)` / `dropAnchor(surfaceId)` → `personSession.updateConversationId / dropAnchor`

`services.acpWireRegistry` and `services.surfaceCycles` are removed from `GatewayServices`.

### 4.2 SessionRouter split (falls out for free)

`SessionRouter` today owns two things: per-session bindings **and** surface anchors. Split
them:

- **Bindings stay** in `SessionRouter`, keyed by `sessionId`. `conversationId` leaves the
  binding entirely — the binding becomes purely `(userId, url, apiKey)`.
- **Anchors move** to `PersonSession`, keyed by `surfaceId`. `onCycle` reads
  `personSession.conversationIdFor(surfaceId)` instead of `binding.conversationId`; it
  writes via `personSession.updateConversationId(surfaceId, id)`.
- `clearConversationIdForAllSessions(userId)` (which scans all bindings to find a user's
  surfaces) is **deleted** — the apply orchestrator calls `personSession.clearAllAnchors()`
  directly on the resolved PersonSession.

### 4.3 Tier-3 fail-closed assertions (defense in depth)

Structure is the primary fix; assertions are the canary if a pool is ever re-flattened:

- The wire handle records the `userId` it dialed for. `wires.acquire` asserts
  `handle.userId === personSession.userId` on cache-hit → mismatch = refuse + re-dial +
  `error` log. Within a per-user pool this is tautologically true; that is the point — it
  screams if the structural guarantee regresses.
- Every `sessionId → user` resolution (session-configure, MCP-host control lookups) asserts
  the bound `userId` matches the auth-derived `userId`. Loud, cheap, no happy-path change.

### 4.4 PersonSession shape (after)

```
PersonSession (one per userId)
 ├─ deviceBuffers        (exists — DeviceBufferStore)
 ├─ wires                AcpWireRegistry     surfaceId → wire   [MOVED IN]
 ├─ cycles               SurfaceCycleRegistry surfaceId → lease [MOVED IN]
 ├─ anchors              Map<surfaceId, conversationId>         [MOVED IN]
 ├─ lastResponseId / voiceId / recentPendingIds   (exists)
 └─ dispose()            force-dispose wires + abort cycles + drop anchors

GLOBAL (server-minted sessionId, unchanged):
  SessionManager, SessionControls, SessionRouter bindings
```

## 5. Lifecycle & timeout coupling (highest-risk section)

**Core rule: introduce NO new timer and NO new async wait. Reuse the existing buffer-reap
sweep as the single reap clock.** Moving the wire pool inside `PersonSession` changes
*where* wires live, not *when* they die.

### 5.1 Existing ordering (already correct — must be preserved)

The single reap clock is `session.idle_timeout_ms` (config: `900000` = 15 min). The
`PersonSessionRegistry` sweep runs every `max(60_000, idle_timeout_ms/6)`. One synchronous
pass:

1. **Resumable disconnect** → buffer **retained** (TTL starts); `deferredTeardown` (which
   releases the wire ref) is stashed on the buffer entry. `hasRetainedBuffers()` = true →
   PersonSession **not** removed.
2. **Buffer TTL expires** → `sweepIdle` evicts the buffer **and runs `deferredTeardown`** →
   `wires.release` → refCount 0 → `wire.dispose()` (terminal; sets `disposed` before
   closing, so the lazy reconnect is cancelled — no dangling socket / timer).
3. **Same sync pass** then sees `!hasRetainedBuffers()` → removes the PersonSession. Its
   wires are already disposed.

Buffers already gate **both** wire disposal and PersonSession removal, in the correct
order. Preserve this; do not reinvent it.

### 5.2 Three guards against deadlock / dangling

- **Retention guard (belt + suspenders):** PersonSession retention becomes
  `hasRetainedBuffers() || wires.hasLiveWires() || cycles.hasActiveLease()`. Redundant in
  normal flow (buffers gate all three) but guarantees a wire/lease can never outlive its
  PersonSession, even if a future path releases a buffer without releasing a wire.
- **Teardown = force-dispose + leak canary:** PersonSession removal calls
  `personSession.dispose()`, which force-disposes any residual wires, aborts any residual
  cycle leases (**waking `whenReleased()` waiters** so no awaiting `onCycle` hangs), and
  drops all anchors. A non-empty residual logs `warn` — a leak-in-the-making alarm, not a
  silent cleanup.
- **No await under the sweep:** the entire reap path is synchronous (matches today). Wire
  reconnect is lazy-on-send and `disposed`-gated, so `dispose()` fully severs it with no
  background timer left running.

### 5.3 Why no ref is ever pinned forever

The wire refcount is released only via `deferredTeardown` (buffer reap) or immediate full
teardown — both guaranteed to run **exactly once**: `acquire` hands the pending teardown
back on resume so it fires on the handover; `sweepIdle` runs it on expiry. There is no path
where a ref is held indefinitely, so refCount always reaches 0 → no permanently-pinned
PersonSession → no leak.

### 5.4 Cross-timeout interactions to preserve

- Resume handover (`ws-resume-handover.ts`): the load-bearing "acquire wire (refCount 1→2)
  **before** running the prior deferred teardown (2→1)" ordering must survive the move —
  the acquire is now `personSession.wires.acquire`, but the same PersonSession instance
  serves both the old and new transport (same `userId`), so the refcount arithmetic is
  identical.
- `switch_teardown_timeout_ms` (3000), `hermes_http_timeout_ms` (5000), ACP
  `open_timeout_ms` (5000) / `reconnect_max_attempts` (5): untouched — these live below the
  wire and are unaffected by where the pool is instantiated.

## 6. Testing

Per `.claude/rules/testing.md`, tests pin wire/protocol contracts, FSM/invariants, and
security boundaries.

### 6.1 Unit / contract

- **Isolation pin (new, security boundary):** two `userId`s, same `surfaceId` → distinct
  wires dialed to distinct workers; second user never receives the first's `acpConn`.
- **Fork pin (kept green):** same `userId`, two `surfaceId`s → distinct wires (the
  surface-isolation behavior `9b42d54` intended).
- **Tier-3 assertion:** a cache-hit whose handle `userId` mismatches → refuse + re-dial (no
  leak, `error` logged).
- **Lifecycle (FSM/invariant):** resumable disconnect → TTL expiry → assert wire disposed
  **then** PersonSession removed, in that order; residual force-dispose logs `warn`;
  cycle-waiter is aborted on teardown (no hang).
- **SessionRouter split:** binding no longer carries `conversationId`; anchor read/write
  goes through PersonSession; `clearAllAnchors` clears only the target user's anchors.

Delete no security/contract tests. Factory-wiring / DI-plumbing tests are not added.

### 6.2 E2E matrix (inline, per `.claude/rules/e2e-testing.md`)

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| Cross-account no-leak (web) | desktop 1280×900 | logged in as A, has history | logout → login as B → send new chat | reply addresses B; B's memory/persona only | `getOrCreate` for B's userId; `wires.acquire.dial` (fresh, not `.reuse`) under B's userId; no A userId in the cycle trace |
| Cross-account no-leak (web mobile) | 390×844 | same | same | same | same |
| Cross-account no-leak (native) | Maestro sim/emulator | A logged in on device | logout → login B → send | reply is B's identity | `os_log`/`logcat` + gateway: fresh dial under B; no A worker URL |
| Same-user reconnect resume | desktop | A mid-chat, transport drop | reconnect within TTL | same chat continues, no fork | `acquire.reuse` (refCount 2), handover runs prior teardown, wire survives |
| Same-user multi-surface | desktop | A in tab 1 | open tab 2, send in each | two independent chats | two `wires.acquire.dial` under A, distinct surfaceIds, distinct children |
| Idle reap ordering | any | A disconnected, buffer retained | wait past `idle_timeout_ms` | session gone | `sweepIdle.evicted` → `wire dispose` → `sweep.session-removed`, in order; no residual `warn` |

Reuse case shells from `agents/docs/testing-knowledge.md`; add the cross-account case there,
indexed by surface. Native E2E is Maestro (`qa/mobile/run-e2e.sh --tags`), never Playwright.
All smoke runs against the local Docker stack (`deploy/macos/`), never prod.

## 7. Version & deliverables

- `gateway/package.json`: `1.13.0` → `1.13.1`.
- No client, Hermes, or config-schema changes. `surfaceId` wire field unchanged.

## 8. Risks

- **Blast radius:** touches the hot `session-configure` path and the resume/handover
  ordering. Mitigated by reusing the registry classes verbatim (instantiation-site change
  only) and by the lifecycle guards in §5.
- **Anchor relocation** changes `SessionRouter.get` semantics (binding no longer carries
  `conversationId`). Every reader of `binding.conversationId` must be migrated to
  `personSession.conversationIdFor(surfaceId)` — enumerated during planning; a dangling
  reader would silently lose conversation continuity, so this is a checklist item, not a
  best-effort sweep.
- **Pre-handover gate:** every e2e case green, evidence captured, lint + typecheck + unit
  tests clean, local-stack smoke done, before any handover. No partial green.
