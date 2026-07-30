### Task 9d: D11 — register the gateway's MCP with the delegated agent

**Wave 5 (addendum) · model: opus · ⚠️ DECISION REQUIRED BEFORE ANY CODE**

> **Do not start this task by writing code.** It carries one open question the owner has to answer
> (Step 0). Two agents have already chased this symptom to the wrong layer; a third guessing at the
> answer would commit a capability-scope decision nobody made.

**Why this task exists.** The delegated Hermes agent has **no gateway/HA/MA/searxng tools**, on every
fresh install, for every user. NM-T9c fixed one *necessary* half — the per-user MCP socket moved off
SIP-read-only `/run` (`36250cb`) — and proved that socket end-to-end, but only after a manual
`hermes -p <id> mcp add`. The remaining half is that nothing in the product performs that
registration: the gateway renders `mcp_servers` + `enabled_toolsets` into
`~/.sentient/gateway/<id>/profiles/<id>/`, hermes reads `~/.hermes/profiles/<id>/`, and the
`HERMES_HOME` bridge between them was the supervisord program env deleted in the native cutover. The
render is dead output.

**Read first — the whole diagnosis is already written up, do not re-derive it:**
`qa/web/evidence/2026-07-30-t9c-verification-gaps/README.md` § **D11** (symptom as measured, root
cause proven with `hermes profile show`, the two obvious fixes and why each is wrong, the hand-proven
route, local-dev state caveat). Code-side entry point: `gateway/src/admin/hermes-profile-bridge.ts`.

**Current containment (already shipped, `092083c`):** the fault cannot ship silently —
`hermes-profile.bridge.not-live` WARNs once per user on create and on every boot backfill, carrying
`reason`, `renderedRoot`, `defect="D11"` and the consequence. Deleting that guard is part of this
task's exit, not part of its start.

**Files:**
- Modify: `gateway/src/admin/hermes-profile-provisioner.ts` (register after `profile create --clone-from`)
- Modify: `gateway/src/admin/hermes-profile-bridge.ts` (the guard's meaning changes once registration exists)
- Modify: `gateway/config.yaml` only if Step 0's answer needs a new tunable
- Modify: `qa/web/evidence/2026-07-30-t9c-verification-gaps/README.md` (close § D11 with the live proof)

---

- [ ] **Step 0: The owner answers these. An agent must NOT pick.**

**Q1 — WHAT does the delegated agent get?** Only the gateway's own MCP (`identify_user`,
`pause_audio`, `resume_audio`, `update_user_settings`), or the user's whole enabled `mcp_catalog`
(HA, MA, searxng, fetch)?
- *Gateway-only* is the least authority that closes the symptom; a delegated agent asked to "turn off
  the kitchen light" still cannot.
- *Whole catalog* means a delegated sub-agent inherits the delegator's full tool authority — a
  capability-scope decision under the four-layer model, not a wiring detail. It also puts the
  delegated agent outside the gateway's PDP/PEP: hermes dials those MCPs itself, so the gateway's
  per-call permission mediation and `confirm` prompts do not apply to it.

**Q2 — WHEN does registration happen?** Once at provision, or reconciled on every profile change /
every boot?
- *At provision only* is one CLI call per new user; a catalog edit later never reaches existing users.
- *Reconcile* keeps hermes in step with `mcp_catalog` forever, at the cost of an `mcp list` +
  diff per user per boot (subprocesses at startup) and a real removal path when a tool is withdrawn.

Record the answer verbatim in this file before Step 1.

- [ ] **Step 1: State probe**

```bash
git log --oneline -12
grep -n "checkHermesProfileBridge" gateway/src/admin/*.ts
grep -c "hermes-profile.bridge.not-live" ~/.sentient/gateway/logs/$(date +%F).log
hermes -p <userId> mcp list      # is it already registered on THIS box, by hand?
```
`u_885ffeb7` on the dev box was hand-patched during NM-T9c. Verify against a user that was not
(`u_0417d3b0`, `u_1eee01a4`) or the task will "pass" on pre-existing local state.

- [ ] **Step 2: Write the failing test**

Pin the contract at the process boundary — the argv the provisioner hands the hermes CLI — with an
injected fake `spawn`, never a real subprocess (the existing provisioner deps already support this):

```ts
it("INVARIANT: provisioning registers the gateway MCP on the user's hermes profile", async () => {
  const argvs: string[][] = [];
  const provisioner = createHermesProfileProvisioner({ /* …, spawn: capture(argvs) */ });
  await provisioner.create("u_deadbeef");
  // the socket arg must be the SAME resolver the mcp-host listens on — a second
  // spelling of the path is the D8 bug wearing a different hat.
  expect(argvs.at(-1)).toEqual([
    "hermes", "-p", "u_deadbeef", "mcp", "add", "gateway",
    "--command", "nc", "--args", "-U", resolveMcpSocketPath("u_deadbeef"),
  ]);
});
```

- [ ] **Step 3: Implement, using hermes's PUBLIC API only**

`hermes -p <userId> mcp add …` / `mcp list`. Never write into `~/.hermes/**` and never read a Hermes
credential — the standing rule, and the reason `--clone-from` exists. Derive the socket path from
`resolveMcpSocketPath`, not from a second literal.

- [ ] **Step 4: Verify live — the assertion is TOOL NAMES, not "the command exited 0"**

```bash
# a user that was NOT hand-patched
hermes -p u_0417d3b0 mcp list
hermes -p u_0417d3b0 -z "List the exact names of every tool you can call, then stop."
```
Expected: `identify_user` / `pause_audio` / `resume_audio` / `update_user_settings` present (plus
whatever Q1's answer adds). "Exit 0" is not evidence — NM-T9c's whole point is that exit 0 coexisted
with zero tools.

- [ ] **Step 5: Retire the guard's now-wrong meaning**

With registration in place the `HERMES_HOME` bridge is no longer the thing that matters, so
`hermes-profile-bridge.ts` must either be deleted (with every comment that references D11) or
re-pointed at the new invariant (is the gateway MCP registered for this user?). Leaving a WARN that
fires on a fixed install is the same class of defect as the stale BLOCKED headers NM-T9c cleaned up.

- [ ] **Step 6: Commit**

```bash
git commit -m "fix(admin): register the gateway MCP with each user's hermes profile" -- \
  gateway/src/admin/ qa/web/evidence/2026-07-30-t9c-verification-gaps/README.md
```

---

### E2E matrix

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| `delegate-tool-access` | desktop 1280×900 | fresh user, never hand-patched, gateway booted after Step 3 | ask for something that needs a gateway tool via `delegateTask` | the delegated reply reflects real gateway data (e.g. the actual known-user list), not a refusal | `hermes-profile.create.ok` → no `hermes-profile.bridge.not-live` for that userId → `mcp-host:unix-listener` connection on `mcp-<userId>.sock` → hermes transcript shows `mcp__gateway__<tool>` |
| `delegate-hermes-bg` (regression) | desktop 1280×900 | same | dispatch a delegated task | one `{taskId}` tile, one follow-up bubble | `hermes-runner.run.start` **once** per request (D7's dedupe still holds) → `run.ok` |
| `provision-backfill` | n/a | stop gateway, `hermes -p <id> mcp remove gateway`, boot | none | n/a | boot backfill re-registers: `mcp list` shows `gateway ✓ enabled` again |

Reference the existing rows by name from `agents/docs/testing-knowledge.md`; do not duplicate bodies.
