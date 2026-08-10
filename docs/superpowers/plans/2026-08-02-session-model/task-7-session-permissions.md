### Task 7: a permission prompt belongs to the session, not to a socket

**Spec:** §2.4. **Model:** opus — this is a security boundary. **Depends on tasks 5 and 6.**

`runtime/permission-broker.ts:14` says it plainly: *"One broker per WS connection, held on `ws.data.permissions`."* With one window per session that was right. With N windows, a prompt raised while you are at your laptop is unanswerable from your phone, and closing the laptop strands a tool call until it times out.

**Files:**
- Create: `gateway/src/runtime/session-permission-broker.ts`
- Modify: `gateway/src/runtime/permission-broker.ts` (keep the per-prompt state machine; move ownership)
- Modify: `gateway/src/tools/tool-broker.ts` (its `requestConfirm` seam)
- Modify: `gateway/src/session-handlers/ws-handlers.ts` (permission responses route by session)
- Test: `gateway/src/runtime/session-permission-broker.test.ts`

**Interfaces produced:**

```ts
export interface SessionPermissionBroker {
  /** Fan a prompt to every attachment; resolve on the FIRST answer. */
  request(req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision>;
  /** Answer from any attachment. Returns false when already settled. */
  resolve(requestId: string, decision: PermissionDecision, attachmentId: string): boolean;
  /** Deny everything outstanding — session teardown. */
  denyAll(reason: string): void;
}
```

---

- [ ] **Step 1: Failing test — raised on one window, answered on another**

```ts
it("INVARIANT: a prompt raised for one attachment can be answered by another", async () => {
  const pending = broker.request(req, signal);
  expect(connA.received).toContainEqual(expect.objectContaining({ type: "permission.request" }));
  expect(connB.received).toContainEqual(expect.objectContaining({ type: "permission.request" }));
  broker.resolve(req.requestId, { allow: true }, bAttachmentId);
  await expect(pending).resolves.toEqual({ allow: true });
});
```

`requestId`s are **session-global**: one id, fanned to every attachment, so any window's answer names the same prompt.

- [ ] **Step 2: Failing test — a second answer is refused, never re-decided**

```ts
it("SECURITY: a second answer to a settled prompt is refused and does not change the outcome", async () => {
  const pending = broker.request(req, signal);
  expect(broker.resolve(req.requestId, { allow: false }, aId)).toBe(true);
  expect(broker.resolve(req.requestId, { allow: true }, bId)).toBe(false);
  await expect(pending).resolves.toEqual({ allow: false });
});
```

The existing broker gets this right by removing the prompt from its map on answer. Preserve that property exactly — a deny that a later allow can overturn is a security defect, not a race.

- [ ] **Step 3: Failing test — the issuing window leaving does not strand the prompt**

```ts
it("INVARIANT: a prompt outlives the attachment that first displayed it", async () => {
  const pending = broker.request(req, signal);
  registry.detach("s_1", aId);
  expect(broker.resolve(req.requestId, { allow: true }, bId)).toBe(true);
  await expect(pending).resolves.toEqual({ allow: true });
});
```

The prompt entity lives on the **session**. This is the concrete reason the relocation is real work rather than a rename.

- [ ] **Step 4: Failing test — timeout denies, and zero windows denies immediately**

```ts
it("SECURITY: a prompt with no attachments is denied at once, not queued", async () => {
  registry.detachAll("s_1");
  await expect(broker.request(req, signal)).resolves.toEqual(
    expect.objectContaining({ allow: false }),
  );
});
```

Fail closed, both ways: a timeout resolves **deny**, and a prompt nobody can see is denied immediately rather than parked. A side-effecting tool waiting on a dialog nobody will ever see is the worst of both outcomes.

- [ ] **Step 5: Failing test — a resolution names the answering attachment in the log**

```ts
it("INVARIANT: a resolution is attributable to the attachment that answered", () => {
  broker.resolve(req.requestId, { allow: true }, bId);
  expect(logLines).toContainEqual(expect.objectContaining({ attachmentId: bId }));
});
```

With N windows, "who approved this" must be answerable from the log. Never log the prompt's arguments — the wire frame carries them, the log carries `argKeys` only, which is what the existing broker already does.

- [ ] **Step 6: Rebind the `requestConfirm` seam**

`ToolBroker.requestConfirm` is currently bound to *this connection's* broker at the composition root. Rebind it to the **session's** broker via the registry from task 5.

Watch for the trap: wrapping the old per-connection broker in a session-shaped façade would re-introduce per-connection resolution under a new name. The prompt map itself must move.

- [ ] **Step 7: Route responses by session, not by socket**

`ws-handlers.ts` resolves a permission response against `ws.data.permissions` today. It must resolve against the session the connection is attached to, carrying the `attachmentId` for attribution. Task 9's mediator is where the generation check goes; do not duplicate it here.

- [ ] **Step 8: Verify live — two windows, one prompt**

Ask for something that trips a confirm-tier rule (`delegateTask` is the reliable one). Confirm the dialog appears in **both** tabs, answering in either resolves it once, and the other tab's dialog closes showing the outcome rather than sitting stale.

Then repeat, closing the tab that raised it before answering in the other.

- [ ] **Step 9: Gate and commit**

```bash
source scripts/env.sh
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
```

```bash
git add -A gateway/src/runtime gateway/src/tools gateway/src/session-handlers
git commit -m "feat(permission): prompts belong to the session, and the first answer settles them"
```
