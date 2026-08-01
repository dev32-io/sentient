### Task 15: D16 — a background completion is not the user speaking

**Wave 8 · model: opus · owner-observed, then independently reproduced by NM-T12 on both delegation drives**

Ask for a delegated explanation of a Fresnel lens. The background path works perfectly — dispatch, run, `delegate-task.run.ok outputLength=476`, a steered follow-up turn, queued audio. Then the assistant says:

> "Great! Let me know if you'd like to use that description somewhere."

The Fresnel explanation never appears. Same shape on the second drive: *"Got it—thanks for the update!"*, no Saturn fact. From outside, the feature looks broken.

**The model is not confused. It is answering correctly to a wrongly-shaped input.**

`gateway/src/store/model-projection.ts:275`:
```ts
if (entry.kind === "user" || entry.kind === "trigger") {
  messages.push({ role: "user", content: entry.text ?? "" });
```

A background completion is appended as a `trigger` entry — `"Delegated task 7f3cf9be… (delegateTask) completed: <result>"` — and projected as **`role: "user"`**. The model sees the person pasting a delegated result into the chat, so it responds the only sensible way: acknowledging it. Then the client never renders the `trigger` feed item at all, so the human sees the acknowledgement and not the content.

**Files:**
- Modify: `gateway/src/store/model-projection.ts` (the `trigger` branch)
- Modify: wherever the completion stimulus text is composed (`gateway/src/tools/delegate-task.ts` or its background-task seam — find it, do not assume)
- Modify: `gateway/system_prompts/system_prompt.md`
- Modify: `gateway/webui/src/**` (render the completion as its own thing)
- Modify: `docs/native-todo.md` (strike D16)

---

## Step 0 — DECIDED (owner, 2026-07-31)

**Model side: `role: "system"`, not `user`.** Chosen over the two alternatives:
- *`role:"tool"` tied to the original call* — semantically ideal, but background tools answer immediately with `{taskId}`, so that `tool_call_id` is already satisfied and `model-projection`'s rule 4 explicitly drops a second result for an answered id. It fights the contract.
- *A bespoke message shape* — not in any provider's protocol.

**The completion must name its task AND echo the request.** The owner's reasoning, and it is the important half:

> "i feel like we still need to response/'inject' the result as context specific to the original tool call when we could associated to the taskId, or at least noted that taskId, so that LLM understand which task is returning this result when multiple bg tasks are happening"

The id alone is not enough. The dispatch's `{taskId}` tool_result is what the model would join against — and **compaction summarises that away**, leaving an opaque hex string bound to nothing, precisely when several tasks are in flight. So the event carries a truncated echo of the original `taskPrompt` alongside the id. Self-describing, survives compaction, unambiguous under concurrency.

**A mid-conversation `system` message is not the trained pattern**, so the system prompt must describe it. Models handle `role:"tool"` after an assistant `tool_calls` natively — that is deep in-distribution — but `system` is trained as the *leading* instruction block. Mid-stream it mostly works and is treated as authoritative, but it is not something to leave implicit.

---

- [ ] **Step 1: State probe**

```bash
git log --oneline -8
grep -rn "trigger" gateway/src/store/model-projection.ts gateway/src/store/client-projection.ts | grep -v '\.test\.'
grep -rn "completed:\|Delegated task" gateway/src --include='*.ts' | grep -v '\.test\.'
sqlite3 ~/.sentient/gateway/users/<a user>/sessions.db \
  "SELECT seq, kind, substr(text,1,90) FROM entries WHERE kind='trigger' ORDER BY seq DESC LIMIT 3"
```
The store rows are the ground truth for what the completion currently says.

- [ ] **Step 2: Failing test — a completion is not user speech**

```ts
it("INVARIANT: a background completion projects as system, never as the user", () => {
  const msgs = projectForModel([userEntry("do the thing"), triggerEntry("Delegated task t1 … completed: RESULT")]);
  const last = msgs.at(-1);
  expect(last?.role).toBe("system");
  expect(last?.content).toContain("t1");
});
```
**Careful — `trigger` is not only used for background completions.** Check every producer of a `trigger` entry before you change the branch: if some other stimulus (a sensor event, a scheduled wake) also lands as `trigger` and *should* read as user-ish input, then the distinction belongs in the entry, not in the projection. Establish that from the code, and say what you found.

- [ ] **Step 3: Failing test — the completion is self-describing**

```ts
it("INVARIANT: a completion names its task AND echoes what was asked", () => {
  const text = composeCompletion({ taskId: "t1", agent: "hermes", prompt: "explain a Fresnel lens in two sentences", output: "…" });
  expect(text).toContain("t1");
  expect(text).toContain("Fresnel");        // survives compaction of the dispatch result
});
```
Truncate the echoed prompt (the ≤120-char logging cap is a reasonable precedent; pick a value, put it in config with a comment and a range).

- [ ] **Step 4: The system prompt is describing a product that no longer exists**

`gateway/system_prompts/system_prompt.md` is 23 lines and still documents the **retired** architecture: a `speak` tool, a `configure` tool, "sensor triggers". None exist on 2.0. It never mentions `delegateTask` or background tools at all.

A model told about tools it does not have, and not told about the ones it does, behaves oddly in ways that read as loop bugs. Fix both halves:
- Remove what is gone. Verify against the live catalog rather than trusting this list — `grep "list-tools.ok" ~/.sentient/gateway/logs/$(date +%F).log`.
- Add the background-task lifecycle: a background tool returns `{taskId}` immediately; its result arrives later as a system event naming that id; **the expected reaction is to relay the result to the user**, not to acknowledge it as though the user spoke.

Note line 23 already establishes the out-of-band-system-message precedent ("A separate ephemeral system message MAY appear at the very end…") — extend that pattern rather than inventing a second one.

- [ ] **Step 5: The client never renders the completion**

`client-projection.ts` emits a `trigger` feed item, and `gateway/webui/src/**` has no branch for it — so the result is invisible and only the assistant's reaction shows.

The owner wants it invisible **to the model as chat** but the human still needs the content. Render it as its own thing — a system/task card, visually distinct from a chat bubble — carrying the task id and the result. Decide with the existing feed components rather than inventing a new visual language.

- [ ] **Step 6: Verify live, end to end**

```bash
# in the browser (PIN 1234): ask for a delegated task, wait for completion
grep -E "delegate-task|trigger|turn.started" ~/.sentient/gateway/logs/$(date +%F).log | tail -20
```
Expected: the follow-up turn **relays the delegated content** to the user, and the completion is visible as a task card. Drive **two concurrent** delegations too — that is the case the taskId echo exists for, and the case that fails silently if you get it wrong.

- [ ] **Step 7: Strike D16, gate, commit**

```bash
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
bun qa/web/stack-integrity.ts
```
Expected: ≥1230 pass, `RESULT PASS`.
