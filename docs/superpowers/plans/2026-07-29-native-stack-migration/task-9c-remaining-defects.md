### Task 9c: Close the remaining defects before the native matrix

**Wave 5 (addendum) · model: opus · last blocker before T10**

T9b fixed six defects and, in doing so, surfaced three more plus left two verification gaps. This closes them. After this, the web side is done and T10 (native matrix) can run.

**Files:**
- Modify: `gateway/config.yaml` (`mcp_host.socket_path`), `gateway/src/mcp-host/**` (socket path resolution), and the Hermes-side profile template that points at it
- Modify: `gateway/src/admin/hermes-profile-provisioner.ts` (`OUTPUT_PREVIEW_MAX`)
- Modify: `gateway/src/tools/tool-broker.ts` or `gateway/src/runtime/react-loop.ts` (background re-dispatch guard)
- Modify: `gateway/src/runtime/compaction.ts` (cap the backoff)
- Modify: `qa/web/evidence/2026-07-30-delegate-hermes-bg/README.md`, `.superpowers/sdd/progress.md` note (stale BLOCKED headers)

---

- [ ] **Step 1: State probe**

```bash
git log --oneline -12
git status --short
grep -n "socket_path" gateway/config.yaml
grep -n "OUTPUT_PREVIEW_MAX" gateway/src/admin/hermes-profile-provisioner.ts
cat qa/web/evidence/2026-07-30-delegate-hermes-bg/RE-DRIVE-T9b.md   # T9b's findings, incl. D7
```

---

#### D8 — FUNCTIONAL: the delegated Hermes gets no gateway tools

`mcp_host.socket_path` is `/run/sentient/mcp.sock`, a containerized-Hermes leftover. **`/run` is SIP-read-only on macOS**, so the per-user MCP sockets can never open on a native host. T9b turned the resulting crash into a loud WARN — good — but the consequence stands: `delegateTask` now runs, and the delegated agent has **zero** gateway tools.

- [ ] **Step 2: Confirm the failure and find both sides of the path**

```bash
grep -rn "socket_path\|mcp-\${userId}\|/run/sentient" gateway/src gateway/templates --include='*.ts' --include='*.yaml' --include='*.tmpl' | grep -v '\.test\.'
grep -E "unix-listener|socket" ~/.sentient/gateway/logs/$(date +%F).log | tail -10
ls -ld /run 2>/dev/null   # confirm it is not writable
```
There are **two** sides: the gateway listens, and the rendered Hermes profile dials. Both must move together, or hermes dials a path nothing serves — which fails silently rather than loudly.

- [ ] **Step 3: Write the failing test**

Pin that the resolved socket path is under the user-owned state root, never `/run`:

```ts
it("INVARIANT: the per-user MCP socket resolves under the state root, not /run", () => {
  const p = resolveMcpSocketPath("u_deadbeef");
  expect(p.startsWith("/run")).toBe(false);
  expect(p).toContain(".sentient");
  // unix sockets have a ~104-byte sun_path limit on macOS; a long state root
  // plus a userId must not silently exceed it (this bit us before on a
  // scratch-dir path in an earlier plan).
  expect(p.length).toBeLessThan(100);
});
```

- [ ] **Step 4: Run it, then fix both sides**

```bash
cd gateway/src && bun test mcp-host/
```
Move the default to `~/.sentient/run/mcp.sock` (config'd, with the range/rationale comment), and update the Hermes profile template that dials it. Keep the value in config — it is a path, not a constant.

- [ ] **Step 5: Verify the delegated agent actually gets tools**

The real assertion, not just "the socket opened":

```bash
# restart the gateway, then check the socket exists and hermes can see gateway tools
ls -l ~/.sentient/run/
hermes -p <userId> -z "list the tools you can call, then stop" ; echo "EXIT=$?"
grep -E "mcp-host|unix-listener|identify_user" ~/.sentient/gateway/logs/$(date +%F).log | tail -10
```
Expected: the socket exists, and hermes reports gateway-provided tools rather than none.

- [ ] **Step 6: Commit**

```bash
git commit -m "fix(mcp-host): move the per-user tool socket off SIP-readonly /run" -- \
  gateway/config.yaml gateway/src/mcp-host/ gateway/templates/
```

---

#### D9 — SECURITY-ADJACENT: a 300-char preview where a credential would appear

- [ ] **Step 7: Fix the cap**

`hermes-profile-provisioner.ts:36` sets `OUTPUT_PREVIEW_MAX = 300`. `.claude/rules/logging.md` requires previews ≤120 chars, and this function's **own comment** says the logged text is "exactly where a credential would appear." The tight cap exists precisely for that case.

Lower it to 120. Then check whether truncation alone is the right control here at all — if the previewed text can contain a credential, consider redacting known key shapes before truncating rather than relying on length. State your reasoning.

- [ ] **Step 8: Commit**

```bash
git commit -m "fix(admin): tighten the hermes CLI output preview to the logging cap" -- \
  gateway/src/admin/hermes-profile-provisioner.ts
```

---

#### D7 — one request dispatches the same background task ten times

- [ ] **Step 9: Read T9b's evidence, then reproduce**

`qa/web/evidence/2026-07-30-delegate-hermes-bg/RE-DRIVE-T9b.md` records one user request producing **ten** `delegateTask` dispatches, each a real hermes subprocess. It converges, so it is waste rather than a hang — but ten subprocesses per request is not shippable.

- [ ] **Step 10: Write the failing test**

The likely cause is that the background tool's `tool_result` does not tell the model the work is already under way, so the model re-dispatches on the next iteration. Two candidate fixes; pick deliberately and say why:
- make the background `tool_result` text explicitly state *dispatched, do not re-dispatch*, and/or
- dedupe on `(toolName, args)` per turn for background tools.

Prefer the dedupe as the guard (a prompt-only fix depends on model compliance), with the clearer result text as reinforcement.

```ts
it("INVARIANT: the same background tool call is dispatched once per turn, not per iteration", async () => {
  // model asks for the same delegateTask twice in one turn
  const dispatched: string[] = [];
  /* ...drive the loop with a provider stub that repeats the call... */
  expect(dispatched).toHaveLength(1);
});
```

- [ ] **Step 11: Fix, verify live, commit**

Re-drive the delegate row and confirm **one** hermes subprocess per request:

```bash
pgrep -fl hermes | wc -l   # during a delegated request
grep -c "hermes-runner.run.start" ~/.sentient/gateway/logs/$(date +%F).log
```

```bash
git commit -m "fix(tools): dispatch a background tool once per turn" -- gateway/src/
```

---

#### D10 — unbounded compaction backoff

- [ ] **Step 12: Cap it**

`createCompactionGate`'s `turnsToSkip = 2 ** (failures - maxConsecutiveFailures)` has no ceiling. The comment says the gate is "deliberately NOT a permanent give-up," but unbounded doubling is indistinguishable from one in a long session. Add a `max_backoff_turns` config key with a range, and log at `error` when the cap is reached so it is visible rather than silent.

```bash
cd gateway/src && bun test runtime/compaction.test.ts
git commit -m "fix(orchestrator): cap the compaction backoff so it cannot silently stall" -- \
  gateway/src/runtime/compaction.ts shared/config/src/schemas/orchestrator-config.ts gateway/config.yaml
```

---

#### Verification gaps and stale records

- [ ] **Step 13: Correct the stale BLOCKED headers**

`qa/web/evidence/2026-07-30-delegate-hermes-bg/README.md` still opens "Result: BLOCKED on two real product defects" while its companion `RE-DRIVE-T9b.md` records PASS. A reader hitting the README first gets the wrong answer. Correct the header and point it at the re-drive. Do the same for the progress-ledger line that still lists the three rows as BLOCKED.

- [ ] **Step 14: Re-drive `interrupt`'s background-cancel arm**

T9b left this un-flipped rather than claiming it — correct behaviour, but it now needs driving. With a delegated task genuinely in flight, press Stop and assert the background task is cancelled (`background.cancelAll()` → `proc.kill()`), not merely that the turn aborted.

- [ ] **Step 15: State the `steer-followup-audio` audio-half limit honestly**

T9b verified the *text* half; the audio half needs a client that negotiates `audio.output`, which the WS-seam harness does not. Either drive it in a real browser session, or record it for T11 with the exact reason. **Do not flip the row on the text half alone.**

- [ ] **Step 16: Full gate**

```bash
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
```
Expected: green, ≥1122 pass.
