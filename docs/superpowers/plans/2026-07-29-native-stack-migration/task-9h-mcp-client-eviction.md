### Task 9h: a dead MCP transport is cached for the process lifetime

**Wave 6 · model: opus · found by task 9g, outside its ownership**

`gateway/src/tools/mcp-client.ts` caches one transport per catalog server and evicts it **only when the connect rejects** — never when a `listTools` or `callTool` fails on an already-connected transport.

The system orchestrator recreates `ma-mcp` during its boot reconcile, *after* the client's warm-up already connected. Every later call on that cached transport returns `-32600 "Session not found"`, for the **rest of the gateway process's life**. Consequence: `ma_*` is missing from the delegated listing, and — the part that makes this more than a delegation bug — **the gateway's own ReAct loop hits it identically.** Music control is dead until someone restarts the gateway.

**Files:**
- Modify: `gateway/src/tools/mcp-client.ts`
- Test: `gateway/src/tools/mcp-client.test.ts`

---

- [ ] **Step 1: State probe and reproduce**

```bash
git log --oneline -8
grep -n "transport\|cache\|connect\|evict\|catch" gateway/src/tools/mcp-client.ts | head -30
# live: boot the gateway, wait for the orchestrator's reconcile, then exercise an ma_* tool
grep -E "mcp\.|Session not found|-32600|ma-mcp" ~/.sentient/gateway/logs/$(date +%F).log | tail -20
```

- [ ] **Step 2: Write the failing test**

```ts
it("INVARIANT: a call failure evicts the cached transport so the next call reconnects", async () => {
  let connects = 0;
  const client = createMcpClient({
    /* …, connect: () => { connects++; return okTransport(failingAfterFirstCall); }, … */
  });
  await client.callTool("music_assistant", "ma_search", {});   // fails: session gone
  await client.callTool("music_assistant", "ma_search", {});   // must RECONNECT, not reuse
  expect(connects).toBe(2);
});
```

Read the real factory signature first and match it. Do not invent deps.

- [ ] **Step 3: Implement — evict on the right failures, and only those**

The bug is that eviction is wired to one narrow event. Evict when a call or list fails in a way that means *this transport is dead* — a transport/session error — and reconnect on the next use.

Two things to get right, and both are judgement, so state your reasoning:
- **Do not evict on an application-level tool error.** A tool that legitimately returns "no such playlist" is a *working* transport. Evicting there turns every user mistake into a reconnect storm.
- **Do not retry forever.** A reconnect that fails must surface as a tool error with a reason, not a loop. Every external call is timed out per the house rules; keep it that way.

Prefer eviction plus a *single* transparent retry on the next call over an inline retry loop — the loop is where unbounded behaviour creeps in.

- [ ] **Step 4: Verify live, on both consumers**

The point of this fix is that two callers share the fault:

```bash
# 1. the gateway's OWN loop — ask for something that needs an ma_* tool via the webui or WS
# 2. the delegated agent
hermes -p u_1eee01a4 -z "List the exact names of every tool you can call, then stop."
```
Expected: `ma_*` names present in the delegated listing, and the gateway's own loop completes an `ma_*` call after an orchestrator recreate. Force the recreate rather than hoping for it — restart the `ma-mcp` addon while the gateway stays up, then call again.

- [ ] **Step 5: Update the record, gate, commit**

Strike this defect from `docs/native-todo.md`.

```bash
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
git commit -m "fix(tools): evict a dead MCP transport instead of caching it forever" -- \
  gateway/src/tools/ docs/native-todo.md
```
Expected: ≥1185 pass.
