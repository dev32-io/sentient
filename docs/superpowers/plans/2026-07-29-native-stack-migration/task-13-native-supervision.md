### Task 13: native addon supervision — identity, not just liveness

**Wave 7 · model: opus · P0 · blocks T12 (nothing can be E2E'd against a stack that isn't running)**

Native addon supervision has never worked. Both addons exit `code=1` within ~400 ms of every spawn, and the orchestrator reported `apply.complete state="ready"` anyway — because its health probe was answered by a **day-old orphan**. Every green reading of native supervision on this branch was measuring a process the orchestrator did not start.

Full evidence: `docs/native-todo.md` § 1, the P0 entry.

**Files:**
- Modify: `gateway/src/system-orchestrator/native-driver.ts`, `native-io.ts`, `health-watch.ts`
- Modify: `gateway/src/main.ts` (wire the single-instance claim — see Step 1)
- Modify: `gateway/config.yaml` if a port or a probe needs a tunable
- Test: the covering system-orchestrator tests

---

## The security frame — this is why the pid matters

The owner's framing, and it upgrades the fix:

> "recording pid is also beneficial as security standpoint - so that nobody can swap and man in the middle our dep services"

A probe that asks only *"is something answering on 127.0.0.1:8770"* accepts **any** local process that gets there first. `local-tts` receives assistant text and returns synthesized audio; `whisper-stt` receives raw microphone audio and returns transcripts. An impostor on those ports reads every word spoken in the house and can substitute what the assistant says.

Today that is not hypothetical in the mild sense — it already happened by accident. An orphan from a previous run occupied the port and the orchestrator adopted it as healthy. Accident and attack are the same code path; only the intent differs.

So the health contract becomes: **a service is healthy iff the port answers AND the process owning that listening socket is the child we started.** Liveness alone is not health.

Be honest about the strength of this control in your report. Same-user impersonation is only partly addressed — a process running as the operator can do plenty regardless — but it does defend against a different local user, against leftovers, and against silent adoption of a foreign listener. State what it does and does not cover rather than overselling it.

---

- [ ] **Step 1: Wire the single-instance claim (it exists and nothing calls it)**

`gateway/src/bootstrap/single-instance.ts` and its tests landed in `ec8ce61`, but `main.ts` never calls them — dead code, and the guard it provides is exactly what stops two gateways fighting over these addons.

Acquire **before** `Bun.serve` and before the orchestrator applies. On a live conflict, print `describeConflict(...)` and exit non-zero. Release on the existing shutdown path. Claim file under `~/.sentient/run/` alongside the MCP sockets.

- [ ] **Step 2: State probe — reproduce before changing anything**

```bash
source scripts/env.sh
pgrep -f "src/main.ts|whisper_stt|local_tts"          # expect empty; kill any stragglers
lsof -nP -iTCP:8768 -iTCP:8769 -iTCP:8770 -iTCP:8771 -sTCP:LISTEN
bun run dev &
grep -E "native.started|native.exited|apply.complete" ~/.sentient/gateway/logs/$(date +%F).log | tail
```
Expected (the defect): `native.started` then `native.exited code=1`, and `apply.complete state="failed"`.

Then reproduce the underlying bind failure directly, which is how the real error becomes visible at all — the driver currently discards the child's stderr:

```bash
PYTHONPATH="$SENTIENT_CODE/whisper-stt/src" "$SENTIENT_CODE/whisper-stt/venv/bin/python" -m whisper_stt
```

- [ ] **Step 3: Establish the pid relationship empirically. Do NOT assume.**

Observed: `native.started pid=46977` while `lsof` showed **46636** holding the port. The driver's recorded pid is not the serving pid. Find out why before designing around it — does the service fork? re-exec? does the venv `python` shim exec a different binary? The whole task depends on this answer, so get it from evidence:

```bash
# with a service running, compare
lsof -nP -iTCP:8768 -sTCP:LISTEN -t
ps -o pid,ppid,pgid,command -p <that pid>
```
Record what you find. If the serving process is a descendant, the driver must record **the pid that owns the socket**, not the pid it spawned — and the reap/kill path must target the right one.

- [ ] **Step 4: Failing test — a foreign listener is NOT health**

The invariant that would have caught everything:

```ts
it("SECURITY: a port answered by a process we did not start is UNHEALTHY, not adopted", async () => {
  const driver = createNativeDriver({
    /* …, listeningPidFor: () => 9999, … */   // someone else owns the socket
  });
  const health = await driver.probe(nativeService("local-tts", ["/bin/true"]), { ourPid: 1234 });
  expect(health.healthy).toBe(false);
  expect(health.reason).toContain("foreign");   // named, so the log says WHY
});
```
Match the real driver's signatures — read them first, do not invent.

- [ ] **Step 5: Failing test — reaping covers what we did not record**

`reapOrphans()` only knows pids it wrote down, so a leftover from a previous binary, a crash, or a hand-started process is invisible and blocks the port forever. Pin that a leftover on a service's port is detected and cleared (or reported as a hard, named failure — decide which and say why).

**Judgement, and state your reasoning:** killing a process the gateway did not start is a real action on the operator's machine. Weigh "reap anything on my port" against "refuse to start and name the holder". Consider that prod is unattended, so refusing forever is its own outage — but silently killing an unrelated process that happens to use 8770 is worse. There may be a middle: reap only what is identifiably ours (argv, cwd, or a marker), refuse loudly otherwise.

- [ ] **Step 6: Failing test — the child's stderr is not discarded**

The bind error above was invisible in the gateway log; it only appeared when run by hand. A supervisor that cannot say *why* its child died is why this took a whole branch to notice. Capture the child's stderr tail and include it in `native.exited`'s reason, truncated to the ≤120-char logging cap.

- [ ] **Step 7: Implement, then prove it on the real stack**

```bash
# clean slate, then a full boot
pkill -f "src/main.ts"; pkill -f "whisper_stt|local_tts"
source scripts/env.sh && bun run dev &
grep -E "native.started|native.exited|apply.complete|health" ~/.sentient/gateway/logs/$(date +%F).log | tail -10
lsof -nP -iTCP:8768 -iTCP:8770 -sTCP:LISTEN
```
Expected: `apply.complete state="ready"`, both services listening, and the listening pids are the ones the driver recorded.

- [ ] **Step 8: The restart case — this is the P1, and it is probably the same bug**

`native-todo.md` records a `local-tts` restart hang, reproducible 2/2, marked operator-only because dev never supervised the addons. Dev supervises them now, so **drive it here**:

```bash
# restart twice while the addons are up
kill $(pgrep -f "src/main.ts"); sleep 3; source scripts/env.sh && bun run dev &
# ...wait for ready, then again
```
Expected: both services come back both times, no orphans accumulate, no hang. If it reproduces, you now have it in a debuggable environment — fix it here rather than deferring it back to the operator. If your fix resolves it, say so explicitly and strike the P1.

- [ ] **Step 9: Update the record, gate, commit**

Strike the P0 (and the P1 if fixed) from `docs/native-todo.md`. Update the operator checklist's § 5 if its "highest-risk unknown" no longer stands.

```bash
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
```
Expected: ≥1202 pass.
