### Task 9b: Fix the defects the web E2E matrix found

**Wave 5 (addendum) · model: opus · blocks T10 and the plan's own acceptance**

T9 drove all 11 web rows against the real stack and found six defects. Seven rows PASS. Four are blocked or partial, and **three of the four share a single root cause**. None were fixable inside T9's ownership (`qa/web/**`), so they are collected here.

**The headline:** `delegateTask` — the entire justification for this migration — **still does not work end to end.** The migration fixed the OS/ABI blocker exactly as designed (the gateway can now spawn `hermes`), and that exposed a *second*, unrelated blocker underneath it: Hermes provisioning was never wired for gateway-created users. Fixing that is what finally proves the migration's premise.

**Files:**
- Modify: `gateway/src/admin/user-provisioner.ts` (+ hermes profile creation), `gateway/src/tools/hermes-runner.ts` (diagnostics)
- Modify: `gateway/src/system-orchestrator/native-driver.ts` (`spawnService` hang)
- Modify: `gateway/src/runtime/session-runtime.ts` (`nextTurnTrigger` stale snapshot)
- Modify: `gateway/src/runtime/compaction.ts`, `shared/config/src/schemas/orchestrator-config.ts`, `gateway/config.yaml` (summarizer token budget)
- Modify: `docs/superpowers/specs/2026-07-29-native-stack-migration-design.md` §9.2 (correct the barge-in row)

---

- [ ] **Step 1: State probe**

```bash
git log --oneline -12
git status --short
ls qa/web/evidence/           # T9's per-case root-cause READMEs — read the ones you are fixing
tail -40 .superpowers/sdd/progress.md
```
Each defect below has a full reproduction in `qa/web/evidence/2026-07-30-<case>/README.md`. **Read the relevant one before fixing** — the diagnosis is already done; do not re-derive it.

---

#### P1 — Defect 5: `local-tts` boot spawn hangs (reproduced 2/2)

This is first because it defeats the health watchdog's whole premise: the hang means `apply.complete` never fires, so `health-watch` never starts. T8b verified the watchdog recovers a *running* stack; this is the boot path.

- [ ] **Step 2: Reproduce before changing anything**

```bash
pkill -f "bun --hot src/main.ts" || true
pgrep -f local_tts | xargs -r kill -9
cd gateway && bun --hot src/main.ts 2>&1 | tee /tmp/boot-hang.log &
sleep 90
grep -E "native.started|apply.start|apply.complete|local-tts" ~/.sentient/gateway/logs/$(date +%F).log | tail -20
```
Expected (the defect): `apply.start` for local-tts, then **no** `native.started` and **no** `apply.complete`. T9 ruled out the command itself and port conflicts, narrowing it to `spawnService()`'s call chain.

- [ ] **Step 3: Find the blocking await**

Read `spawnService` and everything it awaits — `prepare()`'s interpreter-version probe is the prime suspect (it spawns a child and reads its output; a child that never closes its stdio leaves that await pending forever). Note `native-io.ts` has a `VERSION_PROBE_TIMEOUT_MS` constant — check whether it is actually **enforced** on the probe, or merely declared.

- [ ] **Step 4: Write the failing test**

Pin the invariant, not the symptom: *no single service's spawn can block apply forever.*

```ts
it("INVARIANT: a spawn that never returns cannot hang apply — it times out and reports failure", async () => {
  const driver = createNativeDriver({
    // a spawn that never settles, i.e. the observed boot hang
    spawn: () => ({ pid: 999, exited: new Promise(() => {}), kill: () => {} }),
    probeInterpreter: () => new Promise(() => {}),   // never resolves
    writePidFile: async () => {}, readPidFiles: async () => [], killPid: () => {},
  });
  const started = Date.now();
  const r = await driver.prepare(nativeService("local-tts", ["/bin/true"]));
  expect(r.ok).toBe(false);                       // fails, rather than hanging
  expect(Date.now() - started).toBeLessThan(15_000);
});
```

- [ ] **Step 5: Run it, watch it hang or fail, then fix**

```bash
cd gateway/src && bun test system-orchestrator/native-driver.test.ts
```
Expected: the test times out or fails. Fix by bounding **every** await in the spawn/prepare path with the config'd timeout, and returning a `Result` failure with a `reason` naming the service and the stage. A service that cannot start must fail loudly and let apply continue — never wedge the whole reconcile.

- [ ] **Step 6: Verify the real boot, then commit**

Re-run Step 2. Expected: either local-tts starts, or it fails with a named reason **and `apply.complete` still fires** so `health-watch` starts.

```bash
git commit -m "fix(orchestrator): bound the native spawn path so one addon cannot wedge apply" -- \
  gateway/src/system-orchestrator/
```

---

#### P1 — Defects 1 & 2: Hermes provisioning is broken for every fresh user

- [ ] **Step 7: Reproduce both halves**

```bash
# 1. no profile is created for a gateway-provisioned user
ls ~/.sentient/gateway/*/profiles/ 2>/dev/null
grep -rn "profile create\|hermes profile" gateway/src --include='*.ts' | grep -v '\.test\.'
# 2. even a manually-created profile has no bound model/key — call hermes directly, bypassing the gateway
hermes -p <someUserId> -z "say ok" ; echo "EXIT=$?"
```
Expected: no `hermes profile create <userId>` call site anywhere, and a direct invoke failing on an unbound model/key.

Note the constraint that survives from Wave 3: `hermes-runner` sets its subprocess `cwd` to `resolveProfileDir(userId)` and **the profile must already exist**. `renderInnerProfile` writes the *inner* profile; what is missing is Hermes's own profile registration plus its model/key binding.

- [ ] **Step 8: Write the failing test**

```ts
it("INVARIANT: provisioning a user creates its hermes profile and binds a model", async () => {
  const calls: string[][] = [];
  const provisioner = createUserProvisioner({
    /* ...existing deps... */
    runHermesCli: async (argv) => { calls.push(argv); return { ok: true }; },
  });
  await provisioner.createUser({ userId: "u_deadbeef", /* ... */ });
  expect(calls.some((c) => c.includes("profile") && c.includes("create"))).toBe(true);
  // a profile with no bound model cannot answer a delegateTask
  expect(calls.some((c) => c.join(" ").match(/model|key/))).toBe(true);
});
```
Read the real `createUserProvisioner` signature first and match it — do not invent deps.

- [ ] **Step 9: Implement, then prove it end to end**

Wire profile creation + model/key binding into user provisioning, sourcing the key from the operator's secrets store via `getActiveLlm()` — **never** an env var, and never log the key value.

Then prove the thing this whole migration exists for:

```bash
# create a NEW user through the real admin path, then ask for delegated work in the webui
hermes -p <newUserId> -z "say ok"; echo "direct EXIT=$?"
grep -E "delegate|hermes-runner" ~/.sentient/gateway/logs/$(date +%F).log | tail -10
```
Expected: the direct invoke answers, and `delegateTask` returns a `{taskId}` and later a real completion.

- [ ] **Step 10: Commit**

```bash
git commit -m "fix(admin): create and bind a hermes profile when provisioning a user" -- \
  gateway/src/admin/ gateway/src/tools/hermes-runner.ts
```

---

#### P2 — Defect 4: compaction never completes (and now fires sooner)

- [ ] **Step 11: Understand the interaction before touching the threshold**

T9 lowered `compact_threshold_tokens` 24000 → 8000 so the trigger could be exercised. The trigger works. The **summarizer** fails empty-summary 2/2: `gpt-oss:20b` burns `max_output_tokens: 1024` on its Harmony reasoning channel before emitting any visible text. `maybeCompact()` runs at every turn end, so a failed compaction **retries every turn, silently, while context grows unbounded** — and at 8000 that now starts much earlier than before. The lowered threshold made a latent defect frequent.

- [ ] **Step 12: Give the summarizer its own token budget**

The main loop's 1024 is a reasonable answer cap; a summarizer needs headroom for reasoning plus a summary. Add a dedicated key rather than raising the global:

```yaml
    # Output cap for the compaction summarizer specifically. The main loop's
    # max_output_tokens is an ANSWER cap; a reasoning model (gpt-oss:20b emits a
    # Harmony reasoning channel first) exhausts 1024 before producing any visible
    # summary text, which fails compaction silently and forever. Range 512-8000.
    summarizer_max_output_tokens: 4000
```

- [ ] **Step 13: Make a failed compaction loud and non-thrashing**

Two invariants to pin with tests: an empty/failed summary must **not** be appended as a compaction entry (that would corrupt the model projection), and a repeated failure must log at `error` with a reason and **back off** rather than retrying every single turn boundary.

- [ ] **Step 14: Verify against the real model, then commit**

Drive a conversation past the threshold and confirm a compaction entry is actually appended and the conversation continues coherently.

```bash
git commit -m "fix(orchestrator): give the compaction summarizer its own token budget" -- \
  gateway/src/runtime/compaction.ts shared/config/src/schemas/orchestrator-config.ts gateway/config.yaml
```

---

#### P2 — Defect 3: phantom follow-up turn from a stale `lastProcessedSeq`

- [ ] **Step 15: Write the failing test**

`nextTurnTrigger()` re-fires an already-consumed mid-loop steer as an empty follow-up turn, because it compares against a stale `lastProcessedSeq` snapshot. Costs an LLM call and leaks a local-tts WebSocket per occurrence.

`session-runtime.test.ts` already has the harness for mid-loop steer — extend it: a steer consumed *during* a turn must **not** produce a second turn after it settles.

- [ ] **Step 16: Fix, then verify no leak**

Re-read `lastProcessedSeq` at decision time rather than using the captured snapshot. **Preserve** the genuine back-to-back follow-up (a stimulus landing *after* the final answer must still start a new turn) — that is spec §4.5 and it has its own tests. Do not fix the phantom by disabling real follow-ups.

```bash
cd gateway/src && bun test runtime/session-runtime.test.ts
git commit -m "fix(runtime): do not re-fire a steer already consumed mid-turn" -- gateway/src/runtime/
```

---

#### P3 — Defect 6: the spec's barge-in row describes a control that does not exist

- [ ] **Step 17: Correct the spec, do not paper over it**

Spec §9.2 lists `barge-in (UI stop arm)` as agent-drivable. That premise is **wrong**: `runtime.bargeIn()`'s only production caller is STT speech-onset (`stt-session.ts`), and the webui Stop button always yields `cutoff: "interrupt"`. There is no UI barge-in.

Correct §9.2 to a single `barge-in (acoustic, mic onset)` row marked operator-handoff, and note in §9.4 that the earlier "UI arm" split was a planning error — so a future reader does not reintroduce it.

- [ ] **Step 18: Full gate + commit**

```bash
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
git commit -m "docs(spec): barge-in has no UI arm — correct the E2E matrix" -- \
  docs/superpowers/specs/2026-07-29-native-stack-migration-design.md
```

- [ ] **Step 19: Re-drive the unblocked rows**

With defects 1/2 fixed, `delegate-hermes-bg`, `steer-followup-audio` and `interrupt`'s background-cancel arm become drivable **for the first time ever**. Drive all three, update `qa/web/evidence/` and the results table. If any still fails, leave it FAIL with the new evidence — never flip a row on an unverified fix.
