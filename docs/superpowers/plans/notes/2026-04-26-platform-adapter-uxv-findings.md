# Phase G — Live UX validation findings (2026-04-26)

Driven via Chrome DevTools MCP against the full local stack
(`docker compose -f deploy/docker/docker-compose.yml up -d`).

## Stack health at start of validation

All five services up (gateway, sentient-hermes, stt-service, egress-proxy,
ha-mcp). Gateway healthcheck green. Boot-migration rendered the existing
user's supervisord program; supervisord launched `hermes -p u_6ae26974
gateway run` and the per-profile WS adapter prewarmed cleanly via the
shared bridge network (`prewarm.upsert ws://sentient-hermes:8650/ws`).

## Flows exercised

| # | Flow | Result |
|---|------|--------|
| 1 | Login (PIN keypad) | ✅ pass |
| 2 | Settings → My Agent renders SOUL + Personalities | ✅ pass |
| 3 | GET /api/v1/profile/soul populates textarea + last-saved | ✅ pass |
| 4 | GET /api/v1/profile/personalities lists existing | ✅ pass (empty) |
| 5 | Add personality → save → restart cycle (~2.7s) → ready | ✅ pass after fix #1 |
| 6 | Switch active personality (instant, no restart) | ✅ pass |
| 7 | SOUL edit → save → restart cycle (~2.2s) → ready | ✅ pass |
| 8 | Edit active personality body → save → restart → reapply /personality | ✅ pass after fix #2 |
| 9 | Delete personality (two-step inline confirm) | ✅ pass |
| 10 | Console errors after full session | ✅ clean (only Chrome audio-autoplay warning) |
| 11 | Failed network requests | ✅ clean after fixes |

## Flows NOT exercised (deferred to manual user testing)

- **G.5 — Tool-call rendering with a real conversation.** Requires
  voice or text prompt that triggers a tool call; the conversation panel
  exists but driving it via Chrome DevTools MCP for a live LLM round-trip
  is out of scope.
- **G.6 — Barge-in test.** Voice-only.
- **G.4 step 5 — voice-prompt verification of personality switch.** Voice-only.

These are intentionally left for the user to run after Phase G hands off.

## Bugs found + fixed inline

### Fix #1 — `personality-store` crashes when `agent:` key is missing entirely

**Symptom:** First `POST /api/v1/profile/personalities` returns 500 with
`personality-store: agent node must be a map`. The webui shows the
red "Something went wrong / Retry / View logs" failed-restart banner.

**Root cause:** `personality-store.ts:ensurePersonalitiesMap` did
`doc.set("agent", { personalities: {} })` when `agent` was missing. The
`yaml` lib v2 stores the value as a plain JS object, not a YAMLMap node,
so the follow-up `doc.get("agent")` + `isMap()` check fails and we throw.

**Fix:** wrap the plain object via `doc.createNode(...)` before assignment:
```ts
doc.set("agent", doc.createNode({ personalities: {} }));
agent.set("personalities", doc.createNode({}));
```

**Test added:** `personality-store.test.ts` — "add bootstraps
agent.personalities when config has no agent key".

The default `profile-renderer` does NOT seed `agent.personalities`, so
this code path fires for every brand-new user's first personality
creation. High-impact regression that the existing test suite (which
always pre-seeded `agent:`) didn't catch.

### Fix #2 — Editing the active personality's body breaks the active selection

**Symptom:** Click Save on the active personality's edit form → restart
spinner → Ready → Active personality dropdown silently reverts to
"— none —". The voice persona stays at the OLD body until the user
manually re-selects it.

**Root cause:** `personality-store.list()` resolves `activeName` by
matching `agent.system_prompt` against each personality's resolved body.
Updating only the personality body (not `system_prompt`) leaves the two
out of sync. The plan called this out as an edge case the gateway should
handle (re-fire `/personality <name>` after restart) but Phase D's
implementation didn't.

**Fix:** in `profile-edit.ts:handlePersonalityNamed` (PUT branch):
1. Capture `wasActive = activeName === name` BEFORE the update.
2. After successful restart, if `wasActive`, dispatch the `/personality
   <name>` slash via the WS adapter as `internal: true`.
3. Poll the personality store every 200 ms (up to 3 s) until activeName
   matches `name` again — this avoids a webui→gateway race where the
   webui's re-fetch arrives before Hermes has rewritten `system_prompt`.

**Verified:** `reapplyActive.dispatched` → `reapplyActive.confirmed
elapsedMs=206` and the UI keeps activeName=focus across the cycle.

## Polish items deferred (low severity)

- **Discoverability of "+ New personality…":** the only way to create
  the first personality is to open the Edit dropdown and pick the
  sentinel option `+ New personality…`. Empty state has no visible
  "Add personality" button. Users who don't notice the dropdown's New
  option may think personalities aren't editable. Worth a follow-up:
  show an inline "+ Add personality" button when `personalities.length
  === 0`.
- **`view logs` link is a stub** (`href="#logs"`). Fine for v1; route
  it to a real logs viewer once one exists.
- **Active dropdown's option is reported as `disabled` in the a11y
  snapshot** when an option is the only valid one and currently
  selected. Cosmetic — functional behavior is correct. May be a Chrome
  a11y tree quirk on `<select>` with one item.
- **active-personality returns 502 `ws-not-connected` if pool entry
  missing.** Phase F's prewarm makes this rare in practice (boot-migrate
  pre-warms every existing user). Mid-session newly-created users hit a
  lazy upsert that's racy. Could pre-warm at user-create time too.

## Stack tear-down

Stack stays running for follow-up manual voice testing by the user.
Run `docker compose -f deploy/docker/docker-compose.yml down` to stop.
