### Task 4: serve the session list, and make "+" mean something on screen

**Spec:** §3.5 #3, §1. **Model:** sonnet.

`GET /api/v1/sessions` has no handler — `grep -rn "api/v1/sessions" gateway/src` is empty. Both SDKs call it, and mobile's failure branch is `SdkConnectors.loadHistoryForSession` → `replaceMirror(emptyList())`, which is why answering `conversation.activate` before this route exists would **wipe the visible chat**. This task lands the route and the web drawer.

**Files:**
- Create: `gateway/src/api/handlers/sessions.ts`
- Modify: `gateway/src/api/router.ts` (register before the static fallback)
- Modify: `gateway/src/bootstrap/phase-routes.ts` (wire the handler)
- Modify: `gateway/webui/src/hooks/use-sessions.ts`, `components/sessions/drawer.tsx`, `hooks/use-voice-client.ts:625`
- Test: `gateway/src/api/handlers/sessions.test.ts`

**Interfaces consumed:** `listSessionsWithMetadata()`, `getSession()` (task 2); `resolveSession` (task 3).

---

- [ ] **Step 1: Failing test — the route reads the principal, never a request parameter**

```ts
it("SECURITY: a userId in the request cannot select whose sessions are returned", async () => {
  const res = await handleSessions(requestAs(ada, "/api/v1/sessions?userId=u_grace"));
  const body = await res.json();
  expect(body.sessions.every((s) => adaSessionIds.has(s.sessionId))).toBe(true);
});
```

This is the classic authorization mistake and it is cheapest to prevent before the route exists. The handler resolves a principal from the request's session token, grants a capability, opens **that** store. A `userId` in the query string or body is ignored — and if present, logged at WARN as a `reason`, because a client sending one is either broken or probing.

- [ ] **Step 2: Failing test — an unauthenticated request gets nothing**

```ts
it("SECURITY: an unauthenticated request is refused", async () => {
  const res = await handleSessions(new Request("https://x/api/v1/sessions"));
  expect(res.status).toBe(401);
});
```

- [ ] **Step 3: Serve list and messages**

- `GET /api/v1/sessions` → `{ sessions: SessionMetadata[] }`, newest-updated first (task 2 already orders it, so do not re-sort in the handler).
- `GET /api/v1/sessions/:id/messages` → the committed feed for that session, using the **same client projection** the live path uses. Two projections would drift, and `render(replay) == render(live)` is a protocol contract.
- An id not in the caller's store → **404**, the same answer as an id that never existed. Do not distinguish "not yours" from "not there"; that difference is an oracle for enumeration.

Register in `api/router.ts` alongside the other `API_V1` routes, **before** `handleStatic` — the static fallback can otherwise return `index.html` with a 200 for an API path.

- [ ] **Step 4: Wire the drawer, and delete the comment that lies**

`drawer.tsx:133` still documents the deleted ACP mechanism: *"the gateway clears the chat pane synchronously (`switchFlow.switchTo("")`)"*. That code path no longer exists, and the comment is the reason the button looks wired.

`use-voice-client.ts:625` handles `created` by clearing typewriter/drain state and then calling `refreshMessages()` — which re-reads the same conversation and undoes the clear. That is **correct for a switch** and wrong for a new session. Distinguish the two: a switch refetches; a new session starts empty.

- [ ] **Step 5: Failing test — the list survives an empty store**

```ts
it("returns an empty list rather than an error for a user with no sessions", async () => {
  const body = await (await handleSessions(requestAs(freshUser, "/api/v1/sessions"))).json();
  expect(body.sessions).toEqual([]);
});
```

A fresh user hitting an error here is what produces the drawer's "Couldn't load sessions" banner that E2E round 2 saw throughout.

- [ ] **Step 6: Verify live at both viewports**

Desktop 1280×900 and mobile-sized 390×844. Confirm: the drawer lists real sessions with titles, no error banner, opening an older one renders its full history, and "+" produces an empty feed.

Check the drawer at 390 px for horizontal overflow by walking the ancestor chain comparing `scrollWidth` to `clientWidth` — **not** by the page-level `scrollWidth <= innerWidth` check, which passes on clipped content because an ancestor's `overflow: hidden` suppresses the very scroll it looks for. That trap has been hit twice on this branch.

- [ ] **Step 7: Gate and commit**

```bash
source scripts/env.sh
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4) && (cd gateway/webui && bun run test 2>&1 | tail -4)
```

```bash
git add -A gateway/src/api gateway/src/bootstrap gateway/webui/src
git commit -m "feat(sessions): serve the session list and make the drawer real"
```
