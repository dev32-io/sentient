### Task 3: opaque ids, minting on first message, and rejecting what we never minted

**Spec:** §3.3, §3.5, §4.2. **Model:** opus — this task carries the wire change and the security-relevant addressing rules.

Today `ws-session-configure.ts:355` **derives** the id as `c::<userId>::<surfaceId>` and honours any client-presented id with that prefix, silently creating an empty partition for one it has never seen. This task replaces derivation with allocation, and the prefix parse with a membership lookup.

**Files:**
- Create: `gateway/src/session-handlers/session-id.ts`
- Modify: `gateway/src/session-handlers/ws-session-configure.ts` (`resolveConversationId` → membership lookup)
- Modify: `gateway/src/session-handlers/ws-session-new.ts`
- Modify: `shared/protocol/src/messages.ts` (the explicit-new-chat signal + the mint key)
- Modify: `shared/web-sdk/src/connectors/sessions-connector.ts`, `shared/mobile-sdk/.../SentientSdk.kt`
- Test: `gateway/src/session-handlers/session-id.test.ts`, `ws-session-configure.test.ts`

**Interfaces produced:**
- `mintSessionId(): string` — CSPRNG, ≥128 bits, opaque
- `isWellFormedSessionId(id: string): boolean` — accepts both a minted id and a legacy `c::` id
- `resolveSession(deps: { store: SessionStore; presented: string }): { sessionId: string } | { rejected: "unknown-session" }`
- `mintOnFirstMessage(deps: { store: SessionStore; mintKey: string; text: string }): { sessionId: string }` — creates the session row and the first entry in one transaction, and returns the **existing** id when `mintKey` was already used (task 2's `UNIQUE` constraint is what detects that)

---

- [ ] **Step 1: Failing test — ids are unguessable and carry nothing**

```ts
it("SECURITY: a minted session id embeds no identity and does not repeat", () => {
  const ids = new Set(Array.from({ length: 1000 }, mintSessionId));
  expect(ids.size).toBe(1000);
  for (const id of ids) {
    expect(id).not.toContain("u_");
    expect(id.length).toBeGreaterThanOrEqual(22);   // ≥128 bits, base64url
  }
});
```

Use `crypto.randomUUID()` or `crypto.getRandomValues` — **not** `Math.random()`. `auth/session-manager.ts:61` uses `Math.random().toString(36)` for a connection id; that is fine there and wrong here. Do not copy it.

- [ ] **Step 2: Failing test — an id we never minted is refused, not created**

```ts
it("SECURITY: an unknown session id is rejected rather than silently created", () => {
  const r = resolveSession({ store, presented: mintSessionId() });
  expect(r).toEqual({ rejected: "unknown-session" });
  expect(store.listSessionsWithMetadata()).toHaveLength(0);
});
```

The current behaviour — documented in `resolveConversationId`'s own comment as *"a new conversation, not an error"* — is what this replaces. Silently creating a partition for any well-formed string is the junk-partition vector.

- [ ] **Step 3: Failing test — a legacy id already in the store still opens**

```ts
it("INVARIANT: a legacy c:: partition with existing entries is addressable", () => {
  store.append(entryFor("c::u_0417d3b0::web-1"));
  expect(resolveSession({ store, presented: "c::u_0417d3b0::web-1" }))
    .toEqual({ sessionId: "c::u_0417d3b0::web-1" });
});
```

And the pair that proves the rule is membership, not shape:

```ts
it("SECURITY: a well-formed legacy id with no entries is rejected like any unknown id", () => {
  expect(resolveSession({ store, presented: "c::u_0417d3b0::never-used" }))
    .toEqual({ rejected: "unknown-session" });
});
```

**The prefix parse is retired.** No code path may infer ownership from an id's shape — the store being queried is already chosen by capability, which is the stronger check. The `surfaceId` embedded in a legacy id is dead metadata carrying no authority.

- [ ] **Step 4: Failing test — minting is idempotent under a dropped ack**

```ts
it("INVARIANT: retrying the first message with one mint key yields one session", () => {
  const a = mintOnFirstMessage({ store, mintKey: "k-1", text: "hello" });
  const b = mintOnFirstMessage({ store, mintKey: "k-1", text: "hello" });
  expect(b.sessionId).toBe(a.sessionId);
  expect(store.listSessionsWithMetadata()).toHaveLength(1);
});
```

The spec's R1 claimed the row, the entry and the ack "commit together". **They cannot** — the ack is a wire frame and cannot join a SQLite transaction. Commit succeeds, socket drops, client retries, and without this you get a second session plus a ghost holding a message the user can never reach.

So: the DB commit (session row + first entry) is atomic; the client supplies a mint key; the unique constraint from task 2 catches the retry and you **return the existing id**.

- [ ] **Step 5: The wire change — distinguish "the user pressed +" from "the app launched"**

Read `ws-session-new.ts`'s header in full first. It documents why `session.new` currently returns the existing id: **mobile fires it on every launch, twice per launch** (`ChatViewModel.init` turns a null route id into `sendNewChat()`), and minting per `session.new` would fork a conversation on every app open, destroying `reload-convergence` and `restart-persistence`.

`shared/protocol` is frozen, so this needs a deliberate delta. Decide between an explicit-intent field on `session.new` and a separate frame, and **say why in your report**. Then move the gateway, `shared/web-sdk` and `shared/mobile-sdk` in this task — a wire change split across tasks strands one client.

Also handle the no-session-yet state: mobile gates its outbound queue on `session.created` (`SendMessageUseCase.flushIfReady` refuses to drain while `attachedId` is null). If the answer is "you have no session yet", specify exactly what the client holds so the queue still drains on the first send.

- [ ] **Step 6: A fresh connection starts fresh; the draft leaves no trace**

A connection presenting no id gets an empty draft — **no row, no id**. The id is minted when the first message arrives. Ten opened tabs must leave the session list unchanged.

- [ ] **Step 7: Add the `session.title` frame while you are in the protocol**

Task 10 generates a session title and must push it to every attached window. It is a session-metadata frame of the same family as the mint broadcast in step 8, and the global constraint confines wire changes to this task and task 9 — so **add the frame type here** (owner's ruling, pre-flight review) and let task 10 merely emit it.

Shape: the session id, the new title, and its provenance (`"generated" | "user"`). Both SDKs move with it, in this task.

Nothing emits it yet. That is deliberate and different from adding an unused *type*: the frame has a named consumer in task 10 and a test row (`title-appears`), so it is scheduled work rather than speculative surface.

- [ ] **Step 8: Broadcast the mint**

Two windows can attach to one draft before either sends. When the first message mints the id, the new `sessionId` goes out on the session lane so the other window adopts it **without re-attaching**. (The session lane is formalised in task 6; here, emit it the way the existing code emits session frames and leave a comment pointing at task 6.)

- [ ] **Step 9: Verify live**

In the browser, press "+", send a message, and confirm on the wire that `stream-start messageCount` counts **only** the fresh turn. Then ask the model to repeat a marker string from before the click **without offering it an escape hatch** — an earlier round found the model falsely claiming `NO-CONTEXT` when offered one, while the wire showed the full prior transcript.

- [ ] **Step 10: Gate and commit**

```bash
source scripts/env.sh
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
```

```bash
git add -A gateway/src/session-handlers shared/protocol shared/web-sdk shared/mobile-sdk
git commit -m "feat(session): allocate opaque session ids and reject what we never minted"
```
