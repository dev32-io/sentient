### Task 6: Deletions + config audit

**Wave 3 · model: opus · spec §8**

**You are the sole owner of `gateway/config.yaml` this wave.** Task 7 runs concurrently and owns only `.claude/rules/**`, `CLAUDE.md`, `deploy/README.md`, `agents/docs/**`.

**Files:**
- Delete: `gateway/src/admin/supervisord-control.ts` (+ test), `gateway/src/admin/user-port-store.ts` (+ test), `gateway/src/session-router.ts` (+ test), supervisord templates
- Modify: `gateway/src/admin/boot-migration.ts`, `gateway/src/bootstrap/phase-state.ts`, `gateway/src/bootstrap/phase-services.ts`, `gateway/src/bootstrap/create-gateway-services.ts`, `gateway/src/apply/apply-deps.ts`, `gateway/config.yaml`

---

**⚠️ THE TRAP IN THIS TASK.** `profile-store`, `renderInnerProfile` and `renderConfigsForExistingUsers` **STAY**. `hermes-runner` sets its subprocess `cwd` to `resolveProfileDir(userId)`, and its own comment states the profile must already exist. Deleting profile rendering breaks `delegateTask` in a way **no unit test covers** — the runner is unit-tested with a fake spawn, so the tests stay green while production breaks. Verify before touching anything nearby.

- [ ] **Step 1: Verify the trap yourself before deleting anything**

```bash
sed -n '1,30p' gateway/src/tools/hermes-runner.ts
grep -n "resolveProfileDir\|cwd" gateway/src/tools/hermes-runner.ts
grep -rn "renderInnerProfile\|renderConfigsForExistingUsers" gateway/src --include="*.ts" | grep -v "\.test\."
```
Expected: the runner resolves a profile dir as `cwd`; profile rendering has live callers. Record this in your report as the reason those modules survive.

- [ ] **Step 2: Prove the deletion targets have no live readers**

For each candidate, grep for non-test consumers:

```bash
for sym in supervisordControl SupervisordControl userPortStore UserPortStore createSessionRouter SessionRouter renderProgramsForExistingUsers; do
  echo "=== $sym ==="
  grep -rn "$sym" gateway/src --include="*.ts" | grep -v "\.test\." | grep -v "^.*://"
done
```
Expected consumers, all 1.0 ACP-era: `session-router.ts` and `apply-deps.ts` for the port store; `phase-state.ts` / `phase-services.ts` for supervisord. Record the list — **anything unexpected stops the deletion** until you understand it.

- [ ] **Step 3: Run the suite to capture the baseline**

```bash
cd gateway/src && bun test 2>&1 | tail -4
```
Record the pass count. It is your regression net through a large deletion; it must not drop.

- [ ] **Step 4: Delete the supervisord daemon machinery**

```bash
git rm gateway/src/admin/supervisord-control.ts gateway/src/admin/supervisord-control.test.ts
git rm -r gateway/templates/supervisord 2>/dev/null || true
```
Then remove `supervisordControl` from `phase-state.ts`'s construction and output, from `PhaseServicesInput`, and from every consumer. Delete `renderProgramsForExistingUsers` from `boot-migration.ts` **but keep `renderConfigsForExistingUsers`** (Step 1).

- [ ] **Step 5: Typecheck and test**

```bash
bun run --filter '@sentient/gateway' typecheck
cd gateway/src && bun test 2>&1 | tail -4
```
Expected: typecheck exit 0; pass count equals the Step 3 baseline minus only the deleted files' own tests. **A drop anywhere else means you removed something live** — investigate before continuing.

- [ ] **Step 6: Commit**

```bash
git commit -m "refactor(gateway): delete the supervisord daemon machinery" -- \
  gateway/src/admin/ gateway/src/bootstrap/phase-state.ts gateway/src/bootstrap/phase-services.ts
```

- [ ] **Step 7: Delete the port store and the ACP session router**

```bash
git rm gateway/src/admin/user-port-store.ts gateway/src/admin/user-port-store.test.ts
git rm gateway/src/session-router.ts
```
Remove the port-store branches from `apply-deps.ts` (its URL/health resolution existed only for per-user hermes daemons) and the `sessionRouter` field from `GatewayServices` / `PhaseServicesOutput` / `ApplyDeps`. `session-router.ts` was already nullable from an earlier fix, so its consumers already handle absence — verify rather than assume.

- [ ] **Step 8: Typecheck and test**

```bash
bun run --filter '@sentient/gateway' typecheck
cd gateway/src && bun test 2>&1 | tail -4
```
Expected: green.

- [ ] **Step 9: Commit**

```bash
git commit -m "refactor(gateway): delete the port store and the legacy ACP session router" -- \
  gateway/src/admin/ gateway/src/session-router.ts gateway/src/apply/apply-deps.ts \
  gateway/src/bootstrap/ gateway/src/server.ts
```

- [ ] **Step 10: Audit `gateway/config.yaml` key by key — read before delete**

For every key under `cerebrum:`, `hermes:` and `apply:`, find a live reader:

```bash
for key in $(grep -oE "^\s{2}[a-z_]+:" gateway/config.yaml | tr -d ' :' | sort -u); do
  hits=$(grep -rn "$key" gateway/src shared/config/src --include="*.ts" | grep -v "\.test\." | wc -l | tr -d ' ')
  echo "$key -> $hits reader(s)"
done
```
Build a table in your report: key → reader count → keep/delete → evidence. **Delete only the zero-reader keys.** `cerebrum:` is already marked "do not add new keys" and 2.0 rehomed everything under `orchestrator:`, so expect it to be fully removable — but prove it per key rather than dropping the block wholesale.

- [ ] **Step 11: Remove the dead keys and their schema entries**

Delete zero-reader keys from `gateway/config.yaml` **and** their zod fields in `shared/config/src/schemas/`. A schema field with no config key (or vice versa) is the drift this audit exists to remove. Definitely gone: `hermes.worker.port_base` and the supervisord keys.

- [ ] **Step 12: Verify config still loads and the full gate is green**

```bash
bun run --filter '*' typecheck
bunx biome check .
cd gateway/src && bun test 2>&1 | tail -4
bun run --filter '@sentient/config' test 2>&1 | grep "Tests"
```
Expected: all green, pass count at or above the Step 3 baseline.

- [ ] **Step 13: Commit**

```bash
git commit -m "refactor(config): remove config keys with no live readers" -- \
  gateway/config.yaml shared/config/src/schemas/
```
