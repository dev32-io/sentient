# TODO — parked findings

## Live assistant rendering fidelity (do these two together, after WS-resilience)

Both make the *live* assistant output match what Hermes actually produces and persists.
Investigated 2026-06-09 while debugging the "Removing Bitcoin for World News" prod run
(session `s-mq69c6ug-lbbtf5a7`, cycle-2, 2026-06-08 23:30).

### 1. Show intermediate narration as its own live bubble (gateway un-merge)

**Symptom:** the message "Wait, what Liquid Glass refinements…" produced TWO assistant
responses in raw chat history (a "Let me pull the key articles…" narration + the long
final answer). Live, only the final showed; the narration appeared only after a
reconnect/history-reload.

**Root cause:** within one cognitive cycle the gateway accumulates every Hermes assistant
micro-turn into ONE merged entry and commits a single `conversation.entry`:
- `gateway/src/cerebrum/hermes-event-translator.ts:289-301` — live path: one merged
  `assistantText` → one committed entry.
- Reload path rehydrates from Hermes via `getMessages`, which stored the micro-turns as
  SEPARATE turns → two bubbles:
  - `gateway/src/sessions/hermes-message-to-mirror.ts:67-72`
  - `gateway/src/sessions/switch-flow.ts:86-91`

**Log evidence:** cycle-2 — `assistantChars=2597 eventCount=11`, narration emitted before
4 tool calls (searxng + 3× fetch), one merged entry committed live.

**Fix direction:** emit/commit each Hermes assistant micro-turn as its own live
`conversation.entry` (keyed by `messageId`), so the live feed matches the reloaded feed.
Pairs with #2.

### 2. ACP token-level text-delta streaming (typewriter live)

**Finding:** token-level streaming from Hermes IS achievable. Verdict: gated on **Hermes
emit granularity**, NOT the ACP protocol, the gateway, or a capability handshake.

- ACP supports multiple `agent_message_chunk` per message (stable `messageId` across
  chunks, client concatenates) — `gateway/src/hermes-adapter-client/session-updates.ts:18-28`;
  upstream ACP message-id RFD.
- Gateway is already a streaming passthrough — one `message.delta` per chunk, no buffering
  — `per-profile-connection.ts:120-132`, `event-translator.ts:102-118`,
  `acp-hermes-client.ts:239-243`. Confirmed in `agents/docs/learnings.md:10`.
- Today Hermes emits ONE complete block per micro-turn
  (`docs/research/2026-05-07-acp-probe-results.md:115-125`). The change is **server-side in
  Hermes' `acp_adapter`** — emit incremental `agent_message_chunk` (same `messageId`,
  successive `content.text` deltas) as the model streams.

**Gateway-side caveats when Hermes goes token-level:**
- Move the per-chunk trailing `\n` (TTS / paragraph segment boundary) off per-chunk onto
  per-`messageId`-completion / per-cycle, else token-level chunks shatter TTS sentence
  aggregation — `acp-hermes-client.ts:243`.
- Thread `messageId` through (parsed but ignored today) — `session-updates.ts:23`.

**Why together:** #1 gives each micro-turn its own bubble; #2 makes each bubble type out
live. Combined = faithful live assistant rendering. Both also dovetail with the stable
per-entry id introduced by the WS-resilience work (see that spec).
