### Task 6: two lanes, one journal, N cursors — and a joiner that lands mid-turn

**Spec:** §2.1, §7.1, §7.2, §7.3. **Model:** opus. **Depends on task 5.**

**Files:**
- Create: `gateway/src/session-handlers/frame-lanes.ts`, `fan-out-emitter.ts`
- Create: `gateway/src/runtime/turn-state-snapshot.ts`
- Modify: `gateway/src/session-handlers/frame-journal.ts` (session-scoped; lane-aware write API)
- Modify: `gateway/src/session-handlers/replay-registry.ts` (journal keyed by session)
- Modify: `gateway/src/session-handlers/ws-turn-emitter.ts`, `ws-send.ts`
- Test: `frame-lanes.test.ts`, `fan-out-emitter.test.ts`, `turn-state-snapshot.test.ts`

**Interfaces produced:**
- `frameLane(type: GatewayMessage["type"]): "session" | "connection"` — total over the union
- `createFanOutTurnEmitter(deps: { registry: SessionRegistry; sessionId: string }): TurnEmitter`
- `captureTurnStateSnapshot(runtime: SessionRuntime): TurnStateSnapshot`

---

- [ ] **Step 1: Failing test — the lane table is TOTAL over the wire union**

```ts
it("CONTRACT: every gateway frame type is assigned a lane", () => {
  for (const type of ALL_GATEWAY_MESSAGE_TYPES) {
    expect(() => frameLane(type)).not.toThrow();
  }
});
```

Derive `ALL_GATEWAY_MESSAGE_TYPES` from the zod union in `shared/protocol` rather than hand-listing it — a hand-list silently rots the moment a frame is added, which is exactly the failure this test exists to prevent. A frame type with no lane must **throw**, not default: the spec says an unassigned type is a contract break.

- [ ] **Step 2: Failing test — connection-lane frames never reach another window**

```ts
it("SECURITY: a connection-lane frame is not journaled and not fanned out", () => {
  const emitter = createFanOutTurnEmitter({ registry, sessionId: "s_1" });
  sendConnectionFrame(connA, { type: "pong" });
  expect(journalFor("s_1").frames).toHaveLength(0);
  expect(connB.received).toHaveLength(0);
});
```

`ws-send.ts` already splits `sendGatewayFrame` (sequenced) from `sendUnsequencedFrame` (not) — the distinction exists *accidentally*. This makes it deliberate and enforced.

- [ ] **Step 3: Failing test — one allocation, N cursors**

```ts
it("INVARIANT: a session frame is allocated once and read by every cursor", () => {
  const emitter = createFanOutTurnEmitter({ registry, sessionId: "s_1" });
  emitter.textDelta("t1", "hi");
  expect(journalFor("s_1").frames).toHaveLength(1);
  expect(connA.received.at(-1)).toEqual(connB.received.at(-1));
});
```

The journal moves from per-surface to per-session, so the seq lives in the session's space. Cursors differ; bytes do not.

- [ ] **Step 4: Failing test — a dead subscriber cannot silence the session**

```ts
it("INVARIANT: a throwing subscriber is dropped and the others still receive", () => {
  connA.send = () => { throw new Error("socket gone"); };
  emitter.textDelta("t1", "hi");
  expect(connB.received).toHaveLength(1);
  expect(registry.subscribers("s_1")).not.toContainEqual(expect.objectContaining({ connectionId: "conn-a" }));
});
```

Log a WARN with a `reason` when dropping. One wedged socket must never stop a conversation for everyone.

- [ ] **Step 5: Failing test — the attach linearization point**

```ts
it("INVARIANT: a frame emitted during attach is delivered exactly once, in order", async () => {
  const attaching = attachWithSnapshot(registry, "s_1", connB);
  emitter.textDelta("t1", "mid-attach");        // races the snapshot
  await attaching;
  expect(connB.received.filter(isTextDelta)).toHaveLength(1);
});
```

The first spec draft said "send the feed, then place the cursor at head" — a frame emitted between the two steps is **lost silently**. Capture `{store watermark, journal seq}` atomically, register the subscriber, **buffer** concurrent emissions, send the snapshot, then drain.

Four separable sub-invariants, each worth its own `it()`: the capture is atomic; nothing between watermark and cursor is dropped; nothing is delivered twice; the drain preserves order.

- [ ] **Step 6: Failing test — a joiner mid-turn does not re-hear old audio**

```ts
it("INVARIANT: a joiner receives the in-flight turn's state but no historical audio", async () => {
  const snap = await attachWithSnapshot(registry, "s_1", connB);
  expect(snap.activeTurnId).toBe("t1");
  expect(snap.textSoFar).toContain("partial");
  expect(connB.received.filter(isAudioFrame)).toHaveLength(0);
});
```

Clients build in-flight UI from **transient prerequisite** frames — `turn.started` before deltas, audio-start before audio, a prompt before its resolution. A joiner given only committed entries plus a head cursor renders deltas for a turn it never saw start.

**Ownership:** `SessionRuntime` owns the snapshot and emits it atomically at attach. It is **not** journaled and is recomputed live. If no runtime is resident, the session rehydrates first and the snapshot is empty by definition — there is no in-flight turn to describe.

- [ ] **Step 7: State the replay invariant correctly in code comments**

The draft asserted `render(replay) == render(live)` for joiners. It cannot hold: a joiner's live view is *snapshot + subsequent frames*, while replaying from that cursor later yields *subsequent frames only*. The true form:

> `render(replay_from(seq)) == render(live_at(seq))` for any seq a client genuinely reached.
> A fresh joiner is `snapshot ∪ replay_from(watermark)` — a different, defined path that converges with the committed projection once the in-flight turn commits.

Both paths get a test. Conflating them is what made the original claim false.

- [ ] **Step 8: The logging contract**

Every session-lane line carries `sessionId` + `turnId`. Every command, permission and cancellation line additionally carries `attachmentId`. Under one window per session `turnId` sufficed; with N windows an unattributed Stop cannot be traced. Add a `audio.skip-reason="midturn-join"` line where a joiner's audio replay is suppressed, so step 6's behaviour is visible in a log.

- [ ] **Step 9: Bound the lag — decide, do not defer**

`ws-send.ts:64` ignores `ws.send()`'s return value, and `frame-journal.ts` evicts oldest while never evicting the only frame. With a shared journal a slow window's prerequisite frames can be evicted while it lags — and a stale `turn.started` can pin itself as the last survivor.

Pick **one** policy — forced re-snapshot or disconnect past a maximum lag — put the threshold in `config.yaml` with a comment and range, and log evictions. Two implementers choosing opposite defaults here is a real risk; record your choice and why.

- [ ] **Step 10: Gate and commit**

```bash
source scripts/env.sh
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
bun qa/web/stack-integrity.ts
```

```bash
git add -A gateway/src/session-handlers gateway/src/runtime gateway/config.yaml shared/config
git commit -m "feat(session): session-scoped journal with two lanes, fan-out and an atomic attach"
```
