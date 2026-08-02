### Task 10: an auxiliary-task seam, whose first user happens to be titles

**Spec:** §6. **Model:** sonnet. **Depends on tasks 2, 6 and 8.**

Build the seam, not the titler. Titles are its first user; tags, follow-up suggestions and summarisation are named in the spec as the obvious next ones, and each should be a template plus a caller rather than a new subsystem.

This follows [Open WebUI](https://docs.openwebui.com/features/workspace/prompts/), whose "task model" seam drives title generation, tag generation and follow-up suggestions from one place with a prompt template, structured JSON output, a 3–5 word target and input truncation.

**Files:**
- Create: `gateway/src/runtime/auxiliary-task.ts`, `gateway/src/runtime/titler.ts`
- Create: `gateway/system_prompts/auxiliary/title.md`
- Modify: `gateway/src/runtime/session-runtime.ts` (fire the titler at the right moment; report `hasAuxiliaryTaskInFlight`)
- Modify: `gateway/config.yaml`, `shared/config/src/schema.ts`
- Test: `gateway/src/runtime/auxiliary-task.test.ts`, `titler.test.ts`

**Interfaces produced:**

```ts
export interface AuxiliaryTaskRequest<T> {
  templatePath: string;                 // resolved via the operator-override loader
  variables: Record<string, string>;    // substituted into the template
  schema: z.ZodType<T>;                 // the structured answer
  maxOutputTokens: number;
}
export function runAuxiliaryTask<T>(req: AuxiliaryTaskRequest<T>, deps): Promise<T | null>;
```

Returns `null` on any failure — the caller decides the fallback. It never throws into a turn.

---

- [ ] **Step 1: Failing test — an auxiliary task never blocks or breaks a turn**

```ts
it("INVARIANT: an auxiliary task that fails returns null rather than throwing into the caller", async () => {
  const result = await runAuxiliaryTask({ ...req }, { provider: alwaysFails });
  expect(result).toBeNull();
});
```

- [ ] **Step 2: Failing test — input is truncated before it reaches the prompt**

```ts
it("INVARIANT: a long conversation slice is truncated to the configured budget", async () => {
  await runAuxiliaryTask({ ...req, variables: { messages: "x".repeat(50_000) } }, deps);
  expect(capturedPrompt.length).toBeLessThanOrEqual(TRUNCATION_LIMIT + TEMPLATE_SLACK);
});
```

A pasted document in the first message must not blow the auxiliary prompt. This is the same class as wave 1's tool-result cap: bound the input at the seam, not in each caller.

- [ ] **Step 3: Failing test — the titler fires on the first COMPLETED reply only**

```ts
it("INVARIANT: a cut-off first reply does not trigger titling", async () => {
  await commitAssistantEntry({ text: "partial", cutoff: "barge-in" });
  expect(titlerCalls).toBe(0);
  await commitAssistantEntry({ text: "full answer" });
  expect(titlerCalls).toBe(1);
});
```

- [ ] **Step 4: Failing test — CAS and provenance, the two independent guards**

```ts
it("SECURITY-ADJACENT: a generated title never overwrites a title the user set", async () => {
  const s = store.createSession("s_1", "k");
  store.setTitle("s_1", "Kitchen lights", "user", s.version);
  await runTitler("s_1", deps);
  expect(store.getSession("s_1")?.title).toBe("Kitchen lights");
});
```

Both guards from task 2 are needed and neither is redundant: the **version** catches a concurrent write, the **provenance** check catches a later one that happens to carry a valid version. The race is real, not theoretical — the generator fires seconds after the first reply, exactly when a user might rename.

- [ ] **Step 5: Failing test — a failure falls back, and says so**

```ts
it("INVARIANT: a failed titling attempt leaves a readable title, never 'Untitled'", async () => {
  await runTitler("s_1", { ...deps, provider: alwaysFails });
  expect(store.getSession("s_1")?.title).toBe(truncate(firstUserMessage));
  expect(warnings).toContainEqual(
    expect.objectContaining({ reason: expect.any(String), fallback: "truncated-first-message" }),
  );
});
```

Pin the literal log shape. "Failure logged with a reason" is satisfiable by `title.failed` with no reason, which is how a vacuous pass gets shipped.

- [ ] **Step 6: Failing test — the title reaches every attached window**

```ts
it("INVARIANT: a generated title is emitted on the session lane, not to one connection", async () => {
  await runTitler("s_1", deps);
  expect(connA.received).toContainEqual(expect.objectContaining({ type: "session.title" }));
  expect(connB.received).toContainEqual(expect.objectContaining({ type: "session.title" }));
});
```

Assign the frame a lane in task 6's `frame-lanes.ts` table — a frame type with no lane throws by design.

- [ ] **Step 7: Config, and the prompt template**

Every tunable gets a key with a comment and a range under `orchestrator.auxiliary`: output cap, input truncation limit, the title word target, the template directory, and the operator override directory. Nothing hardcoded in source.

The template lives in `gateway/system_prompts/auxiliary/title.md` and loads through the **existing** override-with-fallback loader (operator dir → baked-in dir), per the clean-code rule that large prompt content lives in `.md` files. Reuse `loadSystemPrompt`'s loader rather than writing a second one — and note that this loader had zero callers until recently, so verify it is actually wired before relying on it.

Reasoning effort **off** for auxiliary calls — this is exactly what wave 1's `reasoning_effort` knob was added for, and a title does not need a reasoning phase.

- [ ] **Step 8: Report in-flight state to retention**

`hasAuxiliaryTaskInFlight` (task 8) becomes real here. A session must not be dropped out from under its own title.

- [ ] **Step 9: Verify live, two windows**

Two tabs on a fresh session; send the first message. Confirm a title appears in **both** without a refresh, and that renaming before the generator returns keeps the user's name.

- [ ] **Step 10: Gate and commit**

```bash
source scripts/env.sh
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
```

```bash
git add -A gateway/src/runtime gateway/system_prompts gateway/config.yaml shared/config
git commit -m "feat(session): an auxiliary-task seam, and titles as its first user"
```
