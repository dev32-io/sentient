### Task 9e: D12 — the gateway never answers `session.new`

**Wave 6 · model: opus · blocks the entire mobile surface**

`gateway/src/session-handlers/ws-handlers.ts:189` routes `session.new` and `conversation.activate` to the `default:` arm with "not yet wired". The client waits for a reply that never comes, so **no mobile text send completes on either platform**. Seven Android rows in the native matrix are red on this single cause, plus `12-permission-confirm` on both platforms. Web is unaffected — it never sends `session.new`.

Both reply frames already exist in the frozen contract: `session.created` and `session.switched`, `shared/protocol/src/sessions.ts:40,57`. **This is a task about answering, not designing.** Do not extend the protocol.

**Files:**
- Modify: `gateway/src/session-handlers/ws-handlers.ts` (the `default:` arm)
- Modify: whatever mints a session id + store handle today (read before assuming — `SessionRuntime` owns the store handle)
- Test: `gateway/src/session-handlers/*.test.ts`

Do **not** touch `shared/protocol/**`. The contract is frozen and already sufficient; a change there is a finding.

---

- [ ] **Step 1: State probe**

```bash
git log --oneline -10
git status --short
sed -n '180,200p' gateway/src/session-handlers/ws-handlers.ts
grep -rn "session.new\|session.created\|conversation.activate\|session.switched" \
  gateway/src shared/protocol/src --include='*.ts' | grep -v '\.test\.'
```

- [ ] **Step 2: Read the trap before writing anything**

`gateway/src/session-handlers/ws-session-configure.ts:375-400` documents a live residual you can walk straight into. Both SDKs treat a history-refetch as following certain frames, and **`GET /sessions/:id/messages` is a route this gateway does not serve** (sessions CRUD is later scope). Mobile's `SentientSdk.onStreamResumed` → `refetchHistoryForSession` has no handler-map gate, so a 404 lands *after* the snapshot and replaces the mirror with an empty list.

Consequence for you: **answering `conversation.activate` with `session.switched` can make the mobile client wipe the visible chat.** Answering `session.new` does not carry that risk.

So the two halves are not equivalent, and the task's priority is explicit:
- **`session.new` → `session.created` is the deliverable.** It unblocks every red row.
- **`conversation.activate` is only in scope if you can prove it does not wipe the mirror.** Drive it on a real device and look at the screen. If it wipes, leave it in `default:`, replace the stale "not yet wired" comment with the real reason and a pointer to the REST route it waits on, and record it in `docs/native-todo.md` § 2 under multi-conversation. **Shipping a chat-wiping frame to unblock a test row would be a bad trade** — say so and stop rather than forcing it.

- [ ] **Step 3: Write the failing test**

Pin the wire contract at the process boundary — a `session.new` gets a `session.created` carrying a usable id:

```ts
it("WIRE: session.new is answered with session.created carrying the live session id", async () => {
  const sent: unknown[] = [];
  const ws = fakeWs({ send: (f: unknown) => sent.push(f) });
  await handleMessage(ws, { type: "session.new", requestId: "r1" });
  const reply = sent.find((f) => (f as { type: string }).type === "session.created");
  expect(reply).toBeDefined();
  expect((reply as { sessionId: string }).sessionId).toBeTruthy();
  // the frame must survive the outbound validator, not merely be constructed
  expect(gatewayMessageSchema.safeParse(reply).success).toBe(true);
});
```

Read the real `handleMessage` signature and the existing test harness first — match them, do not invent a shape. The `safeParse` line is not decoration: a frame that is constructed but never validated leaves the schema decorative, which a previous task in this plan was pulled up on.

- [ ] **Step 4: Run it red, then implement the minimum**

```bash
cd gateway/src && bun test session-handlers/
```
Expected: fails because nothing answers. Then implement — and mind the two things the `default:` arm's comment hides:
- **`requestId` correlation.** `session.new` carries one; `session.created` does not echo it. Check how the client correlates before assuming, and if it cannot, that is a real finding to report, not something to fix by editing the frozen protocol.
- **Failure path.** `sessions.error` exists with a `code` enum for exactly this. A failure must produce one, not silence — silence is the defect you are fixing.

- [ ] **Step 5: Verify on a real device, not just in the suite**

The whole point of this task is that a green suite already coexisted with a dead surface.

```bash
./qa/mobile/run-e2e.sh android --tags chat,session
```
Expected: the seven rows the native matrix left FAIL-with-evidence go green **unchanged** — do not edit a flow to make it pass. A flow needing an edit means the fix is not the one the matrix was waiting for. Re-drive `12-permission-confirm` on both platforms too.

- [ ] **Step 6: Update the record**

`qa/mobile/` results rows and `agents/docs/testing-knowledge.md` carry D12 as an open defect. Close them with the live evidence, and strike D12 from `docs/native-todo.md` § 1 — **only** for the half you actually closed. If `conversation.activate` stayed deferred, § 2 gains its precise reason.

- [ ] **Step 7: Full gate + commit**

```bash
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
git commit -m "fix(sessions): answer session.new so a client can start a chat" -- \
  gateway/src/session-handlers/ qa/mobile/ agents/docs/testing-knowledge.md docs/native-todo.md
```
Expected: ≥1138 pass.

---

### E2E matrix

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| `native-turn-happy` (re-drive) | Android emulator | logged in, fresh chat | send a text message | the reply streams into the feed | `session.created` → `turn.started` → `turn.delta`* → `turn.completed`; no `message-unhandled` |
| `native-turn-happy` (re-drive) | iOS simulator | logged in, fresh chat | send a text message | same | same |
| `permission-confirm` (re-drive) | Android + iOS | logged in | ask for a `confirm`-tier tool | permission dialog appears, Allow completes the turn | `permission.request` → `permission.response` → `turn.completed` |
| `session-new-failure` | Android emulator | store unavailable for the new session | send `session.new` | a visible error, not a hung composer | `sessions.error` with a `code`, never silence |
| `conversation-activate` | Android emulator | two sessions exist | activate the older one | **the visible chat is NOT wiped** | `session.switched` and no empty-mirror replace — if it wipes, leave unhandled per Step 2 |
