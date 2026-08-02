### Task 9: a command names its session, and the first window to talk wins

**Spec:** §3.7, §8.3. **Model:** opus. **Depends on task 5.**

This is a **requirement, not a risk** — it is the correctness condition for the switching the whole redesign exists to deliver. `text.input`, `interrupt` and permission responses carry no session id, and binary audio uses the ambient `ws.data.runtime`. The moment session switching exists, a command issued before a switch lands on the session after it.

**Files:**
- Create: `gateway/src/session-handlers/command-mediator.ts`
- Modify: `shared/protocol/src/messages.ts` (session binding on command frames)
- Modify: `gateway/src/session-handlers/ws-handlers.ts`, `stt-session.ts`
- Modify: `shared/web-sdk/src/**`, `shared/mobile-sdk/src/**`
- Test: `gateway/src/session-handlers/command-mediator.test.ts`

**Interfaces produced:**

```ts
export type CommandVerdict =
  | { accept: true; sessionId: string; attachmentId: string }
  | { accept: false; reason: "stale_generation" | "not_attached" | "session_busy" | "credential_expired" };

export function mediateCommand(cmd: InboundCommand, conn: ConnectionState, registry: SessionRegistry): CommandVerdict;
```

---

- [ ] **Step 1: Failing test — a pre-switch command does not land on the post-switch session**

```ts
it("INVARIANT: a command carrying a stale attachment generation is dropped, not applied", () => {
  const a = registry.attach("s_1", "conn-a", build);
  registry.detach("s_1", a.attachmentId);
  const b = registry.attach("s_2", "conn-a", build);
  const verdict = mediateCommand({ type: "text.input", sessionId: "s_1", generation: a.generation }, conn, registry);
  expect(verdict).toEqual({ accept: false, reason: "stale_generation" });
  expect(store.readSession("s_2")).toHaveLength(0);
});
```

- [ ] **Step 2: Failing test — a rejection is explicit, never silence**

```ts
it("CONTRACT: a rejected command produces a rejection frame the client can act on", () => {
  mediateCommand(staleCmd, conn, registry);
  expect(conn.sent).toContainEqual(expect.objectContaining({ type: "command.rejected", reason: "stale_generation" }));
});
```

Silence here is indistinguishable from a lost network and leaves a client waiting forever. Say no out loud.

- [ ] **Step 3: Failing test — a stale command discards its STT buffer without committing a partial**

```ts
it("INVARIANT: a stale-generation command resets STT rather than committing a partial utterance", () => {
  mediateCommand(staleAudioCmd, conn, registry);
  expect(sttSession.buffered).toBe(0);
  expect(store.readSession("s_1").filter(isUserEntry)).toHaveLength(0);
});
```

Committing half an utterance into the wrong session is worse than dropping it.

- [ ] **Step 4: Failing test — input arbitration: first window wins a race**

```ts
it("INVARIANT: two inputs racing at one dispatch resolve to the first; the second is refused busy", () => {
  const first = mediateCommand(inputFrom(connA), connA, registry);
  const second = mediateCommand(inputFrom(connB), connB, registry);
  expect(first.accept).toBe(true);
  expect(second).toEqual({ accept: false, reason: "session_busy" });
});
```

Owner's decision, and it generalises past voice: **a connection is a window onto the session, and the first window to talk wins.** Applies to every input form — mic onset, text, anything later.

- [ ] **Step 5: Failing test — later input during a turn still STEERS**

```ts
it("INVARIANT: input arriving during a running turn steers it rather than being refused", () => {
  startTurn("s_1", connA);
  advanceIntoTurn();
  expect(mediateCommand(inputFrom(connB), connB, registry).accept).toBe(true);
  expect(turnsStarted).toBe(1);      // steered, not a second turn
});
```

**This is the pair that makes step 4 correct.** Arbitration is for *simultaneous contention*, not a floor lock for the whole turn — a floor lock would make one speaker own the session until their turn ended, defeating multi-window entirely. Steering is the existing 2.0 stimulus seam; do not build a second one.

- [ ] **Step 6: Failing test — barge-in from any window is honoured and stays idempotent**

```ts
it("INVARIANT: a second barge-in on an already-aborted turn commits no second cutoff entry", () => {
  runtime.bargeIn(); runtime.bargeIn();
  expect(store.readSession("s_1").filter((e) => e.cutoff === "barge-in")).toHaveLength(1);
});
```

`cancellation.ts:43-44` already documents that a second `bargeIn()` sees the aborted signal, so the machinery exists — this pins it against the multi-window case. `stt-session.ts:110` is the only production caller.

Note the user-visible change to record in the module header: under the old per-surface model, barge-in on one surface affected only that surface. Under one runtime per session it aborts the shared turn for everyone attached. **That is intended.**

- [ ] **Step 7: Failing test — an expired credential stops authorizing (spec §3.6)**

```ts
it("SECURITY: a command on a connection whose token has expired is refused", () => {
  conn.tokenExpiresAt = Date.now() - 1;
  expect(mediateCommand(inputFrom(connA), conn, registry))
    .toEqual({ accept: false, reason: "credential_expired" });
});
```

`UserPrincipal` is `Object.freeze({ userId, role, householdId })` (`identity/user-principal.ts:20`) — **no expiry field** — and the PASETO token is validated once at connect. An attachment can therefore outlive its credential indefinitely: a token expiring mid-session keeps authorizing for hours.

Carry `tokenExpiresAt` on the **connection state**, not the principal — the principal is an identity anchor and must stay immutable. Revalidate here, at the same choke point, and fail closed. Add `"credential_expired"` to `CommandVerdict`'s reason union.

This covers reads too, not only writes: a revoked principal must not keep receiving session content. Detach the attachment on expiry rather than merely refusing its commands.

- [ ] **Step 8: Failing test — `pendingId` is unique per attachment (spec §3.8)**

```ts
it("INVARIANT: two windows reusing one pendingId do not suppress each other's message", () => {
  submitFrom(connA, { pendingId: "p-1", text: "from A" });
  submitFrom(connB, { pendingId: "p-1", text: "from B" });
  expect(store.readSession("s_1").filter(isUserEntry)).toHaveLength(2);
});
```

`findByPendingId(sessionId, pendingId)` is the durable client-resend idempotency record (`store/session-store.ts:78`) and it is **session-scoped**. With N windows appending to one session, two windows that happen to reuse a value would have the second silently deduped away — a lost message that looks like a network fault.

Scope the dedup key by attachment (or namespace the `pendingId` at the mediator) so resend idempotency still works per window without colliding across them.

- [ ] **Step 9: The wire delta**

Command frames carry `sessionId` **and** `attachmentGeneration`. `shared/protocol` is frozen, so gateway, `shared/web-sdk` and `shared/mobile-sdk` move together in this task — a wire change split across tasks strands one client.

Binary audio frames need the same binding. Their header is fixed-width, so decide deliberately whether the generation rides the header or the connection's attachment is authoritative for audio, and **say why**.

- [ ] **Step 10: One choke point, not sprinkled checks**

Every inbound command passes through `mediateCommand` — one place, mirroring `ToolBroker`'s single-gate discipline. Verb-style checks scattered across `ws-handlers.ts` is how a bypass appears later (barge-in bypassing the gate is exactly that shape).

**No source-attribution column this wave.** Entries carry no `sourceSurfaceId` and do not need one under this rule. If attribution is wanted later it is a migration-ladder change — never a `STORE_DDL` edit.

- [ ] **Step 11: Verify live**

Two tabs on one session. Send from both simultaneously → one lands, one gets a busy rejection visible in the log. Then send from B three seconds into A's turn → it steers, one reply, one `react-loop.start`.

Then switch sessions in one tab with an input in flight and confirm it does not appear in the new session.

- [ ] **Step 12: Gate and commit**

```bash
source scripts/env.sh
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
bun qa/web/stack-integrity.ts
```

```bash
git add -A gateway/src/session-handlers shared/protocol shared/web-sdk shared/mobile-sdk
git commit -m "feat(session): bind commands to their session and arbitrate simultaneous input"
```
