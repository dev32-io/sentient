### Task 18: a turn that produced nothing must not report success

**Wave 11 · model: opus · P1 — the worst defect E2E round 2 found**

Full evidence: `docs/native-todo.md` § 1, **D17**, and `qa/web/evidence/2026-08-01-e2e-round-2/group-d-tools-and-errors.md`.

Ask for Home Assistant history. `ha_get_history` **succeeds** and returns ~81 KB. The next provider completion returns `finish_reason: "length"` with **zero text**. No reply ever renders, the composer sits on Interrupt forever, a reload confirms the transcript is genuinely empty — and the turn is stored `completed=true failed=false`.

Three independent causes. Fix all three; any one alone leaves the hole open.

**Files:** `gateway/config.yaml`, `gateway/src/runtime/react-loop.ts`, `gateway/src/tools/tool-broker.ts`, `gateway/src/provider/openai-provider.ts` + `provider-client.ts`, `shared/config/src/schema.ts`, plus covering tests.

---

- [ ] **Step 1 — the answer budget, and the precedent that proves the number**

`orchestrator.provider.max_output_tokens` is **1024**. Reasoning tokens are charged against it, so a reasoning model spends the whole budget thinking and emits no visible text.

**We already fixed this once, in one of the two places it lives.** `config.yaml:204` says so:

> `max_output_tokens is an ANSWER cap; a reasoning model (gpt-oss:20b emits a Harmony reasoning channel first) exhausts 1024 before producing any visible summary text, which failed compaction silently and forever (observed 2/2 live)`

That is why `summarizer_max_output_tokens: 4000` exists. The summarizer got headroom; the answer path did not.

Raise `max_output_tokens` to **8000** (owner-approved). Rewrite the comment to say it must cover reasoning **plus** the answer, and cross-reference the summarizer key so the next reader sees they are the same question. Keep the documented range.

Do **not** raise it further "for safety": the requested generation size is used by some backends as an initial estimate with compute reserved for the duration, so an oversized cap has a real scheduling cost. 8000 is clear of the failure without entering that territory.

- [ ] **Step 2 — failing test: an empty completion is a failure, not a success**

`react-loop.ts:467` — when there are no tool calls it commits `outcome.text` and returns `completed: true`. `finishReason` is logged one line earlier at `:460` and **never read**.

```ts
it("INVARIANT: finish_reason 'length' with no text is a failed turn, never a silent success", async () => {
  // provider stub: yields no text, no tool calls, finishReason "length"
  const result = await runReactLoop(deps);
  expect(result.completed).toBe(false);
  // and the user is told something, rather than getting an empty bubble
});
```

Then implement. Decide deliberately and **write down which you chose and why**: retry once with the offending tool result truncated, or surface an honest error to the user. Consider that this fires when the model is already out of budget, so an unconditional retry can loop.

Whatever you choose, an empty assistant entry must never be committed as a completed turn — that record is what made this invisible.

- [ ] **Step 3 — failing test: no single tool result may starve the answer**

Cap tool result size at the **broker**, not in any one tool. `ha_get_history` is merely the first result big enough to prove the class; `read_file` and `write_file` will hit it next.

```ts
it("INVARIANT: an oversized tool result is truncated, and says so", () => {
  const out = capToolResult("x".repeat(50_000), { limit: 20_000 });
  expect(out.length).toBeLessThanOrEqual(20_000 + MARKER_SLACK);
  expect(out).toContain("truncated");
});
```

- Limit: **20000 characters**, in `config.yaml` with a comment and a range.
- **Head-and-tail**, not head-only — history and log-shaped data carry meaning at both ends.
- The marker must state that content was cut and roughly how much, so the model can narrow its query instead of silently reasoning over a fragment.

This is the established convention, not an invention: Codex truncates at 10 KiB / 256 lines head-and-tail; Pi at 2000 lines / 50 KB and tells the model to paginate.

- [ ] **Step 4 — send `reasoning_effort`, which we have never sent**

`grep -rn "reasoning" gateway/src/provider/` returns only comments. The orchestrator has never passed it.

Add `orchestrator.provider.reasoning_effort`, default **`low`** (owner-approved), plumbed to the provider request. Rationale for the comment: reasoning is the invisible phase that delays the first spoken word, and a household assistant wants an answer sooner. `low` rather than `minimal` deliberately — minimal can degrade tool selection, and picking the wrong tool is worse than a slightly slower reply.

**Do not** wire this to `profile.json#advanced.reasoningEffort`. That field is rendered into Hermes' config and has never reached our loop; binding a UI to it would appear to work and change nothing — the exact shape of the model-selection bug closed in task 16. The settings UX for this is deferred (`native-todo.md` § 3 item 6).

Send it only when the provider accepts it; a provider that rejects an unknown field must not break the turn.

- [ ] **Step 5 — verify live, on the case that found it**

In the browser as **Ada** (PIN `1234`), ask for Home Assistant history — the original 81 KB trigger.

Oracle, all four:
- a reply actually renders, and it is about the history;
- the log shows the tool result was truncated with its marker;
- no turn recorded `completed=true` with empty text;
- `stream-start` carries the new budget and the reasoning effort.

Then re-drive one ordinary turn and one tool turn to confirm nothing regressed.

- [ ] **Step 6 — strike D17, gate, commit**

```bash
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
bun qa/web/stack-integrity.ts
```
Expected: ≥1244 pass, `RESULT PASS`.
