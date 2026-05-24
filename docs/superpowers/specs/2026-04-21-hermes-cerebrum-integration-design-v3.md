# Hermes Cerebrum Integration — Design v3

**Date:** 2026-04-21
**Status:** Draft — supersedes v2 (`...-design-v2.md`). Introduces the **Steward** agent as the canonical ambient-reaction mechanism (deferred implementation; architectural home reserved in v1). Restricts v1 scope to user-originating dispatch only.
**Scope:** Replace the in-gateway cognitive cycle with Hermes Agent (MIT, v0.10.x). V1 integration ships user-session-only. Ambient reactivity (Home Assistant events, sensors, tonic triggers) is re-routed from "inject into every user session" (broken) to "dispatch to a dedicated Steward agent" (Phase 10+, explicitly scoped).

---

## Changelog from v2

| Topic | v2 position | v3 position | Reason |
|---|---|---|---|
| Ambient event routing | Inject labeled-prefix into each user session's next turn | **User sessions are never auto-dispatched for ambient events.** Ambient events are *observed and logged* in v1; in v1.5+, they dispatch to a dedicated **Steward** agent. | v2 had a multi-session broadcast trap: N user sessions each reacting to the same event causes race conditions, redundant actions, salience feedback loops, and cross-user UX collisions (see §3 D-17). |
| Steward agent | Absent | **New §5.15.** Dedicated always-on Hermes instance. Own profile, memory, persona. Consumes ambient salience. Takes actions. Notifies user sessions read-only via gateway-hosted MCP. | Required to deliver the "what makes our system special" (proactive ambient reasoning) without the v2 session-broadcast problem. |
| User→Steward interaction | No such primitive | **User sessions can pull state or request action via gateway-hosted MCP (`query_steward`, `request_steward_action`).** Never direct. | Preserves security boundary and auditable flow. User sessions ask; Steward decides. |
| V1 scope | Included ambient event injection | **V1 user sessions respond only to user-originating events (STT/text).** HA observer remains in place but its output is logged and queued for a future Steward; not surfaced to any session. | Lets us ship the Hermes migration cleanly before taking on the Steward design. |
| "What Hermes provides" reference | Absent | **New §2.5.** Reference card listing Hermes's `.[all]` extras and which ones we enable/disable. | Requested in review. Removes ambiguity about what we're bundling and why the curated Dockerfile exists. |
| Multi-profile naming | `alice`, `bob`, `family` | **Adds reserved profile id `_steward`** for Phase-10 use. Config shape unchanged. | Names the slot; no code yet. |

Everything else from v2 (HA dual-path, markdown/emoji stripping, multi-profile strategies A/B, ESP32 satellite devices, gateway-hosted MCP, session risk accumulator, policy-as-code, empirical gates) carries forward.

---

## Table of contents

1. Motivation
2. Scope and non-goals
   - 2.5 What Hermes provides (reference card)
3. Decision log
4. Architecture overview (v1 today, Steward future)
5. Component design
   - 5.1 Hermes deployment topology (curated install; Steward slot reserved)
   - 5.2 Gateway↔Hermes adapter (`hermes-client`)
   - 5.3 Event translation: Hermes SSE → wire messages
   - 5.4 Input pipeline (v1: user-originating events only)
   - 5.5 Output pipeline (text-delta TTS; speak-as-tool conditional)
   - 5.6 Home Assistant dual-path (observation-logged in v1, dispatched to Steward in v1.5)
   - 5.7 Memory, persona, skills partition
   - 5.8 MCP servers and tool allowlist
   - 5.9 Conversation history: dual model
   - 5.10 AttentionGate: v1 scope and v1.5 split
   - 5.11 Multi-profile strategy (Strategy A default; B fallback)
   - 5.12 ESP32 satellite devices
   - 5.13 Gateway-hosted MCP (elevated component; hosts Steward-interaction tools too)
   - 5.14 Interrupt and barge-in
   - **5.15 Steward agent (future phase — architectural home reserved now)**
6. Wire protocol preservation contract
7. Configuration partitioning
8. Security hardening (+ Steward-specific policies)
9. Migration: delete / keep / adapt
10. Future extensibility
11. Edge cases (incl. Steward scenarios, marked v1.5+)
12. Testing strategy
13. Empirical measurements required before Phase 1 lock
14. Upstream contributions / local patches
15. Risks and mitigations
16. Implementation phases (v1 + Steward phases appended)
- Appendix A: Hermes SSE → wire-message mapping
- Appendix B: Sample per-user profile `config.yaml`
- Appendix C: Sample Steward profile `config.yaml`
- Appendix D: `docker-compose.yml` excerpt (gateway + 2 user Hermes + Steward stub)
- Appendix E: Glossary

---

## 1. Motivation

Our custom cerebrum (AttentionGate + CognitiveCycle + ConversationHistory + ShortTermContext + Effects + TaskManager) has converged on what is substantially a ReAct agent loop with memory, skills, tool dispatch, salience-gated waking, and prompt-injection hardening. Every piece is well-solved in NousResearch Hermes Agent (MIT, v0.10, 108K+ stars). The gateway's real differentiator is voice UX and salience-gated attention. By moving the LLM-brain to Hermes we reclaim ~4000–6000 LOC and refocus on the parts that are special.

**What v3 adds over v2:** a correct ambient-reaction architecture. v2's "inject ambient context into each user session" model is broken under multi-session load. v3 routes ambient reactivity to a dedicated Steward agent in a future phase, while v1 ships a simpler user-reactive scope that doesn't depend on Steward existing.

## 2. Scope and non-goals

**In scope (v1):** everything from v2 except ambient auto-dispatch. User sessions respond to user-originating events (STT, text). HA observation runs but logs/queues events rather than injecting them. Multi-profile deployment on 8 GiB Pi 5, 3–5 ESP32 satellites, gateway-hosted MCP, Phase-0 empirical gates.

**In scope (v1.5+, after v1 is stable):** Steward agent design and implementation. User-session awareness of Steward events (as labeled system messages in their context, not as auto-dispatchers). `query_steward` and `request_steward_action` gateway-hosted MCP tools.

**Non-goals (v1 AND v1.5):**
- On-device LLM inference.
- Biometric speaker identification (deferred; device identity + voice phrase covers family-scale).
- Cross-user memory sharing beyond Steward's household-level `MEMORY.md`.
- Messaging platform gateways (Telegram, Discord, etc.). Hermes supports them; we don't.
- Hermes's Tool Gateway (paid Nous subscription). We use our own providers.

### 2.5 What Hermes provides (reference card)

This is what ships in `nousresearch/hermes-agent:<version>`, what we enable, and what we deliberately strip.

| Capability | How it ships | Our v1 stance |
|---|---|---|
| **ReAct loop + tool dispatch** | Core | **Enabled.** The primary reason we're using Hermes. |
| **LLM provider abstraction** | Core (OpenRouter, Nous Portal, OpenAI, Anthropic, local endpoints) | **Enabled.** Provider configured per profile; call through our egress-proxy container. |
| **Pluggable memory (`MEMORY.md`, `USER.md`)** | Core | **Enabled.** Hermes's auto-memory per user profile. |
| **Skills system (procedural memory)** | Core | **Enabled** but quiet. Hermes may auto-create skills; we don't actively curate in v1. |
| **Context files (`SOUL.md`, `AGENTS.md`, `CLAUDE.md`)** | Core | **Enabled** for `SOUL.md` (our persona template). Others disabled via `skip_context_files` where relevant. |
| **MCP client** | Core | **Enabled.** Home Assistant + gateway-hosted MCP. |
| **Approval gates (`smart`, `manual`, `off`)** | Core | **`smart`** for all user profiles. Required for any mutating tool. |
| **Tirith prompt-injection scanner** | Core | **Enabled.** Supplements our gateway-boundary sanitization. |
| **Compression (50% preflight, 85% gateway)** | Core | **Enabled.** With `flush_per_turn: true` (patched locally if upstream #5021 not merged). |
| **Session continuity (`conversation` parameter)** | Core | **Enabled.** Primary session primitive. |
| **Cron scheduling** | Core | **Reserved for Steward** (Phase 10+). Disabled on user profiles in v1. |
| **Subagent delegation (up to 3 concurrent)** | Core | **Disabled in v1.** Deferred to a Steward workflow in v2+. |
| **Checkpoint / rollback** | Core | **Disabled in v1.** Not useful for voice UX. |
| **File read/write tools** | Core | **Disabled via `disabled_toolsets` config.** Too broad attack surface. |
| **Shell exec tool (`execute_code`, `run_shell`)** | Core | **Disabled via `disabled_toolsets`.** Attack surface. |
| **Terminal backends (local, Docker, SSH, Modal, Daytona, Singularity)** | Core | **`local`** (we handle container isolation at Docker level). |
| **`[voice]` extra: OpenAI-Whisper (STT), Piper (TTS)** | Optional | **Disabled (not installed).** Our gateway owns STT (Deepgram/Flux) and TTS (Fish Audio). |
| **`[browser]` extra: Playwright** | Optional | **Disabled.** No web browsing in v1. |
| **`[vision]` extra: OpenCV** | Optional | **Disabled.** No image analysis. |
| **`[messaging]` extra: 18 platforms (Telegram, Discord, Slack, WhatsApp, Signal, HA gateway, Matrix, Mattermost, SMS, Email, BlueBubbles, WeCom, DingTalk, Feishu, CLI...)** | Optional | **Only CLI retained** for admin-side `hermes` commands. Telegram/Discord/HA-gateway/etc all disabled. |
| **Tool Gateway (paid Nous subscription: web search, image gen, TTS, browser)** | Paid service | **Disabled.** We use our own providers for everything. |

**Net result:** our curated slim Dockerfile produces a Hermes image that's a pure ReAct-agent-over-MCP engine. Everything that looks like an input or output channel (voice, browser, messaging, paid services) is stripped — the gateway owns those.

---

## 3. Decision log

Eighteen decisions. Marked [v1] carried from earlier, [v2] added in v2, [v3] new.

| # | Decision | Rationale | Alternatives |
|---|---|---|---|
| D-1 [v1] | Fork B: Hermes as full cerebrum. | Matches original framing. Highest code-reclaim. | A (LLM-brain only): keeps reinventing memory. C (hybrid): two-memory problem. |
| D-2 [v1] | Disable Hermes built-in HA gateway; HA observation in gateway; HA action via official HA MCP. | Preserves salience differentiator. HA Expose UI is the allowlist. | Built-in gateway: too coarse, wrong response channel. |
| D-3 [v2] | Speak = TTS decorator chain. Conditional unlock as streaming MCP tool if M-3 confirms `function_call_arguments.delta`. | Don't build on unverified Hermes internals. | GLM plugin: brittle APIs. |
| D-4 [v1] | `remove-markdown` + `emoji-regex` for TTS-safe text stripping. | Battle-tested. | LLM stripping: brittle. |
| D-5 [v2] | Multi-profile: one curated container per user; Strategy A default, B fallback. | Preserves per-user isolation at our RAM budget. | Per-request profile swap: not viable. Conversation-ID multi-tenancy: breaks family memory isolation. |
| D-6 [v1] | Situation awareness as labeled prefix in user message (where applicable). | `.claude/rules/llm-protocol.md`. Preserves cache. | `instructions` override: flushes cache. |
| D-7 [v1] | Session continuity via `conversation` parameter. | Hermes preference. | `previous_response_id`: brittle concurrency. |
| D-8 [v2] | Interrupt via SSE disconnect. Mid-tool side effects land (known). | Only API-level mechanism. | Plugin-internal abort: unverified. |
| D-9 [v2] | Dual conversation history: Gateway authoritative for UI, Hermes authoritative for LLM. Delta-only per turn. | Clean separation. Token-efficient. | Send full history each cycle. |
| D-10 [v2] | AttentionGate fires per turn, not per ReAct iteration. | Hermes owns ReAct internally. | Plugin-surfaced iteration events: unverified. |
| D-11 [v2] | Barge-in: continue Hermes turn; discard TTS deltas; accumulate barge-in transcript for next turn. | Works over HTTP SSE. No server-side cancellation needed. | SSE disconnect on barge-in: forces abort. |
| D-12 [v1] | Tools don't change mid-session. | Prompt cache hygiene. | Dynamic tools: cache-buster. |
| D-13 [v2] | ESP32 satellites: device identity + voice-phrase rebind via `identify_user` MCP tool. | Simple, correct for family scale. | Biometric ID: v2+. |
| D-14 [v2] | Gateway-hosted MCP elevated to v1 component. | Enables reach-back tools via documented protocol only. | Custom IPC. |
| D-15 [v2] | Session risk accumulator + policy-as-code at gateway MCP boundary. | Defense-in-depth. | Rely only on Tirith. |
| D-16 [v2] | Empirical gates (M-1..M-5) before Phase 1 lock. | Don't build on assumptions. | Ship and see. |
| **D-17 [v3]** | **V1 user sessions respond only to user-originating events (STT/text). HA observation runs but is LOGGED ONLY in v1; it does not dispatch any session.** | **Multi-session broadcast of ambient events causes: N-way reaction fan-out, privacy leaks across family members, salience feedback loops when one session's reaction changes HA state and re-fires others, and duplicated actions (two users' sessions both lock the door). Fixing this requires a dedicated ambient-reactive agent (D-18).** | **Any multi-session ambient injection scheme we could invent (roles, authority weighting, per-event routing) would reinvent the Steward agent. Defer the functionality, preserve the architecture.** |
| **D-18 [v3]** | **Introduce Steward agent as the canonical ambient-reactor, implemented in Phase 10+. One always-on Hermes instance with dedicated profile, memory, persona. Consumes ambient salience. Takes actions. Notifies user sessions via gateway-hosted MCP, never via auto-dispatch. Named "Steward" over alternatives (Warden, Housekeeper, Concierge, Sentinel).** | **Clean separation: users drive sessions, Steward drives household. No session reacts to ambient events except Steward. Prevents event loops (Steward's own HA actions don't re-trigger its salience; filtered out). Enforces security boundary (users can *query* or *request*, never *force*, Steward action).** | **Multi-session ambient injection: see D-17. Gateway-only reaction (no LLM): loses reasoning. Dedicated non-Hermes worker: reinvents Hermes.** |

---

## 4. Architecture overview

**v1 (initial migration):**

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        CLIENT (webui / SDK / ESP32)                       │
└────────────┬────────────────────────────────────────────────▲────────────┘
             │ WS (frozen wire protocol)                      │
             ▼                                                │
┌───────────────────────────────────────────────────────────────────────────┐
│                      SENTIENT GATEWAY (Bun/TS)                             │
│                                                                            │
│  STT  ───▶  AttentionGate (user-originating events only, D-17) ───▶       │
│                                                                            │
│  HA observer ───▶ AmbientEventLog (persisted; queued for Steward; NOT     │
│                   dispatched to any session in v1)                         │
│                                                                            │
│  AttentionGate (wake) ──▶  HermesClient (per user profile)                │
│                                │                                           │
│                                ▼                                           │
│                    text-delta ──▶ TTS decorator chain                      │
│                    tool-calls ──▶ task.update                              │
│                                                                            │
│  Gateway-hosted MCP: identify_user, pause_audio, set_channel              │
└───────────────────────────────────────────────────────────────────────────┘
       │ HTTP/SSE                              ▲ WS (HA observation)
       ▼                                       │
┌─────────────────────────────┐  ┌─────────────┴──────────────┐
│ Hermes containers (per user)│  │ Home Assistant              │
│ curated slim image          │  │ official MCP for action     │
└─────────────────────────────┘  └─────────────────────────────┘
```

**v1.5+ (Steward enhancement):**

```
(everything above, plus:)

 HA observer / sensors ───▶ AttentionGate.ambient ───▶ StewardDispatcher
                                                              │
                                                              ▼
                                                    Steward Hermes (always-on)
                                                      profile: _steward
                                                      persona: SOUL-steward.md
                                                      memory: household-level
                                                              │
                                                              ├▶ HA MCP (action)
                                                              ├▶ notify_user_session(user, summary)
                                                              │    via gateway-hosted MCP
                                                              │         │
                                                              │         ▼
                                                              │    [injected into user
                                                              │     session context as
                                                              │     labeled system msg]
                                                              └▶ log_event (household memory)

 User sessions (awareness-only):
   Their SOUL.md: "You may be informed of household events and Steward
                   actions. Do not take action in reaction; discuss
                   with the user first if relevant."

 User → Steward:
   gateway-hosted MCP tools (new in v1.5):
     query_steward(question)        → synchronous Q&A
     request_steward_action(summary, tool_hint?) → async request,
                                                    Steward decides
```

---

## 5. Component design

### 5.1 Hermes deployment topology

**Per-user containers:** one curated slim container per human user. Config carried from v2.

**Slim Dockerfile** (`deploy/docker/hermes/Dockerfile.slim`):

```dockerfile
FROM python:3.12-slim-bookworm AS base
RUN pip install --no-cache-dir hermes-agent==<pinned>
# intentionally omitted: [voice], [browser], [vision], [messaging-all]
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

**Expected idle:** 300–450 MiB (verify in Phase 0, M-1).

**Steward container (v1.5+):** same image, different profile. Single always-on instance. Dedicated port (e.g., 8649). Own config directory `~/.hermes/profiles/_steward/`. In v1, this slot is RESERVED (profile directory and port registered in gateway config) but the container is NOT started. Starting it is the Phase 10 task.

**Pi 5 RAM budget (v1):** unchanged from v2 — 5 user profiles × 450 MiB = 2.25 GiB, comfortable within 8 GiB.

**Pi 5 RAM budget (v1.5+ with Steward):** +1 profile × 450 MiB = 2.70 GiB, still comfortable.

### 5.2 Gateway↔Hermes adapter (`hermes-client`)

Unchanged from v2. HTTP + SSE transport. `HermesClient.dispatch()` takes `HermesTurnInput`, yields `HermesEvent`s.

**New v3:** `HermesClient` instances are keyed by `(containerId, profileId)`. Both user-profile clients AND the future Steward client use the same class with different bindings. No Steward-specific adapter class needed.

### 5.3 Event translation

Unchanged from v2.

### 5.4 Input pipeline (v1: user-originating events only)

**v1 scope (D-17):** AttentionGate fires a turn ONLY on user-originating events:

| Source | Signal | Salience key | Dispatches in v1? |
|---|---|---|---|
| STT final transcript | `connector.transcript.final` | `conversation.user.speech` | **Yes.** |
| Text input via composer | `text.input` | `conversation.user.text` | **Yes.** |
| User interrupt | `interrupt` | (clears pending, no dispatch) | No (side effect). |
| HA state_changed (observed) | `sensor.ha.<domain>` | `ambient.ha.<domain>` | **No in v1.** Event is logged to `AmbientEventLog` (new, §5.6) and queued for future Steward. |
| Pi sensor (future) | `sensor.pi.<kind>` | `ambient.sensor.<kind>` | **No in v1.** Same path as above. |
| Tonic state change (future) | `sensor.tonic.<mode>` | `ambient.tonic.<mode>` | **No in v1.** |
| Scheduled trigger / cron | `trigger.cron.<name>` | `ambient.cron.<name>` | **No in v1.** |

**User message assembly (v1):** labeled-prefix format is retained for future ambient injection, but in v1 the user message is simply the user's utterance. No ambient prefixes are added. Example:

```
Alice
```

(Not:)

```
[trigger/homeassistant.state_changed] porch motion at 22:04
Alice
```

The labeled-prefix format is preserved in code (we still route messages through the assembler) so that enabling ambient injection later — for Steward messages — is a config flip.

### 5.5 Output pipeline

Unchanged from v2.

### 5.6 Home Assistant dual-path

**V1 observation (logged only, D-17):**

- `HomeAssistantObserver` subscribes to HA WebSocket exactly as in v2.
- Received events are written to a new `AmbientEventLog` (ring buffer, in-memory + optional SQLite for durability).
- Events are NOT forwarded to AttentionGate's active dispatch path.
- Log entries carry full metadata: source, entity, old_state, new_state, timestamp, inferred salience-key.
- Ring buffer size: 10,000 events (tunable).
- Rationale: we want the signal present and queryable for when Steward comes online. User sessions can also query the log via a future read-only MCP tool (`query_ambient_log`, deferred to v1.5).

**V1 action (same as v2):** Hermes's per-user profile has the HA official MCP configured; action tools are available to user sessions. Hermes calls `HassCallService` etc. as normal tool calls.

**V1.5+ observation:** `AmbientEventLog` feeds Steward's AttentionGate fork. Steward's turn includes recent ambient events as its primary input.

**V1 → V1.5 transition path:** enabling Steward is a config flip + starting the Steward container. No rewrite of the observer or event log.

### 5.7 Memory, persona, skills partition

Unchanged from v2 for user profiles.

**Steward profile (v1.5+):**
- `SOUL-steward.md` — specific persona (see §5.15).
- `MEMORY.md` — household-level facts (not per-user).
- `USER.md` — DISABLED (`memory.user_profile_enabled: false`). Steward doesn't model a user; it models the household.
- Skills — enabled; Hermes may build household-level procedural skills over time.

### 5.8 MCP servers and tool allowlist

**User profile (v1 roster):**

| Server | Purpose | Transport |
|---|---|---|
| `home_assistant` | Smart-home action | HTTP/SSE (HA 2025.2+) |
| `gateway` | Gateway reach-back: `identify_user`, `pause_audio`, `resume_audio`, `set_channel` | stdio over Unix socket |
| `time` (built-in) | Clock / timezone | built-in |
| `memory_search` (built-in) | Past-session recall | built-in |

**User profile (v1.5+ additions):**

| Server | New tool | Notes |
|---|---|---|
| `gateway` | `query_steward(question: string)` → `{answer: string}` | Synchronous. Gateway proxies to Steward; returns answer. Timeout 15 s. |
| `gateway` | `request_steward_action(summary: string, tool_hint?: string)` → `{accepted: bool, reason: string}` | Async. Gateway queues request; Steward sees it in its next turn; may act. Acknowledges acceptance. |
| `gateway` | `query_ambient_log(filter)` → `{events: Event[]}` | Read-only query on AmbientEventLog. For "what sensors fired recently?" user queries. |

**Steward profile (v1.5+ roster):**

| Server | Purpose | Transport |
|---|---|---|
| `home_assistant` | Smart-home action (broader allowlist than user profiles — see §8) | HTTP/SSE |
| `gateway` | Steward-specific tools: `notify_user_session(user, summary, priority)`, `log_household_event(kind, summary)`, `schedule_reminder(...)` | stdio over Unix socket |
| `time` | Built-in | — |
| `memory_search` | Built-in, household-scope | — |
| (cron) | Hermes-native cron for scheduled checks ("every 10 min, review camera state") | built-in |

### 5.9 Conversation history: dual model

Unchanged from v2.

**Addition (v1.5+):** Steward's conversation history is its OWN session. The gateway maintains a `StewardConversationMirror` that records every Steward turn. User sessions don't share this. Instead, when Steward calls `notify_user_session(alice, "porch motion logged; welcome-home routine triggered")`, the gateway pushes a labeled read-only system message into Alice's session context on her NEXT turn:

```
[steward/notice at 22:04] Porch motion detected; welcome-home routine triggered.
Alice's message: "Hey, did you start the welcome-home scene?"
```

Alice's SOUL.md instructs: "You may see `[steward/...]` messages summarizing household events. Do not call tools in reaction unless Alice asks."

### 5.10 AttentionGate: v1 scope and v1.5 split

**V1:** AttentionGate has one track — the user-originating track. Fires on STT and text events per §5.4.

**V1.5+:** AttentionGate splits:

```
AttentionGate
  ├── ConversationTrack (unchanged — user events, per-user-session)
  └── AmbientTrack (new — household-wide, feeds StewardDispatcher)
```

Each track has its own accumulator and thresholds. The ambient track's thresholds might be tighter (Steward should react less aggressively than user requests).

**Event-loop prevention on ambient track:** Steward's own HA actions ARE observed by HA (they're state_changed events). Without handling, Steward's turn to turn off the light would retrigger its own dispatch ("light turned off at 22:04"). Prevention:

1. Every HA call from Steward tags the action with a correlation ID (stored in HA `context.id` field when supported, or in a parallel gateway-side registry).
2. HomeAssistantObserver filters out events where `context.user_id == _steward_ha_user` OR events whose `context.id` matches a Steward correlation within the last 30 s.
3. Fallback: Steward's SOUL.md rule — "when you take a household action, you will see the resulting state change in your next turn. Acknowledge and do NOT re-evaluate unless the state differs from your intent."

### 5.11 Multi-profile strategy

Unchanged from v2. **v3 addition:** Steward is an always-on profile (never subject to Strategy B eviction). Gateway's `SessionRouter` marks it as pinned.

### 5.12 ESP32 satellite devices

Unchanged from v2.

**v3 clarification:** ESP32 devices only bind to human user profiles (not to Steward). Steward has no voice interface — it communicates through gateway-hosted MCP only. If a device wants a Steward-driven action (e.g., a button that says "run night routine"), the device sends a message to its currently-bound user's session, the user's LLM calls `request_steward_action`, and Steward responds.

### 5.13 Gateway-hosted MCP

**v1 tools (for user profiles):**

| Tool | Args | Effect | Impact |
|---|---|---|---|
| `identify_user` | `name: string` | Session rebind | confirm (smart) |
| `pause_audio` | `reason?: string` | Stop current TTS | auto |
| `resume_audio` | `reason?: string` | Resume TTS | auto |
| `set_channel` | `channel: "voice"\|"text"` | Gate TTS output | auto |

**v1.5+ additions (for user profiles):**

| Tool | Args | Effect | Impact |
|---|---|---|---|
| `query_steward` | `question: string` | Sync proxy to Steward | auto |
| `request_steward_action` | `summary: string, tool_hint?: string` | Async request | confirm |
| `query_ambient_log` | `filter: {...}` | Read AmbientEventLog | auto |

**v1.5+ additions (for Steward profile):**

| Tool | Args | Effect |
|---|---|---|
| `notify_user_session` | `user: string, summary: string, priority?: "info"\|"urgent"` | Push labeled system message into user's next-turn context |
| `log_household_event` | `kind: string, summary: string` | Append to gateway's household event journal |
| `schedule_reminder` | `at: ISO-datetime, summary: string, recipient: string\|"household"` | Register a cron entry (Hermes's built-in cron) |

**Transport:** stdio over Unix socket (`/run/sentient/mcp.sock`), shared between gateway and Hermes containers via bind mount. Confirmed per v2 decision.

### 5.14 Interrupt and barge-in

Unchanged from v2.

### 5.15 Steward agent (future phase)

**Purpose:** a single always-on agent that owns ambient reactivity. User/device sessions never auto-react to ambient events.

**Container:** dedicated Hermes instance, profile id `_steward`, slim image, own bearer key, own port (8649 reserved).

**Persona (`SOUL-steward.md`):** a discreet, attentive, quietly competent household steward. Notable traits:

- Avoids action unless confident it helps.
- Prefers logging over acting when uncertain.
- Never initiates voice conversation (has no voice channel).
- Notifies user sessions only when information changes a decision they might make.
- Tight language in `notify_user_session` calls.
- Treats HA state as authoritative (not its own memory).

Sample fragment (from `gateway/templates/SOUL-steward.md.tmpl`):

```markdown
You are the household Steward. Your role is to observe, reason about, and
react to ambient events in the home. You are NOT the family's voice
assistant — each family member has their own. You are behind the scenes.

## What you do
- Receive labeled ambient events in your user messages.
- Decide whether action is warranted. When in doubt, log and wait.
- When you take action, use the fewest tool calls necessary.
- When you want to inform a user, call `notify_user_session` — use it
  sparingly, for things that genuinely affect what that user is doing.

## What you don't do
- Do not speak aloud (you have no TTS).
- Do not impersonate users.
- Do not make changes to user memory or preferences.
- Do not call tools just because you could.

## How to handle your own actions
When you take a household action (e.g., turning off lights), you will
see the resulting state change in your next turn. Do NOT re-evaluate or
reverse your action unless the state differs from your intent.
```

**Dispatch flow (v1.5+):**

1. Ambient event enters `AmbientEventLog` (as in v1).
2. AttentionGate.AmbientTrack accumulates salience.
3. When threshold crossed, `StewardDispatcher` fires:
   - Builds a user message from recent ambient events (labeled-prefix format).
   - Calls `HermesClient.dispatch()` bound to the Steward profile.
   - Consumes SSE events as usual.
4. Steward's tool calls flow through the standard event translator. The gateway's policy-as-code inspects each call against Steward's allowed-tools set.
5. `notify_user_session` calls push labeled system messages into the target user's session context (stored in `ConversationMirror`; shown in their next Hermes dispatch as an `[steward/...]` prefix).

**Security:**
- Steward has broader HA access than user profiles (can control alarm, locks — policy-configurable).
- Steward cannot call `identify_user`, `pause_audio`, or any user-session-mutating tool. Its gateway-hosted MCP is a distinct allowlist.
- Users can request Steward actions (via `request_steward_action`), but Steward always gets the final decision.
- Policy-as-code rules applied to Steward:
  - Can't notify more than 3 users in a single turn.
  - Can't schedule more than 10 reminders per hour.
  - Can't call the same HA service twice within 30s (except explicit retries after failure).

**Event loop prevention:** §5.10.

**Steward conversation history:** visible to admins via webui (v2+); not visible to user sessions. `notify_user_session` is the only leak-path, and it's Steward-authored (summarized).

**When Steward is down:** AmbientEventLog keeps accumulating. Gateway supervisor restarts the container. On recovery, Steward's first turn processes the backlog with a "catching up on N events from the last M minutes" preamble.

---

## 6. Wire protocol preservation contract

Unchanged from v2. **v3 additions (all optional):**

| Field | Under v3 | Visible when |
|---|---|---|
| `cycle.started.triggerKind` | New value `steward.notice` | When user session's turn is triggered by a Steward notify (forces dispatch to acknowledge visibly). |
| `conversation.entry` with `source: "steward"` | New optional `source` field | For `[steward/...]` system-injected messages showing as a subtle chat bubble or banner. |
| `session.ready.capabilities` | Add `steward: boolean` | Client knows if Steward is available; webui can render a "household" pane. |

## 7. Configuration partitioning

**Gateway `config.yaml` additions (v3):**

```yaml
hermes:
  profiles:
    alice:
      container_name: hermes-alice
      port: 8643
      api_key_env: HERMES_API_KEY_ALICE
      url: "http://hermes-alice:8643"
      profile_dir: "./profiles/alice"
      role: user
    bob:
      container_name: hermes-bob
      port: 8644
      api_key_env: HERMES_API_KEY_BOB
      url: "http://hermes-bob:8644"
      profile_dir: "./profiles/bob"
      role: user
    family:
      container_name: hermes-family
      port: 8645
      api_key_env: HERMES_API_KEY_FAMILY
      url: "http://hermes-family:8645"
      profile_dir: "./profiles/family"
      role: user
    # v1: SLOT RESERVED, container not started
    _steward:
      container_name: hermes-steward
      port: 8649
      api_key_env: HERMES_API_KEY_STEWARD
      url: "http://hermes-steward:8649"
      profile_dir: "./profiles/_steward"
      role: steward
      enabled: false    # flip to true in v1.5

  ambient:
    event_log:
      enabled: true
      retention_count: 10000
      persist_path: "./data/ambient-events.db"    # SQLite for crash recovery
    dispatch:
      # v1: disabled; v1.5 flip to true
      steward_enabled: false
      accumulation_window_ms: 2000    # batch multiple events into one Steward turn
      thresholds:
        standard: 60
        immediate: 120

  home_assistant_observer:
    enabled: true
    url: "ws://homeassistant.local:8123/api/websocket"
    token_env: HA_OBSERVE_TOKEN
    watch_domains: [binary_sensor, climate, alarm_control_panel, light, lock, cover]
    # v1: observer still runs; just not dispatched anywhere
```

## 8. Security hardening

All v2 layers carry forward. **v3 additions for Steward-era:**

### 8.1 Steward-specific policy-as-code

```yaml
# gateway/config/mcp-policy-steward.yaml
rules:
  - name: steward_max_notifications_per_turn
    tool: notify_user_session
    condition: "count_per_turn() > 3"
    action: deny
    reason: "Notification flood protection"

  - name: steward_cannot_impersonate
    tool: "*"
    condition: "tool == 'identify_user' OR tool == 'pause_audio' OR tool == 'set_channel'"
    action: deny
    reason: "Steward may not mutate user-session state"

  - name: steward_alarm_confirm
    tool: HassCallService
    condition: "args.domain == 'alarm_control_panel' AND args.service == 'alarm_disarm'"
    action: confirm
    reason: "Disarming alarm requires explicit approval"
```

### 8.2 Steward conversation isolation

- Steward's `ConversationMirror` is stored separately from user mirrors.
- Admin view (webui, v2+) can show Steward history; user views never include Steward's conversation.
- User sessions see only what Steward explicitly pushed via `notify_user_session` — a one-way firewall.

### 8.3 Rate limits

- `request_steward_action`: max 5 per user per hour (policy).
- `query_steward`: max 30 per user per hour (policy).
- Steward's `HassCallService`: subject to HA's own rate limits + our own 30-second-per-service dedup.

### 8.4 Everything else

From v2: container isolation, network isolation, secret management, approval gates, Tirith scanner, input sanitization at boundaries, canary tokens, risk accumulator (user sessions only in v1; extended to Steward sessions in v1.5), HA event sanitization.

## 9. Migration: delete / keep / adapt

V2's table carries forward. **v3 additions:**

- New file: `gateway/src/sensors/ambient-event-log.ts` (ring buffer + optional SQLite persist).
- New file: `gateway/src/cerebrum/steward-dispatcher.ts` (v1.5+; skeleton only in v1).
- New file: `gateway/src/mcp-host/steward-tools/` (v1.5+).
- New file: `gateway/templates/SOUL-steward.md.tmpl` (v1.5+; template committed in v1 for future reference).
- `gateway/config/mcp-policy-steward.yaml` (v1.5+).
- AttentionGate gets a stub for `AmbientTrack` in v1 (never triggered); fully wired in v1.5.

## 10. Future extensibility

V2's list carries forward. **v3 additions:**

- **Steward subagents (v2+):** Hermes's subagent delegation feature lets Steward spin off isolated workers for long-running tasks (e.g., "monitor this sensor for 10 minutes and report any anomalies"). Natural fit.
- **Multiple Stewards per household area** (v2+): one Steward for kitchen-centric events, another for bedroom-area sleep routines. Today: out of scope.
- **Steward-authored skills** (v2+): Hermes's skill auto-creation means Steward can build procedural memory ("whenever porch motion at night + Alice not home → turn on porch light, send notification").
- **Biometric voice ID** (v2+): still deferred. Enables auto-rebind on voice recognition; Steward is not involved.
- **Speak-as-streaming-tool** (v2+ conditional on M-3): same as v2.

## 11. Edge cases

V2's §11 carries forward. **v3 additions:**

### 11.31 Steward crashes mid-turn

Steward container dies during dispatch. Gateway's supervisor restarts. AmbientEventLog still has the queued events. Steward resumes with a "catching up on events from the last N minutes" preamble. If restart loops, gateway emits an admin-level error (log + optional push notification) and disables StewardDispatcher until human intervention. User sessions are unaffected.

### 11.32 User session receives a `notify_user_session` during mid-turn

Alice's session is mid-dispatch when Steward pushes a notification. Options:
- (A) Buffer the notification until Alice's current turn completes. Inject at the start of her next turn. **Chosen for v1.5.**
- (B) Emit as an out-of-band wire message to the webui (doesn't enter Alice's Hermes context).
- (C) Inject mid-turn (messy; might confuse the model).

### 11.33 User asks "what did Steward just do?"

Alice asks explicitly. Her session's LLM calls `query_steward("what did you just do?")`. Gateway proxies to Steward. Steward responds with a brief summary of its recent turn. Alice's LLM relays to Alice.

### 11.34 Steward's action conflicts with user's action

Alice says "lock the door"; at the same instant Steward decides to lock the door. Both issue `HassCallService` calls. HA idempotency handles it (locking an already-locked door is a no-op). Both Steward and Alice's session log the action. The duplicate is visible but not harmful.

### 11.35 Steward takes an action Alice disagrees with

Steward turns off the porch light based on time-of-day rule. Alice wants it on. Alice says "turn on the porch light." Her session calls `HassCallService` to turn it on. Steward's next turn sees the state change, SOUL.md rule kicks in: "the state differs from my intent." Steward recognizes the override and adjusts its internal model (via memory) that Alice sometimes wants the porch light on at that time.

### 11.36 Runaway Steward turn

Steward enters a ReAct loop and exceeds `max_turns`. Hermes caps it. Gateway logs the truncation. Steward's next dispatch has labeled-prefix context of the incomplete attempt.

### 11.37 AmbientEventLog overflow

10,000 events retained; older ones evicted. Not a correctness issue — Steward's memory is the permanent record.

### 11.38 Device rebind mid-Steward-action

Alice is on kitchen device; Steward is processing an ambient burst on her behalf. Alice says "I am Bob" — session rebinds to Bob's profile. Steward's action completes unaffected (Steward is session-agnostic). Any `notify_user_session(alice, ...)` that Steward might emit is queued for Alice's NEXT session (she may re-enter later).

---

## 12. Testing strategy

V2 tests carry forward. **v3 additions (v1.5+):**

- Integration test: simulated ambient event burst → verify Steward dispatches exactly once per accumulated batch, takes expected action, notifies correct user.
- Integration test: Steward's own HA action → verify it doesn't re-trigger Steward's salience (correlation filter works).
- Chaos test: kill Steward container mid-turn → verify recovery and backlog processing.
- Contract test: `notify_user_session` injection produces the right labeled system message in target user's next dispatch.
- Policy test: `request_steward_action` denied for guest role.
- Load test: 100 ambient events in 10 s; AttentionGate accumulation window collapses them into 1–3 Steward turns, not 100.

---

## 13. Empirical measurements required before Phase 1 lock

Unchanged from v2 (M-1..M-5).

**New (before v1.5):** M-6. Steward idle RAM with no ambient activity — target ≤ 500 MiB. M-7. Ambient-event dispatch latency (event arrives → Steward responds) under light load — target ≤ 5 s p95.

---

## 14. Upstream contributions / local patches

Unchanged from v2.

---

## 15. Risks and mitigations

V2 table carries forward. **v3 additions:**

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Steward over-notifies (noisy) | Medium (v1.5 launch) | Medium (UX degradation) | Policy cap of 3 notifications/turn; per-user rate limit in gateway; SOUL.md "sparingly" rule; user-controllable "quiet mode" via `set_channel` on Steward (v2+). |
| Steward under-reacts (misses real events) | Medium | Medium | Salience map tuning; monitoring dashboard showing events → dispatches ratio; admin override to force-dispatch. |
| Steward action conflicts cascade | Low | Medium | Policy rate limits; correlation-ID event-loop prevention; SOUL.md override-recognition rule. |
| Steward's household memory contains PII | Low | Medium | Steward's `MEMORY.md` audited via existing Hermes redaction; access restricted to admin role. |
| Steward becomes a single point of failure | Low | Medium | Supervisor restart; AmbientEventLog persists events through downtime; user sessions unaffected. |

---

## 16. Implementation phases

**Phase 0 — Empirical gates (M-1..M-5).** 1–3 days. Measurements feed Phase 1 config.

**Phase 1 — Scaffolding + HermesClient + curated slim image.** See v2 Phase 1.

**Phase 2 — TTS decorator chain + barge-in gate.** See v2 Phase 2.

**Phase 3 — Gateway-hosted MCP (v1 tools).** `identify_user`, `pause_audio`, `set_channel`.

**Phase 4 — Switchover under flag.** User sessions cut over to Hermes.

**Phase 5 — HA action via MCP.** User can trigger HA via voice. HA observer RUNS in v1 but logs only.

**Phase 6 — Multi-profile + satellite devices.** ESP32s, `identify_user` flow, `SessionRouter` multi-user.

**Phase 7 — Security hardening + prod compose.** Rootless, read-only FS, isolation, secrets.

**Phase 8 — Delete old code.** Cognitive cycle, dispatch, effects, etc.

**Phase 9 — Polish.** UX, dashboards, docs. **End of v1.**

---

**Phase 10 — Steward scaffolding.** (v1.5)
- `AmbientEventLog` persistent version.
- AttentionGate `AmbientTrack` skeleton.
- `StewardDispatcher` (fires to Steward profile).
- `gateway/src/mcp-host/steward-tools/` v1.5 tools.
- `SOUL-steward.md` authored and tested.
- Steward Hermes container enabled.

**Phase 11 — User-session Steward awareness.** (v1.5)
- `notify_user_session` fully wired; labeled system message injection.
- User profiles' SOUL.md updated with Steward awareness rule.
- `query_steward`, `request_steward_action` MCP tools live.
- Integration tests green.

**Phase 12 — Steward correlation and loop prevention.** (v1.5)
- HA action correlation IDs.
- Observer filter for Steward-originated events.
- Chaos tests for restart and backlog recovery.

**Phase 13 — Steward rate limits and policy.** (v1.5)
- Policy-as-code rules for Steward.
- Admin dashboard for Steward activity.
- Runbook for tuning.

**Phase 14 — Production enablement.** (v1.5)
- Deploy Steward to Pi.
- Monitor notification rates for a week.
- Tune thresholds based on telemetry.

Phase 10–14 are scoped as "v1.5." They can be deferred indefinitely without blocking v1 users.

---

## Appendix A: Hermes SSE → wire-message mapping

Unchanged from v2.

## Appendix B: Sample per-user profile `config.yaml`

(Carried from v2 Appendix B. Adds disabled-toolsets for clarity.)

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

compression:
  enabled: true
  flush_per_turn: true

approvals:
  mode: smart
  timeout_seconds: 60
  fail_closed: true

terminal:
  backend: local

# Disable broad toolsets we don't want the LLM to have access to
disabled_toolsets:
  - shell
  - file_write
  - file_edit
  - code_execute
  - web_extract      # we don't enable browser
  - skill_create     # user profiles don't auto-create skills in v1

security:
  redact_secrets: true
  tirith:
    enabled: true

privacy:
  redact_pii: false

platforms:
  homeassistant:
    enabled: false

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
      # v1.5+: add query_steward, request_steward_action, query_ambient_log

display:
  tool_progress: true
  streaming: true
  show_reasoning: false
  personality: minimal
```

## Appendix C: Sample Steward profile `config.yaml` (v1.5+)

```yaml
model:
  provider: openrouter
  model: google/gemini-2.5-flash   # same model as users for v1.5 parity; can diverge

providers:
  openrouter:
    base_url: http://egress-proxy:3128/openrouter
    api_key_env: OPENROUTER_API_KEY

agent:
  max_turns: 4       # Steward should conclude fast
  reasoning_effort: medium

memory:
  memory_enabled: true
  user_profile_enabled: false   # Steward doesn't model a user
  char_limits:
    memory: 30000    # household-level; slightly more headroom than per-user

compression:
  enabled: true
  flush_per_turn: true

approvals:
  mode: smart
  timeout_seconds: 30
  fail_closed: true

terminal:
  backend: local

disabled_toolsets:
  - shell
  - file_write
  - file_edit
  - code_execute
  - web_extract
  - skill_create    # Steward can auto-create skills in v2+; disable in v1.5

platforms:
  homeassistant:
    enabled: false

# Cron enabled — Steward uses Hermes's scheduler
cron:
  enabled: true
  max_concurrent: 3

mcp_servers:
  home_assistant:
    url: http://homeassistant.local:8123/mcp_server/sse
    headers: { Authorization: "Bearer ${HA_MCP_TOKEN_STEWARD}" }
    timeout: 15
    tools:
      # Steward has broader allowlist than users — it can disarm alarm with approval
      exclude: [HassRestart]

  gateway:
    command: "nc"
    args: ["-U", "/run/sentient/mcp.sock"]
    tools:
      include:
        - notify_user_session
        - log_household_event
        - schedule_reminder

display:
  tool_progress: true
  streaming: true
  show_reasoning: false
  personality: minimal

# Steward-specific: different SOUL file
soul_file: SOUL-steward.md
```

## Appendix D: `docker-compose.yml` excerpt

(Shows gateway + 2 user Hermes + 1 Steward stub. Steward stub has `profiles: [v1.5]` so it's excluded from default `docker compose up` until v1.5.)

```yaml
networks:
  sentient-internal:
    driver: bridge
    internal: true
  sentient-external:
    driver: bridge

secrets:
  hermes_api_key_alice: { file: ./secrets/hermes_api_key_alice }
  hermes_api_key_bob:   { file: ./secrets/hermes_api_key_bob }
  hermes_api_key_steward: { file: ./secrets/hermes_api_key_steward }
  ha_mcp_token: { file: ./secrets/ha_mcp_token }
  ha_mcp_token_steward: { file: ./secrets/ha_mcp_token_steward }
  ha_observe_token: { file: ./secrets/ha_observe_token }
  openrouter_api_key: { file: ./secrets/openrouter_api_key }

services:
  gateway:
    build: ./gateway
    networks: [sentient-internal, sentient-external]
    ports: ["8888:8888"]
    volumes:
      - ./run/sentient:/run/sentient
      - ./profiles:/profiles
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./data:/app/data   # AmbientEventLog persist
    secrets: [hermes_api_key_alice, hermes_api_key_bob, ha_observe_token]

  hermes-alice:
    build: { context: ./deploy/docker/hermes, dockerfile: Dockerfile.slim }
    # ... (same template as v2 Appendix C)

  hermes-bob:
    build: { context: ./deploy/docker/hermes, dockerfile: Dockerfile.slim }
    # ... (same)

  hermes-steward:
    profiles: ["v1.5"]    # not started unless --profile v1.5 passed
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
      - ./profiles/_steward:/data
      - ./run/sentient/mcp.sock:/run/sentient/mcp.sock
    environment:
      HERMES_HOME: /data
      API_SERVER_PORT: "8649"
      API_SERVER_KEY_FILE: /run/secrets/hermes_api_key_steward
      HA_MCP_TOKEN_FILE: /run/secrets/ha_mcp_token_steward
      OPENROUTER_API_KEY_FILE: /run/secrets/openrouter_api_key
    secrets: [hermes_api_key_steward, ha_mcp_token_steward, openrouter_api_key]
    networks: [sentient-internal]
    mem_limit: 768m
    cpus: "1.0"
    restart: unless-stopped
    depends_on: []   # Steward can run without user profiles
```

## Appendix E: Glossary

Carried from v2 with additions:

| Term | Definition |
|---|---|
| **Steward** | Dedicated always-on Hermes agent handling ambient reactivity. One per household. Own profile, memory, persona. Implemented in Phase 10+. |
| **AmbientEventLog** | Gateway's persistent log of HA + sensor + cron events. v1: populated but not dispatched. v1.5+: feeds Steward. |
| **AmbientTrack** | The salience accumulator inside AttentionGate that feeds StewardDispatcher. Parallel to the ConversationTrack. |
| **`notify_user_session`** | Steward-side MCP tool. Pushes a labeled system message into a user's next Hermes dispatch. Only path from Steward to user sessions. |
| **`query_steward` / `request_steward_action`** | User-side MCP tools. Read-only query / async action request. Only paths from user sessions to Steward. |
| **Correlation ID (HA action)** | Tag attached to Steward-initiated HA calls. Observer filters Steward's own echo events to prevent loops. |
| **Curated slim image** | `deploy/docker/hermes/Dockerfile.slim` — Hermes without `.[voice]`/`[browser]`/`[vision]`/`[messaging-all]`. Target ≤ 500 MiB idle. |
| **v1 / v1.5 / v2+** | v1 = this spec's Phase 1–9 (Hermes migration, user-session-only). v1.5 = Phase 10–14 (Steward). v2+ = later enhancements (biometric ID, subagents, per-area Stewards). |
