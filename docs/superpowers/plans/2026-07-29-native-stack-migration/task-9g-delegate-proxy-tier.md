### Task 9g: the delegated proxy tier — provide it at dispatch, expose the `allow` tier

**Wave 6 · model: opus · owner-decided design, see Step 0**

Task 9d proved registration works, and in doing so proved the design underneath it was priced wrong. This corrects both halves: *when* we register, and *what the delegated agent can actually reach*.

**Files:**
- Modify: `gateway/src/tools/delegate-task.ts` (setup/init phase before spawn)
- Modify: `gateway/src/external-tools/**` (from boot-time reconcile to dispatch-time verify-and-provide)
- Modify: `gateway/src/bootstrap/**` (unwire the boot-time configuration step)
- Modify: `gateway/src/mcp-host/**` (proxy the `allow` tier)
- Modify: `docs/native-todo.md`, `qa/web/evidence/2026-07-30-t9c-verification-gaps/README.md`

---

### Step 0 — DECIDED (owner, 2026-07-30). Two corrections to task 9d.

**The two-tier model, in the owner's words:**
> "user or hermes can modify their own setup to add more mcp or customization on the box manually or
> thru llm, so gateway's proxy is essentially just providing additional 'sentient built-in mcps' on
> top of user's own setup to give it more flexibility and capability … we are essentially providing a
> secondary tier of mcp via proxy at this point"

So the two tiers differ in kind, and the distinction governs every choice below:
- **The user's own tier** — whatever they or Hermes configure, by hand or through an LLM. **Never ours to touch, prune, reorder or audit.** We own exactly one entry, named `gateway`.
- **Our proxy tier** — additive capability we provide. Every call through it passes the gateway's PDP/PEP.

**Correction 1 — register at dispatch, not at boot.**
> "at delegateTask handler, before launching delegate tool, we could introduce a setup/init phase
> where we check & provide our mcp proxy. This way our proxy always survives, no drift when user
> edits."

Task 9d put this in a boot-time handler. That leaves a window: a user edits their profile at 10am, and every delegation until the next restart silently gets nothing — which is D8's failure mode wearing a fourth hat. Verifying at the moment of use makes drift **structurally impossible** rather than merely detected.

The fully-ephemeral variant the owner also raised ("inline hermes cli … so we don't even need to track persistency") **is not available**: `hermes --help` has no per-invocation MCP flag, `mcp add` writes to the profile store, the `HERMES_HOME` redirect loses the `.env`/`auth.json` that `--clone-from` exists to supply, and register-run-remove would race concurrent delegations and leak on crash. Verify-and-provide at dispatch is the closest thing that is real. **If you find an inline route I missed, take it and say so** — it is strictly better.

**Correction 2 — the confirm gate is one-time, and nothing inside re-prompts.**
> "this is a dialog prompt triggered from `delegateTask` tool call, it's a one time gate before
> calling delegate tool … once user had confirmed this dialog, tool will then start running, nothing
> inside would need/trigger confirm prompt again, this is by design so that the tool is super capable
> for long running complex unsupervised task"

This is deliberate, so **do not** add a mid-run permission path, and do not treat an unmediated call inside a delegated run as a defect. The scope question — what that single approval grants, and how it is shown before the user approves — is a later spec (`native-todo.md` § 1).

**What the proxy exposes now: the `allow` tier only.** Owner's call. Derive it from `gateway/mcp-policy.yaml` at runtime — never a second hardcoded list, and never treat an unmatched tool as allowed (`policy-engine.ts`'s `UNMATCHED` is `confirm` by design; inheriting the fail-closed default is the point).

---

- [ ] **Step 1: State probe**

```bash
git log --oneline -12
git status --short
ls gateway/src/external-tools/
grep -rn "createExternalToolsConfigurator\|configureExternalTools" gateway/src --include='*.ts' | grep -v '\.test\.'
grep -rn "delegatedTools\|delegated-tool-tier" gateway/src --include='*.ts' | grep -v '\.test\.'
hermes -p u_1eee01a4 mcp list
```

- [ ] **Step 2: Move the provision to dispatch — write the failing test first**

```ts
it("INVARIANT: a delegation verifies and repairs the gateway MCP entry before spawning", async () => {
  const calls: string[][] = [];
  // profile reports the entry MISSING -> must be added before the agent spawns
  const tool = createDelegateTask({ /* …, runHermesCli: capture(calls), … */ });
  await tool.execute({ agent: "hermes", taskPrompt: "x" });
  const addedAt = calls.findIndex((c) => c.includes("mcp") && c.includes("add"));
  const spawnedAt = calls.findIndex((c) => c.includes("-z"));
  expect(addedAt).toBeGreaterThanOrEqual(0);
  expect(addedAt).toBeLessThan(spawnedAt);   // ordering IS the invariant
});

it("INVARIANT: a drifted entry is repaired, not skipped", async () => {
  // entry present but its args point at a stale socket path — 9d returned early
  // on the NAME alone, which is a silent no-tools path
});
```

- [ ] **Step 3: Implement the dispatch-time phase**

Verify **the entry's content**, not just that its name appears — that early-return-on-name is exactly the hole 9d left. Repair on mismatch.

Three properties this must hold, none optional:
- **Additive.** Read, compare our one entry, write only our one entry. Never prune, reorder, or normalize anything else in `mcp_servers`. A declarative reconcile would delete the user's own MCPs on every dispatch — the single worst outcome available here.
- **Non-fatal.** A registration failure must **not** fail the delegation. Log `WARN` with a reason and dispatch anyway: a delegated agent with fewer tools is degraded; one that refuses to run is broken. Return the `{taskId}` either way.
- **Bounded.** This is now on the hot path of a user-visible action. Timeout it (the existing `hermes_mcp_register_timeout_ms` tunable) and let the delegation proceed on expiry. Never let a CLI hang become a hung delegation.

Then unwire the boot-time configurator. Do not leave both running — two writers of one entry is a race with no owner.

- [ ] **Step 4: Proxy the `allow` tier — write the failing test first**

```ts
it("WIRE: the gateway MCP advertises the allow-tier catalog tools", async () => {
  const listed = await mcpHost.listTools(userId);
  expect(listed.map((t) => t.name)).toEqual(expect.arrayContaining(["searxng_search"]));
  // and NOTHING from the confirm/deny tier
  expect(listed.some((t) => CONFIRM_TIER.includes(t.name))).toBe(false);
});

it("SECURITY: a proxied call goes through the broker, not straight to the upstream", async () => {
  // the PDP is the whole reason this tier exists; a proxy that bypasses it is worse
  // than no proxy, because it looks mediated
});
```

- [ ] **Step 5: Implement the proxy**

The mcp-host gains a proxied tool entry per `allow`-tier catalog tool, each forwarding through the existing `ToolBroker` so the PDP still evaluates it. `tools/mcp-client.ts` already dials the http-transport catalog entries — HA, MA and searxng are http, so the client side exists. Reuse it; do not open a second path to the same servers.

Name-collision matters: a proxied name must be unambiguous to the delegated model and traceable in the log. Pick a scheme, state it, and apply it uniformly.

- [ ] **Step 6: Verify live — tool names, and the negative**

```bash
# a user that was never hand-patched
hermes -p u_1eee01a4 -z "List the exact names of every tool you can call, then stop."
```
Expected: allow-tier names present (a real search tool, not just `pause_audio`), **and no `confirm`/`deny`-tier name**. Assert the absence explicitly — a proxy that quietly forwarded a write tool would pass a "did it get tools?" check while defeating the only control in this task.

Then a real delegated task that uses one:
```bash
grep -E "delegate|hermes-runner|mcp-host|tool-broker" ~/.sentient/gateway/logs/$(date +%F).log | tail -20
```
Expected: the delegated agent calls a proxied tool, the broker logs the PDP decision, the result comes back. "Exit 0" is not evidence — 9c's whole lesson is that exit 0 coexisted with zero tools.

- [ ] **Step 7: Update the record, gate, commit**

`docs/native-todo.md` § 1: D11's follow-up closes; keep the deferred scope-surface spec, restated per Correction 2 (**not** mid-run prompt routing — what the one-time gate grants and how its scope is shown).

```bash
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
```
Expected: ≥1164 pass. Commit by explicit pathspec, `git add` any new file first, then `git show --stat HEAD` to confirm it is listed.
