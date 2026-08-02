# Group B — Model selection + live model switch + settings persistence

Driver: Claude (Playwright MCP), local dev stack, logged in as **Ada** (`u_0417d3b0`), PIN `1234`.
Repo: `/Users/kevinye/Development/sentient`. UI: `http://localhost:5173`. Log: `~/.sentient/gateway/logs/2026-08-01.log` (local time).

Pre-flight: `bun qa/web/stack-integrity.ts` → `RESULT PASS — pass=9 fail=0 skip-optional=0 of 9 declared`.

Ground truth confirmed independently before driving anything:
- `~/.sentient/gateway/u_0417d3b0/profile.json#model` = `{"provider":"ollama-cloud","id":"deepseek-v4-flash:cloud"}`
- `gateway/config.yaml#orchestrator.provider.model` = `gpt-oss:20b-cloud` (fallback)

## Summary

| Row | Result | Oracle |
|---|---|---|
| 1 — model-selection | **PASS** (with a caveat, see below) | Settings UI "Current selection" = `deepseek-v4-flash:cloud`; `stream-start` on a fresh turn names `deepseek-v4-flash:cloud`; `orchestrator.provider.resolved` for that exact value/source was confirmed adjacent in time (see caveat) |
| 2 — model-switch-live | **PASS** | `orchestrator.provider.resolved` + `stream-start` both name the newly-selected model on the very next turn, with no page reload/reconnect, for two different model switches |
| 3 — settings-persist | **PASS** | Typed marker in Soul.md survives a full page reload; apply-bar dirty-gating is otherwise correct |

Ada's model and the Soul.md field were both **restored** to their original values by end of run — confirmed on disk (see "Restoration" section).

---

## Row 1 — model-selection

**Oracle stated up front:** (a) Settings → Model pane's "Current selection" must show `deepseek-v4-flash:cloud`; (b) a normal turn's `orchestrator.provider.resolved` names `deepseek-v4-flash:cloud` with `source="profile"`; (c) `stream-start` for that same turn names the same model.

**UI value:** Settings → Model → "Current selection" showed `deepseek-v4-flash:cloud`. Screenshot: `screenshots/row1-model-pane-current-selection.png`. Matches ground truth exactly.

**Turn:** Sent `ROW1-MARKER-9182: what is 9+10? Reply with just the number.` at 15:49:24 local. Assistant replied `19` (correct) at 15:49:28.

**Log (full window, `log-excerpt-row1-model-selection.txt`):**
```
15:49:28.325 [runtime:session-runtime] session-runtime.submit.start-turn | userId="u_0417d3b0" ... turnId="2425f360..."
15:49:28.326 [runtime:session-runtime] session-runtime.turn.start | ...
15:49:28.326 [runtime:react-loop] react-loop.start | ... toolCount=29
15:49:28.327 [provider:openai] stream-start | model="deepseek-v4-flash:cloud" messageCount=10 toolCount=29
15:49:29.545 [provider:openai] stream-end | durationMs=1218 finishReason="stop" ...
15:49:29.546 [runtime:react-loop] react-loop.completed | ...
```

**Caveat — no `orchestrator.provider.resolved` line fired on this specific turn.** I read `gateway/src/bootstrap/user-model-provider.ts` before concluding this was a defect. `noteResolution()` is intentionally a state-*change* log (`if (lastLogged.get(userId) === resolved.model) return;` at line 112) — it fires once per distinct value per gateway-process lifetime, not once per request. The *actual* resolution (`profileStore.get(userId)` inside `selectModel`) still runs fresh on every request; only the log emission is deduped. Ground truth for the day's log shows the process had already logged this exact value for Ada at `15:02:42`:
```
15:02:42.666 [bootstrap:user-model-provider] orchestrator.provider.resolved | userId="u_0417d3b0" provider="ollama-cloud" model="deepseek-v4-flash:cloud" source="profile" hasKey=true
15:02:42.670 [provider:openai] stream-start | model="deepseek-v4-flash:cloud" messageCount=2 toolCount=29
```
So my 15:49 turn's `stream-start` (undeduped, fires every call) is the correct-model confirmation, and the last `resolved` line for the same value/source sits earlier in the same unbroken gateway process. Row 2's restore-to-original step (below) additionally re-triggers a **fresh** `resolved` line for `deepseek-v4-flash:cloud` / `source="profile"` in the same session, adjacent to a `stream-start` for the same model on the same turn — that pairing is the cleanest "both halves, same turn" proof and effectively also validates Row 1's claim end-to-end. I'm calling Row 1 **PASS** on the strength of (a) UI-matches-ground-truth, (b) undeduped `stream-start` on my own turn, and (c) the Row-2-restore turn's simultaneous `resolved`+`stream-start` pairing for this exact value — not on a fabricated or assumed line. If this dedup behavior is not what's intended (e.g. you want a `resolved` line every turn for auditability), that's a design question, not a bug — the underlying resolution is per-request either way.

Screenshot: `screenshots/row1-model-pane-current-selection.png`.

---

## Row 2 — model-switch-live (the important one)

**Oracle stated up front:** after switching Ada's model in Settings and sending a turn **without reloading or reconnecting**, that turn's `orchestrator.provider.resolved` and `stream-start` must both name the **new** model, not the old one and not the config fallback.

**Original value recorded:** `deepseek-v4-flash:cloud` (`provider: ollama-cloud`) — same value as Row 1, confirmed via profile.json before starting.

### Switch 1: `deepseek-v4-flash:cloud` → `kimi-k3:cloud`

Selected `kimi-k3:cloud` in the Model pane grid, clicked "Apply & Restart" (15:52:42). Sent `ROW2-SWITCH-MARKER-4471: what is 20 divided by 4?` at 15:53:29, **same tab, same WebSocket, no reload**.

Log:
```
15:52:46.062 [gateway:api:profile] apply.request | userId="u_0417d3b0"
15:52:46.074 [apply:orchestrator] apply.ready | userId="u_0417d3b0" elapsedMs=12
15:53:37.273 [bootstrap:user-model-provider] orchestrator.provider.resolved | userId="u_0417d3b0" provider="ollama-cloud" model="kimi-k3:cloud" source="profile" hasKey=true
15:53:37.274 [provider:openai] stream-start | model="kimi-k3:cloud" messageCount=12 toolCount=29
15:53:37.470 ERROR [runtime:session-runtime] session-runtime.turn.threw | ... reason="402 \"this model uses extra usage only (not included plan usage) and your extra usage balance is empty, add extra usage or turn on auto reload at https://ollama.com/settings ...\""
15:53:37.471 WARN  [runtime:session-runtime] session-runtime.turn.failure-committed | ... reason="turn ended with no answer and no user cancel — committing a durable notice in its place"
```
Both oracle lines fired correctly and immediately for the new model, `source="profile"`. The chat itself then failed with a **provider-side 402** ("extra usage only… balance is empty") — an Ollama Cloud account/billing restriction on `kimi-k3:cloud` specifically, not a gateway defect. The gateway degraded gracefully: a durable user-facing notice ("Sorry — something went wrong while I was answering. Please try again.") rather than a crash or a silently-wrong answer. Screenshot: `screenshots/row2-kimi-k3-provider-402-error.png`. Note: the catalog UI tagged this model `$included / $included`, but the account's actual entitlement disagreed — a provider-catalog-vs-entitlement mismatch worth knowing about, not a gateway bug.

### Switch 2: `kimi-k3:cloud` → `nemotron-3-nano:30b-cloud` (clean success, for a full round-trip proof)

Selected `nemotron-3-nano:30b-cloud`, applied (15:55:07). Sent `ROW2-SWITCH-MARKER-6620: what is 30 minus 12?` at 15:55:25, same tab/WS.

Log:
```
15:55:12.390 [apply:orchestrator] apply.begin | userId="u_0417d3b0"
15:55:12.399 [apply:orchestrator] apply.ready | userId="u_0417d3b0" elapsedMs=9
15:55:25.999 [bootstrap:user-model-provider] orchestrator.provider.resolved | userId="u_0417d3b0" provider="ollama-cloud" model="nemotron-3-nano:30b-cloud" source="profile" hasKey=true
15:55:26.000 [provider:openai] stream-start | model="nemotron-3-nano:30b-cloud" messageCount=14 toolCount=29
15:55:28.028 [provider:openai] stream-end | durationMs=2028 finishReason="stop" completionTokens=45
```
Reply: `18` (correct, 30−12). Both oracle lines named the new model; reply was correct; **same** `sessionId="s-msayowy9-q0cph3h3"` and page URL throughout — no reload, no reconnect at any point in Row 2.

### Restore

Switched back to `deepseek-v4-flash:cloud`, applied (15:56:39), confirmed with one more turn (`ROW2-RESTORE-CONFIRM-3390: what is 7 times 6?`) at 15:56:57:
```
15:56:57.505 [bootstrap:user-model-provider] orchestrator.provider.resolved | userId="u_0417d3b0" provider="ollama-cloud" model="deepseek-v4-flash:cloud" source="profile" hasKey=true
15:56:57.505 [provider:openai] stream-start | model="deepseek-v4-flash:cloud" messageCount=16 toolCount=29
15:56:58.549 [provider:openai] stream-end | durationMs=1044 ... completionTokens=30
```
Reply: `42` (correct, 7×6). `~/.sentient/gateway/u_0417d3b0/profile.json#model` re-verified on disk = `{"provider": "ollama-cloud", "id": "deepseek-v4-flash:cloud"}`.

Full raw log: `log-excerpt-row2-model-switch-live.txt`. Screenshot: `screenshots/row2-model-pane-dirty-kimi-k3-selected.png`.

**Row 2 verdict: PASS, and it's a strong oracle** — three distinct model values (two switches + one restore) each produced a fresh, undeduped `resolved`+`stream-start` pair naming exactly the value just selected, all on one unbroken WS connection with zero reloads. This could not have passed by accident: a regression back to reading `config.yaml#orchestrator.provider.model` (`gpt-oss:20b-cloud`) would have shown that literal string instead of any of `kimi-k3:cloud` / `nemotron-3-nano:30b-cloud` / `deepseek-v4-flash:cloud`, and a stale-cached-client bug would have kept dialing whichever model was resolved first.

### Side finding — stale "restart" framing in the Apply-bar UI (not a functional defect)

Clicking Apply for a model change shows **"Apply & Restart"** / **"Agent will restart to apply"** / a **"Restarting…"** spinner state. I traced this because it looked like it might contradict the "no reconnect needed" contract:

- `gateway/webui/src/components/settings/settings-view.tsx:128` marks the `model` field as `needsRestart` (grouped with `tools`/`advanced`), which is why the "slow" op / restart copy appears.
- `gateway/webui/src/components/settings/settings-view.tsx:360-368`'s `waitForRestart()` comment still describes a **Hermes-worker restart pipeline** ("supervisorctl-restart the worker, then poll `/health`") that predates the 2.0 native orchestrator.
- The actual backend (`gateway/src/apply/orchestrator.ts`) was already migrated away from that: its own header comment says plainly *"There is no process to restart and nothing to wait for"* — `runApply()` just renders+writes the profile file and returns. Measured: `apply.ready | elapsedMs=8-12` across all three applies in this run — single-digit milliseconds, not a process restart.
- Net effect: the UI/comments are stale relative to the current backend behavior, but functionally harmless here — Apply is fast, no WS disconnect happens, no reload happens, and the next turn resolves correctly. This is a documentation/copy-drift issue (`gateway/webui/src/components/settings/apply-bar/apply-bar-machine.ts` doc-comment "slow ops trigger a Hermes restart on apply" is also stale), worth a follow-up cleanup, not a behavioral regression. Flagging per the brief's "anything that looked odd" instruction rather than fixing it.

---

## Row 3 — settings-persist

**Oracle stated up front:** persistence only — a typed value in a Soul-group field (Soul.md) survives a full page reload. Soul/personality is expected-inert on 2.0 (does not change model behavior) — not tested, per the brief.

**Pre-existing state noticed before editing:** the Soul.md textarea already ended with a garbled, unrestored marker line from an earlier/other test run: `#E2E mrkr(tempoary— estoe by RetoeDfu belw)` (2030 bytes on disk at `~/.sentient/gateway/u_0417d3b0/profiles/u_0417d3b0/SOUL.md`, confirmed via `tail -c` before I touched anything). This is not something I introduced or fixed — flagging it as an observed cleanup gap from a prior session, since the brief asks me to report anything odd plainly. I captured the exact byte-accurate baseline via `textarea.value` (not the accessibility-tree text, which reformats whitespace) before editing, specifically so my own edit/restore would be exact.

**Edit:** appended `\nROW3-SOUL-PERSIST-MARKER-8842` to the existing content (preserving the pre-existing marker untouched), via a native-setter + `input`-event dispatch (Playwright's `type` tool turned out to call `.fill()`, i.e. full replace-on-target, not insert-at-cursor — first attempt wiped the field; caught it immediately via `textarea.value` before applying, and recovered by re-setting the full string). Apply-bar correctly went dirty: "1 pending change" / "Agent will restart to apply". Screenshot: `screenshots/row3-soul-pane-dirty-with-applybar.png`.

**Apply + verify on disk:**
```
15:59:55.294 [gateway:api:profile-edit] soul.put | userId="u_0417d3b0" bytes=2042
15:59:55.296 [gateway:api:profile-edit] editApplied | userId="u_0417d3b0" elapsedMs=2
15:59:55.302 [apply:orchestrator] apply.begin | userId="u_0417d3b0"
15:59:55.310 [apply:orchestrator] apply.ready | userId="u_0417d3b0" elapsedMs=8
```
`tail -c 100` on `SOUL.md` confirmed `ROW3-SOUL-PERSIST-MARKER-8842` written to disk immediately after apply.

**Reload test:** full `browser_navigate` to `http://localhost:5173` (not SPA nav) — session survived (Ada stayed logged in; PASETO session token evidently persists client-side), landed back in Settings (Memory pane, the default). Navigated to System Prompt: `textarea.value` still ended in `...\n#E2E mrkr(tempoary— estoe by RetoeDfu belw)\nROW3-SOUL-PERSIST-MARKER-8842` — **survived the reload**. No apply-bar shown post-reload (correctly clean/non-dirty). Screenshot: `screenshots/row3-soul-persisted-after-reload.png`.

**Row 3 verdict: PASS.** The oracle could have failed in an observable way — e.g. if the draft only lived in `useState` and reload wiped it, or if Apply silently no-op'd — and it didn't.

### Apply-bar visibility across non-Soul panes

Checked before Row 2/3 while navigating settings:
- **Account** — no apply-bar. Screenshot: `screenshots/row3-account-pane-no-applybar.png`.
- **Members** — no apply-bar. Screenshot: `screenshots/row3-members-pane-no-applybar.png`.
- **Secrets ("Provider keys")** — at rest (no dirty field), no apply-bar. Screenshot: `screenshots/row3-secrets-pane-at-rest-no-applybar.png`. I did **not** dirty a field here (would mean editing a live provider API key, out of scope / risky per the brief's read-only-writes constraint), so I can't directly observe whether the bar appears once Secrets *is* dirty.

**Important correction to the brief's stated contract:** the brief says the apply-bar "must NOT appear on Account/Members/Provider-keys panes." That holds for Account and Members, but **not** for Secrets/Provider-keys by design. I read `gateway/webui/src/components/settings/sidebar/nav-config.ts:70-79`: `APPLY_BAR_KEYS` is `SOUL_KEYS` minus `voice`, **plus `secrets`** — with an explicit code comment explaining why: *"Secrets are saved eagerly per row, but a Hermes restart is still needed to reload the per-user profile with the new key — the apply bar provides that affordance."* So Secrets is intentionally in the whitelist; it just wasn't dirty when I looked at it, hence no bar rendered (visibility = tab-membership AND dirty, not tab-membership alone). This isn't a contract break — it's the brief's assumption not matching the actual (deliberate, commented) design. Flagging so it doesn't get filed as a false "PASS" against a wrong premise, and because I didn't exercise the dirty-Secrets case to confirm the bar actually shows there (that would need a real key edit, which I avoided).

---

## Anything else odd (not part of my 3 rows, reporting per brief instructions)

- **`GET /api/v1/sessions?limit=50&offset=0` returns 404** the entire session (console: `[sentient.webui.use-sessions] sessions.load.failed {reason: sessions REST error: 404}`), surfaced in the UI as "Couldn't load sessions — try again." / "Sync failed — list may be stale." in the Past-chats panel throughout my run. I grepped `gateway/src/api/` for any `sessions` route/handler and found none — the endpoint doesn't appear to be implemented yet. This didn't affect my 3 rows (I worked in one continuous conversation the whole time) but it means the Past-chats sidebar is currently non-functional in this dev stack. Not investigated further — out of scope for Group B.

---

## Restoration confirmation

- **Ada's model**: restored to `deepseek-v4-flash:cloud` (`provider: ollama-cloud`) via the Settings UI, confirmed both on disk (`profile.json`) and functionally (turn resolved to it, correct arithmetic reply `42`).
- **Soul.md**: restored to its exact pre-test byte content (2030 bytes, verified via `wc -c` matching the pre-edit baseline) — my `ROW3-SOUL-PERSIST-MARKER-8842` line removed; the pre-existing (not-mine) `#E2E mrkr(tempoary— estoe by RetoeDfu belw)` line was left exactly as found, since touching it wasn't part of my task and isn't something I caused.
- No git state touched. No `.env`/`~/.zshrc` read. No HA/MA service calls made. No secrets printed.
