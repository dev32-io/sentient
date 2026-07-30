### Task 9d: D11 — register the gateway's MCP with the delegated agent

**Wave 6 · model: opus · DECIDED — see Step 0, build exactly that**

> **Read Step 0 first.** It carried a capability-scope question the owner has now answered, verbatim
> and in full. It is not yours to re-open, widen or "improve": registering more than the `allow` tier
> silently hands a sub-agent unmediated write authority. Two agents already chased this symptom to
> the wrong layer — the diagnosis is done, do not re-derive it.

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
- Create: the generic external-tool configuration handler (name it for what it does, not for Hermes —
  it gains a second tool later). Place it where a startup step lives, not inside `admin/`.
- Modify: `gateway/src/admin/hermes-profile-provisioner.ts` (Hermes becomes one implementation behind
  that handler's interface, not the handler itself)
- Modify: `gateway/src/admin/hermes-profile-bridge.ts` (the guard's meaning changes once registration
  exists — Step 5)
- Modify: the bootstrap phase that owns startup ordering (hook after orchestrator apply-complete)
- Modify: `gateway/config.yaml` only if Step 0's shape needs a new tunable
- Modify: `qa/web/evidence/2026-07-30-t9c-verification-gaps/README.md` (close § D11 with live proof)
- Modify: `docs/native-todo.md` (strike D11 from § 1 once it is genuinely closed — and only then)

**One more defect rides along.** After deleting a personality the rendered `config.yaml` keeps a
stale `personalities: {<name>: ""}` entry. It is harmless *today only because D11 makes that file
dead output*. The moment you make the render live, it stops being harmless. Fix it in this task —
`native-todo.md` § 1 records why it cannot wait.

---

### Step 0 — DECIDED (owner, 2026-07-30). Build exactly this.

The two open questions are answered. Recorded verbatim so no agent re-opens them:

**Q1 — what tool authority does the delegated agent get?**
> "for now, just render `allow` tiers only, but log this: realistically, delegate tool is intended to
> be dangerously capable, we would make a settings page to allow user to fine tune what's allowed for
> delegate tool separated from the available tool settings for sentient (orchestrator layer), but this
> is a very complex security layer fine design for just delegate tool, this does not block our current
> work, we could do this later"

So: register the tools tiered **`allow`** in `gateway/mcp-policy.yaml`. Not the whole catalog.
`confirm` and `deny` tier tools stay gateway-only. Hermes dials the servers **directly** — no gateway
proxy; the owner ruled it over-complicated for today's value.

The filter is the whole security control here, so understand *why* before you touch it: because
Hermes dials those servers itself, the gateway's PDP/PEP never sees the call — no `confirm` prompt,
no argument-value check. `delegateTask` exists to go read the web (searxng, fetch), which is a
prompt-injection surface. **Derive the set from `mcp-policy.yaml` at runtime; never hardcode a
second list.** A tool that matches no rule is `confirm` by design (`policy-engine.ts`'s `UNMATCHED`),
so an untiered tool must NOT be registered — inheriting the fail-closed default is the point.

The proper answer — a separate permission surface for delegated tools, tuned independently of
Sentient's own tool settings — is logged in `docs/native-todo.md` § D11 as its own later design. Do
not attempt it here.

**Q2 — when does registration happen?**
> "just make a generic 'configure external tool' function/handler to check & reconfigure hermes
> (other tools later) at start up time (after mcp/docker and all our 'internal' dependencies startups
> are done)"

So: **at gateway startup**, through a **generic external-tool configuration handler**, sequenced
*after* the system-orchestrator finishes bringing internal dependencies up (docker addons, native
addons, MCP servers). Generic because Hermes is the first external tool, not the only one — name and
shape it so a second one is a registration, not a fork of this code. Do not build the declarative
registry yet (that is a `native-todo.md` § 3 item); do make it obvious where one would attach.

Installer-time configuration is the eventual destination (`native-todo.md` § 3) — this handler is the
interim. Design it so it can later degrade from *repair* to *check-and-WARN* without a rewrite.

**Ordering is a real constraint, not a preference.** Registering before the MCP host is listening
writes a config pointing at a socket nothing serves — which is D8 wearing a third hat. Hook it to the
orchestrator's apply-complete signal, and if that signal never fires, log the skip loudly rather than
registering blind.

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
Expected: `identify_user` / `pause_audio` / `resume_audio` / `update_user_settings`, plus the
`allow`-tier catalog tools and **nothing from the `confirm` or `deny` tier**. Assert that absence
explicitly — a registration that quietly included a write tool is the exact failure Step 0's filter
exists to prevent, and it would pass a "did it get tools?" check.

"Exit 0" is not evidence — NM-T9c's whole point is that exit 0 coexisted with zero tools.

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
