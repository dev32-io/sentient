### Task 14: a hot reload must tear down what the previous evaluation owned

**Wave 7 · model: opus · P1 · blocks T12, and poisons every developer's stack until fixed**

`bun --hot src/main.ts` — the documented dev command — re-evaluates the module graph **inside one process** and tears nothing down. Every reload constructs another `SystemOrchestratorService` and arms another `healthWatch` while every previous one keeps ticking; `stopHealthWatch()` is wired to gateway *shutdown*, which a hot reload never performs.

Measured on a single OS process (pid 59250) after two edits: **4 `gateway-started`, 4 `health-watch started`.** During task 12's run it reached twelve, of which five spawned a `whisper-stt` child within 10 ms of each other, signalled each other's children, and left survivors that read as *foreign* against pids whose parent is the gateway itself. Eight `reapply.gave-up`. It does not self-heal — the next reload adds a thirteenth.

**Why this matters beyond tidiness:** the wreckage looks exactly like a product defect. Most of one day was spent chasing symptoms this produced. Task 13's fix was correct but its population was too small — it solved *"a successor process meets a predecessor's child"*; this is *"N supervisors inside ONE process meet each other's children"*, which no pid file can arbitrate because they all write the same one.

**Files:**
- Modify: `gateway/src/main.ts` (the teardown registry and its wiring)
- Modify: `gateway/package.json` / root `package.json` if the dev command changes
- Modify: `gateway/CLAUDE.md`, `CLAUDE.md` if the dev command changes
- Modify: `docs/native-todo.md` (strike the P1)

---

- [ ] **Step 1: State probe — measure it yourself before changing anything**

```bash
source scripts/env.sh
pgrep -f "src/main.ts"                       # note the ONE pid
bun run dev &                                # wait for apply.complete state="ready"
# make two trivial edits ~10s apart to a module main.ts imports, then:
awk '$0 >= "<the boot timestamp>"' ~/.sentient/gateway/logs/$(date +%F).log | grep -c "gateway-started"
awk '$0 >= "<the boot timestamp>"' ~/.sentient/gateway/logs/$(date +%F).log | grep -c "health-watch] started"
pgrep -f "src/main.ts"                       # still ONE pid — that is the point
```
Both counts rise while the pid does not. **Anchor your counts to a timestamp, not to the last `gateway-started` line** — that line is what is multiplying, so counting "since the last boot" reads 1 forever and hides the defect. (I made exactly that mistake first.)

Also check what else leaks per reload, rather than assuming it is only the watchdog: the `Bun.serve` listener, the MCP host's per-user unix sockets under `~/.sentient/run/`, any interval or timer, and any open WS to STT/TTS. Enumerate before you design.

- [ ] **Step 2: Decide the approach, on evidence, and write down why**

Two honest options. **Weigh both and state your reasoning** — this is the task's real decision:

**(a) `bun --watch` — full process restart per change.** Correct by construction: the process dies, so every OS resource it owned is released by the kernel. Costs reload latency (a boot is ~12–15 s, mostly `apply`). The question to answer with a measurement, not a guess: how long does a `--watch` reload actually take, and is that acceptable for the edit-run loop?

**(b) `bun --hot` plus an explicit teardown registry.** Keeps sub-second reloads, but every OS resource the gateway owns must be released deliberately, and anything missed becomes exactly this defect again in a new place.

The mechanism for (b), if you choose it: **module state does not survive a hot reload, but `globalThis` does.** So a registry hung off `globalThis` lets a fresh evaluation find and dispose what its predecessor created, before constructing anything.

A process that owns unix sockets, docker containers, detached child processes and a TCP listener is a poor fit for in-process hot reload. That is an argument for (a), not a decision — measure the reload cost and choose.

- [ ] **Step 3: Failing test first**

Whichever approach: pin the invariant, not the mechanism.

```ts
it("INVARIANT: a second evaluation disposes the first's supervisor before arming its own", async () => {
  const stopped: string[] = [];
  // simulate: evaluate the composition root twice in one process
  // expect the first watchdog to have been stopped before the second starts
  expect(stopped).toContain("health-watch");
});
```
Read the real composition root first and match its shape — do not invent a factory that does not exist.

- [ ] **Step 4: What must NOT be torn down**

Getting this wrong is worse than the leak:

- **Detached native children must survive.** They are detached on purpose so a gateway crash does not take STT and TTS down with it, and task 13's ownership-from-pid-file path exists to re-adopt them. A teardown that kills them turns every keystroke into a 12-second addon restart.
- **The single-instance claim must survive.** Same pid, same claim; re-acquiring is a no-op but releasing it mid-reload would let a second gateway in through the window.
- **Docker addons must survive.** They are supervised, not owned by the process.

So the rule is: dispose what this *evaluation* created (watchdog, listener, sockets, timers); leave what the *machine* owns.

- [ ] **Step 5: Verify by measurement, on the real stack**

```bash
# after the fix, repeat Step 1 exactly
```
Expected: N edits, still one process, and **exactly one** live watchdog — plus no accumulation of `whisper-stt`/`local-tts` children, no `reapply.gave-up`, and `bun qa/web/stack-integrity.ts` printing `RESULT PASS` after the edits, not just after a cold boot.

That last one is the real acceptance test: the stack-integrity check is what T12 built to catch precisely this class, so it must pass *after* a reload storm.

- [ ] **Step 6: If the dev command changes, change the docs with it**

`gateway/CLAUDE.md` and the root `CLAUDE.md` both name `bun --hot src/main.ts`. A fix that leaves the docs pointing at the broken command is not a fix.

- [ ] **Step 7: Strike the P1, gate, commit**

```bash
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
```
Expected: ≥1227 pass.
