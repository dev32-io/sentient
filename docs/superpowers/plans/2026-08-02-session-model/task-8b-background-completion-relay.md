### Task 8b: give the model something it will actually answer

**Inserted 2026-08-02 by owner decision, between tasks 8 and 9. Model: opus.** Closes **D16**, open since 2026-07-31.

**Files:**
- Modify: `gateway/src/store/model-projection.ts` (**both** emission paths — see Step 2)
- Modify: `gateway/src/tools/background-completion-note.ts`
- Modify: `gateway/system_prompts/system_prompt.md` (the "Background tasks" section, only if it now contradicts)
- Modify: `docs/native-todo.md` (strike D16)
- Test: `gateway/src/store/model-projection.test.ts`, `gateway/src/tools/background-completion-note.test.ts`

---

## What is wrong, and what is already ruled out

A delegated task completes, returns real content (measured: 5,172 characters), the gateway stores it durably and appends it as a `role: "system"` message, and starts a follow-up turn. **The model emits `completionTokens=1, textLength=0`.** Before wave 1 the user saw silence; wave 1's empty-final guard now turns that into *"Sorry — something went wrong."*

Do not re-derive any of this. It has been measured:

- The content is **not** lost or truncated — it is in the store and provably in the prompt.
- The model **sees** it: asked directly, it reproduces the payload and the task id verbatim.
- Not model-specific: **0/9** relays on `gpt-oss:20b`; *worse* on `deepseek-v4-flash` after the model-selection fix — total silence rather than an acknowledgement.
- Not the note's wording: an explicit hand-off line ("the person has not seen this yet; your next reply is how they receive it") moved it **0/6**.
- `role: "user"` **does** work — 2/2 — but then the model treats the payload as something the *person* pasted and answers "Got it, thanks for the update!" without restating it. That is D16's original symptom, and reverting the role reinstates a lie the model then acts on.

So the defect reduces to one sentence: **these models will not volunteer a reply to a system-role message.** They answer *users*.

## The fix — owner's decision, use this wording verbatim

The follow-up turn ends with a **user-role instruction**:

```
The background task you dispatched has returned. Respond accordingly.
```

**"Respond accordingly", not "relay the result", is deliberate.** It leaves the model free to judge: relay it, start a fresh ReAct turn and call more tools, or report a failure. A directive to relay would be wrong for a delegation that errored, and wrong for one whose result needs another tool call before it means anything.

**The payload does not move.** It stays fenced as data inside the `role: "system"` message, with its task id and request echo. Per the Model Spec chain of command, tool output is the *lowest*-trust input and a delegated agent reads the open web; promoting that content into the user's voice is the injection surface this design has been avoiding. What goes in the user turn is the **harness speaking** — a short, fixed instruction containing none of the payload.

---

- [ ] **Step 1: Failing test — the projection ends with an instruction the model can answer**

```ts
it("INVARIANT: a background completion is followed by a user-role instruction, and the payload stays in the system message", () => {
  const msgs = projectForModel([userEntry("delegate the thing"), triggerEntry("Delegated task t1 … completed: PAYLOAD")]);
  const last = msgs.at(-1);
  expect(last?.role).toBe("user");
  expect(last?.content).toBe("The background task you dispatched has returned. Respond accordingly.");
  expect(msgs.at(-2)?.role).toBe("system");
  expect(msgs.at(-2)?.content).toContain("PAYLOAD");
  expect(last?.content).not.toContain("PAYLOAD");
});
```

That last assertion is the trust boundary, not a style check: the instruction must carry no payload.

- [ ] **Step 2: BOTH emission paths, not one**

`model-projection.ts` gives a `trigger` entry `role:"system"` on **two** paths — rule 5, and rule 3b's deferred path. **Rule 3b is the path every completion takes while another delegation is still mid-dispatch**, i.e. the concurrent case. Wave 1's task 15 shipped a one-line fix that covered only one of them and had to be corrected; do not repeat it.

Write the test twice — once through each path — rather than asserting the shared helper.

- [ ] **Step 3: Failing test — a bare instruction never appears without its payload**

```ts
it("INVARIANT: the instruction is emitted only alongside a completion, never alone", () => {
  const msgs = projectForModel([userEntry("hello")]);
  expect(msgs.filter((m) => m.content === BACKGROUND_COMPLETION_INSTRUCTION)).toHaveLength(0);
});
```

And the multiplicity case: **two** completions in one projection produce two system messages and two instructions, in order — not one instruction covering both. A model handed two payloads and one prompt has no way to say which it is answering.

- [ ] **Step 4: Cache stability**

The model projection is cache-stable by contract — a prefix must never be rewritten by a later turn. Appending a fixed instruction after a completion preserves that; **rewriting an earlier completion when a second one lands would not.** Confirm your change only ever appends, and say so in your report.

- [ ] **Step 5: The system prompt**

`system_prompts/system_prompt.md`'s "Background tasks" section currently says results "arrive later as a system message naming that task id. That is not the user speaking." That is still true and should stay. Change it **only** if your implementation makes it inaccurate — and if you do change it, keep the section's existing shape: no examples, no MUST/NEVER scaffolding, no re-expansion. It was written lean on purpose after several rounds.

- [ ] **Step 6: Verify live — the oracle is the rendered reply CONTAINING the delegated content**

In the browser as **Ada** (PIN `1234`), ask for a delegated task and wait for the completion.

**"A follow-up turn fired" is not the oracle. "No error message appeared" is not the oracle.** Read what the reply says and confirm the delegated content is in it. That distinction is the entire history of this defect — it has been reported fixed twice on weaker oracles.

Then drive **two concurrent** delegations. That is what the task-id echo exists for, it is rule 3b's path, and it is the case that fails silently if step 2 was done wrong.

Record the model you drove it on. Every prior measurement is annotated with its model, and this one must be too.

- [ ] **Step 7: If it still does not relay, stop and report — do not iterate on wording**

Nine trials across two models have already failed on prompt wording. If the user-role instruction does not move it, that is a genuinely new finding: report it with the completion's token counts and the exact messages array, and stop. Do not spend rounds rephrasing. The next candidate would be structural (a synthetic user turn carrying the request rather than the instruction), and it is the owner's call.

- [ ] **Step 8: Strike D16, gate, commit**

Strike D16 in `docs/native-todo.md` using the file's `~~D16 — …~~ — CLOSED <date> (plan task 8b)` convention, keeping the original symptom text. **Two things stay open** and must be recorded there rather than implied closed:

- the webui does not render `trigger` feed items at all, so the raw completion is invisible in the transcript even when the relay works;
- a window reconnecting inside the retention window may hear a whole delegated answer spoken from the journal (task 8's consequence).

```bash
source scripts/env.sh
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
bun qa/web/stack-integrity.ts
```
