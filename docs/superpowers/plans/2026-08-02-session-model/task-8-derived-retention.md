### Task 8: a session stays because work is happening, not because a flag says so

**Spec:** §5. **Model:** opus. **Depends on task 5.** Fixes a live defect, not only a future one.

**The defect this closes today:** `SessionRuntime.dispose()` **deliberately leaves** registered background tasks alive — only `interrupt()` calls `broker.background.cancelAll()` — but it closes the SQLite handle, so a completion can never land. **Closing your last tab orphans a running delegated task.** `retention-holds-work` is a defect gate, not a comfort feature.

**Files:**
- Create: `gateway/src/runtime/session-retention.ts`
- Modify: `gateway/src/session-handlers/session-registry.ts` (substitute the disposal policy hooked in task 5)
- Modify: `gateway/src/session-handlers/replay-registry.ts` (the sweep reads the predicate)
- Modify: `gateway/config.yaml`, `shared/config/src/schema.ts`, `gateway/src/config/operator-config-migrator.ts`
- Test: `gateway/src/runtime/session-retention.test.ts`

**Interfaces produced:**

```ts
export type RetentionReason =
  | "hasSubscribers"
  | "isTurnInFlight"
  | "hasPendingForegroundTool"
  | "hasUnfinishedBackgroundTask"
  | "hasOutstandingPrompt"
  | "hasAuxiliaryTaskInFlight";

export function computeRetentionReasons(s: SessionLivenessInputs): RetentionReason[];
export function isRetained(s: SessionLivenessInputs): boolean;   // reasons.length > 0
```

---

- [ ] **Step 1: Failing test — retention is derived, and it names its reasons**

```ts
it("INVARIANT: retention reports which term holds the session, not just that one does", () => {
  const reasons = computeRetentionReasons({ ...idle, hasUnfinishedBackgroundTask: true });
  expect(reasons).toEqual(["hasUnfinishedBackgroundTask"]);
  expect(isRetained({ ...idle, hasUnfinishedBackgroundTask: true })).toBe(true);
});
```

A stored `workInFlight` boolean would be set and cleared at six sites and eventually leak one — holding a session resident forever, or dropping one mid-work. Derive on every evaluation. **Log the reasons**, or "why is this session still resident" is unanswerable and the timer becomes undebuggable.

- [ ] **Step 2: Failing test — the timer starts only on the transition**

```ts
it("INVARIANT: the disposal timer starts on the transition to not-retained, not on every check", () => {
  policy.evaluate(retained); policy.evaluate(retained);
  expect(policy.timerStarts).toBe(0);
  policy.evaluate(idle);
  expect(policy.timerStarts).toBe(1);
});
```

- [ ] **Step 3: Failing test — a term going true cancels a running timer**

```ts
it("INVARIANT: work resuming cancels a pending disposal rather than racing it", () => {
  policy.evaluate(idle);
  policy.evaluate({ ...idle, hasSubscribers: true });
  expect(policy.timerCancelled).toBe(true);
});
```

- [ ] **Step 4: Failing test — the disposal race the spec singles out**

```ts
it("INVARIANT: a timer that fired while a connection was attaching cannot dispose a live session", () => {
  policy.evaluate(idle);
  const stamp = policy.pendingGeneration;
  registry.attach("s_1", "conn-late", build);      // arrives after the timer fired
  policy.fireDisposal(stamp);
  expect(handles.disposed).toBe(false);
});
```

Disposal is **generation-stamped** and re-checks retention **under the same lock** immediately before disposing. This is the exact shape of the false-green failures this branch keeps hitting: a check that passed at time T is not a check that passes at time T+ε.

- [ ] **Step 5: Failing test — a lost background task cannot pin a session forever**

```ts
it("INVARIANT: a background task that stops reporting is marked lost and stops holding the session", () => {
  const inputs = { ...idle, hasUnfinishedBackgroundTask: true };
  watchdog.advance(LOST_TASK_THRESHOLD_MS + 1);
  expect(computeRetentionReasons(watchdog.inputs())).toEqual([]);
  expect(warnings).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("lost") }));
});
```

Derivation fires on state-change events. A worker that dies without emitting completion leaves `hasUnfinishedBackgroundTask` true **forever** and the timer never starts. So retention is also re-evaluated periodically, with a bounded gap after which a task is marked lost, removed from the predicate, and WARNed. Put the threshold in config.

- [ ] **Step 6: Wire the six inputs**

Hooks from `SessionRuntime` (turn in flight), `ToolBroker` (foreground call awaiting a result; background task registered), the session permission broker from task 7 (prompt outstanding), and the auxiliary-task runner from task 10 (`hasAuxiliaryTaskInFlight` — wire the input now, returning `false` until task 10 lands, and say so in a comment).

Substitute this policy into the disposal hook task 5 left. Do not rewrite the registry.

- [ ] **Step 7: The config rename**

`ReplayRegistry`'s sweep is reused; the **predicate feeding it is new**. Calling the whole thing "reuse" would understate it — say so in the module header.

- `session.replay_journal_retention_ms: 300000` → **`session.retention_ms: 900000`** (15 min), with a comment and range. The rename is required: the key now governs session lifetime, not journal bytes, and a key that under-describes its job is how the dead `session.idle_timeout_ms` survived with zero readers.
- Carry existing installs in `operator-config-migrator.ts`.
- `session.replay_journal_max_bytes` (16 MB) is now **per session** — a 1×→N× change against its tuned value. Re-tune with task 6 step 9 and note it in the comment.

- [ ] **Step 8: Verify live — the defect, reproduced then fixed**

Start a delegated task, then close **every** window before it completes. Reattach afterwards.

Expected: the result is there, and the log shows `hasUnfinishedBackgroundTask` as the holding reason with no dispose. Before this task, the same drive orphans the task — run it that way **first** so you have seen the failure your fix removes.

- [ ] **Step 9: Gate and commit**

```bash
source scripts/env.sh
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
```

```bash
git add -A gateway/src/runtime gateway/src/session-handlers gateway/config.yaml shared/config gateway/src/config
git commit -m "feat(session): keep a session while work is in flight, derived not flagged"
```
