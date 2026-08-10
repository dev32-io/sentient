### Task 19: a tool that failed must not reach the model shaped as success

**Wave 11 · model: opus · the confabulation defect**

Full evidence: `docs/native-todo.md` § 1, **D18**, and `qa/web/evidence/2026-08-01-e2e-round-2/group-d-tools-and-errors.md`.

With `sentient-searxng` stopped, "what's USD to CAD" was answered **"1 USD = 1.40 CAD"** — no citation, no hedge, stated as fact and wrong. The same question after recovery returned the real rate with a source.

The upstream `searxng-mcp-server` (pip, pinned 0.1.9) swallows its own DNS failure and returns a 131-byte **success**:

```json
{"total_results": 0, "results": [], "error": "[Errno -3] Temporary failure in name resolution"}
```

`isError=false`, so the ToolBroker, the PDP and the log all read it as clean. The failure exists only *inside* the payload. The model, handed an empty result set with no error signal, answered from its weights.

**We cannot fix the upstream package.** The boundary is ours: result honesty is a property we have to check, not one we can inherit.

**Files:** `gateway/src/tools/mcp-client.ts` (the `callTool` result path, ~line 310), `gateway/config.yaml`, plus covering tests.

---

- [ ] **Step 1 — failing test: an in-band error is an error**

```ts
it("INVARIANT: a result whose payload carries an error is isError, whatever the flag said", () => {
  const r = normalizeToolResult({
    isError: false,
    content: '{"total_results":0,"results":[],"error":"[Errno -3] Temporary failure in name resolution"}',
  });
  expect(r.isError).toBe(true);
  expect(r.content).toContain("name resolution");   // the reason survives, so the model can say WHAT failed
});
```

Match the real signature — read `mcp-client.ts:278-318` first.

- [ ] **Step 2 — decide the rule, and keep it narrow**

The obvious rule ("any payload with an `error` key is an error") is close to right but think about the false positives before committing: a legitimate result could contain the word *error* as data — a log search, a home-assistant entity literally named `error`, a web page about errors.

Suggested shape, but **make the call yourself and record your reasoning**:
- the payload parses as JSON, **and**
- it has a top-level `error` key whose value is a non-empty string, **and**
- the result set alongside it is empty.

That last clause matters: a search that returned results *and* a warning is not a failed call. Narrow beats broad here — turning real results into errors is a worse failure than the one being fixed.

Put the detection in the **shared** `callTool` path so every MCP server gets it, not just searxng.

- [ ] **Step 3 — an empty search result is not automatically an error**

Resist widening this to "empty results = failure". A genuine no-hits search is a valid answer and the model should say so. The signal being acted on is the **error string**, not the emptiness; emptiness is only corroboration.

- [ ] **Step 4 — verify live, reproducing the original**

As **Ada** (PIN `1234`):

1. `docker ps` → identify the exact searxng container by name. **Never a broad kill.**
2. `docker stop <exact-name>`.
3. Ask a question that needs a web search and has a checkable answer.
4. Oracle: the reply says it could **not** search — it must not state a figure. The log shows `isError=true` with the upstream reason.
5. Restore. The gateway's own watchdog restarted it unaided in ~15 s during round 2; observe whether it does again, and `docker start` it yourself if not.
6. Ask the same question again and confirm a real, cited answer.

Finish with `bun qa/web/stack-integrity.ts` → `RESULT PASS`. Do not leave the stack degraded.

- [ ] **Step 5 — strike D18, gate, commit**

```bash
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
```

Note in `native-todo.md` that this is a containment at our boundary, not a fix of the upstream package — and that the same check is the natural hook for the inbound scanning boundary when that lands, since both inspect an incoming payload before it reaches the model.
