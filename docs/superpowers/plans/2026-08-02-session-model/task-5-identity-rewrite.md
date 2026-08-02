### Task 5: one runtime per session, many attachments — the structural cutover

**Spec:** §2.5. **Model:** opus. **Tasks 6–9 are incoherent until this lands.**

This is the change four independent reviewers found missing from the first spec draft. Everything else in this plan — one journal, one turn at a time, fan-out to N cursors — is false unless the runtime *is* the session.

**Files:**
- Create: `gateway/src/session-handlers/subscriber-set.ts`
- Create: `gateway/src/session-handlers/session-registry.ts`
- **Delete:** `gateway/src/session-handlers/conversation-runtime-registry.ts` + its test
- Modify: `gateway/src/runtime/session-runtime.ts` (the `sessionId` doc-comment at :174-186 is now wrong)
- Modify: `gateway/src/session-handlers/ws-session-configure.ts`, `ws-handlers.ts`
- Modify: `CLAUDE.md`, `docs/superpowers/specs/2026-07-23-sentient-2.0-native-orchestrator-design.md` §2.6
- Test: `gateway/src/session-handlers/session-registry.test.ts`

**Interfaces produced:**

```ts
export interface Attachment {
  readonly attachmentId: string;   // unique per attach; the log-attribution key
  readonly connectionId: string;
  readonly generation: number;     // task 9 validates commands against this
}

/** What one attach constructs on the first attachment: the runtime plus the
 *  per-session handles `ws-session-configure` builds today (its permission
 *  broker, its tool broker, its emitter). Read that file for the real shape —
 *  do not invent fields. */
export interface SessionHandles {
  runtime: SessionRuntime;
  dispose(): void;
}

export interface SessionRegistry {
  /** Attach a connection. Constructs the runtime on the FIRST attach only. */
  attach(sessionId: string, connectionId: string, build: () => SessionHandles): Attachment;
  detach(sessionId: string, attachmentId: string): void;
  subscribers(sessionId: string): readonly Attachment[];
  runtimeFor(sessionId: string): SessionRuntime | null;
  readonly size: number;
}
```

---

- [ ] **Step 1: Read the registry you are deleting, and keep its reasoning**

`conversation-runtime-registry.ts`'s header states the invariant that must survive:

> two live runtimes on one partition are two ReAct loops appending to one append-only log, each having read prior context without the other's writes — which breaks the store's cache-stable prefix invariant — plus two `bun:sqlite` handles contending on one WAL file.

**That is still true and still binding.** What changes is the remedy: today a second connection *evicts* the first (`previous.evict()` → deny open prompts + `runtime.dispose()`, aborting the in-flight turn). Tomorrow it *joins*. Exactly one runtime per `sessionId`; N attachments.

Carry that paragraph into the new module's header. Deleting the file must not delete the reason it existed.

- [ ] **Step 2: Failing test — a second attachment shares the runtime instead of evicting**

```ts
it("INVARIANT: a second connection to one session shares the runtime, never forks or evicts it", () => {
  const a = registry.attach("s_1", "conn-a", build);
  const b = registry.attach("s_1", "conn-b", build);
  expect(buildCallCount).toBe(1);
  expect(registry.subscribers("s_1")).toHaveLength(2);
  expect(handles.disposed).toBe(false);           // A was NOT torn down
  expect(a.attachmentId).not.toBe(b.attachmentId);
});
```

Under today's registry this test fails by *destroying* A — which is why the spec's `two-windows-live`, `join-midturn` and `last-one-out` rows are not merely unimplemented but incoherent.

- [ ] **Step 3: Failing test — the runtime dies with the LAST attachment, not the first**

```ts
it("INVARIANT: the runtime is disposed when the last attachment leaves", () => {
  registry.attach("s_1", "conn-a", build);
  registry.attach("s_1", "conn-b", build);
  registry.detach("s_1", aId);
  expect(handles.disposed).toBe(false);
  registry.detach("s_1", bId);
  expect(handles.disposed).toBe(true);
});
```

Task 8 replaces the "last one out disposes" rule with the retention predicate. Wire it as a **hook** here so task 8 substitutes a policy rather than rewriting this module.

- [ ] **Step 4: Failing test — a stale detach cannot kill a live attachment**

```ts
it("INVARIANT: a superseded connection's late close does not detach the live one", () => {
  const a = registry.attach("s_1", "conn-a", build);
  registry.detach("s_1", a.attachmentId);
  registry.detach("s_1", a.attachmentId);        // duplicate close event
  const b = registry.attach("s_1", "conn-b", build);
  registry.detach("s_1", a.attachmentId);        // stale
  expect(registry.subscribers("s_1")).toContainEqual(expect.objectContaining({ attachmentId: b.attachmentId }));
});
```

The old registry solved the analogous problem by comparing connection ids; `replay-registry.ts`'s lease model solves it for journals. Keep that discipline — detach is keyed on `attachmentId`, which is unique per attach, so a duplicate or late close is a no-op rather than a mis-hit.

Note this is the **only** thing the lease model is a precedent for. Its purpose — single ownership — is the opposite of a subscriber set, and the first spec draft called it "precedent" in a way that invited reusing exactly the wrong primitive.

- [ ] **Step 5: Failing test — one runtime per session, N sessions in parallel**

```ts
it("INVARIANT: distinct sessions get distinct runtimes", () => {
  registry.attach("s_1", "conn-a", build);
  registry.attach("s_2", "conn-b", build);
  expect(registry.runtimeFor("s_1")).not.toBe(registry.runtimeFor("s_2"));
});
```

- [ ] **Step 6: Re-key `SessionRuntime`**

`SessionRuntimeDeps.sessionId`'s doc-comment (`session-runtime.ts:174-186`) currently explains that the durable id is *"principal + the client's stable surface id"*. That is now wrong. Rewrite it: the id is server-minted and opaque (task 3), and the runtime is keyed on it.

Do not change `SessionRuntime`'s public shape beyond that. Fan-out is a property of the emitter it is handed (task 6), not of the runtime — keeping the runtime unaware of multiplexing is what stops it becoming a god-class.

- [ ] **Step 7: Cut `ws-session-configure` over**

Replace the `claim`/`release` calls with `attach`/`detach`. Hold the returned `Attachment` on the connection state — task 9 validates commands against its `generation`, and the logging contract needs its `attachmentId`.

- [ ] **Step 8: Supersede the documents that still say otherwise**

`CLAUDE.md` and 2.0 design §2.6 both state *"`SessionRuntime` — one per `(userId, surfaceId)`"*. Update both **in this task**. A contradiction left in the canonical docs is how the next reader inherits the old model — and this branch has three instances of documentation asserting something untrue.

- [ ] **Step 9: Verify live — two windows, one session**

Open the same session in two browser tabs. Confirm the first tab keeps working when the second attaches (it is torn down today), and that the gateway log shows **one** `react-loop.start` per turn, not two.

- [ ] **Step 10: Gate and commit**

```bash
source scripts/env.sh
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
bun qa/web/stack-integrity.ts
```

```bash
git add -A gateway/src/session-handlers gateway/src/runtime CLAUDE.md docs/superpowers/specs
git commit -m "refactor(session): key the runtime on sessionId and replace eviction with attachment"
```
