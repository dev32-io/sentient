# E2E round 2 — results

Driven 2026-08-01 against the local dev stack (webui `:5173` → gateway `:8888`,
`bun --watch`), in a real browser via Playwright MCP, logged in as **Ada**.
Pre-flight `bun qa/web/stack-integrity.ts` → `RESULT PASS` (9/9) before every
group, and again after group D restored the stack.

Plan and matrix: `docs/superpowers/plans/2026-07-29-native-stack-migration/task-17-e2e-round-2.md`.

Round 1 (tasks 9, 10, 12) drove the 2.0 spec matrix and the first slice of the
tool surface. This round covered what it never looked at: auth sad paths, error
paths, settings persistence, and every surface tasks 15/16 changed *after* round 1
ran. Mic-dependent rows are excluded by decision and listed at the bottom.

## Results

| Row | Verdict | Oracle used |
|---|---|---|
| `auth-wrong-pin` | **PASS** | still on login screen + no successful auth in the log for the attempt |
| `auth-logout` | **PASS** | the exact marker string `QUOKKA-7734-MARKER` visible again after re-login; same conversation id, `itemCount` 2→4 |
| `newchat-red` | **RECORDED — D15 upgraded** | wire `messageCount` 6→8 across the click; model recited the pre-"+" marker verbatim when denied an escape hatch |
| `model-selection` | **PASS** | settings UI, `provider.resolved source="profile"` and `stream-start` all name `deepseek-v4-flash:cloud`, not the `gpt-oss:20b-cloud` fallback |
| `model-switch-live` | **PASS** | two live switches + restore, one unbroken WS session, no reload; each turn's `resolved`+`stream-start` named the newly-selected model |
| `settings-persist` | **PASS** | marker byte-exact in `textarea.value` after a full reload; apply-bar clean on Account/Members |
| `delegate-dialog-args` | **PASS** | 549-char `taskPrompt` read out of the DOM — tail marker present, one row per arg, `overflow-y:auto; max-height:360px` |
| `delegate-deny` | **PASS** | `confirm-resolved confirmed=false`, zero `hermes-runner.run.start`, reply admits the decline, no retry |
| `bg-no-card` | **MEASUREMENT — D16 worse** | no `.system-event`, follow-up turn fired, and it emitted `completionTokens=1 textLength=0` — silence |
| `tool-error-path` | **PASS** | nonexistent entity → "Home Assistant returned a 404", honest `isError=true`, turn completed in 2 iterations |
| `tools-breadth` | **PARTIAL** | 7 more tools content-oracled against `tool-truth.ts`; 1 tool defective (D17), 1 nonexistent (D19) |
| `tool-server-down` | **FAIL** | the outage answer was confabulated (D18). Watchdog self-healed the container in ~15 s — that half passed |
| `mobile-390-recheck` | **PASS + 2 findings** | dialog fits and its args scroll internally at 390×844; long-token clipping and sub-44px tap targets found |

## What this round found

Filed in `docs/native-todo.md` § 1:

- **D17** — a large tool result (`ha_get_history`, ~81 KB) drives the completion to
  `finishReason="length"` with empty text. No reply ever renders, and the turn records
  itself `completed=true failed=false`. The class, not the tool, is the defect.
- **D18** — `searxng-mcp-server` returns its own DNS failure as an `isError=false`
  payload with an in-band `error` key. The model answered from its weights: an
  uncited, confidently wrong exchange rate.
- **D19** — `ha_search_entities` is in the catalog and the policy; the server has no
  such tool (the real one is `ha_search`). Entity search is therefore unavailable,
  and `filterByAllowlist` drops the phantom **silently**, so the config reads as coverage.
- **D20** — a failed login logs nothing at the deployed `info` level. PIN guessing
  is invisible.
- **D15 upgraded** — "+ new chat" is a context leak, not a cosmetic bug.
- **D16 worse** — the first measurement on a chosen model gives silence, not the
  acknowledgement previously measured on `gpt-oss:20b`.
- Smaller: chat bubbles clip long unbroken tokens; stale "Apply & Restart" copy;
  sub-44px composer controls; eight `ma_queue` prompts for one read-shaped question.

## Two oracle lessons worth keeping

1. **`scrollWidth <= innerWidth` passes on clipped content**, because `overflow: hidden`
   suppresses the scroll the oracle looks for. The clipping was only found by walking
   the ancestor chain. An oracle that cannot fail on the defect is not an oracle.
2. **A model's self-report is not evidence.** Offered an escape hatch, it claimed
   `NO-CONTEXT`; the wire showed the full prior transcript in the prompt, and without
   the hatch it recited the marker. Ask the transport, not the model.

## Excluded by decision — needs the owner's hands

Both are recorded in `docs/native-todo.md` § 4 and are **not** counted as covered:

- **`voice-roundtrip`** — speak a query, hear the answer.
- **`barge-in`** — talk over TTS; audio stops, turn aborts with `cutoff="barge-in"`,
  and background tasks keep running (that is the distinction from Stop).

A fake audio device can inject a file, but not reproduce the acoustic echo path that
these rows actually test.
