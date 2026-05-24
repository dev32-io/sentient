# ACP Pivot Smoke Results — 2026-05-08

**Final status (post Phase 7 cleanup):** GREEN-PARTIAL retained — Phase 7 retired the legacy custom-WS code paths and feature flag without touching the ACP wire. C1 retry remains GREEN; cases C3 / C10 / C11 / C13 / C17 still need to be re-run on the cleaned tree as a follow-up smoke pass. ACP wire is now the only path; `gateway.use_acp_wire` flag was deleted along with `sentient_gateway.py`, `ConnectionPool`, `WsHermesClient`, the legacy event-translator, and 9 of 10 overlay patches.

**Earlier history:** F1–F4 fixed the systemic ACP-wire gaps (missing `session/new`; ACP gaps for search/delete/get/getMessages). F5 found the LLM 404 was NOT an upstream-Hermes bug — it was a stale on-disk config: the profile-renderer templates had been switched from `model: <id>` → `default: <id>` to match ACP's `model_cfg.get("default")` reading, but the user's existing rendered `config.yaml` had not been re-rendered. Fix landed in two parts: one-shot edit of the on-disk file + a boot-time re-render pass (`renderConfigsForExistingUsers`) that idempotently regenerates every existing user's profile config from the current template on every gateway boot. C1 retry is now fully green (real assistant response + real auto-title). Cases previously deferred behind C1 (C3, C10, C11, C13, C17) are unblocked.

> **Original BLOCKED report preserved further down for context.** F1-F4 in commits `2db34db`, `621f412`, `108c0a1`, `95832b9`, `74d8a6c` cover the recovery work.

## F5 (post-F1-F4) results

### Gateway-side fixes that landed during F5

Two 1-line-class fixes uncovered by smoke and applied in the same commit as the doc update — both purely on the ACP-wire branch, legacy path unchanged:

- `gateway/src/session-handlers/sessions-handlers.ts` `sessions.list`: when `cfg.acpConn` is set, route through `listSessionsViaAcp` (no REST call to `/api/sessions` which the ACP-only Hermes build doesn't serve). Without this, the drawer perma-shows "Couldn't load sessions" on first open under `use_acp_wire=true`.
- `gateway/src/session-handlers/sessions-handlers.ts` `sessions.search`: under ACP wire, drop the `row.source === "sentient-user"` filter — every session in the per-profile DB is `source="acp"` by construction (the supervisord ACP child writes that source), so the legacy filter was rejecting 100% of search hits. Ownership filter via `profileSessionsLookup` (which already routes through ACP) still applies.

Same code paths still default to legacy when `acpConn === null`, so `use_acp_wire=false` regressions are zero.

### Smoke matrix

| # | Case | Result | Notes |
|---|---|---|---|
| C1 | First-ever message + auto-title | GREEN (post-F5 fix) | First attempt YELLOW: assistant response was the 404-error string, root cause was a stale on-disk profile config (legacy `model: <id>` key vs the current template's `default: <id>` — see F5 fix below). Retry post-fix: "Hi, what is 2+2?" → "2 + 2 is 4." real assistant response, auto-title "Basic Addition Calculation" populates the drawer within ~10s. Evidence at `.playwright-mcp/acp-pivot/F5-fix-C1-desktop-llm-call-success.png`. |
| C2 | Resume existing session | GREEN | Click "Long Cat Story Request" / "Cat Story Request"; `getMessages` via plugin REST returns 3 messages, snapshot rehydrates, `session.switched` precedes `conversation.snapshot`. |
| C3 | Mid-cycle switch | DEFERRED | Requires active cycle to mid-interrupt. Unblocked post-F5 fix; not yet re-run in this session — flag for next smoke pass. |
| C4 | Reconnect with `?session_id=` | GREEN (= C19) | Session id persists across page reload via `sessionStorage`, history rehydrates. Tested via reload of `https://localhost:8888` after switching to a session. |
| C5 | Mobile viewport tap targets (390×844) | GREEN | Drawer renders 8 sessions; tap targets measure 66×44 px (meets WCAG 2.5.5 minimum 44×44). |
| C6 | Search — hit + no-hit | GREEN | `cat` returns 5 sessions (all yesterday's cat-story chats). `xyzzy` shows "No matches for xyzzy". Both paths route through plugin REST `/search` and pass the ownership filter post-fix. |
| C7 | Rename live update + persistence | YELLOW | Rename UI flow works (input → Enter → row updates immediately). Persists across reload **inside the same gateway container's lifetime**. Lost on container recreate because the title-store path `~/.sentient/gateway/users/...` resolves inside-container to `/root/.sentient/gateway/users` (not volume-mounted in `deploy/macos/docker-compose.yml`). Pre-existing deploy issue, NOT ACP-related. |
| C8 | Delete current session clears chat pane | GREEN | Click delete on the active session row → row disappears, chat pane resets to "Start a conversation...", gateway emits `session.created + session.switched + conversation.snapshot[]` per the post-delete-newchat code path. |
| C9 | Delete non-current session | GREEN | Drawer drops from 9→8 rows; chat pane unaffected. |
| C10 | Tool call streaming (HA) | DEFERRED | Was blocked by C1's LLM bug. Unblocked post-F5 fix; not yet re-run — flag for next smoke pass. |
| C11 | `/personality` slash command | DEFERRED | Was blocked by C1 (`commands.available` is only emitted after `cycle.started`; no cycle could fire). Unblocked post-F5 fix; not yet re-run — flag for next smoke pass. Wire path was already exercised when C1 errored — `commands.available` arrived in the same cycle log. |
| C12 | Barge-in | OUT-OF-SCOPE | Real mic input — not driveable via Playwright. Flagged for operator follow-up. |
| C13 | UI Stop / interrupt | DEFERRED | Was blocked by C1 — needed active cycle to interrupt. Unblocked post-F5 fix; not yet re-run — flag for next smoke pass. |
| C14 | Cross-tab sync (rename) | YELLOW | Rename in tab B persists in tab B and survives reload in tab A. Live broadcast (without reload) does not propagate — tab A's WS goes stale (`acp-wire-bootstrap.send: WS not open`) the moment a second tab connects to the same profile. Pre-existing single-WS-per-profile pattern; not introduced by ACP wire. Note for follow-up. |
| C15 | Drawer empty state | DEFERRED | Profile `u_8c866990` has 8+ sessions; would need a fresh-user setup to verify the empty-state copy. Out of scope for an ACP-wire smoke. |
| C16 | Drawer-empty regression repro | GREEN | Drawer renders 8-9 rows reliably on every fresh load (post-F4 + F5 list fix). Originally the P0 from past-sessions todo, now confirmed not reproducing on ACP. |
| C17 | Long conversation + 1-shot auto-title | DEFERRED | Was blocked by C1. Unblocked post-F5 fix; not yet re-run — flag for next smoke pass. C1's auto-title is now confirmed working. |
| C18 | Hermes worker restart, gateway reconnects | GREEN | `supervisorctl restart hermes-u_8c866990-acp` → drawer reload still returns sessions (per-WS-session ACP wire re-bootstraps cleanly on the next user message / drawer-open). |
| C19 | Network blip — close/reopen tab | GREEN | Reload of `https://localhost:8888` resumes the same `sessionId` (read from `sessionStorage.sentient.currentSessionId`), `getMessages` rehydrates history. |
| C20 | 100+ sessions in drawer | YELLOW | Pagination contract is correct — `sessions.list.result.hasMore` reflects whether ACP returned a `nextCursor`. Profile only has 8 sessions; the 100+ stress is not exercised end-to-end. Cursor mechanics tested in unit tests only. |

**Tally (post-F5 fix):** 10 GREEN (C1 promoted), 3 YELLOW, 6 DEFERRED (5 unblocked but not yet re-run + 1 fresh-user setup), 1 OUT-OF-SCOPE.

### F5 fix — empty model under `hermes -p X acp` was a stale rendered-config bug, not upstream-Hermes

Symptom: every prompt under the ACP child returned
```
API call failed after 3 retries: HTTP 404: model "" not found | provider=ollama-cloud model=
```
even though `hermes -p u_8c866990 config show` correctly resolved the model.

Root cause (corrected): the profile-renderer templates (`gateway/templates/profile/model.*.tmpl`) emit `default: {{model_id}}` because ACP's `acp_adapter/session.py:_make_agent` reads `model_cfg.get("default")` only. But the user's on-disk rendered config (`~/.sentient/gateway/data/u_8c866990/profiles/u_8c866990/config.yaml`) was generated by an older template version that emitted `model: {{model_id}}`. ACP read the new key and got `None`; Hermes then dispatched the LLM call with `"model": ""`. The CLI `config show` worked because that read-path tolerates both keys; ACP does not. The earlier upstream-Hermes diagnosis (gateway/run.py path mismatch) was wrong — the file in question was being read fine, just had the wrong key.

Fix:
- One-shot edit of the on-disk config, replacing the stale inner `model:` key with `default:`.
- `gateway/src/admin/boot-migration.ts#renderConfigsForExistingUsers` — new boot-time pass that iterates every user via `userStore.list()` and calls `renderAndWrite(applyDeps, userId)` per user. Idempotent (atomic-write of byte-identical content is a no-op). Wired into `gateway/src/bootstrap/phase-services.ts` BEFORE `renderProgramsForExistingUsers` so the supervisord program upsert sees the latest provider. The renderer is a pure function of (template, profile, mcp_catalog), so this pass forces the on-disk config to track template changes — no manual migration step needed for future schema bumps.
- ACP re-reads the profile config on each `_make_agent` call, so re-rendering on boot fixes the next dispatch without a worker restart.

Tests: `gateway/src/admin/boot-migration.test.ts` — three new cases pin no-users, render-all-users, and continue-past-per-user-failure. Existing renderer unit tests (`profile-renderer.test.ts`) already pin the `default:` template output for ollama-cloud + openrouter + custom; together they cover the legacy → current migration path.

### Container/build outcomes

- `sentient/hermes:local` — rebuilt against `HERMES_VERSION=v2026.4.23`. Plugin baked at `/opt/hermes/plugins/sentient-plugin/dashboard/` (`manifest.json`, `dist/index.js`, `plugin_api.py`, `test_plugin_api.py`).
- `sentient/gateway:local` — rebuilt three times during the run (initial, post-list-fix, post-search-fix). Final image carries both fixes.
- All 7 containers up + healthy: gateway, hermes, stt-service, ha-mcp, ma-mcp, ddg-mcp, egress-proxy.

### Per-profile supervisord shape

```
$ docker exec sentient-hermes supervisorctl status
hermes-u_8c866990-acp            RUNNING   pid 139, uptime 0:00:06
hermes-u_8c866990-dashboard      RUNNING   pid 18,  uptime 0:04:11
```

Both programs running per profile as F3 designed. The dashboard sidecar serves `/api/plugins/sentient-plugin/{search, sessions/{id}, sessions/{id}/messages}` — verified directly via `urllib` from inside the hermes container with the `SENTIENT_HERMES_BEARER` token.

### Bottom line for Phase 5 (post-F5 fix)

- **Wire green:** ACP `session/new`, `session/list`, `session/load`, `session/prompt`, `session/cancel`, plus plugin REST for search/delete/get/getMessages all work. Drawer-empty regression doesn't reproduce.
- **LLM green:** C1 retry post-fix delivers a real assistant response and a real auto-title. The earlier 404 was a stale-config bug, not upstream Hermes. Boot-time re-render pass prevents recurrence on future template bumps.
- **Recommendation:** Phase 6 Pi rollout no longer gated on the LLM bug. Suggest a follow-up smoke pass to actually run C3, C10, C11, C13, C17 (now unblocked). Phase 7 (legacy `sentient_gateway.py` retirement) safe to plan; the legacy REST surface is fully replaced by plugin sidecar + ACP wire.

### Confirmation: Pi was NOT touched

All F5 work happened on the Mac local stack (`deploy/macos/docker-compose.yml`) and the repo. Pi `hacore.lan` was not contacted, not deployed to, not even pinged.

---

## Original BLOCKED report (pre-F1-F4)

**Status: BLOCKED.** Phase 5 cutover landed image + supervisord template changes cleanly, but smoke immediately hit two systemic gaps in the Phase 4 gateway wiring that prevent any green case. Stopping per the runbook (`If multiple cases are red AND it looks like a systemic issue: STOP, report BLOCKED with diagnosis`).

## Stack version

- Image: `sentient/hermes:local` rebuilt from `HERMES_VERSION=v2026.4.23` (overlay tag pinned in `deploy/hermes-overlay/HERMES_VERSION`).
- Gateway image: `sentient/gateway:local` rebuilt from `feature/acp-pivot` HEAD with `gateway/config.yaml#use_acp_wire: true` (flipped locally only — reverted before commit; the smoke run validated the flag).
- Profile: `u_8c866990` (Kevin), PIN `1234`.
- All 7 containers up + healthy: gateway, hermes (supervisord spawning `acp_ws_server.py`), stt-service, ha-mcp, ma-mcp, ddg-mcp, egress-proxy.

## Phase 5 changes that DID land cleanly

- `gateway/templates/program/program.conf.tmpl` — supervisord per-profile program now spawns `/opt/hermes/.venv/bin/python /opt/hermes-overlay/acp_ws_server.py --profile {{userId}} --port {{port}} --hermes-home {{hermesHome}}` instead of `hermes -p {{userId}} gateway run`. Token env var renamed from `SENTIENT_GATEWAY_TOKEN` to `SENTIENT_HERMES_BEARER` (acp_ws_server validates the bearer under that name).
- `deploy/hermes-overlay/Dockerfile` — comment updated to reflect Phase 5 supervision shape.
- `sentient/hermes:local` rebuilt clean against the pinned upstream `nousresearch/hermes-agent:v2026.4.23`. Verified `acp_ws_server.py` resides at `/opt/hermes-overlay/` and runs end-to-end (`Starting acp_ws_server profile=u_8c866990 port=8650`).
- Gateway rebuilt + restarted; on boot, `renderProgramsForExistingUsers` rewrote `/data/supervisor/programs/u_8c866990.conf` to the new ACP command. Supervisord re-read + restarted the program. New process started clean — no python import errors, no aiohttp failure.
- ACP wire-bootstrap log trail confirmed working when a browser WS opens: `bootstrap.begin → initialize.begin → initialize.done → bootstrap.done → acp-wire-bootstrap-ok`. The new `/acp` endpoint terminates the WS and the per-profile-connection's `initialize` handshake completes within ~600ms.

## Findings

### F1 — Gateway never invokes ACP `session/new`; first `session/prompt` 404s with "session not found"

**Severity:** BLOCKER for C1 (and every case that sends a fresh-chat message).

**Repro:** Open `https://localhost:8888`, log in (already authed), type "Hello — what is 2 plus 2?", Enter. User bubble renders. No assistant response — ever.

**Trace:**

- Gateway (`sentient-gateway`):
  - `[hermes-adapter-client:acp:per-profile-connection] cycle.start | cycleId="2" sessionId="cycle-1"`
  - `[hermes-adapter-client:acp:per-profile-connection] cycle.done | cycleId="2" stopReason="refusal"`
  - `[cerebrum:hermes-event-translator] done | sawError=false eventCount=2 assistantChars=0 elapsedMs=38`
- Hermes (`/Users/kevinye/.sentient/gateway/data/u_8c866990/supervisord.err.log`):
  - `2026-05-07 20:49:17 [ERROR] acp_adapter.server: prompt: session cycle-1 not found`

**Root cause:** `gateway/src/hermes-adapter-client/acp/acp-hermes-client.ts:144` builds the ACP `session/prompt` request with

    sessionId: input.forcedSessionId ?? input.conversationId ?? input.cycleId

For a fresh chat there's no `forcedSessionId` and no `conversationId`, so it falls back to `cycleId` (`"cycle-1"`). Hermes' ACP server has never seen that id because the gateway never called `session/new`. The legacy custom-WS contract creates the session implicitly on the first `user.message`; ACP requires an explicit `session/new` (or `session/load`) before any `session/prompt`. `acpConn.newSession()` exists in `per-profile-connection.ts:146` but no production code path outside tests invokes it.

The Phase 4 plan (Task 4.7) names this gap explicitly: *"Replace per-profile-connection consumer with acpConn; replace sessionsClient.list() with listSessionsViaAcp(acpConn). ... wire into existing handlers (sessions-handlers, switch-flow, etc.)"* — only the wire-bootstrap landed.

### F2 — Sessions REST endpoints (`/api/sessions/*`) all 404 under ACP — drawer empty, search/delete/get/getMessages broken

**Severity:** BLOCKER for C2, C3, C4, C6, C7, C8, C9, C16, C17, C20 (any case that touches the past-sessions drawer).

**Repro:** Open the app, click Past chats (drawer). Drawer shows "Couldn't load sessions — try again." (the prior session for u_8c866990 has 13 sessions on disk under `~/.sentient/gateway/data/u_8c866990/profiles/u_8c866990/sessions/`).

**Trace:**

- Browser console: `[sentient.webui.use-sessions] sessions.load.failed {reason: internal: GET /api/sessions?limit=50&offset=0&source=sentient-user -> 404}`
- Hermes access log: `GET /api/sessions?limit=50&offset=0&source=sentient-user HTTP/1.1" 404 174 "Bun/1.3.13"`
- Gateway log (background pool dialing legacy `/ws` path, also 404): `ws.error → ws.close code=1002 reason="Expected 101 status code"` on a steady 4 s reconnect cadence.

**Root cause:** `acp_ws_server.py` mounts only `/healthz` and `/acp`. The legacy Hermes process previously co-hosted `/api/sessions/*` (commit `13b3eb3` briefly added them, `b13f8bb` reverted). Phase 4 designed `listSessionsViaAcp` (in `gateway/src/hermes-adapter-client/sessions-client.ts:183`) as the ACP replacement, but `gateway/src/session-handlers/sessions-handlers.ts:87` still calls `cfg.client.list(...)` against the REST `createHermesSessionsClient`. `listSessionsViaAcp` is only used inside a helper called `profileSessionsLookup` (used for ownership filtering during search/delete), not for the user-facing list. Same gap for `search`, `delete`, `get`, `getMessages` — all five REST methods route to a server that doesn't speak HTTP for those paths.

In addition, `switchFlow.fetchHistory` (`gateway/src/session-handlers/ws-session-configure.ts:586`) calls `sessionsClient.getMessages(targetSessionId)` — also REST, also 404. Means session resume via `?session_id=` (C4) and mid-cycle switch (C3) cannot rehydrate history.

## Results matrix

| # | Case | Desktop | Mobile | Evidence | Notes |
|---|---|---|---|---|---|
| C1 | First message + auto-title | FAIL | NOT RUN | `.playwright-mcp/acp-pivot/C1-desktop-no-assistant-response.png`, `C1-desktop-console.log`, `C1-desktop-network.log`, `C1-desktop-gateway.log`, `C1-desktop-hermes-stderr.log` | F1 — `session/prompt` 404 "session cycle-1 not found"; F2 — drawer 404 |
| C2–C20 | Resume / mid-cycle switch / reconnect / mobile / search / rename / delete / tools / slash / barge-in / interrupt / cross-tab / empty / regression / long / restart / blip / pagination | NOT RUN | NOT RUN | — | Stopped after C1 due to systemic blocker per Phase 5 runbook |

## Failures

### C1 — first message + auto-title (RED)

- User message renders.
- No assistant response. cycle ends with `stopReason="refusal"` after ~40 ms — well before any LLM call could have taken place.
- Drawer shows error: "Couldn't load sessions — try again."
- Hermes ACP server logs `prompt: session cycle-1 not found`.

Both F1 and F2 hit at the same time on this single case.

## Deferred (cannot test via Playwright)

- C12 barge-in (mic onset during TTS) — needs real mic audio; would have been deferred regardless. Not relevant given F1/F2 already block any TTS playback.

## Diagnosis summary

The Phase 5 cutover (overlay image + supervisord template) is technically correct and lands cleanly. The new ACP wire-bootstrap path connects to `acp_ws_server.py`'s `/acp` endpoint, completes `initialize`, and the `acpConn` handle reaches `ws-session-configure` as designed. What's missing is the rest of Phase 4's gateway-side rewiring:

1. **Sessions handler not on ACP.** `gateway/src/session-handlers/sessions-handlers.ts` still uses `createHermesSessionsClient` (REST). `listSessionsViaAcp` exists but is only called from a tangential ownership-filter helper.
2. **Switch-flow history fetch not on ACP.** `switchFlow.fetchHistory` in `ws-session-configure.ts` still calls REST `getMessages`. ACP has `session/load` but no equivalent of fetching message history that the gateway wires up.
3. **No `session/new` on first prompt.** `acp-hermes-client.ts` falls through to `cycleId` as the ACP `sessionId` when no forced/captured id exists. There is no code path in production that calls `acpConn.newSession()` before the first `sendUserMessage`.
4. **REST endpoints on `acp_ws_server.py` are absent.** Even if (1) and (2) were rewired, the gateway-side sessions client baseUrl points at the same per-profile port — and `acp_ws_server.py` only serves `/healthz` and `/acp`. The previous attempt to mount Hermes REST inline (commit `13b3eb3`) was reverted with the preview-drop refactor.

These are not bugs in the smoke environment — they are the same gaps that would surface on the Pi. The Phase 5 plan assumed Phase 4 completed all consumer rewiring; it did not.

## Recommended path forward

These are NOT trivial 1-2 line fixes. Each warrants its own task with spec/quality review per the skill discipline (per Phase 5 T5.7 instruction):

- **Fix-A — `session/new` on fresh chat.** When `acp-hermes-client.dispatch` has no `forcedSessionId` AND no `conversationId`, call `acpConn.newSession({})` first and use the returned `sessionId`. Capture it as the new `conversationId` in the binding so subsequent turns reuse it. Decide what happens on session.new from the WS handler (`sessions-handlers.ts` mints a new session id today via `generateSessionId()` — that custom id needs to be passed to ACP via `sessionId` in `session/new` if upstream allows, or replaced with the ACP-minted id).
- **Fix-B — Sessions handler on ACP.** Rewire `sessions-handlers.ts` so when `acpConn !== null`, list/search use ACP `session/list` (with title filter for search) and the relevant ACP methods for delete (`session/delete`?). Confirm against the upstream ACP method list whether all four user-facing ops have ACP equivalents — for any that don't, decide between (a) re-add minimal REST to `acp_ws_server.py`, or (b) defer to local title store / accept a feature regression.
- **Fix-C — `switchFlow.fetchHistory` via ACP.** Use `session/load` to get history when `acpConn !== null`. Confirm `session/load` returns the message log in the format the gateway translator expects.

Each fix needs its own spec review BEFORE coding. Forge ahead only after approval.

## Next steps

- **Phase 6 Pi rollout:** DEFERRED per user directive. Pi was NOT touched during this run.
- **Phase 7 cleanup (`sentient_gateway.py` retirement):** Stays in scope only AFTER Phase 5 actually goes green. Cannot retire the legacy adapter while the gateway still depends on its REST endpoints.
- **Confirmation: Pi (`hacore.lan`) was NOT touched at any point during Phase 5. All work happened on the Mac local stack and the repo.**
