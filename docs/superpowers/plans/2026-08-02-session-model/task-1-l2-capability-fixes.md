### Task 1: close the L2 capability holes, before anything rests on them

**Spec:** §3.2. **Model:** sonnet — two small, well-bounded changes with clear tests.

`CLAUDE.md` says *"L2 resource handles — `SessionRuntime`, `FileScope`, `ToolBroker`, `ProviderClient` — hold capabilities by value, never an ambient 'current user'."* Two parts are untrue, and this is the **third instance on this branch** of documentation asserting a control that is not wired (after `delegateTask`'s "would double-prompt" and `mcp-policy.yaml`'s claimed injection scan).

Everything later in this plan calls a session "a capability-scoped resource". That phrase is empty while resource class goes unchecked, so this lands first.

**Files:**
- Modify: `gateway/src/access/capability.ts` (add the `session` resource class)
- Modify: `gateway/src/store/session-store.ts:85-89`
- Modify: `gateway/src/tools/tool-broker.ts:147` and its construction site in `gateway/src/bootstrap/phase-services.ts`
- Test: `gateway/src/store/session-store.test.ts`, `gateway/src/tools/tool-broker.test.ts`

**Interfaces produced:**
- `ResourceClass` gains `"session"` → `"session-store" | "file-scope" | "tool-broker" | "session"`
- `openSessionStore(cap: Capability): SessionStore` — unchanged signature, now throws on a wrong-class capability
- `ToolBrokerDeps.capability: Capability` replaces `ToolBrokerDeps.principal` as the **authorization** input; `principal` stays for log correlation only

---

- [ ] **Step 1: Failing test — a wrong-class capability cannot open the session store**

```ts
it("SECURITY: a capability for another resource class cannot open the session store", () => {
  const fileScope = accessManager.grant(principal, "file-scope");
  expect(() => openSessionStore(fileScope)).toThrow(/resource class/i);
});
```

This is the case that makes it a confused deputy rather than a style issue: a `file-scope` capability has an **identical `rootPath`**, so `capabilityCoversPath` passes and the store opens today.

- [ ] **Step 2: Run it, confirm it fails**

```bash
source scripts/env.sh && cd gateway/src && bun test store/session-store.test.ts
```
Expected: FAIL — no throw.

- [ ] **Step 3: Check the class before the path**

In `openSessionStore`, reject a capability whose `resource` is not `"session-store"` **before** the path check. Order matters for the error message: a wrong class is a different fault from an escaping path and must say so.

- [ ] **Step 4: Failing test — `ToolBroker` authorizes from a capability**

```ts
it("SECURITY: the broker's authority comes from its capability, not an ambient principal", () => {
  const broker = createToolBroker({ ...deps, capability: cap });
  expect(broker.ownerUserId).toBe(cap.ownerUserId);
});
```

Read `tool-broker.ts`'s real `ToolBrokerDeps` before writing this — match the actual shape, do not invent fields.

- [ ] **Step 5: Thread the capability through**

`ToolBrokerDeps` takes `capability: Capability`. Every authorization decision — the PDP call, the user-id stamped into tool arguments, the delegated-agent socket path — reads `capability.ownerUserId`. `principal` may remain **only** for log correlation (`role` is still useful in a log line); it must not be an input to any decision.

Update the construction site in `bootstrap/phase-services.ts`. Grant the capability from the same `AccessManager` that already mints the store's.

- [ ] **Step 6: Add the `session` resource class**

Extend `ResourceClass` with `"session"`. Nothing consumes it yet — task 3 does — but adding it here keeps the type change in the task that owns the capability model.

- [ ] **Step 7: Correct the documentation that was wrong**

`CLAUDE.md`'s capability bullet described this as already true. Leave the sentence (it is now true) but do **not** add new claims. If you find another doc asserting an unwired control while working, note it in your report rather than fixing it here.

- [ ] **Step 8: Gate and commit**

```bash
source scripts/env.sh
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
```

```bash
git add -A gateway/src/access gateway/src/store gateway/src/tools gateway/src/bootstrap
git commit -m "fix(access): a capability's resource class is checked, not assumed"
```
