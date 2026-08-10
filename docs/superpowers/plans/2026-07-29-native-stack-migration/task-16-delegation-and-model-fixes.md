### Task 16: the model you chose, the gate that never fired, and five smaller truths

**Wave 9 · model: opus · seven fixes, ordered — later ones depend on earlier ones being true**

All seven were found by the owner in normal use over one session, none by a test. Each is small. The ordering is not arbitrary: fix 3 makes every later observation about model behaviour meaningful, and fixes 1–2 close a live security gap before anything else runs.

Full evidence for all of them: `docs/native-todo.md` § 1.

**Files:** `gateway/mcp-policy.yaml`, `gateway/config.yaml`, `gateway/src/tools/delegate-task.ts`, `gateway/src/tools/hermes-runner.ts`, `gateway/src/bootstrap/phase-services.ts`, `gateway/src/admin/secrets-store.ts` (+ its shared type), `gateway/persona.md`, `gateway/templates/persona/default.md`, `gateway/system_prompts/**`, `gateway/src/tools/background-completion-note.ts`, `gateway/webui/src/**`, `docs/native-todo.md`.

---

- [ ] **Step 1 — `delegateTask` must ask. It currently never does.**

`mcp-policy.yaml:204` sets `action: allow`, justified in-file by *"a blanket PDP confirm here would double-prompt and is not what §2.3 specifies."* **The guard it defers to never prompts** — it classifies (`low → allow`), and every live dispatch logs `tier="low" action="allow"`. There is no first prompt to double.

Change it to `confirm` with a reason the user can act on, and **rewrite that comment** — a wrong rationale left in place is how this survived review.

The dialog must show what is actually being authorised: the `taskPrompt`. Approving "run a delegated task" without seeing the instruction is not consent.

This is interim. The tiered classifier is the destination and is deferred to its own spec (`native-todo.md` § 1, with Claude Code's auto-mode decomposition as the reference). Do **not** build a classifier here.

- [ ] **Step 2 — delegate against the `default` Hermes profile**

Owner's decision. One of three per-user profiles was returning `HTTP 401: User not found.` because `--clone-from` copies a credential at a point in time and nothing re-syncs it.

Point delegation at the `default` profile. Keep using Hermes' public CLI — never read or write a Hermes credential, never point `HERMES_HOME` at the gateway tree (tried and rejected: that directory has no `.env`/`auth.json`).

Record in `native-todo.md` that this is interim, and cross-reference the existing **§ 3 external-tool installation** item — this is the same *render-once vs reconcile* question that section already owns, now with a second instance.

- [ ] **Step 3 — the model the user selects is ignored. Fix before judging any model behaviour.**

`ResolvedLlm` is `{provider, apiKey, baseUrl}`; `phase-services.ts:447` takes the model from `config.yaml`'s `orchestrator.provider.model`. The settings UI showed `deepseek-v4-flash:cloud` while the runtime ran `gpt-oss:20b-cloud`.

Carry the selected model through, with `config.yaml` as the fallback when nothing is selected. Then verify from the log that `orchestrator.provider.resolved` names the **selected** model.

Read how the settings UI stores the selection before designing this — do not assume it lives in the secrets store just because the key does.

- [ ] **Step 4 — a failed delegation must not log `run.ok`**

The 401 came back as a 26-character output and `delegate-task` logged `delegate-task.run.ok outputLength=26`. Failure reported as success is what let this hide.

Failing test first. Decide deliberately how failure is detected — exit code, output shape, or an explicit error channel — and say why. **A short output is not a failure**; "yes" is a legitimate answer. Do not proxy failure with a length threshold.

- [ ] **Step 5 — the prompt loader, `persona.md`, and the templates**

`loadSystemPrompt` was wired in task 15, but the surrounding state is still wrong:

- `gateway/persona.md` is the file that actually loads (`templates/persona/default.md` is only its fallback, and `build-gateway.sh:52` ships `persona.md`). It says *"running on a Raspberry Pi 5"* — retired hardware — and *"when uncertain, ask clarifying questions rather than assuming"*, which contradicts the system prompt it overrides.
- Keep the persona **lean**: character and tone only. The system prompt owns role and scope. Restating is how contradictions creep back, and per OpenAI's guidance contradictions cost reasoning tokens rather than being merely untidy.
- `gateway/system_prompts/system_prompt_unlimited.md` is dead in the live tree (its only reference is a stale `gateway/dist/` build artifact). Delete it, or say why it stays.

Verify by log, not by inspection: `system-prompt-loaded` + `persona-loaded` + the resolved character count.

- [ ] **Step 6 — the completion note narrates the dispatch instead of carrying the result**

It reads *"Background task <id> completed. **You dispatched it earlier with the delegateTask tool.**"* — so the model talks about dispatching: *"Sure thing; I just sent Hermes another go-round."*

Drop the dispatch narration. Keep the task id, the request echo, and the fenced payload — those earn their place (id for concurrency, echo to survive compaction, fence because the payload is untrusted).

- [ ] **Step 7 — the background-task bubble is not user-facing**

Task 15 renders the completion as a visible card. Owner's ruling: **a tool result is context for the model, never a user-facing artifact.** The model synthesises a reply from it and *that* is what the user sees and hears — which is also the only thing that works in voice, where there is no card.

Remove it. If you believe something should remain visible, say what and why in your report rather than keeping it by default.

- [ ] **Step 8 — verify, gate, commit**

Live, in the browser (PIN `1234`):
- a delegation now **prompts**, and the dialog shows the `taskPrompt`;
- approving it runs against `default` and returns real content;
- `orchestrator.provider.resolved` names the **selected** model;
- no `run.ok` on a failed delegation;
- no background-task card in the feed.

```bash
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
bun qa/web/stack-integrity.ts
```
Expected: ≥1235 pass, `RESULT PASS`.
