### Task 20: a phantom tool, a silent allowlist, and an invisible failed login

**Wave 11 · model: sonnet · two unrelated small fixes, both found by E2E round 2**

Evidence: `docs/native-todo.md` § 1, **D19** and **D20**, and `qa/web/evidence/2026-08-01-e2e-round-2/group-d-tools-and-errors.md` / `group-a-auth-and-newchat.md`.

**Files:** `gateway/config.yaml`, `gateway/mcp-policy.yaml`, `gateway/src/tools/mcp-client.ts`, `gateway/src/user-auth/auth-service.ts`, plus covering tests.

---

## Part A — the tool that does not exist

`ha_search_entities` appears in `config.yaml`'s ha-mcp `tools.include` list **and** has its own `allow_ha_search_entities` rule in `mcp-policy.yaml`. The server has no such tool — confirmed by a direct MCP dial (`Unknown tool: 'ha_search_entities'`) and a full `tools/list` showing all 78 it does serve. The real one is **`ha_search`**.

Consequence: the assistant cannot search for a device by name at all. It can only reach an entity whose exact id it already knows. That is a live capability gap.

- [ ] **Step 1 — confirm the name against the running server before changing anything**

```bash
bun qa/web/tool-truth.ts home_assistant ha_search '{"query":"light"}'
```

Do not take this task's word for it. If `ha_search` takes different arguments than expected, the catalog and the policy must both match reality — read its schema from `tools/list`.

- [ ] **Step 2 — fix both files together**

Rename in `config.yaml`'s include list and in `mcp-policy.yaml`'s rule (name, `tool:`, and `condition:`). Both, or the tool is exposed with no rule and hits the fail-closed default — invisible in a different way.

- [ ] **Step 3 — failing test: an allowlist entry that matches nothing must WARN**

This is the important half. `filterByAllowlist` (`mcp-client.ts:109`) intersects the include list with what the server advertises and **drops the rest silently**, so a curated surface rots as upstream renames things while the config keeps reading like coverage. That is how a phantom survived this long.

```ts
it("INVARIANT: an include entry matching no advertised tool is reported, not silently dropped", () => {
  const kept = filterByAllowlist([toolRef("ha_search")], ["ha_search", "ha_search_entities"]);
  expect(kept).toHaveLength(1);
  // and the caller logs a WARN naming the unmatched entry
});
```

WARN once per server at startup, naming the server and the unmatched entries. Keep `filterByAllowlist` pure if it is pure today — return the diff and let the caller log it.

- [ ] **Step 4 — verify live**

Restart the gateway, confirm no `include` entry is reported unmatched, then ask the assistant in the browser to find a device **by name** (not by entity id) and confirm it uses `ha_search` and answers.

---

## Part B — a failed login leaves no trace

`user-auth/auth-service.ts:81,86` log `authenticate.no-user` and `authenticate.wrong-pin` at **DEBUG**; the running level is `info` (also the documented prod default). Success logs at INFO on line 90.

So a wrong PIN produces a correct user-visible error and a 401, and **nothing at all** in the gateway log. Repeated PIN guessing against a household assistant is invisible, and there is no record to rate-limit or alert on later.

- [ ] **Step 5 — failing test, then raise both branches to WARN**

```ts
it("SECURITY: a rejected credential is logged at WARN with a reason", async () => {
  await auth.authenticate("u_nope", "9999");
  expect(warnings).toContainEqual(expect.objectContaining({ reason: expect.any(String) }));
});
```

Both branches, each with its own distinguishable reason (no such user vs wrong pin). Per the logging rules a rejected credential is exactly a "boundary decision with a reason".

**Never log the PIN**, not even a prefix, not even truncated — the userId and the reason are the whole payload.

- [ ] **Step 6 — verify live**

In the browser, enter a wrong PIN, then:

```bash
grep "authenticate" ~/.sentient/gateway/logs/$(date +%F).log | tail -5
```

The failure must be there at the default level. Round 2's group A found this because it was **not**.

- [ ] **Step 7 — strike D19 and D20, gate, commit**

```bash
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
```
