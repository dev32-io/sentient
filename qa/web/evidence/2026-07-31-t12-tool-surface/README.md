# Task 12 · Step 4 — the tool-surface matrix

**Driven 2026-07-31, local dev stack, real browser (Playwright MCP) against
`http://localhost:5173` → gateway `:8888`.** Signed in as Grace; every turn went
through the gateway's own native ReAct loop, not the WS-seam harness.

Pre-flight, so the results mean something:

```
$ bun qa/web/stack-integrity.ts
[stack-integrity] RESULT PASS — pass=9 fail=0 skip-optional=0 of 9 declared
```

## The oracle, and why it is not the log

`tool-broker.dispatch.foreground.done` records `isError` and `contentLength`
and **deliberately no content** — chat content must never reach the log. So
"the reply is right" cannot be established from gateway logs alone; an oracle
built only from them can only re-assert what the gateway already believes.
That is exactly how `native-tool-call` passed while its own evidence read
`isError=true`.

Each row below therefore has **two** independent halves:

1. **`isError=false`** on both `mcp.call-tool.ok` and
   `tool-broker.dispatch.foreground.done` — from the gateway log.
2. **Result content matches ground truth obtained over a different path** —
   `bun qa/web/tool-truth.ts <server> <tool> '<args>'` dials the same MCP server
   directly, bypassing the ReAct loop, ToolBroker and PDP entirely.

A row is PASS only when both halves hold. Any `isError=true` is FAIL,
regardless of what the bubble says.

## Results — 5 / 5 PASS

| Row | Ask | Tool + PDP rule | Log | Content oracle |
|---|---|---|---|---|
| `tool-ha-read` | state of `sun.sun` | `ha_get_state`, `allow_ha_get_state` | `isError=false contentLength=374` | reply = `above_horizon`; probe = `"state":"above_horizon"` ✅ |
| `tool-ma-read` | search library for Miles Davis | `ma_search`, `allow_ma_search` | `isError=false contentLength=973` | reply = Kind of Blue / Sketches of Spain / Bitches Brew — all three in probe output ✅ |
| `tool-websearch` | search web, top result | `search_web`, `allow_search_web` | `isError=false contentLength=3765` | reply = "James Webb Space Telescope – NASA Science", `science.nasa.gov/mission/webb/` = probe's `score:4.0` top hit ✅ |
| `tool-fetch` | fetch `https://example.com` | `fetch`, `allow_fetch` | `isError=false contentLength=679` | reply quotes "This domain is for use in documentation examples without needing permission. Avoid use in operations." verbatim ✅ |
| `tool-multi` | `sun.sun` **and** a web search, one reply | `ha_get_state` + `search_web` | both `isError=false` (374, 3841) | `above_horizon` + "Mars 2020: Perseverance Rover – NASA Science"; probe returned `contentLength=3841`, byte-identical ✅ |

`gateway-log-step4.txt` — 31 lines, unedited: **12 × `isError=false`, 0 ×
`isError=true`**, no `dispatch.unknown-tool`, no `permission-broker.request`
(every tool used was `allow`-tier, so no prompt is correct here).

`tool-multi` took `iterations=3` on one `turnId`
(`c036168b-8a7d-4543-8686-d5992fc67c1b`): call HA → call searxng → compose. Two
servers, one turn, one coherent answer.

## Firsts

The gateway's own ReAct loop had **never** called `search_web` or `fetch` in any
test before this run — that was the structural gap the task was written for.
Both are now driven with a content oracle.

## Coverage

**Before: 5 / 28. After: 9 / 28.**

Newly exercised through the gateway's loop, with a content oracle:
`ma_search`, `search_web`, `fetch`. `ha_get_state` was already counted but had
only ever been observed at `isError=true`; this is its first verified-good
drive. `ha_get_overview` was exercised by the ground-truth prober only, so it is
**not** counted — the denominator counts tools driven through the gateway's own
loop.

The honest read: four of the five catalog servers now have a real row
(`home_assistant`, `music_assistant`, `searxng`, `fetch`), but 19 of 28 tools
remain untouched — the bulk being HA's 16-tool surface, of which only
`ha_get_state` is verified. Per-server coverage is the win here; per-tool
coverage is still thin, and calling it anything else would repeat the mistake
this task exists to correct.

## Safety

Reads only. No `ha_call_service`, no `ha_bulk_control`, no `ma_playback`,
`ma_play_media` or `ma_volume` — nothing that changes a device or starts audio
in the house. `tool-truth.ts` enforces this structurally via `READ_ONLY_TOOLS`,
which is deliberately stricter than `mcp-policy.yaml`'s `allow` tier (that tier
contains all three MA playback tools, prompt-free by design). Prompts for the
music row said "search only — do not play anything"; the log confirms only
`ma_search` dispatched.

## Screenshots

Captured beside this file but **not committed** — `.gitignore:82` ignores `*.png`
repo-wide, and no evidence screenshot in `qa/web/evidence/**` is tracked
(`git ls-files qa/web/evidence | grep -c png` → 0). The log excerpt is the
durable evidence; the images are local to the drive machine.

- `01-rows-ha-ma-websearch-fetch.png` — rows 1-4 in the feed with their tool pills
- `02-row-tool-multi.png` — row 5, two pills (`ha_get_state`, `search_web`) on one reply
