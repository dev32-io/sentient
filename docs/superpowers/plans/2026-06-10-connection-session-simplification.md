# Connection & Session Simplification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the over-complex connection/session machinery with one model — reconnect-on-presence, always attach-by-id, no durable client store, `pendingId` as the idempotency key — so a long-idle session reconnects and continues instead of stranding an optimistic send.

**Architecture:** One WS per device; one `activate(sessionId)` attaches a client to a conversation (gateway picks warm replay vs cold REST history). The only mint is a new chat (eager `session.new`). The gateway dedups `text.input` by `pendingId`; the client flushes the outbox only when the conversation id is attached. The SQLDelight mirror, gate-mint, the outbox `flushed`-guard, and the client 60-min idle timer are deleted.

**Tech Stack:** Gateway (Bun/TypeScript, `bun run test` = Bun native unit + vitest integration), KMP `mobile-sdk` + `mobile-data` (kotlin.test, `./gradlew :shared:…:test`), iOS (Swift, xcodebuild), Android (Kotlin/Compose, gradle), Maestro for e2e.

**Spec:** `docs/superpowers/specs/2026-06-10-connection-session-simplification-design.md`

**Conventions for every task:** run `source scripts/env.sh` before any shell command. Commit messages use `type(scope): description`. Work on the current branch `feature/ws-resilience-hardening`.

---

## Phase 0 — Already landed (verify only, do not redo)

These were done earlier in this branch; confirm they are present before starting Phase 1.

- [ ] **iOS "+" fix** — `ios/App/Nav/UserSessionHost.swift`: `chatIdentity = activeSessionId ?? "new-\(newChatEpoch)"`, `.id(chatIdentity)`, `onNewChat` bumps `newChatEpoch`. Verify by reading the file.
- [ ] **History "no messages" label** — `ios/App/History/HistoryRow.swift` + `android/.../history/HistoryRow.kt` show relative time only; `messageCountLabel` deleted from both `RelativeTime` files. Verify.
- [ ] Commit these now if uncommitted:

```bash
source scripts/env.sh
git add ios/App/Nav/UserSessionHost.swift ios/App/History/HistoryRow.swift ios/App/History/RelativeTime.swift android/src/main/kotlin/io/sentient/android/history/HistoryRow.kt android/src/main/kotlin/io/sentient/android/history/RelativeTime.kt
git commit -m "fix(mobile): iOS new-chat '+' rebuild via nonce identity; drop misleading history message-count label"
```

---

## Phase 1 — Gateway: dedup, delete gate-mint, raise cap

### Task 1.1: Raise the WS connection cap 10 → 100

**Files:**
- Modify: `shared/config/src/schema.ts:392`
- Modify: `gateway/config.yaml:14`
- Test: `shared/config/src/schema.test.ts:32`

- [ ] **Step 1: Update the schema default + max.** `max_sessions: z.number().int().min(1).max(100).default(10)` → raise both the cap ceiling and default:

```ts
// shared/config/src/schema.ts:392
  max_sessions: z.number().int().min(1).max(1000).default(100),
```

- [ ] **Step 2: Update the config value + comment.** `gateway/config.yaml:14`:

```yaml
  max_sessions: 100   # Max concurrent WS connections (mobile + webui + cube, multi-user). Range 1–1000.
```

- [ ] **Step 3: Update the schema test.** `shared/config/src/schema.test.ts:32` — change `expect(result.max_sessions).toBe(10)` to `toBe(100)`.

- [ ] **Step 4: Run.**

```bash
source scripts/env.sh
cd shared/config && bun run test src/schema.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add shared/config/src/schema.ts shared/config/src/schema.test.ts gateway/config.yaml
git commit -m "config(gateway): raise max_sessions cap to 100 (multi-device, multi-user)"
```

### Task 1.2: PersonSession — bounded `pendingId` dedup set

**Files:**
- Modify: `gateway/src/person-session/person-session.ts` (add state + method)
- Test: `gateway/src/person-session/person-session.test.ts` (create or extend)

Rationale: a resend arrives on a *new* WS connection after reconnect, so the dedup set must live on the `PersonSession` (survives attach/detach, evicts with the session at retention) — not the per-connection adapter.

- [ ] **Step 1: Write the failing test.** `gateway/src/person-session/person-session.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { PersonSession } from "./person-session.js";

function make(): PersonSession {
  return new PersonSession({
    profile: "u_test", hermesUrl: "http://h", hermesApiKey: "k",
    userId: "u_test", replayBufferMaxBytes: 1024,
  });
}

describe("PersonSession.admitPendingId", () => {
  it("admits a new pendingId once, rejects the duplicate", () => {
    const s = make();
    expect(s.admitPendingId("p1")).toBe(true);
    expect(s.admitPendingId("p1")).toBe(false);
  });
  it("admits distinct ids", () => {
    const s = make();
    expect(s.admitPendingId("p1")).toBe(true);
    expect(s.admitPendingId("p2")).toBe(true);
  });
  it("evicts oldest beyond the cap so the set is bounded", () => {
    const s = make();
    for (let i = 0; i < 300; i++) expect(s.admitPendingId(`p${i}`)).toBe(true);
    // p0 was evicted (cap 256) → re-admitting it succeeds (treated as new)
    expect(s.admitPendingId("p0")).toBe(true);
    // a recent one is still remembered
    expect(s.admitPendingId("p299")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

```bash
source scripts/env.sh
cd gateway && bun test src/person-session/person-session.test.ts
```
Expected: FAIL — `admitPendingId` is not a function.

- [ ] **Step 3: Implement.** In `gateway/src/person-session/person-session.ts`, add a bounded insertion-ordered set + method. Add near the other private fields (after `_idleSinceMs`):

```ts
  /**
   * Recently-seen client pendingIds for idempotent resend dedup. A resend
   * (same pendingId on a new connection after reconnect) is rejected so it is
   * re-echoed via replay/REST history but NOT re-dispatched to Hermes. Bounded
   * insertion-ordered; evicts with the session at retention. Survives reconnect
   * (the whole point of placing it here, like _lastResponseId).
   */
  private readonly _recentPendingIds = new Set<string>();
  private static readonly PENDING_ID_CAP = 256;
```

Add the method (after `setLastResponseId`, before the voiceId getter):

```ts
  /**
   * Returns true if [pendingId] is new (record it and admit the message),
   * false if it was already seen (a resend — caller must skip re-dispatch).
   */
  admitPendingId(pendingId: string): boolean {
    if (this._recentPendingIds.has(pendingId)) return false;
    this._recentPendingIds.add(pendingId);
    if (this._recentPendingIds.size > PersonSession.PENDING_ID_CAP) {
      const oldest = this._recentPendingIds.values().next().value;
      if (oldest !== undefined) this._recentPendingIds.delete(oldest);
    }
    return true;
  }
```

- [ ] **Step 4: Run to verify it passes.**

```bash
cd gateway && bun test src/person-session/person-session.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add gateway/src/person-session/person-session.ts gateway/src/person-session/person-session.test.ts
git commit -m "feat(gateway): PersonSession.admitPendingId — bounded resend-dedup set"
```

### Task 1.3: Dedup `text.input` by `pendingId` at the adapter

**Files:**
- Modify: `gateway/src/adapters/adapter-types.ts` (add `admitPendingId` to `AdapterContext`)
- Modify: `gateway/src/adapters/user-text-input-adapter.ts` (skip on dup)
- Modify: `gateway/src/session-handlers/ws-session-configure.ts:~677` (wire the callback from the PersonSession)
- Test: `gateway/src/adapters/user-text-input-adapter.test.ts` (create or extend)

- [ ] **Step 1: Write the failing test.** `gateway/src/adapters/user-text-input-adapter.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { createUserTextInputAdapter } from "./user-text-input-adapter.js";
import { createConversationMirror } from "../cerebrum/conversation-mirror.js";

function ctx(seen: Set<string>) {
  const mirror = createConversationMirror();
  return {
    mirror,
    adapterCtx: {
      conversationHistory: mirror,
      admitPendingId: (id: string) => (seen.has(id) ? false : (seen.add(id), true)),
      // other AdapterContext fields are unused by the text adapter:
    } as never,
  };
}

describe("user-text-input dedup", () => {
  it("appends a first message", async () => {
    const seen = new Set<string>();
    const { mirror, adapterCtx } = ctx(seen);
    const a = createUserTextInputAdapter();
    await a.start(adapterCtx);
    a.handleTextInput("hello", "p1");
    expect(mirror.snapshot().length).toBe(1);
  });
  it("skips a duplicate pendingId (resend) — no second entry", async () => {
    const seen = new Set<string>();
    const { mirror, adapterCtx } = ctx(seen);
    const a = createUserTextInputAdapter();
    await a.start(adapterCtx);
    a.handleTextInput("hello", "p1");
    a.handleTextInput("hello", "p1"); // resend
    expect(mirror.snapshot().length).toBe(1);
  });
  it("does not dedup messages with no pendingId", async () => {
    const seen = new Set<string>();
    const { mirror, adapterCtx } = ctx(seen);
    const a = createUserTextInputAdapter();
    await a.start(adapterCtx);
    a.handleTextInput("hi");
    a.handleTextInput("hi");
    expect(mirror.snapshot().length).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

```bash
cd gateway && bun test src/adapters/user-text-input-adapter.test.ts
```
Expected: FAIL — duplicate produces 2 entries (dedup not implemented).

- [ ] **Step 3: Add `admitPendingId` to `AdapterContext`.** In `gateway/src/adapters/adapter-types.ts`, inside `interface AdapterContext`:

```ts
  /**
   * Idempotency gate for client message ids. Returns false for a pendingId
   * already processed on this PersonSession (a resend) — the adapter then skips
   * re-dispatch. Defaults to always-admit when no pendingId is supplied.
   */
  readonly admitPendingId: (pendingId: string) => boolean;
```

- [ ] **Step 4: Skip on dup in the adapter.** In `gateway/src/adapters/user-text-input-adapter.ts`, replace the body of `handleTextInput` so a seen pendingId short-circuits before the append:

```ts
    handleTextInput(text: string, pendingId?: string): void {
      if (!ctx) return;
      if (pendingId !== undefined && !ctx.admitPendingId(pendingId)) {
        log.info("text-input.dedup-skip", { pendingId });
        return;
      }
      const truncated = text.length > MAX_LOG_TEXT_LEN ? `${text.slice(0, MAX_LOG_TEXT_LEN)}…` : text;
      log.debug("text-input", { text: truncated, ...(pendingId !== undefined ? { pendingId } : {}) });
      const entry = {
        entryId: crypto.randomUUID(),
        kind: "user" as const,
        ts: Date.now(),
        channel: "text" as const,
        content: text,
      };
      ctx.conversationHistory.append(pendingId !== undefined ? { ...entry, pendingId } : entry);
    },
```

- [ ] **Step 5: Wire the callback at the configure site.** In `gateway/src/session-handlers/ws-session-configure.ts`, find the `AdapterContext` literal that sets `conversationHistory: conversationMirror` (≈ line 677) and add the `admitPendingId` field pointing at the bound PersonSession. Read the surrounding code to confirm the PersonSession variable name in scope (it is the per-user session bound earlier in configure — search upward for `attach(` / `personSession`); wire:

```ts
        conversationHistory: conversationMirror,
        admitPendingId: (id: string) => personSession.admitPendingId(id),
```

If the bound variable is not literally `personSession`, use whatever the configure binds (the `PersonSession` instance from `person-session-registry`). Any other `AdapterContext` construction site (search: `conversationHistory:`) must also supply `admitPendingId` — for non-session contexts use `() => true`.

- [ ] **Step 6: Run adapter + a full gateway typecheck.**

```bash
cd gateway && bun test src/adapters/user-text-input-adapter.test.ts && bun run typecheck
```
Expected: adapter test PASS; typecheck PASS (every `AdapterContext` literal now supplies `admitPendingId`).

- [ ] **Step 7: Commit.**

```bash
git add gateway/src/adapters/adapter-types.ts gateway/src/adapters/user-text-input-adapter.ts gateway/src/adapters/user-text-input-adapter.test.ts gateway/src/session-handlers/ws-session-configure.ts
git commit -m "feat(gateway): dedup text.input by pendingId (idempotent resend)"
```

### Task 1.4: Delete the gate-mint path

**Files:**
- Modify: `gateway/src/session-handlers/ws-session-configure.ts` (drop the fresh-chain mint branch + the `gateMintTimeoutMs` field + the call-site arg ≈ line 629)
- Modify: `gateway/src/session-handlers/resolve-forced-session-id.test.ts` (drop gate-mint cases, keep priority-1/2)
- Modify: `shared/config/src/schema.ts` (remove `gate_mint_timeout_ms`)
- Modify: `gateway/config.yaml:343` (remove the line)

Rationale: the only mint is now an eager client `session.new` (Phase 4). A fresh-chain message with no pending mint is a client bug, not a path to silently mint into an invisible conversation.

- [ ] **Step 1: Simplify `resolveForcedSessionId`.** In `ws-session-configure.ts`, replace the fresh-chain branch so it returns null instead of minting. The function becomes:

```ts
export async function resolveForcedSessionId(input: ResolveForcedSessionIdInput): Promise<string | null> {
  if (input.pendingNewSessionId !== null) return input.pendingNewSessionId;
  if (input.pendingNewSessionPromise !== null) {
    try {
      return await input.pendingNewSessionPromise;
    } catch (err) {
      log.warn("pending-new-session-failed", { cycleId: input.cycleId, reason: errorMessage(err, "unknown") });
      return null;
    }
  }
  // No pending session.new on a fresh chain: do NOT mint here. The client mints
  // eagerly via session.new (visible session.created); a fresh-chain message with
  // no pending id falls through to Hermes default keying (no invisible mint).
  return null;
}
```

- [ ] **Step 2: Remove now-unused fields from `ResolveForcedSessionIdInput`.** Delete `acpConn`, `wsSend`, `setPendingNewSessionId`, `gateMintTimeoutMs`, and `conversationId` if they are no longer referenced by the function body. Keep `pendingNewSessionId`, `pendingNewSessionPromise`, `cycleId`. Remove the `mintAndAnnounceSession` import if it becomes unused in this file (it is still used by the `session.new` handler in `sessions-handlers.ts` — leave that one).

- [ ] **Step 3: Update the call site (≈ line 629).** Remove the arguments that were deleted from the input interface (`gateMintTimeoutMs: services.sessions.gate_mint_timeout_ms`, `acpConn`, `wsSend`, `setPendingNewSessionId`, `conversationId`). Read the call site and pass only the surviving fields.

- [ ] **Step 4: Remove config.** In `shared/config/src/schema.ts` delete the `gate_mint_timeout_ms` field from the `sessions` schema; in `gateway/config.yaml` delete line 343 (`gate_mint_timeout_ms: 5000 …`).

- [ ] **Step 5: Update `resolve-forced-session-id.test.ts`.** Delete the cases that assert a gate-mint fires (the ones constructing `acpConn`/`gateMintTimeoutMs` and expecting `session.created`). Keep/adjust the cases for priority 1 (`pendingNewSessionId` wins) and priority 2 (`pendingNewSessionPromise` awaited). Add a case asserting a fresh chain with both pendings null + no conversation returns `null` (no mint):

```ts
it("returns null on a fresh chain with no pending session.new (no gate-mint)", async () => {
  const result = await resolveForcedSessionId({
    pendingNewSessionId: null,
    pendingNewSessionPromise: null,
    cycleId: "c1",
  });
  expect(result).toBeNull();
});
```

- [ ] **Step 6: Run.**

```bash
cd gateway && bun test src/session-handlers/resolve-forced-session-id.test.ts && bun run typecheck
cd ../shared/config && bun run test
```
Expected: PASS. (If `mintAndAnnounceSession` is now unused anywhere, the typecheck flags the dead import — remove it.)

- [ ] **Step 7: Commit.**

```bash
git add gateway/src/session-handlers/ws-session-configure.ts gateway/src/session-handlers/resolve-forced-session-id.test.ts shared/config/src/schema.ts gateway/config.yaml
git commit -m "refactor(gateway): delete gate-mint — the only mint is an eager client session.new"
```

### Task 1.5: Gateway full check

- [ ] **Step 1: Run the gateway suite + lint.**

```bash
source scripts/env.sh
bun run typecheck && bun run lint && cd gateway && bun run test
```
Expected: all green. Fix any fallout from the deleted fields before moving on.

---

## Phase 2 — mobile-sdk: reconnect on presence, attach-by-id, drop idle timer

### Task 2.1: Delete the 60-minute client idle auto-disconnect

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SentientSdk.kt` (idle loop / threshold)
- Modify: `shared/mobile-sdk/.../sdk/SdkConfig.kt` (remove idle threshold if it becomes unused)
- Test: existing idle tests — update/delete

Rationale: the gateway owns idle (closes at 255 s); the client reconnects on demand. A client idle timer that disconnects a still-foreground app is redundant and competes with on-demand reconnect.

- [ ] **Step 1: Read** `SentientSdk.kt` around `startIdleLoop`, `DEFAULT_IDLE_THRESHOLD_MS`, `DEFAULT_IDLE_TICK_MS`, `IdleDetector`, and `disconnectForIdle` to see the wiring.
- [ ] **Step 2: Remove the auto-disconnect.** Make `startIdleLoop` a no-op (or delete it and its call in `finishReady`), and remove the `disconnectForIdle` invocation. Keep `markInteraction()` (it still resets engagement state used elsewhere). Delete `DEFAULT_IDLE_THRESHOLD_MS` / `DEFAULT_IDLE_TICK_MS` / `IdleDetector` only if nothing else references them after removal (let the compiler tell you).
- [ ] **Step 3: Update tests.** Delete idle-disconnect tests in `commonTest` that assert the socket drops after the threshold. Keep any `IdleDetector` pure-logic test only if the type survives.
- [ ] **Step 4: Run.**

```bash
source scripts/env.sh
./gradlew :shared:mobile-sdk:test
```
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add shared/mobile-sdk
git commit -m "refactor(mobile-sdk): drop client 60-min idle auto-disconnect — gateway owns idle, reconnect on demand"
```

### Task 2.2: Public `ensureConnected()` engagement surface

**Files:**
- Modify: `shared/mobile-sdk/.../sdk/SentientSdk.kt` (add `ensureConnected()`)
- Test: `shared/mobile-sdk/src/commonTest/.../EnsureConnectedTest.kt` (create)

`ensureConnected()` generalizes `onForeground()`: probe-if-ready, reconnect-if-dead. It is the single entry the app calls from every engagement signal (foreground, chat-screen-appear, composer-focus, pre-send).

- [ ] **Step 1: Write the failing test.** Construct the SDK with a fake transport that reports DISCONNECTED; assert `ensureConnected()` drives a reconnect (status → RECONNECTING). Model it on the existing `forceReconnect` / foreground tests in `commonTest` (read one first for the fake harness shape). Skeleton:

```kotlin
@Test
fun `ensureConnected reconnects when not ready`() = runTest {
    val sdk = newTestSdk(/* fake transport, starts DISCONNECTED */)
    sdk.ensureConnected()
    assertEquals(SdkStatus.RECONNECTING, sdk.connection.value.status /* or the deriver status surface used in sibling tests */)
}
```

- [ ] **Step 2: Run to verify it fails.**

```bash
./gradlew :shared:mobile-sdk:test --tests "*EnsureConnected*"
```
Expected: FAIL — `ensureConnected` unresolved.

- [ ] **Step 3: Implement.** In `SentientSdk.kt`, add (next to `onForeground`):

```kotlin
    /**
     * Engagement-driven connectivity check — call from every "user is at the chat"
     * signal (foreground, chat screen appears, composer focus, pre-send). READY ⇒
     * one liveness probe (reuse onForeground's probe); not-READY ⇒ reconnect, which
     * re-establishes the anchored conversation via conversation.activate. On-demand
     * only: never a timer, never while backgrounded.
     */
    fun ensureConnected() {
        markInteraction()
        if (deriver.status == SdkStatus.READY) {
            onForeground() // one-shot liveness probe; reconnects only if the socket is dead
        } else {
            forceReconnect()
        }
    }
```

- [ ] **Step 4: Run to verify it passes.**

```bash
./gradlew :shared:mobile-sdk:test --tests "*EnsureConnected*"
```
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add shared/mobile-sdk
git commit -m "feat(mobile-sdk): ensureConnected() — single engagement-driven reconnect entry"
```

### Task 2.3: Always `activate(currentId)` on a cold reconnect; forbidden ⇒ mint-fresh fallback

**Files:**
- Modify: `shared/mobile-sdk/.../sdk/SentientSdk.kt` (`onReadyReached`, `onSessionForbidden`)
- Test: `shared/mobile-sdk/src/commonTest/.../sdk/ReconnectResumeDecisionTest.kt` + a new fallback test

Rationale: the orphan bug was a cold reconnect that did neither resume nor activate. The decision table already activates when `hasAnchor && !resumeWillBeAttempted` (REESTABLISH_AND_CLEAR). This task guarantees the anchor is honored and defines the *only* legitimate fresh-mint: `forbidden` (Hermes truly dropped the owned session).

- [ ] **Step 1: Read** `onReadyReached`, `decideOnReady`, `reestablishAnchoredSession`, `onSessionForbidden` (already in the file). Confirm REESTABLISH_AND_CLEAR fires `conversation.activate(anchor)`.
- [ ] **Step 2: Write the failing test** for the forbidden→mint-fresh fallback. `onSessionForbidden` currently nulls the anchor; the new behavior additionally surfaces a notice and lets the next send mint fresh. Add to a new `commonTest` `SessionForbiddenFallbackTest.kt`:

```kotlin
@Test
fun `forbidden during re-establish clears anchor and surfaces reopen-failed notice`() = runTest {
    val sdk = newTestSdk(/* anchored to Y, reconnecting */)
    // simulate a re-establish in flight, then a forbidden frame
    sdk.feedFrame(ServerMessage.SessionsError(code = "forbidden"))
    assertNull(sdk.currentSessionId.value)
    // a one-shot notice is exposed for the UI (see Step 3 for the surface)
    assertTrue(sdk.events.replayCache.any { it is SdkEvent.ReopenFailed } /* or the event surface used by sibling tests */)
}
```

- [ ] **Step 3: Implement.** Confirm `onReadyReached` REESTABLISH_AND_CLEAR calls `reestablishAnchoredSession(anchored)` (it does). In `onSessionForbidden`, after clearing the anchor, emit a one-shot notice on the SDK event stream so the UI can show "Couldn't reopen that chat — started a new one." Use the existing one-shot event channel (search the connectors for the error/notification `SharedFlow`); add an event variant `ReopenFailed`. The next user send then has a null anchor ⇒ the app starts a new chat (Phase 4 send path mints eagerly).

- [ ] **Step 4: Run.**

```bash
./gradlew :shared:mobile-sdk:test --tests "*Reconnect*" --tests "*SessionForbidden*"
```
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add shared/mobile-sdk
git commit -m "feat(mobile-sdk): cold reconnect always activates by id; forbidden ⇒ fresh-mint + reopen-failed notice"
```

### Task 2.4: mobile-sdk full check

- [ ] **Step 1:**

```bash
source scripts/env.sh
./gradlew :shared:mobile-sdk:test
```
Expected: green.

---

## Phase 3 — mobile-data: delete the durable mirror, fix the flush gate, drop the guard, add the send timeout

### Task 3.1: Flush gate requires id-attached (core orphan fix)

**Files:**
- Modify: `shared/mobile-data/src/commonMain/.../usecase/SendMessageUseCase.kt` (or wherever `flushIfReady` lives — search `flushIfReady`)
- Modify: `shared/mobile-data/.../di/ChatComponent.kt` (provide the attached-id signal)
- Test: `shared/mobile-data/src/commonTest/.../usecase/SendMessageUseCaseTest.kt` (create/extend)

- [ ] **Step 1: Read** the current `flushIfReady` signature and callers (`grep -rn flushIfReady shared/mobile-data android ios`). It is currently `flushIfReady(cache, status)`.
- [ ] **Step 2: Write the failing test.** Flush must NOT fire when the connection is READY but no conversation id is attached (new chat, mint not yet returned):

```kotlin
@Test
fun `does not flush until a session id is attached`() = runTest {
    val cache = OutboundCache().apply { enqueue("p1", "hello") }
    val sent = mutableListOf<Pair<String,String>>()
    val usecase = SendMessageUseCase(send = { id, text -> sent += id to text })
    usecase.flushIfReady(cache, status = Status.READY, attachedSessionId = null)
    assertTrue(sent.isEmpty())                       // gated: no id yet
    usecase.flushIfReady(cache, status = Status.READY, attachedSessionId = "Y")
    assertEquals(listOf("p1" to "hello"), sent)      // flushes once attached
}
```

- [ ] **Step 3: Run to verify it fails.**

```bash
source scripts/env.sh
./gradlew :shared:mobile-data:test --tests "*SendMessage*"
```
Expected: FAIL — signature has no `attachedSessionId`, flush fires on READY alone.

- [ ] **Step 4: Implement.** Add `attachedSessionId: String?` to `flushIfReady` and gate the drain on `status == READY && attachedSessionId != null`. Thread the attached id from the SDK's `currentSessionId` through `ChatComponent` to the usecase (the component already exposes `currentSessionId`). Update the VM call sites in Phase 4.

- [ ] **Step 5: Run.**

```bash
./gradlew :shared:mobile-data:test --tests "*SendMessage*"
```
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add shared/mobile-data
git commit -m "fix(mobile-data): flush gate requires WS-ready AND id-attached (prevents fresh-mint orphan)"
```

### Task 3.2: Promote `pendingId` — drop the `flushed` double-send guard

**Files:**
- Modify: `shared/mobile-data/src/commonMain/.../outbox/OutboundCache.kt`
- Modify: `shared/mobile-data/.../outbox/Outbox.kt` (PendingMessage / MessageStatus if `flushed` lives there)
- Test: `shared/mobile-data/src/commonTest/.../outbox/OutboundCacheTest.kt`

Rationale: gateway dedup (Task 1.3) makes resend safe, so the `flushed` guard is no longer needed. The outbox simplifies to `QUEUED → removed on echo | FAILED → retry`; `queued()` returns all QUEUED entries; a reconnect freely re-flushes (gateway dedups).

- [ ] **Step 1: Update the tests first.** In `OutboundCacheTest.kt`, replace any assertion that a flushed entry is not re-sent / not failed with the new contract: `queued()` includes a previously-flushed-but-unechoed entry (so reconnect re-sends it), and `markFailed` fails any QUEUED entry. Add:

```kotlin
@Test
fun `queued includes a previously sent-but-unechoed entry so reconnect re-sends`() {
    val c = OutboundCache()
    c.enqueue("p1", "hello")
    c.markFlushed("p1")                 // sent once; echo never arrived
    assertEquals(listOf("p1"), c.queued().map { it.id })  // re-sendable on reconnect
}
```

- [ ] **Step 2: Run to verify it fails.**

```bash
./gradlew :shared:mobile-data:test --tests "*OutboundCache*"
```
Expected: FAIL — current `queued()` excludes flushed.

- [ ] **Step 3: Implement.** Remove `flushed` from `PendingMessage`; `markFlushed` becomes a no-op or is removed; `queued()` returns all `status == QUEUED`; `markFailed` fails any QUEUED (drop the `&& !it.flushed`); `enqueue` dedup guard keeps the FAILED-resurrection block but drops the `flushed` check; `retry` clears nothing extra. Keep `remove(id)` (reconcile by echo).

- [ ] **Step 4: Run.**

```bash
./gradlew :shared:mobile-data:test --tests "*OutboundCache*" --tests "*Outbox*"
```
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add shared/mobile-data
git commit -m "refactor(mobile-data): drop outbox flushed-guard — gateway pendingId dedup makes resend safe"
```

### Task 3.3: Outbox unacked-timeout → reconnect+resend, then FAILED

**Files:**
- Modify: `shared/mobile-data/.../outbox/OutboundCache.kt` (track per-entry sent-at via injected clock) OR a new `OutboxTimeout` unit
- Modify: `shared/config`-equivalent for mobile (the SDK `SdkConfig` or a mobile-data config) — add `outbox_unacked_timeout_ms` (default 10_000)
- Test: `shared/mobile-data/src/commonTest/.../outbox/OutboxTimeoutTest.kt` (create)

- [ ] **Step 1: Write the failing test** with a `TestClock`:

```kotlin
@Test
fun `an unacked sent message times out to FAILED`() = runTest {
    val clock = TestClock()
    val c = OutboundCache(clock = clock, unackedTimeoutMs = 10_000)
    c.enqueue("p1", "hello"); c.markFlushed("p1")
    clock.advanceBy(10_001)
    c.sweepTimeouts()                       // driven by the VM tick / connection collector
    assertEquals(MessageStatus.FAILED, c.pending.value.first { it.id == "p1" }.status)
}
```

- [ ] **Step 2: Run to verify it fails.**

```bash
./gradlew :shared:mobile-data:test --tests "*OutboxTimeout*"
```
Expected: FAIL — no clock/sweep.

- [ ] **Step 3: Implement.** Inject a `Clock` + `unackedTimeoutMs` into `OutboundCache`; record `sentAtMs` on `markFlushed`; add `sweepTimeouts()` that marks any flushed-and-unechoed entry older than the timeout `FAILED`. The VM drives `sweepTimeouts()` from its connection collector / a 1 s tick AND first calls `ensureConnected()` + a re-flush (so a transient drop resends before failing). Add `outbox_unacked_timeout_ms` (default 10_000, range 3_000–30_000) to the mobile config surface.

- [ ] **Step 4: Run.**

```bash
./gradlew :shared:mobile-data:test --tests "*OutboxTimeout*"
```
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add shared/mobile-data shared/mobile-sdk
git commit -m "feat(mobile-data): outbox unacked-timeout → reconnect+resend, then FAILED (no forever-sending)"
```

### Task 3.4: Delete the SQLDelight durable mirror; in-memory timeline + cold-reconcile

**Files:**
- Delete: `shared/mobile-data/.../data/CachingConversationRepository.kt`, `CachingSessionsRepository.kt`, the SQLDelight `ChatDatabase` schema (`*.sq`), `DatabaseDriverFactory` (+ android/ios actuals), `SyncCursorStore`, the durable `ResumeCursorStore` impl in mobile-data
- Modify: `shared/mobile-data/.../di/ChatComponent.kt` (remove the caching decorator wiring; use `SdkConversationRepository`/`SdkSessionsRepository` directly)
- Modify: `shared/mobile-data/build.gradle.kts` (remove SQLDelight + multiplatform-settings deps + plugin)
- Modify: `shared/mobile-sdk/.../sdk/SentientSdk.kt` construction (drop the injected `resumeCursorStore` durable backing → `NoOpResumeCursorStore`)
- Delete: the mirror + cursor tests
- Test: `shared/mobile-data/src/commonTest/.../usecase/ObserveChatUseCaseTest.kt` — keep, ensure it passes against the in-memory path; add a cold-reconcile test

Rationale: history comes from the gateway on attach; the client keeps only the in-memory timeline + the in-memory `ResumeCursor`. Deleting the mirror also deletes the `pendingId`-strip bug.

- [ ] **Step 1: Add the cold-reconcile test FIRST** (it must survive the deletion). On a cold history replace, still-flushed optimistic entries are dropped (they are now represented in the authoritative history, or already FAILED via the timeout) — preventing a duplicate bubble that reconcile-by-pendingId can't catch (cold REST history from Hermes carries no `pendingId`). In `ObserveChatUseCaseTest.kt`:

```kotlin
@Test
fun `cold history replace drops still-pending optimistic entries (no pendingId on cold history)`() = runTest {
    val cache = OutboundCache().apply { enqueue("p1", "hello"); markFlushed("p1") }
    val usecase = makeObserveChat(/* repo emits a fresh REST history snapshot containing "hello" with NO pendingId */)
    // simulate the cold history replace signal
    usecase.onColdHistoryReplace(cache)
    assertTrue(cache.pending.value.none { it.id == "p1" })   // optimistic dropped → single committed bubble
}
```

- [ ] **Step 2: Run to verify it fails / compiles against new surface.**

```bash
./gradlew :shared:mobile-data:test --tests "*ObserveChat*"
```
Expected: FAIL — `onColdHistoryReplace` not defined.

- [ ] **Step 3: Implement `onColdHistoryReplace`** on the chat usecase: drop all currently-flushed optimistic entries from the cache when a cold REST history snapshot replaces the timeline. Wire the cold-replace signal from the repository/SDK (the `recovered:false` / `session.switched` → REST-refetch path).

- [ ] **Step 4: Delete the mirror.** Remove the files listed above; rewire `ChatComponent` to use the SDK-backed repositories directly (no caching decorator). Remove SQLDelight/multiplatform-settings from `build.gradle.kts`. Switch the SDK construction to `NoOpResumeCursorStore`. Delete the mirror/cursor test files.

- [ ] **Step 5: Run the full mobile-data + sdk suites + assemble.**

```bash
source scripts/env.sh
./gradlew :shared:mobile-data:test :shared:mobile-sdk:test
./gradlew :shared:mobile-data:assembleMobileDataDebugXCFramework   # iOS framework must still build
```
Expected: green; XCFramework assembles without SQLDelight.

- [ ] **Step 6: Commit.**

```bash
git add shared/mobile-data shared/mobile-sdk
git commit -m "refactor(mobile-data): delete SQLDelight durable mirror — in-memory timeline + cold-reconcile drop"
```

---

## Phase 4 — iOS / Android: wire engagement hooks + the attached-id send path

### Task 4.1: Android — engagement hooks + flush-gate id + eager new-chat mint

**Files:**
- Modify: `android/src/main/kotlin/io/sentient/android/chat/ChatViewModel.kt`
- Modify: `android/src/main/kotlin/io/sentient/android/nav/ChatHost.kt` (lifecycle resume → ensureConnected)
- Modify: the composer composable (search `onFocus` / the text field in `chat/`) — focus → `ensureConnected`
- Test: `android/src/test/.../chat/ChatViewModelTest.kt`

- [ ] **Step 1: Read** `ChatViewModel.kt` + the composer composable + `ChatHost.kt`.
- [ ] **Step 2:** On new chat (route nil), call the SDK eager `session.new` on VM init so `session.created` arrives and `currentSessionId` attaches; the outbox flush gate (Task 3.1) holds messages until then. Thread `attachedSessionId = currentSessionId` into the `flushIfReady` calls.
- [ ] **Step 3:** Call `ensureConnected()` from: `LaunchedEffect` on chat-screen entry, the lifecycle `ON_RESUME`, and the composer `onFocusChanged{ if (it.isFocused) vm.onComposerFocus() }` → `usecase.ensureConnected()`.
- [ ] **Step 4:** Add a VM test asserting a new-chat VM triggers an eager mint and gates the first send on the attached id (fake usecases). Run:

```bash
source scripts/env.sh
./gradlew :android:testDebugUnitTest --tests "*ChatViewModel*"
```
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add android
git commit -m "feat(android): engagement-driven ensureConnected + eager new-chat mint + id-gated flush"
```

### Task 4.2: iOS — engagement hooks + flush-gate id + eager new-chat mint

**Files:**
- Modify: `ios/App/Chat/ChatViewModel.swift`
- Modify: `ios/App/Nav/UserSessionHost.swift` (scenePhase .active → ensureConnected; already resumes — route it through ensureConnected)
- Modify: `ios/App/Chat/composer/Composer.swift` (focus → ensureConnected)
- Test: `ios/Tests/.../ChatViewModelTests.swift`

- [ ] **Step 1: Read** `ChatViewModel.swift` (already partly known), `Composer.swift`, the scene wiring in `UserSessionHost.swift`.
- [ ] **Step 2:** Mirror Android: eager `session.new` on a nil-route VM; thread `attachedSessionId = component.currentSessionId.value` into `flushIfReady`; remove the new-chat re-anchor hack (`startSessionAnchorCollecting`) in favor of the eager-mint + attach path (the cache anchors when `session.created` sets `currentSessionId`).
- [ ] **Step 3:** Call `component.ensureConnected()` from: `.task`/`.onAppear` on the chat view, `scenePhase == .active`, and the composer `.focused` binding (`onChange(of: isFocused)`).
- [ ] **Step 4:** Rebuild the XCFramework (shared Kotlin changed), then build the app:

```bash
source scripts/env.sh
./gradlew :shared:mobile-data:assembleMobileDataDebugXCFramework :shared:mobile-sdk:assembleMobileSdkDebugXCFramework
xcodebuild -project ios/App.xcodeproj -scheme App -destination 'platform=iOS Simulator,name=iPhone 16' build | tail -20
```
Expected: BUILD SUCCEEDED.

- [ ] **Step 5: Commit.**

```bash
git add ios
git commit -m "feat(ios): engagement-driven ensureConnected + eager new-chat mint + id-gated flush; drop re-anchor hack"
```

---

## Phase 5 — End-to-end durability verification (Maestro, local Docker stack)

Reference the inline matrix in the spec §16. Drive against the running local stack
(`deploy/macos/`, project name `macos`). Rebuild the gateway image from this branch first.

### Task 5.1: Rebuild + boot the local stack

- [ ] **Step 1:**

```bash
source scripts/env.sh
cd deploy/macos && docker compose build gateway && docker compose up -d
docker compose ps   # all healthy
docker logs sentient-gateway --since 1m | tail -20
```
Expected: gateway healthy on the new image.

### Task 5.2: Run the matrix on Android (emulator) and iOS (simulator)

- [ ] **Step 1:** Author/extend Maestro flows under `qa/mobile/flows/{android,ios}/` for each matrix row in spec §16. Reuse the login subflow (PIN 1234, `pin-key-N` ids). For socket-death: Android arms via the debug `adb` broadcast; iOS — where no fault channel exists, simulate via airplane-mode toggle in the flow or flag the row as iOS-deferred per the iOS testing rule (do NOT silently skip).
- [ ] **Step 2:** For each row, run the flow, capture evidence to `qa/mobile/output/`, and grep the gateway + device logs for the expected trail. A row is green only when the user-visible result AND the log trail match.

Priority rows (must be green):
- `long-fg-idle-return` (the original bug): idle past 255 s → return focus → history refreshes, no stuck "Sending…", reply renders.
- `lost-echo`: send → kill socket pre-echo → reconnect → exactly one bubble (warm replay or gateway dedup), reply renders.
- `new-chat-plus-fresh` (iOS): "+" from a fresh chat opens a new empty chat.
- `send-during-reconnect`: "sending" flushes once attached, single bubble.

- [ ] **Step 3:** Capture results into `agents/docs/testing-knowledge.md` (new reusable cases) per the e2e rules.

### Task 5.3: Pre-handover gate

- [ ] **Step 1:** Full local CI + the mobile suites:

```bash
source scripts/env.sh
bun run ci
./gradlew :shared:mobile-sdk:test :shared:mobile-data:test :android:testDebugUnitTest
```
Expected: all green.

- [ ] **Step 2:** Confirm: every matrix row green or explicitly flagged (iOS fault gaps), evidence captured, deployable artifacts built (gateway image, XCFrameworks, Android debug APK). No partial green.

- [ ] **Step 3:** Update the memory note `project_ws_resilience_branch_complete` with the simplification outcome; hand the branch to the user (do NOT merge — standing instruction).

---

## Self-Review notes (for the executor)

- **Spec coverage:** every spec §3–§16 item maps to a task — connection (2.2), attach-by-id (2.3), no durable store (3.4), promoted pendingId (1.2/1.3 + 3.2), flush gate (3.1), timers (2.1/3.3), caps (1.1), deletions (1.4/3.2/3.4), Hermes-expired fallback (2.3), e2e matrix (Phase 5). The two design refinements found while planning are captured: dedup on PersonSession (1.2), cold-reconcile drop (3.4 Step 1).
- **Type consistency:** `admitPendingId(pendingId): boolean` (1.2 → 1.3); `flushIfReady(cache, status, attachedSessionId)` (3.1 → 4.1/4.2); `ensureConnected()` (2.2 → 4.1/4.2); `OutboundCache(clock, unackedTimeoutMs)` + `sweepTimeouts()` (3.3).
- **Build-green between phases:** Phase 1 (gateway) is independent; Phase 2/3 keep the SDK+mobile-data suites green; Phase 4 rebuilds XCFrameworks before the app build; Phase 5 is verification only.
- **Open at execution time:** confirm the exact `PersonSession` variable name at the configure site (1.3 Step 5); confirm the SDK one-shot event surface for `ReopenFailed` (2.3 Step 3) and the `flushIfReady`/`Status` types (3.1) by reading the files first — the code shown is the target shape.
