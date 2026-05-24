# Hermes Cerebrum Integration — Design v2

**Date:** 2026-04-21
**Status:** Draft — supersedes v1 (`2026-04-21-hermes-cerebrum-integration-design.md`). Incorporates verified ideas from GLM-DRAFT-spec and addresses the multi-profile / ESP32 satellite-device concerns raised during v1 review.
**Scope:** Unchanged from v1 — replace our in-gateway cognitive cycle with NousResearch Hermes Agent (MIT, v0.10.x). This v2 revises the integration mechanics, interrupt/barge-in semantics, multi-profile strategy, and adds first-class support for ESP32 satellite voice devices.

---

## Changelog from v1

| Topic | v1 position | v2 position | Reason |
|---|---|---|---|
| Gateway↔Hermes transport | HTTP `/v1/responses` + SSE | **HTTP `/v1/responses` + SSE, unchanged** (GLM's Unix-socket + Python plugin rejected) | GLM's plugin approach relies on undocumented APIs (`stream_delta_callback`, `tool_gen_callback`, `ctx.inject_message()`); none of these are on the documented plugin SDK surface. Verified against official Hermes plugin-building guide. |
| Speak as tool vs decorator chain | Decorator chain (text-delta → TTS) | **Decorator chain by default; speak-as-streaming-tool as conditional unlock** (pending empirical verification of `function_call_arguments.delta` in Hermes SSE) | We don't commit to a plugin-based streaming interception. We DO add a Phase-1 empirical task: if the HTTP API emits argument-delta events during tool calls, we unlock speak-as-tool without a plugin. Otherwise stay with the decorator chain. |
| Barge-in | Drop SSE connection on barge-in | **Continue the Hermes turn; discard TTS-bound deltas; accumulate barge-in transcript for the next turn** | GLM's approach. Cleaner: no forced run abort, no partial-response cleanup. Matches Hermes's turn model. The SSE stream keeps arriving; we simply route text-delta to ConversationMirror only, not to TTS. |
| Interrupt (user Stop button) | Drop SSE connection | **Drop SSE connection (same). Add a secondary "cycle fence" to ensure mid-tool side effects get logged** | `response.cancel()` on OpenAI Python SDK doesn't work for streams (open upstream FR #2643). SSE disconnect IS the mechanism Hermes's own PR #3427 wired up server-side. We lean into it. |
| Conversation history model | ConversationMirror for UI + Hermes owns LLM context | **Dual history, explicitly: Gateway authoritative for client; Hermes authoritative for LLM context; each turn sends deltas only** (GLM framing) | Sharpens the mental model. Token-efficient. |
| AttentionGate dispatch cadence | Per-cycle (same as pre-Hermes) | **Per-turn** — Hermes's internal ReAct handles multi-step reasoning; our AttentionGate fires once per user-attention-event | GLM insight: Hermes owns ReAct. Our "continuation loop" semantics collapse to "wake on new ambient accumulation during an active turn." |
| Multi-profile deployment | One container per user (pattern b) | **Same default, with a curated minimal install (no playwright/opencv/whisper/piper) targeting ~400 MiB/profile.** Strategy B (on-demand pause/unpause) is a documented fallback | The 1-2 GiB/container figure was `.[all]` extras. Curated install likely fits 5 users in <2.5 GiB total. Must measure empirically before Phase 1 lock. |
| Satellite devices (ESP32) | Not addressed | **First-class §5.12** — device identity + "I am X" voice-phrase rebind via gateway-hosted MCP tool | User-raised concern. ESP32 devices are planned around the home; a clean identity-switching UX is required from v1. |
| Gateway-hosted MCP | Sketched as future in §10.1 | **Elevated to a core v1 component (§5.13)** — hosts `identify_user`, `pause_audio`, `set_channel` tools that need gateway reach-back | User's "expose on-device connectors as MCP tools" framing is the right one. |
| Security | 5 hardening layers | **Adds GLM's session risk accumulator + policy-as-code at tool boundary** | Both are cheap to build and layer on existing defenses. |
| Known Hermes issues | Issue #5244 (mid-tool interrupt), #5021 (flush_per_turn) | **Adds #5563 (SQLite state.db corruption — real, open), #12731 (compression corrupts tool_call args), #8042 (history holes)** | Must be called out for risk planning. |

The rest of the v1 spec — disabling Hermes's built-in HA gateway, HA via official MCP for action, HA WebSocket subscriber in gateway for observation, `remove-markdown`+`emoji-regex`, Pi-sensor-into-HA refinement, wire-protocol freeze, config partitioning — carries forward unchanged.

---

## Table of contents

1. Motivation (carried from v1)
2. Scope and non-goals
3. Decision log (expanded)
4. Architecture overview
5. Component design
   - 5.1 Hermes deployment topology (revised: curated install, resource budget)
   - 5.2 Gateway↔Hermes adapter (`hermes-client`)
   - 5.3 Event translation: Hermes SSE → wire messages
   - 5.4 Input pipeline (STT → AttentionGate → Hermes)
   - 5.5 Output pipeline (text-delta → TTS; conditional unlock for speak-as-tool)
   - 5.6 Home Assistant dual-path (unchanged from v1)
   - 5.7 Memory, persona, skills partition
   - 5.8 MCP servers and tool allowlist
   - 5.9 Conversation history: dual model (gateway + Hermes)
   - 5.10 AttentionGate preservation under the turn-based model
   - 5.11 Multi-profile strategy (NEW: Strategy A default, B fallback)
   - 5.12 ESP32 satellite devices (NEW)
   - 5.13 Gateway-hosted MCP (NEW: elevated from "future")
   - 5.14 Interrupt and barge-in (expanded)
6. Wire protocol preservation contract
7. Configuration partitioning
8. Security hardening (+ session risk accumulator, policy-as-code)
9. Migration: delete / keep / adapt
10. Future extensibility
11. Edge cases (expanded)
12. Testing strategy
13. Empirical measurements required before Phase 1 lock (NEW)
14. Upstream contributions / local patches
15. Risks and mitigations (expanded)
16. Implementation phases (outline)
- Appendix A: Hermes SSE → wire-message mapping (revised)
- Appendix B: Sample profile `config.yaml` (revised for curated install)
- Appendix C: `docker-compose.yml` excerpt (revised)
- Appendix D: Glossary

---

## 1. Motivation

(Unchanged from v1.) We built a custom cerebrum — AttentionGate + CognitiveCycle + ConversationHistory + ShortTermContext + Effects + TaskManager — to drive a family voice assistant. The cerebrum has converged on what is substantially a ReAct agent loop with memory, skills, tool dispatch, salience-gated waking, and prompt-injection hardening. Every piece is a well-solved problem in NousResearch Hermes Agent (MIT, v0.10, 108K+ stars on GitHub). The gateway's real differentiator is the voice UX and the salience-gated attention model. By moving the LLM-brain to Hermes we reclaim ~4000–6000 LOC and refocus on the parts that are actually special.

## 2. Scope and non-goals

**In scope**: everything from v1. Plus: multi-profile deployment on 8 GiB Pi 5, 3–5 ESP32 satellite devices with identity binding, gateway-hosted MCP for reach-back tools, empirical measurement tasks added as Phase 1 gates.

**Non-goals**: unchanged from v1. Specifically not: on-device LLM inference, speaker biometric identification (v2+), Telegram/Discord gateways, cross-user memory.

## 3. Decision log

Sixteen decisions. Marked [v1] for carried-forward, [v2] for new or revised.

| # | Decision | Rationale | Alternatives rejected |
|---|---|---|---|
| D-1 [v1] | Fork B: Hermes as full cerebrum. | Matches user's original framing. Highest code-reclaim. | Fork A (LLM-brain only): keeps reinventing memory. Fork C (hybrid): two-memory problem. |
| D-2 [v1] | Disable Hermes's built-in HA gateway; route HA observation through our AttentionGate; expose HA to Hermes via the official HA MCP server for action. | Preserves salience differentiator. HA's Expose UI is authoritative for action allowlist. | Built-in gateway: no salience, wrong response channel. `ha-mcp` (85 tools): blows up cache prefix. |
| D-3 [v2] | **Speak is a TTS decorator chain consuming `response.output_text.delta`. Conditional unlock: if empirical testing in Phase 1 confirms Hermes emits `response.function_call_arguments.delta`, we can restore `speak-as-streaming-tool` with zero plugin work.** | GLM proposed a custom Python plugin for streaming-overlap; verification showed the plugin hooks it depends on (`stream_delta_callback`, `tool_gen_callback`) are undocumented / third-party only. Don't build on unverified APIs. | GLM's plugin approach: brittle, depends on unstable internals. Pure tool-completion-then-TTS (no streaming): loses latency-reduction, acceptable but suboptimal. |
| D-4 [v1] | `remove-markdown` (npm) + `emoji-regex` for TTS-safe text stripping. | Battle-tested, correct on ZWJ/skin-tone. | `strip-markdown`: overkill. LLM-only stripping: brittle. |
| D-5 [v2] | **Multi-profile: one container per user, with curated minimal install (no playwright/opencv/whisper/piper). Target ≤ 450 MiB/profile idle; measure in Phase 1.** Fallback: on-demand pause/unpause (Strategy B) with gateway "one sec" filler during cold start. | Only viable strategy that preserves per-user memory/persona/skills on our RAM budget (see §5.11). | Per-request profile swap: not viable (HERMES_HOME baked at import). Single profile, `conversation`-parameter multi-tenancy: breaks memory isolation — families want privacy. |
| D-6 [v1] | Situation awareness as labeled prefix in the user message. `[<source>/<key>] <summary>\n<user text>`. | Matches `.claude/rules/llm-protocol.md`. Preserves Hermes prompt cache. | `instructions` override: flushes cache. Context files hot-reload: Hermes doesn't support. |
| D-7 [v1] | Session continuity via `conversation` parameter, not `previous_response_id`. | Hermes docs prefer it. Server auto-chains. | `previous_response_id`: brittle on concurrent cycles. |
| D-8 [v2] | **Interrupt via SSE disconnect (kept). Mid-tool side effects still land; this is accepted. `response.cancel()` (Python OpenAI SDK) doesn't support streams — open upstream FR #2643 — so we can't improve on this from the client side.** | Verified: the SDK only supports cancel on *background* (non-streaming) responses. SSE disconnect IS the only API-level abort primitive, and Hermes PR #3427 handles it server-side. | Custom plugin calling internal abort APIs: unverified, brittle. |
| D-9 [v2] | **Dual conversation history. Gateway authoritative for client-facing (`ConversationMirror`). Hermes authoritative for LLM-facing. On each turn, gateway sends new deltas only.** | GLM framing is clearer than v1's "mirror" framing. Token-efficient. | Send full history each cycle: wastes tokens, duplicates state. |
| D-10 [v2] | **AttentionGate fires per *turn*, not per ReAct iteration.** Hermes owns ReAct internally; our "continuation" semantics collapse. ReAct cap becomes Hermes's `max_turns` config. | Hermes-native model. Simpler. | Keeping per-iteration cycles: would require a plugin to surface iteration boundaries — unverified API. |
| D-11 [v2] | **Barge-in: gateway-owned, Hermes-unaware. Discard further TTS-bound text deltas; keep them for ConversationMirror. Let the Hermes turn complete naturally. Barge-in transcript accumulates to the next user message.** | GLM's design. Works over HTTP SSE without server-side changes. Cleaner than forced SSE-disconnect. | SSE disconnect on barge-in (v1): forces Hermes to re-init, loses any useful remainder of the assistant output. |
| D-12 [v1] | Tools (e.g., HA MCP) don't change mid-session. | Prompt cache hygiene per `llm-protocol.md`. | Dynamic tool activation: cache-buster. |
| D-13 [v2] | **ESP32 satellite devices: per-device default user identity mapping + voice-phrase rebind ("I am X") implemented as gateway-hosted MCP tool.** Biometric voiceprint ID deferred to v2+. | Simple, correct, affordable. Device identity is physical context (kitchen = family, Alice's bedroom = Alice). | On-device biometric ID: complex, expensive, error-prone in v1. Gateway-only diarization: only assigns speaker 0/1/2, doesn't identify. |
| D-14 [v2] | **Gateway-hosted MCP server elevated to v1 component.** Hosts tools that need reach-back into gateway state: `identify_user`, `pause_audio`, `set_channel`, future `cancel_all_tasks` (if kept as MCP, not gateway-internal). | Hermes can call these via its standard MCP client. Zero plugin work. Preserves blast-radius isolation — only gateway mutates gateway state. | Custom IPC: reinvents MCP. Built-in `configure` effect: breaks the "Hermes owns all tool dispatch" model. |
| D-15 [v2] | **Add session-level risk accumulator and policy-as-code at the gateway's tool-call boundary.** Every tool invocation is scored; cumulative risk over a decaying window gates confirm/escalate/block. | GLM's addition; cheap insurance against slow-drip injection. Policy-as-code (explicit rule set) is LLM-independent. | Rely solely on Hermes's Tirith scanner: single layer. |
| D-16 [v2] | **Empirical measurements are Phase-1 gates.** Specifically: idle RAM of curated Hermes container; cold-start time; presence/absence of `response.function_call_arguments.delta` in Hermes SSE. The spec makes *conditional* claims that resolve once numbers arrive. | Don't build on assumptions that collapse in production. | Ship without measuring: repeats the classic "1-2 GiB/container" misreading. |

---

## 4. Architecture overview

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                                 CLIENT (webui / SDK / ESP32)                    │
│   VoiceState FSM · typewriter · task cards · stop button · chat bubbles        │
└────────────┬───────────────────────────────────────────────────────▲───────────┘
             │ WS (sentient wire protocol, FROZEN §6)                │
             ▼                                                       │
┌────────────────────────────────────────────────────────────────────┴───────────┐
│                           SENTIENT GATEWAY (Bun/TS)                             │
│                                                                                 │
│   ┌─────────────┐   ┌──────────────┐   ┌──────────────────────────────────┐    │
│   │ WS handlers │──▶│ Auth +       │──▶│ SessionRouter                    │    │
│   │             │   │ device/user  │   │ userId ↔ (port, bearer, convId)  │    │
│   │             │   │ resolution   │   │ + on-demand container supervisor │    │
│   └─────────────┘   └──────────────┘   └─────────────┬────────────────────┘    │
│                                                      │                         │
│   ┌─────────────┐    ┌──────────────┐    ┌──────────▼──────────────────────┐  │
│   │ STT         │    │ HA observer  │    │  ShortTermContext               │  │
│   │ pipeline    │    │ (WS ←HA)     │    │   ambient, tonic, task mirror   │  │
│   └──────┬──────┘    └──────┬───────┘    └────────────┬────────────────────┘  │
│          │                  │                         │                       │
│          ▼                  ▼                         ▼                       │
│   ┌────────────────────────────────────────────────────────────────────────┐  │
│   │                        AttentionGate (per-TURN dispatch)                │  │
│   │  salience map · debounce · thresholds · rate cap · wake once per turn  │  │
│   └────────────────────────────┬────────────────────────────────────────────┘  │
│                                │                                               │
│                                ▼                                               │
│   ┌─────────────────────────────────────────────────────────────────────────┐  │
│   │                         HermesClient                                     │  │
│   │   POST /v1/responses { input, conversation, stream, max_output_tokens } │  │
│   │   consumes SSE →                                                         │  │
│   │     response.created, response.output_text.delta                        │  │
│   │     response.output_item.added|done (function_call, message)            │  │
│   │     hermes.tool.progress, response.completed                            │  │
│   │   on barge-in: drop further text-delta to TTS but keep for mirror       │  │
│   │   on interrupt (hard): close SSE; let Hermes cancel server-side         │  │
│   └──────────┬──────────────────────────────────────────────────────┬──────┘  │
│              │ text deltas (barge-in-gated)                          │         │
│              ▼                                                       │         │
│   ┌──────────────────────────────────────────────────────────────┐   │         │
│   │  TTS decorator chain                                          │   │         │
│   │   markdown-strip → emoji-strip → utterance-aggregator        │   │         │
│   │     → emotion-tagger → Fish Audio → ConnectorSink            │   │         │
│   └──────────────────────────────────────────────────────────────┘   │         │
│                                                                      │         │
│   ┌──────────────────────────────────────────────────────────────┐   │         │
│   │  Gateway-hosted MCP server (Unix socket)                     │   │         │
│   │   tools: identify_user, pause_audio, set_channel,            │   │         │
│   │          (future) cancel_all_tasks                           │◀──┘         │
│   └──────────────────────────────────────────────────────────────┘             │
└────────────────────────────────────────────────────────────────────────────────┘
                    │ HTTP /v1/responses (SSE, one per profile)     ▲ WS (HA obs)
                    │                                                │
                    ▼                                                │
┌─────────────────────────────────────────┐   ┌───────────────────────────────────┐
│   HERMES containers (1 per user)        │   │   Home Assistant                   │
│   curated install (no playwright/whisper│   │   official mcp_server integration  │
│    /piper/opencv) → ~400 MiB idle       │   │   Exposed Entities UI controls     │
│   profiles/<user>/{SOUL,MEMORY,USER}.md │   │   action allowlist                 │
│   skills/, sessions/                    │◀──┤                                    │
└─────────────────────────────────────────┘   └───────────────────────────────────┘
                    │ outbound LLM
                    ▼
           ┌───────────────────┐
           │  egress-proxy     │ (domain allowlist: openrouter, anthropic, openai)
           └───────────────────┘
```

---

## 5. Component design

### 5.1 Hermes deployment topology

**Pattern (default, D-5):** one Hermes container per user profile. For v1, the family is 1–5 users, so 1–5 containers.

**Image:** **custom build** derived from `nousresearch/hermes-agent:<pinned>`. The stock image bundles `.[all]` extras (Playwright, OpenCV, Whisper, Piper) which are irrelevant to us (our gateway owns all voice I/O). Our `deploy/docker/hermes/Dockerfile.slim` installs Hermes with only the core + OpenAI-compatible providers + MCP client deps:

```dockerfile
FROM python:3.12-slim-bookworm AS base
RUN pip install --no-cache-dir hermes-agent[messaging]==<pinned>
# NOTE: intentionally omit [voice], [browser], [vision]
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
USER 1000:1000
WORKDIR /data
ENV HERMES_HOME=/data
ENV API_SERVER_ENABLED=true
EXPOSE 8642
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS -H "Authorization: Bearer $(cat $API_SERVER_KEY_FILE)" http://localhost:8642/health || exit 1
CMD ["hermes", "gateway", "start", "--api-only"]
```

**Expected idle footprint:** ~300–450 MiB (to be measured in Phase 1 per D-16). If a profile exceeds 500 MiB idle, we investigate what's loaded and trim further.

**Resource limits (per container, Pi-tuned):**
- CPU: 1.0 (network-bound; LLM is remote)
- Memory: 768 MiB (2× expected idle as headroom)
- Pids-limit: 256 (Hermes default)
- Disk: per-user bind-mount, no cap

**Pi 5 budget (8 GiB):**

| Component | RAM | Count | Subtotal |
|---|---:|---:|---:|
| OS + system | 512 MiB | 1 | 512 MiB |
| Gateway (Bun/TS) | 256 MiB | 1 | 256 MiB |
| Local STT | 1024 MiB | 1 | 1024 MiB |
| Home Assistant (if co-located) | 1024 MiB | 1 | 1024 MiB |
| egress-proxy | 64 MiB | 1 | 64 MiB |
| gateway-hosted MCP (in-proc) | 0 | — | — |
| Hermes containers (curated) | 450 MiB | 5 | 2250 MiB |
| **Total planned** | | | **~5.1 GiB** |
| **Headroom** | | | **~2.9 GiB** |

If HA runs on a separate device, the Hermes budget doubles. With 5 always-on profiles at 450 MiB, even co-locating HA and STT we fit comfortably.

**Fallback (Strategy B, on-demand):** if empirical RAM exceeds 600 MiB/profile, switch to this model:
- All profiles are installed on disk.
- Only the active user's container runs. When a different user authenticates, we `docker unpause` theirs (or start if stopped) and `docker pause` the previous (SIGSTOP preserves memory but frees CPU).
- Cold-start (~2–3 s on Pi 5) is masked by gateway emitting a "one sec, Alice" filler through the usual TTS pipeline.

Strategy B doesn't reduce peak RAM (paused containers still own their pages); it only reduces CPU contention. If we truly need to reduce RAM below the always-on budget, we add an eviction policy: on low-memory signal, `docker stop` idle profiles (>15 min inactive), accept a 2–3 s cold-start on their next turn.

**Container network:** `sentient-internal` (Docker bridge, `internal: true`). No host port publish. Gateway addresses each Hermes by service name (`hermes-<user>:8642`).

**Egress:** via `egress-proxy` container with domain allowlist (openrouter.ai, api.anthropic.com, api.openai.com, homeassistant.local). Hermes's `providers.*.base_url` points at the proxy.

**Supervisor:** gateway-side `SessionRouter` uses Docker Engine API (via `/var/run/docker.sock` mounted read-only into gateway). Operations: `start`, `pause`, `unpause`, `stop`, `inspect`. Bootstrap and healthcheck-wait done here.

### 5.2 Gateway↔Hermes adapter (`hermes-client`)

**Transport: HTTP + SSE.** No Unix socket for the Hermes side; no custom Python plugin. We use Hermes's documented `/v1/responses` endpoint and standard SSE.

**File:** `gateway/src/cerebrum/hermes-client.ts`.

```ts
export interface HermesClient {
  dispatch(
    input: HermesTurnInput,
    abortSignal: AbortSignal,
    mode: { bargedIn: () => boolean }
  ): AsyncGenerator<HermesEvent>;
}

export interface HermesTurnInput {
  userId: string;
  cycleId: string;            // our assigned; logged on Hermes side as idempotency key
  userMessage: string;        // labeled-prefix-assembled (D-6)
  conversationId: string | null;
  maxOutputTokens: number;
  tools: ToolManifest;        // static per session; see §5.8
}

export type HermesEvent =
  | { type: "created"; responseId: string; conversationId: string }
  | { type: "text.delta"; delta: string }
  | { type: "tool.started"; callId: string; toolName: string; argsPreview: string }
  | { type: "tool.args.delta"; callId: string; delta: string }  // conditional, see D-3
  | { type: "tool.finished"; callId: string; status: "ok" | "failed"; summary: string }
  | { type: "completed"; usage: { inputTokens: number; outputTokens: number } }
  | { type: "error"; message: string };
```

**Key behaviors:**

1. **Barge-in gating** — the `mode.bargedIn()` callback is queried on every `text.delta`. When it returns true, the delta is still emitted (ConversationMirror consumes it) but the TTS fork is suppressed. This matches D-11.
2. **Abort semantics** — `abortSignal` triggers the fetch abort, closing the SSE connection. Hermes cancels server-side (PR #3427).
3. **Idempotency** — `Idempotency-Key: <cycleId>` on every request. Hermes de-duplicates within 5 min.
4. **Backoff** — 429/5xx retried with jitter (250/500/1000/2000/5000 ms cap, 5 attempts). Final failure surfaces as `error`.
5. **Keep-alive** — Bun `fetch` keeps HTTP connections open across turns for the same user; reduces TCP/TLS overhead.

### 5.3 Event translation: Hermes SSE → wire messages

Full table in Appendix A. Five highlights (revised from v1):

| Hermes SSE | Our wire message | Notes (v2) |
|---|---|---|
| `response.created` | `cycle.started` | `conversationId` captured here. |
| `response.output_text.delta` | `message.delta` + conditionally forked into TTS | Barge-in-gated fork: if `mode.bargedIn() === true`, ConversationMirror still gets the delta but TTS does not. |
| `response.output_item.added` (function_call) | `task.update {running}` | `callId` from item.id. argsPreview: initial snapshot. |
| `response.function_call_arguments.delta` (**conditional** — see D-3) | if present AND tool is `speak` (registered via our MCP), additionally fork into TTS as `tool.args.delta` | If Phase 1 confirms this SSE event shape, we can add speak-as-streaming-tool back without a plugin. |
| `response.completed` | `cycle.completed` + `message.done` + `conversation.entry {assistant, cutoff?}` | If barge-in was in effect, cutoff kind="barge-in"; if SSE was disconnected by our abort, cutoff kind="interrupt". |

### 5.4 Input pipeline

Carried from v1 unchanged at entry points. At dispatch time, AttentionGate builds one user message string with labeled prefixes in arrival order, ending with the user's channel text (or a synthesized `[trigger/attention.ambient_only]` line if agent-initiated).

v2 clarification: because AttentionGate now fires per-turn (D-10) rather than per-iteration, the labeled-prefix block combines *all* ambient events that accumulated since the last turn (not just since the last iteration). This means ambient events are less fragmented in the context.

### 5.5 Output pipeline

**Default (D-3, commits immediately):** TTS decorator chain on `response.output_text.delta`:

```
response.output_text.delta stream
  │
  ▼
BargeInGate      (if session.bargedIn: drop; else pass-through)
  │
  ▼
MarkdownStripper       (remove-markdown)
  │
  ▼
EmojiStripper          (emoji-regex)
  │
  ▼
UtteranceAggregator    (paragraph breaks, max_block_chars=600)
  │
  ▼
EmotionTagger          (Gemini Flash, 2 s timeout, safety fallback)
  │
  ▼
FishAudioSynthesizer
  │
  ▼
ConnectorSink          → wire: connector.audio.start/frame/done
```

**Conditional unlock (D-3, Phase 1 empirical test):** if Hermes emits `response.function_call_arguments.delta` in practice, we add a parallel path:

```
response.output_item.added (function_call name=speak)
  │ begin tracking callId
  ▼
response.function_call_arguments.delta (matching callId, field="text")
  │
  ▼
(same decorator chain as above)
```

This path would coexist with the default: the model's final `response.output_text.delta` is still TTS-ed if present, but if the model chooses to call the `speak` MCP tool, the streaming-arg path runs instead. SOUL.md guides the model toward one-or-the-other. We'd register `speak` on the gateway-hosted MCP (§5.13) with a schema requiring a `text: string` arg.

**Pipeline unit rules** per `.claude/rules/pipeline.md`: each stage is an `AsyncGenerator` decorator unit, one responsibility, one file, one test. New files:
- `gateway/src/tts/stages/barge-in-gate.ts` (new)
- `gateway/src/tts/stages/markdown-stripper.ts` (remove-markdown)
- `gateway/src/tts/stages/emoji-stripper.ts` (emoji-regex)

Preserved (moved from `effects/`):
- `gateway/src/tts/stages/utterance-aggregator.ts`
- `gateway/src/tts/stages/emotion-tagger.ts` (prompt simplified: emotion tags only)
- `gateway/src/tts/fish-audio-synthesizer.ts`
- `gateway/src/session-handlers/session-audio-wire.ts`

### 5.6 Home Assistant dual-path

Unchanged from v1. Disable Hermes's built-in HA gateway (`platforms.homeassistant.enabled: false`). Gateway subscribes to HA WebSocket for observation; HA official MCP server (HA 2025.2+) provides action tools, with HA's "Exposed Entities" UI as the authoritative allowlist.

The v1 refinement for pushing Pi sensors into HA via MQTT and leveraging HA's throttle filter before our observer pulls them carries forward.

### 5.7 Memory, persona, skills partition

Unchanged from v1. Hermes owns long-term memory (`MEMORY.md`, `USER.md`), skills (`skills/`), conversation history (SQLite + JSONL), and persona (`SOUL.md`). Gateway retains `ConversationMirror` (client-UI feed only) and `TaskMirror` (live tool-call table for UI).

### 5.8 MCP servers and tool allowlist

v2 roster (per profile's `~/.hermes/profiles/<user>/config.yaml`):

| Server | Purpose | Transport | Auth |
|---|---|---|---|
| `home_assistant` | Smart-home action | HTTP/SSE (HA 2025.2+) | Bearer (HA LLAT) |
| `gateway` (NEW) | Gateway reach-back tools (identify_user, pause_audio, set_channel) | stdio (via `docker exec`) or Unix socket forwarding | Shared secret or socket permissions |
| `time` (Hermes built-in) | Clock / tz | built-in | — |
| `memory_search` (Hermes built-in) | Past-session recall | built-in | — |

**Static tool list per session.** Per D-12, tool definitions don't change mid-session (cache hygiene). If we later need dynamic capabilities, we accept the cost of session reset.

**Approval gates** (defense-in-depth): HA Exposed Entities UI (layer 1) + Hermes `tools.exclude` (layer 2) + Hermes `approvals.mode: smart` (layer 3) + gateway policy-as-code (layer 4, §8) + AttentionGate rate cap (layer 5).

### 5.9 Conversation history: dual model

GLM's explicit dual model, adopted as D-9:

**Gateway (client-authoritative):** `ConversationMirror` — append-only log mirroring what the client sees. Entries: `user` (text/speech), `assistant` (with optional `cutoff` badge for barge-in/interrupt/length-cap), `tool` (terminal status + summary), `trigger` (ambient event summary, subtle display). Cap: 500 entries per session (eviction: FIFO with first-N-pinned for session replay).

**Hermes (LLM-authoritative):** Hermes's built-in session store (SQLite + JSONL). Owns compression, tool-result pairing, memory integration. Our gateway never reads directly from here.

**Sync (delta-only per turn):** each `hermes-client.dispatch()` sends:
- The user message (with labeled-prefix situation awareness)
- NO prior history — Hermes's `conversation: <conversationId>` is the continuity primitive
- If the gateway knows a prior turn was truncated due to interrupt/barge-in, it prepends a labeled marker: `[meta/prior-turn-cutoff] interrupt` so the model has context

**On divergence:** if for any reason the mirror and Hermes history disagree (e.g., a Hermes compression event loses detail the mirror still has), the mirror is authoritative for the client; Hermes's state wins for LLM context. We don't attempt reconciliation in v1.

### 5.10 AttentionGate preservation under the turn-based model

v2 change (D-10): the AttentionGate fires **once per turn**, not per ReAct iteration. Hermes handles its own multi-step reasoning internally via `max_turns` (renamed from our old `maxIterations`).

**Implications:**
- The salience map, debounce window (80 ms), thresholds (50/100), `max_per_hour` rate cap all carry forward.
- `shouldContinue` (our prior ReAct loop driver) becomes "should re-dispatch because ambient signals arrived during this turn." Hermes handles in-turn iteration on its own.
- `clearPendingConversationSalience()` on interrupt still clears the conversation accumulator; ambient is preserved (per `.claude/rules/architecture.md`).
- `forceFinal` flag retired — Hermes manages its own finalization via `max_turns`.
- New config: `cerebrum.turn.accumulation_window_ms` (how long after turn-start we accept new ambient signals into the SAME turn's user-message). Default 0 ms — the turn's message is frozen at dispatch time. Future tuning might add small windows for "accumulate for 500 ms then dispatch" behavior.

### 5.11 Multi-profile strategy

**Default (Strategy A):** always-on container per user, curated minimal install. See §5.1 for resource budget.

**Fallback (Strategy B):** on-demand with idle eviction. Triggered automatically when:
- Gateway detects RAM pressure (>85% use, >5 min sustained)
- OR number of active profiles exceeds `hermes.profiles.max_concurrent` (default 3)

Eviction policy: least-recently-used profile gets `docker pause` (freeze, keep RAM). If still under pressure after 5 min, LRU gets `docker stop` (free RAM, requires cold-start).

**Routing:** `SessionRouter` binds `userId → (port, bearerKey, conversationId)`. Binding persists across WS reconnects. On user change (via `identify_user` MCP tool from Hermes, §5.13), the router rebinds the session atomically — next dispatch goes to the new user's container.

**Profile onboarding:** a first-seen user causes:
1. Template-render `profiles/<user>/config.yaml` from `gateway/templates/hermes-profile.yaml.tmpl`.
2. Template-render `profiles/<user>/SOUL.md` from `gateway/templates/SOUL.md.tmpl`.
3. Generate a per-user bearer key; store in gateway secret store.
4. Docker-compose-up (or equivalent) the new container on the next available port.
5. Wait for health (≤ 15 s). During wait, webui shows "setting up profile…" state.

**Profile deletion:** user action via webui (future); stops container, removes profile dir, revokes bearer. Out of scope for v1.

### 5.12 ESP32 satellite devices

**Goal:** 3–5 ESP32 devices distributed around the home (kitchen, living room, bedrooms), each with mic + speaker + small OLED/TFT screen. Wake-word triggered (on-device). Connect to the gateway over WS (same protocol as webui).

**Device identity (v1, D-13):**

Each device has a unique `deviceId` (stored in ESP32 NVS at provisioning). The gateway maintains a `device_user_map` in config:

```yaml
devices:
  satellite-kitchen:     { default_user: family,  location: "kitchen",    speak_voice: "fish_family_default" }
  satellite-alice-room:  { default_user: alice,   location: "alice-room", speak_voice: "fish_alice" }
  satellite-bob-room:    { default_user: bob,     location: "bob-room",   speak_voice: "fish_bob" }
  satellite-living:      { default_user: family,  location: "living",     speak_voice: "fish_family_default" }
```

On device WS connect, the gateway resolves `deviceId → default_user`, binds the session to that user's Hermes profile. The webui (phone/laptop) follows a similar pattern (each authenticated browser session binds to a user via login).

**Voice-phrase rebind (v1, D-13):**

Users can say "I am Alice" (or equivalent; configurable phrases). The phrase flows through STT → gateway. The gateway does NOT hardcode intent — instead, the phrase is part of the user message sent to Hermes like any other utterance. Hermes's SOUL.md contains:

> If the user says "I am X" or otherwise asserts a new identity, you MUST call the `identify_user` tool with name=X to rebind the session. Then acknowledge briefly, e.g., "got it, Alice."

Hermes calls `identify_user(name="Alice")` via MCP. Our gateway-hosted MCP handler:
1. Looks up Alice's userId and profile binding.
2. Atomically rebinds the session: `SessionRouter.rebind(sessionId, newUserId)`.
3. Stops routing further turns to the previous container; future turns go to Alice's.
4. Emits a `session.user_changed` wire message (new optional field on `session.ready` — see §6).
5. Returns `{ok: true, user: "alice"}` to Hermes as the tool result.

**In-flight turn semantics on rebind:** the current turn (running against the old user's container) completes its response. The NEXT turn goes to Alice's container, starting a fresh conversation on that container (unless a prior Alice conversation exists and is resumed via `conversationId`). The cutoff is natural — no partial-history carryover — and matches user expectation ("I asked Bob a question; now I'm Alice, and Alice starts fresh").

**Voice-phrase ambiguity:** if Hermes encounters "I am tired" or "I am going to work," SOUL.md's rule triggers ONLY on asserted-identity phrases with a known-user match. If Hermes is unsure, it MUST ask ("did you mean to change user?"). This follows standard "ask before acting" SOUL.md convention.

**Multiple users on one device:** fully supported via the voice-phrase rebind. Kitchen device defaults to `family`; any family member can say "I am Alice" to switch the session. Returning to `family` happens via "that's everyone" or explicit "reset to family."

**Screen rendering:** ESP32 OLED/TFT displays per-turn status derived from the existing wire protocol (`cognition.status` for thinking/acting/idle; `message.delta` for the first few lines of assistant text; `session.user_changed` to show current user name). No new protocol. Renderer code lives on-device; out of scope for this gateway spec.

**Biometric voice-ID (v2+, D-13):** speaker embedding (pyannote or similar) on the gateway, matched against 3–5 enrolled voiceprints per user. Auto-rebind on high-confidence match. Deferred.

### 5.13 Gateway-hosted MCP server

**Purpose:** expose tools to Hermes that must mutate gateway state or reach into gateway-owned resources. Hermes calls them via its standard MCP client.

**File:** `gateway/src/mcp-host/` (new). Implements the MCP server protocol (stdio transport initially; socket later).

**Transport (v1):** the gateway runs its own MCP server as a separate process inside the gateway container, listening on a Unix socket (`/run/sentient/mcp.sock`). Hermes dials it via a stdio wrapper: `command: "nc -U /run/sentient/mcp.sock"`. This requires the socket to be mounted into the Hermes container. Simpler alternative: HTTP with bearer auth over internal network. We pick whichever is simpler in implementation — stdio-over-socket avoids an HTTP framing layer but requires shared FS.

**Registered tools (v1):**

| Tool | Args | Effect | Impact |
|---|---|---|---|
| `identify_user` | `name: string` | SessionRouter rebinds session to named user | confirm (smart-gate via approval rule; skip confirm if name is clearly one of known users) |
| `pause_audio` | `reason?: string` | SessionAudioController.pause(); resume requires explicit tool call or user speech | auto |
| `resume_audio` | `reason?: string` | SessionAudioController.resume() | auto |
| `set_channel` | `channel: "voice"\|"text"` | updates session.channel; gateway suppresses TTS on text | auto |
| `(future) cancel_all_tasks` | — | gateway cancels all interruptable tasks | auto |

**Tool schema** follows MCP spec (JSON Schema for args). Schemas registered at MCP server boot, static per session.

**Why gateway-hosted MCP instead of built-in Hermes plugin:**
- Uses only documented MCP protocol — no Hermes internals.
- MCP server runs in our gateway; full access to gateway state without IPC gymnastics.
- Decoupled: Hermes's MCP client doesn't care how we implement it.
- Upgradable independently.

### 5.14 Interrupt and barge-in

**Barge-in (D-11):** user speaks during TTS playback. Gateway's `BargeInController` detects mic-onset + RMS threshold + outside no-interrupt-window.

Flow:
1. SessionAudioController stops TTS playback IMMEDIATELY (<5 ms, in-process).
2. Gateway emits `playback.stop {cycleId, reason: "barge-in"}` to client.
3. Gateway flips session's `bargedIn` flag.
4. Hermes turn CONTINUES — further `response.output_text.delta` events still arrive. ConversationMirror accumulates them (so the chat feed shows the full assistant reply, truncated with a cutoff badge). TTS sink is suppressed (BargeInGate stage drops them).
5. When Hermes `response.completed` arrives, gateway commits the assistant entry with `cutoff: {kind: "barge-in"}` and flips `bargedIn` back to false.
6. STT pipeline is already processing the user's barge-in speech; when the user's new transcript finalizes, AttentionGate accumulates salience and dispatches the NEXT turn with that transcript as user message.

This preserves the ACTUAL spoken assistant text in the conversation mirror (for UI replay) while cutting audio instantly. Hermes is none the wiser — no abort, no cleanup on its side.

**Hard interrupt (D-8, user Stop button or Escape key):** user explicitly aborts the current turn.

Flow:
1. SessionAudioController stops TTS playback immediately.
2. Gateway emits `playback.stop {cycleId, reason: "interrupt"}` to client.
3. Gateway calls `AbortController.abort()` on the current hermes-client dispatch.
4. Fetch aborts → SSE connection drops → Hermes cancels the run server-side (PR #3427).
5. In-flight tool calls on the Hermes side may complete their side effects — known gap; mitigated via short `max_output_tokens` + smart approval mode for mutators.
6. ConversationMirror entry for this turn's assistant content is committed with `cutoff: {kind: "interrupt", cancelledTaskIds: [...]}`.
7. AttentionGate's conversation salience is cleared (per existing rule); ambient salience preserved.

**Difference vs. barge-in:** hard-interrupt tears down the Hermes turn entirely; barge-in lets it finish with TTS suppressed.

**Task cancel (legacy `cancel_task`, `cancel_all_tasks`):** kept as gateway-hosted MCP tools (§5.13). Hermes calls them; gateway aborts local tasks. Less useful in the Hermes-as-cerebrum world (most "tasks" are Hermes tool calls, which we can't cancel mid-flight) but retained for gateway-local tasks (pause_audio, long-running STT buffer flushes).

---

## 6. Wire protocol preservation contract

Unchanged from v1 in substance. The wire protocol as implemented on 2026-04-21 is frozen for v2. No removals. Additions are optional-only.

**Revised notes:**

| Field | v1/today | v2 under Hermes | User-visible |
|---|---|---|---|
| `cycle.started.triggerKind` | our enum | gains: `ambient.homeassistant`, `ambient.sensor.tonic`, `ambient.agent_initiated`, `user.voice_rebind` (new in v2 for satellite rebind events) | SDK renders unknown as "…" |
| `cycle.completed.effectsInvoked` | our effect names | Hermes tool names, mapped via translator table (e.g., `HassCallService` → "Home Assistant") | Same |
| `conversation.entry.cutoff.kind` | `"interrupt"` \| `"barge-in"` | same; new optional `"length-cap"` for `response.incomplete` | Same; new badge variant |
| `session.ready.cerebrum` | absent | NEW optional `{provider: "hermes", version: string, userId: string, profile: string}` | Diagnostic only |
| `session.user_changed` | absent | NEW message (optional) emitted when `identify_user` MCP tool triggers a rebind. Fields: `{sessionId, previousUser, newUser}` | Satellite screen updates to show new user name |

All wire-protocol changes are additive. Older clients see no regressions.

## 7. Configuration partitioning

**`gateway/config.yaml`** — our gateway.

Carry-forward from v1: `server`, `logging`, `tls`, `session`, `stt`, `tts`, `cerebrum.cycle.*`, `webui.playback.*`.

**Revised `hermes` section (v2):**

```yaml
hermes:
  profiles:
    alice:
      container_name: hermes-alice
      port: 8643
      api_key_env: HERMES_API_KEY_ALICE
      url: "http://hermes-alice:8643"
      profile_dir: "./profiles/alice"
    bob:
      container_name: hermes-bob
      port: 8644
      api_key_env: HERMES_API_KEY_BOB
      url: "http://hermes-bob:8644"
      profile_dir: "./profiles/bob"
    family:
      container_name: hermes-family
      port: 8645
      api_key_env: HERMES_API_KEY_FAMILY
      url: "http://hermes-family:8645"
      profile_dir: "./profiles/family"

  defaults:
    max_output_tokens: 512
    request_timeout_ms: 60000
    idempotency_window_s: 300

  resource_management:
    mode: "always_on"       # or "on_demand"
    max_concurrent: 3        # strategy B eviction threshold
    idle_pause_after_ms: 900000   # 15 min
    idle_stop_after_ms: 3600000   # 60 min
    ram_pressure_threshold_pct: 85
    cold_start_filler_text: "one sec..."

  home_assistant_observer:
    enabled: true
    url: "ws://homeassistant.local:8123/api/websocket"
    token_env: HA_OBSERVE_TOKEN
    watch_domains: [binary_sensor, climate, alarm_control_panel, light, lock, cover]
    watch_entities: []
    ignore_entities: []
    duplicate_state_window_ms: 10000

  mcp_host:
    transport: "unix_socket"
    socket_path: "/run/sentient/mcp.sock"

  tts:
    markdown_stripping_enabled: true
    emoji_stripping_enabled: true

  satellite_devices:
    # Per-device default user mapping
    - device_id: "sat-kitchen-001"
      default_user: family
      location: kitchen
      speak_voice: fish_family_default
    - device_id: "sat-alice-bed-002"
      default_user: alice
      location: alice-bed
      speak_voice: fish_alice
```

**`~/.hermes/profiles/<user>/config.yaml`** — Hermes per-profile. Sample in Appendix B.

**`~/.hermes/profiles/<user>/.env`** — secrets. Docker secret mount, chmod 600.

## 8. Security hardening

Carried forward from v1 (rootless, read-only FS, cap-drop ALL, no-new-privileges, pids-limit, tmpfs, egress proxy, secret management, approval gates, prompt-injection sanitization at gateway boundary, canary tokens). **Additions (D-15):**

### 8.1 Session risk accumulator

New module: `gateway/src/security/risk-accumulator.ts`.

Score every session event:

| Event | Base weight |
|---|---:|
| Prompt-injection pattern detected (Tirith or our regex) | 30 |
| Repeated pattern within 5 min | +20 |
| Role violation attempt (child using admin tool) | 60 |
| HA entity name containing prompt-like text | 15 |
| Tool call against `alarm_control_panel`, `lock` domain | 10 |
| Tool call rejected by policy-as-code | 25 |

Scores decay with a 5-minute half-life.

Thresholds (config):
- `warn` (50): log WARN, optionally surface subtle UI indicator.
- `escalate` (80): require explicit confirmation for ALL tool calls this session.
- `block` (100): end session with `error {code: "security_threshold"}`; optionally notify admin.

### 8.2 Policy-as-code at the gateway MCP boundary

Not every decision should be LLM-mediated. A declarative policy set at our gateway-hosted MCP boundary (§5.13) rejects tool calls that violate hard rules:

```yaml
# gateway/config/mcp-policy.yaml
rules:
  - name: no_identify_user_outside_voice
    tool: identify_user
    condition: "session.channel != 'voice'"
    action: deny
    reason: "Identity changes via voice phrase only"

  - name: no_guest_identify
    tool: identify_user
    condition: "session.user == 'guest'"
    action: deny
    reason: "Guest sessions cannot rebind"

  - name: rate_limit_pause_audio
    tool: pause_audio
    condition: "rate(5m) > 3"
    action: deny
    reason: "Pause spam"
```

Rules are deterministic, LLM-independent. Violations count toward the risk accumulator.

### 8.3 Everything from v1 §8 carries forward

Container isolation, network isolation, secret management, approval gates, input normalization, HA event sanitization, canary tokens, observability, update hygiene — all intact.

---

## 9. Migration: delete / keep / adapt

v1's migration table carries forward. Minor v2 additions:

**Adds (v2):**
- `gateway/src/mcp-host/` (new directory, gateway-hosted MCP server)
- `gateway/src/security/risk-accumulator.ts` + tests
- `gateway/src/security/policy-as-code.ts` + tests
- `gateway/config/mcp-policy.yaml`
- `gateway/src/session-router.ts` (elevated from "new file" in v1 to include satellite routing)
- `gateway/src/sensors/satellite-device-registry.ts` (maps deviceId → default_user)
- `deploy/docker/hermes/Dockerfile.slim` (curated install)

**Deletes (v2):** same as v1; additionally confirm `conversation-history.ts` removal (replaced by `ConversationMirror`), and `cognitive-cycle.ts` ReAct loop state (replaced by per-turn AttentionGate).

---

## 10. Future extensibility

v1's §10 carries forward. v2 additions:

- **Biometric voice-ID** (D-13 deferred): speaker embedding on the gateway. Drop-in — adds auto-rebind to SessionRouter without touching Hermes.
- **Cross-device handoff** ("Alice, come to the kitchen"): gateway emits audio to a different ESP32 based on location detection. Trivially layered on the device registry.
- **ESP32 screen as a primary feedback channel** when voice fails: renders the webui state machine via a lightweight renderer. Already supported by wire protocol.
- **Speak-as-streaming-tool restoration** (D-3 conditional): if Phase 1 confirms `response.function_call_arguments.delta`, wire up the MCP `speak` tool and coexist with text-delta TTS. SOUL.md guides the model.
- **Per-room sensor fusion**: each ESP32 contributes its own RMS ambient + motion events to the salience plane via MQTT → HA → our observer.

---

## 11. Edge cases

v1's §11 carries forward verbatim. v2 additions:

### 11.24 User rebind mid-tool-call

User says "I am Alice" while Hermes is executing a tool on Bob's behalf. The tool completes on Bob's container. The `identify_user` tool call itself is the FINAL action of Bob's turn. The next turn begins on Alice's container. Cutoff badge on Bob's assistant entry reflects the natural end-of-turn (no explicit cutoff).

### 11.25 Rebind to a user with no profile yet

`identify_user("eve")` where Eve has no configured profile. Gateway-hosted MCP handler returns `{ok: false, reason: "unknown_user"}`. Hermes surfaces to user: "I don't know Eve — should I create a profile?" (SOUL.md instruction). If user confirms, a new tool `create_profile(name)` (future) runs. v1 returns a polite denial.

### 11.26 Two devices, two users, same Hermes conversation

Alice is on the kitchen device; Bob is on the bedroom device. Both route to their own containers — no collision. `conversationId` is per-session, not per-container.

### 11.27 ESP32 device disconnects mid-turn

Session stays alive for `session.inactivity_timeout_ms` (5 min default). If the device reconnects within that window, session resumes — ConversationMirror replays via `conversation.snapshot`. If not, session ends; next device connect starts fresh.

### 11.28 Strategy B cold-start UX collision

User speaks to Alice's idle (stopped) container. Gateway needs 2–3 s to boot. Meanwhile:
1. Gateway emits `cognition.status {state: "connecting"}` and optionally a "one sec" filler via TTS.
2. Gateway spawns the container; waits for health.
3. First `dispatch()` goes out once healthy.
4. Typewriter and audio resume as normal.

Per-device filler voice (`speak_voice` per satellite config) means each user hears the filler in their preferred voice.

### 11.29 Hermes profile directory corruption

Hermes SQLite state.db corruption (#5563). Detection: on API call, Hermes returns 500 with "database is locked" or similar. Gateway:
1. Retries once.
2. On second failure, copies the corrupt DB to `<profile>/state.db.corrupt.<ts>` for postmortem.
3. Initializes a fresh DB (loses session continuity for THAT profile).
4. Emits `error` wire message with a user-friendly "memory hiccup" copy.
5. Alerts via log at ERROR level.

Supplemental: weekly `hermes db check` cron on each profile (when idle) to catch corruption early. Future: upstream `hermes db repair` (#5563 proposed fix).

### 11.30 Speech mistaken as "I am X"

STT returns "I am Sean" but Sean isn't a configured user. Hermes's SOUL.md rule: call `identify_user("sean")` ONLY if `sean` appears in the known-users list (provided via ephemeral system prompt per turn, per D-6). Unknown names → Hermes asks clarification, doesn't call the tool. This keeps SOUL.md deterministic.

---

## 12. Testing strategy

Carried forward from v1 with these **v2 additions**:

- **Multi-profile tests**: spin up 3 Hermes containers (alice/bob/family). Verify: concurrent dispatches don't cross-contaminate; `identify_user` rebind atomicity; per-profile memory isolation.
- **Strategy B (on-demand) tests**: idle-evict a profile; send dispatch → verify cold-start is awaited and completes within budget; verify filler plays.
- **Gateway-hosted MCP tests**: contract tests against the MCP protocol; integration test with real Hermes dialing the socket; policy-as-code rule evaluation.
- **Satellite device simulator**: mock-ESP32 WS client that exercises rebind scenarios, disconnect/reconnect, mid-turn leave.
- **Risk accumulator tests**: unit tests on scoring + decay; integration test that reaching `block` threshold terminates session cleanly.

---

## 13. Empirical measurements required before Phase 1 lock

Per D-16, the spec makes conditional commitments. These measurements MUST happen before we cut over any code:

| # | Measurement | Threshold / question | Outcome if met / not met |
|---|---|---|---|
| M-1 | Idle RAM of curated Hermes container on Pi 5 (no active conversation, OpenRouter provider configured, HA MCP dialed) | ≤ 500 MiB/container | Met: Strategy A default (always-on 5 profiles). Not met: Strategy B default (on-demand with eviction). |
| M-2 | Cold-start time: fresh container launch → `/health` 200 with keys loaded | ≤ 3 s | Met: Strategy B viable with filler UX. Not met: re-engineer filler or stay Strategy A regardless of cost. |
| M-3 | Hermes SSE event fidelity: does `/v1/responses` emit `response.function_call_arguments.delta` during tool calls? | present & per-token granularity | Met: unlock speak-as-streaming-tool with gateway-hosted MCP. Not met: stay with text-delta TTS only. |
| M-4 | Hermes SSE on SSE-client disconnect: does the server actually stop generating, or just drop packet delivery? | server-side token generation halts within 2 s | Met: SSE-disconnect interrupt is reliable. Not met: add a follow-up `DELETE /v1/responses/{id}` call (if supported) or document the gap. |
| M-5 | Concurrent request tolerance of single Hermes process: 3 simultaneous `/v1/responses` against same profile | isolated, no cross-leak | Met: can multiplex unusual concurrency if needed. Not met: serialize via per-profile mutex in HermesClient. |

Phase 1 implementation branch starts ONLY after M-1..M-4 have verdicts. M-5 can be measured during Phase 1.

---

## 14. Upstream contributions / local patches

Carried from v1. Priority:

- **F-1**: upstream fix for mid-tool-call cancel (#5244). Nice-to-have.
- **F-2**: upstream `flush_per_turn` config (#5021). Local patch if not merged.
- **F-3**: publish `sentient-hermes-voice-template` as OSS contrib.
- **F-4 (NEW)**: upstream work on SQLite state.db corruption (#5563). Support by providing repro scripts and WAL-mode analysis. Not a v1 blocker (we work around it).

---

## 15. Risks and mitigations

v1 table carries forward. v2 additions:

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Empirical idle RAM overshoots 600 MiB/profile | Medium | Medium | Strategy B fallback defined; measurement gate M-1 forces the decision early. |
| Hermes SQLite state.db corruption hits a profile | Medium | Medium | Detection + auto-reset (11.29); weekly db check; upstream contribution (F-4). |
| Satellite device identity spoofing | Low | Medium | Each device has a device certificate (mTLS) for WS connect — unchanged from current web auth model; extended for ESP32 via mbedtls or similar. Rebind requires valid device cert. |
| `identify_user` abused by child role | Low | Medium | Policy-as-code rule: `identify_user` requires `session.role != "child"`. Rebind to child users allowed; rebind AWAY from child requires physical presence (tap button on device's screen or approval) — v2+ enhancement. For v1, any non-guest can rebind. |
| Hermes profile files out-of-sync with gateway state after manual edit | Low | Low | Profile files are gateway-authored from templates. User-facing edits to `SOUL.md` require an admin workflow — v2+. For v1, profiles are gateway-managed. |

---

## 16. Implementation phases (outline)

Detailed plans authored via `superpowers:writing-plans` after user approval. Outline:

**Phase 0 — Empirical gates.** Run M-1..M-4 (§13). Document outcomes. This is the only phase whose "deliverable" is data, not code. Duration: 1–3 days.

**Phase 1 — Scaffolding + HermesClient.**
- Slim Hermes Dockerfile (curated install).
- `hermes-client.ts` with mocked SSE, unit + integration tests.
- `SessionRouter` with single-user + multi-profile binding.
- Docker-compose.yml for dev with 2 profiles.
- `HermesClient` integration test against real Hermes container.

**Phase 2 — TTS decorator chain + barge-in gate.**
- Extract `utterance-aggregator`, `emotion-tagger` to `tts/stages/`.
- Add `markdown-stripper`, `emoji-stripper`, `barge-in-gate`.
- Unit + integration tests including barge-in semantics.

**Phase 3 — Gateway-hosted MCP.**
- MCP server skeleton (stdio-over-socket).
- `identify_user`, `pause_audio`, `set_channel` tools.
- Policy-as-code integration.
- Risk accumulator skeleton.

**Phase 4 — Switchover under flag.**
- AttentionGate flips from `runCognitiveCycle` to `hermes-client.dispatch()` under `cerebrum.provider = "hermes"`.
- Full wire-protocol parity verified via contract tests.
- Dev deploy on a workstation.

**Phase 5 — HA dual-path.**
- HomeAssistantObserver.
- HA MCP config in per-profile Hermes.
- End-to-end: "turn on living room lights" → audio confirmation.

**Phase 6 — Multi-profile + satellite devices.**
- `SessionRouter` multi-user.
- `satellite-device-registry` + WS auth for ESP32.
- `identify_user` rebind flow end-to-end.
- Satellite device simulator tests.

**Phase 7 — Security hardening + prod compose.**
- Rootless, read-only FS, network isolation, egress proxy, secrets.
- Pi deploy + smoke-test.

**Phase 8 — Delete old code.**
- `cognitive-cycle.ts`, `cognitive-cycle-dispatch.ts`, `conversation-history.ts`, `context-assembler.ts`, most of `effects/`, etc.
- Phase 4/5 superseded plan docs marked or removed.

**Phase 9 — Polish.**
- Multi-user UX (user picker; ESP32 screen UX).
- Metrics dashboard.
- Documentation updates.

Phases are designed so Phase 0's measurements inform Phase 1's direction, and Phases 4–9 are largely independent once Phase 4 is stable.

---

## Appendix A: Hermes SSE → wire-message mapping

(Identical to v1 Appendix A with these v2 additions.)

| Hermes SSE event | Payload fields | Our wire message | Mapping notes |
|---|---|---|---|
| `response.function_call_arguments.delta` (**conditional**; verify in M-3) | `item_id` (callId), `delta` (JSON fragment) | if tool is our MCP `speak`: `tool.args.delta {callId, delta}` + fork into TTS decorator chain | Only emitted if M-3 confirms. |
| `response.output_item.added` (message) | boundary | none | Boundary marker for ConversationMirror entry. |
| `response.completed` with `cutoff` synthesized by gateway on barge-in | gateway-side | `cycle.completed` + `message.done` + `conversation.entry {cutoff: {kind: "barge-in"}}` | Gateway detects barge-in was active during this turn via session state. |

## Appendix B: Sample profile `config.yaml`

```yaml
# Auto-generated by gateway at profile bootstrap.

model:
  provider: openrouter
  model: google/gemini-2.5-flash

providers:
  openrouter:
    base_url: http://egress-proxy:3128/openrouter
    api_key_env: OPENROUTER_API_KEY

agent:
  max_turns: 6
  reasoning_effort: medium

memory:
  memory_enabled: true
  user_profile_enabled: true
  char_limits: { memory: 20000, user_profile: 8000 }

compression:
  enabled: true
  flush_per_turn: true   # F-2 local patch

api_server:
  # env-set: API_SERVER_ENABLED=true, API_SERVER_PORT, API_SERVER_KEY_FILE

approvals:
  mode: smart
  timeout_seconds: 60
  fail_closed: true

terminal:
  backend: local

security:
  redact_secrets: true
  tirith:
    enabled: true

privacy:
  redact_pii: false

platforms:
  homeassistant:
    enabled: false   # disabled; our observer does HA

mcp_servers:
  home_assistant:
    url: http://homeassistant.local:8123/mcp_server/sse
    headers: { Authorization: "Bearer ${HA_MCP_TOKEN}" }
    timeout: 15
    tools:
      exclude: [HassRestart, HassTurnOff_switch.main_water, HassUnlock]

  gateway:
    command: "nc"
    args: ["-U", "/run/sentient/mcp.sock"]
    tools:
      include: [identify_user, pause_audio, resume_audio, set_channel]

display:
  tool_progress: true
  streaming: true
  show_reasoning: false
  personality: minimal
```

## Appendix C: `docker-compose.yml` excerpt

(Same as v1 Appendix C with v2 adjustments: slim Dockerfile, MCP socket mount.)

```yaml
services:
  gateway:
    build: ./gateway
    networks: [sentient-internal, sentient-external]
    ports: ["8888:8888"]
    volumes:
      - ./run/sentient:/run/sentient    # shared with Hermes containers for MCP socket
      - ./profiles:/profiles            # profile dirs (read for templates; write for bootstrap)
      - /var/run/docker.sock:/var/run/docker.sock:ro   # supervisor access
    secrets: [hermes_api_key_alice, hermes_api_key_bob, ha_observe_token]
    depends_on: { hermes-family: { condition: service_healthy } }

  hermes-alice:
    build: { context: ./deploy/docker/hermes, dockerfile: Dockerfile.slim }
    user: "1000:1000"
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    pids_limit: 256
    tmpfs:
      - /tmp:size=256M,nosuid
      - /var/tmp:size=128M,noexec,nosuid
    volumes:
      - ./profiles/alice:/data
      - ./run/sentient/mcp.sock:/run/sentient/mcp.sock   # shared MCP socket
    environment:
      HERMES_HOME: /data
      API_SERVER_PORT: "8643"
      API_SERVER_KEY_FILE: /run/secrets/hermes_api_key_alice
      HA_MCP_TOKEN_FILE: /run/secrets/ha_mcp_token
      OPENROUTER_API_KEY_FILE: /run/secrets/openrouter_api_key
    secrets: [hermes_api_key_alice, ha_mcp_token, openrouter_api_key]
    networks: [sentient-internal]
    mem_limit: 768m
    cpus: "1.0"
    restart: on-failure

  # hermes-bob, hermes-family: same template, different ports/keys/volumes
```

## Appendix D: Glossary

(Carried from v1 with additions:)

| Term | Definition |
|---|---|
| **Satellite device** | An ESP32 with mic + speaker + screen deployed around the home. Wake-word triggered. WS client to our gateway. |
| **Device identity** | The static `deviceId → default_user` mapping in `hermes.satellite_devices` config. |
| **Voice-phrase rebind** | User says "I am X" → Hermes calls `identify_user(X)` MCP tool → gateway's `SessionRouter` rebinds session to X's profile. |
| **Gateway-hosted MCP** | An MCP server running in the gateway process, exposing tools that mutate gateway state. Hermes dials it like any other MCP server. |
| **Strategy A / B** | Always-on per-user containers vs. on-demand containers with eviction. See §5.11. |
| **Session risk accumulator** | A decaying-weighted score of suspicious events within a session. Gates `warn`/`escalate`/`block` actions. |
| **Policy-as-code** | Declarative deterministic rules at the gateway MCP boundary. LLM-independent. |
| **Curated install** | Hermes minus `voice`/`browser`/`vision` extras. Reduces idle RAM from ~1.5 GiB to ~400 MiB (projected; measure in M-1). |
| **Empirical gate** | Phase 0 measurement required before committing to a design branch. See §13. |
| **`HERMES_EPHEMERAL_SYSTEM_PROMPT`** | Hermes env var that injects a per-request system prompt block that is NOT cached into the session. Potentially useful for Strategy F (not used in v2 default). |
