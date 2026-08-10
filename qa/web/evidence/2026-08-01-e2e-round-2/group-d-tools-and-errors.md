# Group D — tools-breadth / tool-error-path / tool-server-down

Driver: agent session, local dev stack. Repo root `/Users/kevinye/Development/sentient`.
User: **Ada** (already authenticated in the shared browser session from prior groups; PIN not
re-entered — session cookie was live). Model in use per gateway logs: `deepseek-v4-flash:cloud`.

Pre-flight: `bun qa/web/stack-integrity.ts` → `RESULT PASS — pass=9 fail=0 skip-optional=0 of 9
declared` (16:20 local, before driving; re-confirmed `RESULT PASS` at the end, see Row 3).

All driving happened in the existing "Today" conversation (the past-chats drawer was showing
"Couldn't load sessions" / "Sync failed — list may be stale" both times I tried to open a
genuinely fresh chat — see **Odd, unresolved** below — so I stayed in the live conversation and
used wall-clock timestamps + `sessionId` to scope every log grep to my own turns).

## Result summary

| Row | Verdict | Oracle |
|---|---|---|
| 1 — tools-breadth | **PARTIAL** — 7/9 newly-driven tools PASS content oracle; 1 (`ha_get_history`) is a confirmed FAIL; 1 (`ha_search_entities`) is UNREACHABLE by design defect, not by my failure to drive it | Log `isError=false` on both `mcp.call-tool.ok` + `tool-broker.dispatch.foreground.done`, AND reply content cross-checked against `bun qa/web/tool-truth.ts` |
| 2 — tool-error-path | **PASS** | Reply states the failure honestly ("Doesn't exist — Home Assistant returned a 404"), log shows honest `isError=true`, turn reached a real final answer in 2 iterations |
| 3 — tool-server-down | **FAIL** (the searxng dependency itself self-healed in ~15s both times, which is good — but the one turn that landed *during* the outage window got a confident, uncited, confabulated answer, not an honest "couldn't search") | `search_web`'s own gateway log line vs. the searxng-mcp container's own stderr vs. `tool-truth.ts` dialed directly at the same failure — three independent views of the same 131-byte payload |

Stack restored and re-verified: `bun qa/web/stack-integrity.ts` → `RESULT PASS` at the end. **The
stack was NOT left degraded** — both searxng containers self-healed inside ~15s on both of the two
times I stopped `sentient-searxng`, well under the brief's 90s budget; I did not need to
`docker start` it myself.

---

## Row 1 — tools-breadth

### Oracle stated up front

For each tool: (1) `isError=false` on both `mcp.call-tool.ok` and
`tool-broker.dispatch.foreground.done` in `~/.sentient/gateway/logs/2026-08-01.log`, grepped from
the exact `date "+%H:%M:%S"` I sent the message; AND (2) the reply's claimed content matches
ground truth from `bun qa/web/tool-truth.ts <server> <tool> '<args>'`, which dials the MCP server
directly — a different path than the ReAct loop / ToolBroker / PDP under test.

### Coverage achieved this round (new, content-oracle confirmed)

| Tool | Ask | Log | tool-truth cross-check | Verdict |
|---|---|---|---|---|
| `ha_get_overview` | "Give me a full overview of our Home Assistant smart home setup..." | `isError=false contentLength=13268` (chat) | `total_entities:211, total_domains:26, total_areas:16, version:"2026.4.4"` — matches "211 entities across 26 domains, spread over 16 areas… HA 2026.4.4" exactly | **PASS** |
| `ha_eval_template` | Driven 4× across different asks (thermostat name search, litter-robot search, calendar-entity check, zone.home coordinates) | all `isError=false` | Reproduced the model's own thermostat-list template (`states.climate \| selectattr("name","search","(?i)thermostat")...`) → **identical 6 entity IDs**; reproduced `states.calendar\|list` → `[]`, matching "no calendar entities" claim | **PASS** (strongest-evidenced tool this round — 4 independent confirmations) |
| `ha_list_floors_areas` | "What floors and areas are configured..." | `isError=false contentLength=3464` | `floor_count:0, area_count:16, unassigned_count:16`, all 16 names match the model's alphabetical list exactly | **PASS** |
| `ha_get_zone` | "What are the details of the 'home' zone... coordinates and radius?" | first call (no `zone_id`) `isError=false contentLength=65` | `{"success":true,"count":0,"zones":[],...}` — **65 bytes exact match**. Model correctly explained the YAML-defined `zone.home` doesn't appear in the entity-registry-backed zone list, and pivoted to `ha_get_state(zone.home)` | **PASS** — and this is a *good* example, not a defect: `latitude 49.2248, longitude -122.9829, radius 141m` — exact match to `ha_get_state` ground truth (`49.22484279204865, -122.98292040824892, radius:141`) |
| `ha_get_todo` | "What's on our Home Assistant to-do or shopping list?" | `isError=false contentLength=75` | `{"success":true,"count":0,"todo_lists":[],...}` — **75 bytes exact match** | **PASS** |
| `ma_list_players` | "What music players are set up... just tell me, don't change anything" | `isError=false contentLength=577` | 8 players, byte-exact 577-char match including all volume percentages (SoundTouch 300 25%, Dining Room 50%, Living Room TV 100%, etc.) | **PASS** |
| `ma_browse` | "Browse our Music Assistant library — what artists or albums..." | 8 chained calls, all `isError=false`; root=274B, Apple-Music-root=352B, Apple-Music-albums=1031B | Reproduced all three by path (`` `, `apple_music--Tw3d2WEg://`, `.../albums`) — **byte-exact match on all three**, and "Showing 1-20 of **430** items" matches the model's claimed "430 albums" | **PASS** |
| `ha_get_history` | "What's the recent state history for the kitchen thermostat over the last few hours?" | `isError=false contentLength=81623` (huge — 81KB) | N/A — see FAIL below, no oracle needed because there was no reply to check | **FAIL — see below** |

Plus `ha_get_state` was re-exercised several times (already covered by prior rounds) and
continued to pass content-oracle checks (e.g. kitchen thermostat `state:"heat", temperature:21.0,
preset_mode:"home"` matched the model's "21°C, Preset: Home" claim).

### FAIL — `ha_get_history`: tool succeeds, turn silently produces zero text, UI hangs on "Interrupt" indefinitely

This is the most serious finding of Row 1, and it is exactly the failure class this exercise
exists to catch: **a green tool-call log hiding a broken turn.**

**What happened.** Asked: *"What's the recent state history for the kitchen thermostat
(climate.neviweb130_climate_kitchen_thermostat) over the last few hours?"*

- `tool-broker.dispatch.foreground.done | tool="ha_get_history" isError=false contentLength=81623`
  — the tool call **succeeded**, returning 81,623 bytes (~81KB) of raw HA history JSON.
- The model's follow-up completion then hit the provider's **length limit**:
  `react-loop.iteration.stream-done | iteration=2 forceFinal=false finishReason="length"
  toolCallCount=0 textLength=0` — **zero characters of output text**, `finishReason="length"`.
- The loop treats this as a normal completion anyway:
  `react-loop.completed | iterations=2 forceFinal=false` →
  `session-runtime.turn.end | completed=true failed=false` →
  `turn-emitter.turn-completed`.
- **No text was ever generated for the user.** The UI showed the user's question, the red
  "Interrupt" stop button stayed lit for 3+ minutes (screenshot below), and no assistant bubble
  ever appeared. Reloading the page confirmed this is not a client render glitch: the persisted
  session transcript genuinely has no reply to that message — the empty-text turn was committed
  as "done" server-side.

**Root cause read.** The 81KB raw history payload, folded directly into the model's context with
no truncation/summarization, consumed the entire completion-token budget on the follow-up turn,
leaving nothing for the model to actually say. The react-loop has no retry-with-truncated-context
fallback and no synthesized "answer got too large, here's a partial summary" message for this
case — it just accepts the empty completion as a legitimate, non-failed turn.

**Full log trace** (`log-excerpt-row1-tools-breadth.txt`, turnId
`4fe97f75-1a11-4a1a-ae62-fe51ba6fa22e`):

```
16:28:26.928 tool-broker.pdp.decision | tool="ha_get_history" action="allow"
16:28:27.045 tool-broker.dispatch.foreground.done | tool="ha_get_history" isError=false contentLength=81623
16:28:32.103 react-loop.iteration.stream-done | iteration=2 finishReason="length" toolCallCount=0 textLength=0
16:28:32.104 react-loop.completed | iterations=2 forceFinal=false
16:28:32.105 session-runtime.turn.end | completed=true failed=false iterations=2
16:28:32.105 turn-emitter.turn-completed
```

Screenshot: `screenshots-group-d/row1-ha_get_history-stuck-interrupt.png` — taken ~3 minutes after
`turn-completed` fired server-side; the UI still shows the red stop button and no reply.

**Could this oracle still have failed?** No — I verified two independent things: the gateway's
own `finishReason`/`textLength` fields (server truly produced nothing), and a hard page reload
(client genuinely has nothing persisted to show — not a live-render race). Both agree.

### CONFIRMED DEFECT — `ha_search_entities` does not exist; the real tool is `ha_search`

I asked the model to use its entity search tool four different ways (implicit "search Home
Assistant for X", explicit "use your entity search tool", and finally verbatim "call the
`ha_search_entities` tool specifically"). Every time it fell back to `ha_eval_template`. On the
explicit ask it told me outright:

> "I don't have a tool called `ha_search_entities` available — it's not in my toolset. The
> closest I've got for searching entity names is `ha_eval_template`..."

I verified this independently, bypassing the gateway entirely:

```
$ bun qa/web/tool-truth.ts home_assistant ha_search_entities '{"query":"camera"}'
[tool-truth] isError=true contentLength=34
Unknown tool: 'ha_search_entities'
[tool-truth] RESULT FAIL — server returned isError=true
```

Then dumped the ha-mcp server's actual `tools/list` (78 tools) — there is no `ha_search_entities`
anywhere in it. The real tool is **`ha_search`**. `grep -n "ha_search"` across
`gateway/mcp-policy.yaml` and `gateway/config.yaml` turns up **zero** references to `ha_search` —
only to the non-existent `ha_search_entities`:

- `gateway/mcp-policy.yaml:74` — `allow_ha_search_entities` rule, keyed on `tool: ha_search_entities` — a dead rule that can never match anything.
- `gateway/config.yaml`'s `mcp_catalog.home_assistant.tools.include` also lists `ha_search_entities`, not `ha_search` — so even if the policy rule were fixed, the catalog's include-filter would still silently drop the real tool from what's exposed to the model.

**This is why `ha_search_entities` could not be driven** — not a gap in my testing, a genuine
naming-drift defect: the policy, the catalog, and (per the brief I was handed) even this QA
round's own tool list all inherited a stale name that was never true against the actual ha-mcp
server. I did **not** attempt to drive the real `ha_search` tool myself — it has no policy rule at
all, so per the fail-closed default it would land in the `confirm` tier, and driving an
unaudited/unreviewed tool via a permission-prompt "Allow" click is outside this round's read-only
allow-tier scope. I'm reporting it as a defect, not routing around it.

### Untouched, but for benign/expected reasons

- **`ha_config_get_calendar_events`** — requires `entity_id`; this demo Home Assistant has **zero**
  calendar-domain entities (`{{ states.calendar | list }}` → `[]`, confirmed via
  `ha_eval_template`). `bun qa/web/tool-truth.ts home_assistant ha_config_get_calendar_events '{}'`
  → `VALIDATION_FAILED: entity_id: Missing required argument`. Not reachable from a pure read
  probe in this environment; not a defect.
- **`ha_get_operation_status`** — requires an `operation_id` minted by a prior *write* call. I'm
  restricted to read-only asks, so there is never a legitimate ID to check. The model itself
  reasoned this correctly when asked ("no dedicated background-operations dashboard... no pending
  service calls") rather than guessing at a call. `tool-truth.ts`'s own `READ_ONLY_TOOLS` allowlist
  also excludes this tool for the same reason — consistent with my read.

### Coverage tally (this round + running total across rounds)

Content-oracle-confirmed this round (new): `ha_get_overview`, `ha_eval_template`,
`ha_list_floors_areas`, `ha_get_zone`, `ha_get_todo`, `ma_list_players`, `ma_browse` — **7 tools**.

Driven this round but content-oracle **FAILED**: `ha_get_history` — **1 tool**.

Previously covered (prior rounds, re-confirmed here): `ha_get_state`.

Still genuinely untouched from the round's 15-tool list: `ha_search_entities` (broken — see
above), `ha_config_get_calendar_events` (no calendar entity exists to query),
`ha_get_operation_status` (no operation id reachable read-only). `ma_search`, `search_web`,
`fetch` were already covered by prior rounds and re-exercised incidentally in Rows 1/3 above
without needing new oracle work.

### Odd, unresolved — Past-chats sync

Both times I opened the "Past chats" drawer (once via toggle, once after a full page reload), it
showed **"Couldn't load sessions — try again"** / **"Sync failed — list may be stale"** /
**"No past chats yet."** — despite the conversation clearly having a long history (visible in the
main pane). Clicking "New chat" created a session that briefly appeared under "Today" in the
drawer but the main transcript never switched to it — a page reload discarded it and returned to
the same long-running conversation instead. I did not chase this further since it's outside my
three assigned rows, but it's a real, reproducible-twice UI defect worth someone's attention
separately — not something I'm counting against Row 1/2/3's verdicts.

### Bonus finding — `ma_queue` confirm-tier fan-out on a benign ask

Asking "what music players are set up... just tell me, don't change anything" triggered
`ma_list_players` (allow-tier, fine) followed by **8 separate `ma_queue` confirm-tier permission
prompts** — one per player — each reading `"Reading the queue may also clear it or change
shuffle/repeat"`. I denied all 8 (per the brief's forbidden-tools list, `ma_queue` is not
allow-tier and I'm not authorized to click "Allow" on it). The model handled all 8 denials
gracefully — it did not hang, did not retry the *same* call, and produced a coherent final
answer using just the `ma_list_players` data ("Fair enough — the player list is all I've got
without checking their queues..."). This is correct behavior under denial, but 8 consecutive
permission dialogs for one simple status question is a notable UX smell — flagging it, not
failing the row over it, since read-tier `ma_list_players` itself passed cleanly.

---

## Row 2 — tool-error-path

**Oracle**, stated before driving: (1) the reply states *what* failed, no confabulation, no empty
reply; (2) the turn reaches a final answer without hanging; (3) the log shows the failure honestly
(`isError=true`).

**Ask:** *"What's the current state of sensor.definitely_not_a_real_entity_zx99?"*

**Reply:** *"Doesn't exist — Home Assistant returned a 404 for it. The name checks out."*
(screenshot: `screenshots-group-d/row2-404-entity-honest-error.png`)

**Log** (`log-excerpt-row2-error-path.txt`, turnId `266fbba3-64d1-4080-8427-6bd08f7684b3`):

```
16:39:48.494 tool-broker.pdp.decision | tool="ha_get_state" action="allow"
16:39:48.547 mcp.call-tool.ok | serverName="home_assistant" name="ha_get_state" isError=true contentLength=575
16:39:48.547 tool-broker.dispatch.foreground.done | tool="ha_get_state" isError=true contentLength=575
16:39:49.588 react-loop.iteration.stream-done | iteration=2 finishReason="stop" toolCallCount=0 textLength=74
16:39:49.589 react-loop.completed | iterations=2
16:39:49.589 session-runtime.turn.end | completed=true failed=false
```

**Ground truth**, dialed directly (bypassing the gateway):

```
$ bun qa/web/tool-truth.ts home_assistant ha_get_state \
    '{"entity_id":"sensor.definitely_not_a_real_entity_zx99"}'
isError=true contentLength=575
{"success":false,"error":{"code":"ENTITY_NOT_FOUND",
 "message":"Entity 'sensor.definitely_not_a_real_entity_zx99' not found",
 "details":"API error: 404 - Entity not found.", ...}}
```

`contentLength=575` matches byte-for-byte. This is a clean **PASS**: the tool honestly reports
`isError=true`, the react-loop terminates in exactly 2 iterations with real text, and the model's
reply correctly and concisely states the actual failure (404, entity not found) instead of
inventing a plausible sensor reading. This is the correct-behavior counterpart to the Row 3
finding below — same architecture, same react-loop, opposite outcome, which is useful context: the
loop *can* handle a tool error honestly when the error is a clean `isError=true` from the tool.

**Could this oracle still have failed?** Yes, in principle — a model could see `isError=true` and
still confabulate a plausible temperature anyway. It didn't. Verified by reading the actual reply
text, not just the log flag.

---

## Row 3 — tool-server-down

**Target selection.** `docker ps` showed two related containers:
`sentient-searxng` (the actual SearXNG engine, image `searxng/searxng:latest`, no published host
port — matches the `searxng` addon in `gateway/config.yaml`'s orchestrator registry) and
`sentient-searxng-mcp` (the MCP wrapper, `sentient/searxng-mcp:local`, a **separate** addon).
Per the brief's literal instruction ("Use searxng... smallest blast radius") I stopped
**`sentient-searxng`** — the underlying search engine, not its MCP wrapper — leaving the MCP
protocol server itself reachable so I could observe how *it* handles its own upstream going away.

**Oracle**, stated before driving: (1) the user gets a coherent answer explaining it could not
search — not a hang, not a silent empty reply, not a confabulated "search result"; (2) the turn
terminates; (3) the log names the dial failure with a reason.

### What actually happened

```
16:41:06  docker stop sentient-searxng   (confirmed down via `docker ps`)
16:41:09  asked: "Search the web for today's exchange rate between USD and Canadian dollars."
16:41:13  tool-broker.pdp.decision | tool="search_web" action="allow"
16:41:13  mcp.call-tool.ok | serverName="searxng" name="search_web" isError=false contentLength=131
16:41:16  final reply: "1 USD = 1.40 CAD — as of August 1, 2026."   (NO citation, NO caveat)
16:41:19.8  system-orch health-watch detects "searxng" unhealthy (first failed probe)
16:41:20.8  system-orch recreates sentient-searxng — back to "ready" in ~15s from stop
```

**(2) and part of (3) — PASS.** The turn did not hang; it reached a final, confidently-stated
answer in 3 iterations. And the searxng *addon itself* degraded and self-healed exactly as
designed — impressively fast (~15s, well inside the brief's 90s budget), with a clean,
named-reason log trail (`service.unhealthy | reason="health-probe-failed"` →
`driver.recreated`). I reproduced this identically on a second stop/start cycle a minute later
(~14.4s recovery) — this is reliable, not a fluke.

**(1) — FAIL, and this is the serious one.** The user did **not** get told the search failed. They
got a specific, plausible-sounding, entirely uncited number with zero hedging. This is precisely
the confabulation failure mode the brief calls out by name.

### Root cause, nailed down with three independent views of the same payload

The gateway's own log only ever records `isError` + `contentLength` (by design — chat content
never touches the log, see `qa/web/tool-truth.ts`'s own header comment). So I went straight to the
`searxng-mcp` container's own stderr for the same request, and separately reproduced the exact
same failure through `tool-truth.ts` dialing the MCP server directly.

**searxng-mcp's own log** (`searxng-mcp-container-log-during-outage.txt`), same second as the
gateway's `mcp.call-tool.ok`:

```
2026-08-01 23:41:13,688 - searxng_mcp_server.tools - ERROR - search request failed: [Errno -3] Temporary failure in name resolution
2026-08-01 23:41:13,689 - searxng_mcp_server.tools - ERROR - search_web failed: [Errno -3] Temporary failure in name resolution
```

**Reproduced live** by stopping `sentient-searxng` a second time and dialing directly:

```
$ bun qa/web/tool-truth.ts searxng search_web '{"query":"USD to CAD exchange rate today"}'
[tool-truth] isError=false contentLength=131
{"query":"USD to CAD exchange rate today","total_results":0,"results":[],
 "error":"[Errno -3] Temporary failure in name resolution"}
[tool-truth] RESULT OK
```

**131 bytes, byte-for-byte identical** to what the gateway logged for the live chat call. The
`searxng-mcp-server` package (third-party pip dependency, pinned
`searxng-mcp-server==0.1.9`, `gateway/mcp/searxng-mcp/Dockerfile`) catches its own DNS/connection
failure internally and returns a **successful MCP result** (`isError=false`) whose JSON body
happens to carry `"total_results":0, "results":[], "error":"..."` — the failure is only visible
*in-band*, inside content the model has to actually parse and reason about, not as a transport-level
signal. The model, given this payload plus a follow-up `fetch` call that happened to succeed on
an unrelated page, synthesized a confident specific number instead of noticing `total_results:0`
and the embedded `"error"` key.

**This is a two-layer failure**, and I want to be precise about where each layer sits:

1. **`searxng-mcp-server` 0.1.9** (third-party, vendored via pip in `gateway/mcp/searxng-mcp/Dockerfile`) — should set `isError=true` when its upstream call throws, and doesn't. This means `bun qa/web/tool-truth.ts`'s own pass/fail heuristic (which trusts the MCP-level `isError` flag) would also call this "OK" — the QA tooling's oracle has the same blind spot the gateway does, worth knowing.
2. **The model itself** — even with `isError=false`, the JSON it received literally says `total_results:0` and carries an `"error"` key. A more careful model turn would have caught this from content alone. It didn't.

### Recovery confirmed end-to-end, not just at the container level

Re-asked the identical question after the searxng engine had self-healed:

```
16:43:37  search_web → isError=false contentLength=1826  (normal-sized real result, vs. 131B during the outage)
16:43:44/16:43:52  two follow-up `fetch` calls (individually isError=true — normal per-page
                     404/timeout noise, unrelated to the searxng defect)
16:44 reply: "1 USD = 1.4021 CAD — as of August 1, 2026.
              Source: ExchangeRate-API via open.er-api.com, last updated August 1, 2026 at 00:02 UTC."
```

Same day, same question, two different numbers: **1.40** (fabricated, no source) vs. **1.4021**
(real, cited, sourced). This is the cleanest possible before/after pair confirming the first
answer was not a genuine search result.

Screenshots: `screenshots-group-d/row3a-confabulated-rate-no-citation.png` (during outage) and
`screenshots-group-d/row3b-recovered-rate-with-citation.png` (after self-heal).

### Stack left healthy

```
$ bun qa/web/stack-integrity.ts
[stack-integrity] RESULT PASS — pass=9 fail=0 skip-optional=0 of 9 declared
```

Both `sentient-searxng` and `sentient-searxng-mcp` confirmed `Up` via `docker ps` before running
this. **The stack was not left degraded** and no manual `docker start` was needed at any point —
the system-orchestrator's own health-watchdog handled both recovery cycles unassisted.

**Could this oracle still have failed?** No — I have three independent confirmations of the exact
131-byte payload (gateway's contentLength, the container's own stderr, and a live re-dial via
tool-truth), plus a clean before/after pair from the real chat UI showing two different numbers
for the same question. This is as solid as evidence gets without reading raw provider prompts.

---

## Files in this evidence set

- `group-d-tools-and-errors.md` — this file
- `screenshots-group-d/00-pre-row1-state.png` — starting state
- `screenshots-group-d/row1-ha_get_history-stuck-interrupt.png` — the hung turn, ~3 min post-completion
- `screenshots-group-d/row1-ha_search_entities-missing-tool.png` — model's own confession
- `screenshots-group-d/row2-404-entity-honest-error.png`
- `screenshots-group-d/row3a-confabulated-rate-no-citation.png`
- `screenshots-group-d/row3b-recovered-rate-with-citation.png`
- `log-excerpt-row1-tools-breadth.txt` — raw log, 16:21–16:29 + 16:39 windows
- `log-excerpt-row2-error-path.txt` — raw log, 16:39:44–16:39:49
- `log-excerpt-row3-tool-server-down.txt` — raw log, 16:41–16:44
- `searxng-mcp-container-log-during-outage.txt` — the smoking-gun application-level stderr
