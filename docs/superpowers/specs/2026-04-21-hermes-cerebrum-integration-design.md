# Hermes Cerebrum Integration — Design

**Date:** 2026-04-21
**Status:** Draft — awaiting user review before plan-writing.
**Scope:** Replace our in-gateway cognitive cycle (ReAct loop, effects registry, tool dispatch, memory extraction) with NousResearch's Hermes Agent running as a sidecar container on the same Pi 5. Gateway becomes a thin "ears-eyes-mouth + attention gate" over Hermes. WebUI, SDK, and wire protocol are frozen; zero breaking changes on the client surface. Hermes's built-in Home Assistant gateway is disabled; we route HA through our salience gate for observation and expose HA to Hermes as an MCP tool for action.

**Supersedes (in whole or part):**
- `docs/superpowers/plans/2026-04-04-phase4-classifier-security.md` — intent classifier and prompt-injection defense subsumed by Hermes's 7-layer security model (Tirith scanner, context-file injection detection, MCP credential redaction, approval gates). The classifier's cost-saving "route conversation → cheap model, tools → strong model" is achieved natively via Hermes's Smart Model Routing.
- `docs/superpowers/plans/2026-04-04-phase5-intelligence-layer.md` — tool registry, ReAct loop, skill engine, memory extractor, memory reconciler, guest mode all replaced by Hermes's built-in primitives.
- `docs/superpowers/specs/2026-04-19-speak-as-terminal-tool-design.md` — `speak` as an explicit terminal tool is deprecated in favor of "assistant text → TTS decorator chain." See §5.5 for rationale and what we lose. All wire-protocol signals (`connector.audio.*`, `playback.stop`, `task.update`) the 2026-04-19 spec committed to remain valid.

---

## Table of contents

1. Motivation
2. Scope and non-goals
3. Decision log (exercised autonomy)
4. Architecture overview
5. Component design
   - 5.1 Hermes deployment topology
   - 5.2 Gateway↔Hermes adapter (`hermes-client`)
   - 5.3 Event translation: Hermes SSE → wire messages
   - 5.4 Input pipeline (STT → AttentionGate → Hermes dispatch)
   - 5.5 Output pipeline (Hermes text → markdown-strip → emotion tag → TTS)
   - 5.6 Home Assistant: dual-path (observation + action)
   - 5.7 Memory, persona, skills partition
   - 5.8 MCP servers and tool allowlist
   - 5.9 Multi-profile routing
   - 5.10 AttentionGate and salience preservation
6. Wire protocol preservation contract
7. Configuration partitioning
8. Security hardening
9. Migration: what we delete, keep, adapt
10. Future extensibility points
11. Edge cases
12. Testing strategy
13. Upstream contributions / local patches needed
14. Risks and mitigations
15. Implementation phases (outline only — detailed plans authored separately)
- Appendix A: Complete Hermes SSE → wire-message mapping
- Appendix B: Sample `~/.hermes/profiles/<user>/config.yaml`
- Appendix C: Sample `docker-compose.yml` excerpt
- Appendix D: Glossary

---

## 1. Motivation

We built a custom cerebrum — AttentionGate + CognitiveCycle + ConversationHistory + ShortTermContext + Effects + TaskManager — to drive a family voice assistant. In ~60 days the design has converged on what is substantially a ReAct agent loop with memory, skills, tool dispatch, salience-gated waking, and prompt-injection hardening. Every one of those pieces is a well-solved problem in an OSS framework released Feb 2026: **NousResearch Hermes Agent (MIT, v0.10)**. Hermes ships:

- ReAct loop, streaming tool calls, OpenAI-compatible HTTP API (`/v1/responses`, `/v1/runs`) with SSE.
- Pluggable memory (`MEMORY.md`, `USER.md`, plus pluggable backends), procedural skills, persona via `SOUL.md`, context files.
- First-class MCP integration with per-tool `include`/`exclude` filtering.
- Docker-hardened by default: drop all Linux capabilities except `DAC_OVERRIDE`/`CHOWN`/`FOWNER`, `no-new-privileges`, pids-limit 256, tmpfs `/tmp`/`/var/tmp`/`/run`, SSRF blocking, credential redaction, 7-layer defense-in-depth.
- Smart Model Routing for cost (conversation → cheap model, tools → strong model).
- Multi-profile isolation (per-user memory, skills, persona, sessions).

Our differentiator — the reason people need us and not a stock Hermes install — is the **voice UX and the salience-gated attention model**. Neither is Hermes territory. By moving the LLM-brain layer to Hermes we reclaim ~8k lines of code we shouldn't own, freeze the polished SDK/webui surface, and redirect effort to the parts that are actually special:

- Audio I/O: client-side VAD + WebRTC-AEC + STT + emotion-tagged streaming TTS.
- Attention gate: salience accumulation across conversation + ambient + sensor signals, threshold-gated dispatch, cross-source fusion.
- Multi-user profile routing with our authentication model.
- Situation-awareness injection at each dispatch (our differentiator per user's original framing: "unlike script/cron-based setups").

Hermes is the wrong answer for those. It's the right answer for everything LLM-facing.

---

## 2. Scope and non-goals

### In scope

- Stand up Hermes as a sidecar container (or one-per-user for multi-profile deployments) on the Pi and in local Docker dev.
- Replace `runCognitiveCycle` + effect-dispatch + in-gateway tool execution with an SSE-consuming `HermesClient` that calls `/v1/responses`.
- Replace `ContentTTSPipeline` / `speak-effect` with a text-delta→TTS decorator chain: `text → remove-markdown → emoji-strip → utterance-aggregator → emotion-tagger → TTS`.
- Disable Hermes's built-in Home Assistant messaging gateway (`platforms.homeassistant.enabled: false`) and route HA events through our AttentionGate. Expose HA to Hermes for action via the **official HA MCP server** (HA 2025.2+), scoped via HA's "Exposed Entities" UI.
- Freeze the client-facing wire protocol exactly as it stands on 2026-04-21. All Hermes SSE events translate into existing wire messages; no new top-level message types introduced (only optional fields on existing ones, per §6).
- Keep: SessionAudioController, SessionAuthManager (PASETO-free shared-token), STT pipeline, TTS pipeline, AttentionGate salience logic, WebSocket server, webui, SDK.
- Delete: `gateway/src/cerebrum/cognitive-cycle*.ts`, `conversation-history.ts` (Hermes owns history; we keep a thin client-facing feed mirror), `context-assembler.ts`, effects/ (all except the internal TTS stages), `task-manager.ts` (Hermes owns tool-call lifecycle; we keep a lightweight TaskMirror for UI), and large chunks of in-cycle tool plumbing.

### Non-goals

- No change to STT provider (Deepgram remote or local Flux as configured). No change to TTS provider (Fish Audio).
- No change to client-side VAD, WebRTC loopback AEC, barge-in detection logic.
- No new messaging-platform integrations (Telegram, Discord, Slack) — Hermes supports them but we don't expose them; voice stays primary.
- No change to authentication (sentient-auth shared-token model, STT inbound check). Hermes API is accessed only by our gateway over an internal Docker network; we don't expose Hermes to the LAN.
- No attempt to eliminate the "mid-tool-call interrupt" gap in Hermes (issue #5244) by patching the Hermes codebase as part of initial work. We mitigate via short `max_tokens`, `approvals.mode: smart` on mutators, and UX copy. A follow-up contribution is filed later.
- We do **not** introduce cross-user memory. Each profile's memory is isolated, matching our existing per-user model.

---

## 3. Decision log

Ten load-bearing decisions made with full autonomy. Each is revisable during user review.

| # | Decision | Rationale | Alternatives considered |
|---|---|---|---|
| D-1 | Fork B: **Hermes as full cerebrum.** Hand it ReAct + memory + skills + tool calls. | Matches user's original framing ("our gateway can be simplified as profile management, input parser"). Highest code-reclaim (~8k LOC deleted). Gateway becomes a thin adapter. | Fork A (LLM-brain only): cheaper churn but keeps reinventing memory. Fork C (hybrid): confusing two-memory problem. |
| D-2 | **Disable Hermes's built-in HA gateway; route HA through AttentionGate + expose HA to Hermes via official HA MCP.** | Preserves our "salience-gated" differentiator. Avoids per-event chatty LLM waking. Uses HA's native "Exposed Entities" UI as the allowlist (survives HA upgrades, no code maintenance). | (a) Use built-in gateway: loses salience, prompt-injection surface, wrong response channel. (b) Use `hass-mcp` (community): smaller tool set but no maintained allowlist. (c) Use `ha-mcp` (community): 85 tools, blows up the prompt cache prefix. |
| D-3 | **Speak becomes a decorator chain on text deltas, not a tool.** | User's explicit direction. Hermes's `response.output_text.delta` is the natural stream. Simpler architecture. One less Hermes↔Gateway round-trip per spoken response. | Keep speak as explicit Hermes MCP tool (preserves "visible vs spoken are independent channels" of the 2026-04-19 spec). Rejected because user prioritized simplicity and consistency with Hermes's native output shape. |
| D-4 | **Use `remove-markdown` (npm) + `emoji-regex` for TTS-unsafe text stripping.** Insert as decorator units before emotion-tagger. | Battle-tested, correct on ZWJ/skin-tone emoji. Zero-reinvention. | (a) Zero-dep `/\p{RGI_Emoji}/vg` — works on Bun 1.2+, fine fallback but `emoji-regex` is <2KB and handles edge cases. (b) `strip-markdown` (remark plugin) — heavier, ESM-only. (c) LLM-only stripping — brittle; model drift, token cost, latency. |
| D-5 | **Multi-profile = one Hermes container per user (pattern b).** Our gateway routes `userId → (port, bearerKey)`. | Matches Hermes's native model (one gateway process = one profile). Memory/skills/sessions fully isolated. Each profile can hold a different HA long-lived token and thus a different Exposed Entity set. | (a) Single profile (single-user household): no isolation; fine only for v0. (c) Per-request profile header: not supported by Hermes. |
| D-6 | **Persist situation awareness as a labeled prefix in the user message.** Format: `[sensor/<key>] <summary>\n<user text>`. | Matches existing `.claude/rules/llm-protocol.md` rule. Keeps Hermes's system-prompt cache stable. No cache-breaking per-cycle system-prompt mutations. | (a) `instructions` override per request: flushes cache (confirmed with OpenAI Responses API). (b) Context files (runtime update): Hermes startup-only, not per-cycle. (c) Separate system message at end: Hermes doesn't support custom non-cached system frames. |
| D-7 | **Session continuity via `conversation` parameter, not `previous_response_id`.** | Hermes docs prefer `conversation`; server auto-chains to latest response. No client-side ID tracking. Also maps well to our notion of "one session per authenticated user per WS connection." | `previous_response_id`: explicit but brittle on concurrent cycles, requires state machine in adapter. |
| D-8 | **Accept the mid-tool-call interrupt gap for v1.** Mitigate with short `max_tokens`, `approvals.mode: smart` on mutating tools, and clear UX copy. | Hermes issue #5244 (open) is upstream's problem. The voice UX typically produces short responses — the window is small. | (a) Patch Hermes locally: maintenance burden. (b) Per-run time-cap: heuristic. (c) Contribute upstream: the right long-term move — filed as deliverable F-1 in §13, not a v1 blocker. |
| D-9 | **Keep our own `ConversationMirror` for UI feed, drop `ConversationHistory` as an LLM context store.** The feed mirror's only purpose is populating `conversation.snapshot` / `conversation.entry` wire messages for the webui. Hermes owns the authoritative conversation state. | Avoids dual-sourcing the LLM context. Keeps the webui feed logic that's already polished. | (a) Drop webui feed entirely, reconstruct from wire events: loses session-reconnect replay. (b) Pull full transcript from Hermes `/v1/sessions/{id}/messages`: adds a dependency on a currently-undocumented Hermes endpoint; deferred. |
| D-10 | **AttentionGate stays in our gateway and calls Hermes instead of `runCognitiveCycle`.** The salience map, debounce window, thresholds, ReAct-iteration cap all remain our code. | Differentiator. Our control plane over dispatch decisions. Hermes has no equivalent. | Move salience into Hermes as a "pre-flight" tool: rejected; Hermes's model is "message arrives → think." |

---

## 4. Architecture overview

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                                 CLIENT (webui / SDK)                            │
│   VoiceState FSM · typewriter · task cards · stop button · chat bubbles        │
└────────────┬───────────────────────────────────────────────────────▲───────────┘
             │ WS (sentient wire protocol, FROZEN §6)                │
             ▼                                                       │
┌────────────────────────────────────────────────────────────────────┴───────────┐
│                           SENTIENT GATEWAY (Bun/TS)                             │
│                                                                                 │
│   ┌─────────────┐    ┌──────────────┐    ┌─────────────────────────────────┐   │
│   │ WS handlers │───▶│ Auth +       │───▶│  SessionRouter                  │   │
│   │ (ws-handlers│    │ profile res. │    │  (userId → hermes profile port) │   │
│   │ .ts)        │    │              │    └──────────────┬──────────────────┘   │
│   └─────────────┘    └──────────────┘                   │                      │
│                                                         ▼                      │
│   ┌──────────────────┐     ┌──────────────┐     ┌───────────────────────────┐  │
│   │ STT pipeline     │     │ HA observer  │     │ ShortTermContext          │  │
│   │ (Deepgram/Flux)  │     │ (WS sub to   │     │  ambient events, tonic    │  │
│   └──────┬───────────┘     │  HA WS)      │     │  state                    │  │
│          │                 └──────┬───────┘     └──────────┬────────────────┘  │
│          │                        │                        │                   │
│          ▼                        ▼                        ▼                   │
│   ┌─────────────────────────────────────────────────────────────────────────┐  │
│   │                        AttentionGate                                     │  │
│   │   conversationSalience{}   ambientSalience{}   salience-map.yaml        │  │
│   │   debounce 80ms · thresholds 50/100 · ReAct continuation cap 10         │  │
│   │   emits → onCycle({cycleId, sinceSeq, triggerReason, forceFinal})       │  │
│   └────────────────────────────┬────────────────────────────────────────────┘  │
│                                │                                               │
│                                ▼                                               │
│   ┌─────────────────────────────────────────────────────────────────────────┐  │
│   │                         HermesClient                                     │  │
│   │  POST /v1/responses                                                     │  │
│   │    body: { model, input:[{role:"user",content:"[sensor/k] s\n<user>"}], │  │
│   │            conversation: sessionConversationId,                         │  │
│   │            stream: true, max_output_tokens: 512 }                       │  │
│   │  consumes SSE:                                                          │  │
│   │    response.created       → cycle.started                               │  │
│   │    response.output_text.delta → message.delta + TTS fork                │  │
│   │    response.output_item.added(function_call) → task.update(running)    │  │
│   │    response.output_item.done(function_call) → task.update(finished)    │  │
│   │    response.completed     → cycle.completed + message.done              │  │
│   │    hermes.tool.progress   → task.update(running, argsPreview)           │  │
│   │  on interrupt: close SSE connection + fire playback.stop                │  │
│   └──────────┬──────────────────────────────────────────────────────┬──────┘  │
│              │ text deltas                                           │         │
│              ▼                                                       │         │
│   ┌──────────────────────────────────────────────────────────────┐   │         │
│   │  TTS decorator chain                                          │   │         │
│   │   remove-markdown → emoji-strip → utterance-aggregator       │   │         │
│   │     → emotion-tagger → Fish Audio synthesizer                │   │         │
│   │     → ConnectorSink → connector.audio.*                      │   │         │
│   └──────────┬───────────────────────────────────────────────────┘   │         │
│              │ audio frames                                          │         │
│              └──────────────────────────────┬───────────────────────┘         │
│                                             │                                  │
│                                             ▼                                  │
│                                        (back to client)                        │
└────────────────────────────────────────────────────────────────────────────────┘
                    │ HTTP /v1/responses (SSE)                 ▲ WS (read-only)
                    │                                          │
                    ▼                                          │
┌─────────────────────────────────────────┐   ┌───────────────┴────────────┐
│   HERMES container (per user)           │   │   Home Assistant            │
│   ~/.hermes/profiles/<user>/            │   │   (host or container)       │
│    config.yaml                          │   │                             │
│    SOUL.md   MEMORY.md   USER.md        │   │   "Exposed Entities" UI     │
│    skills/                              │   │   controls what LLM sees    │
│    sessions/ (sqlite + JSONL)           │   │                             │
│                                         │   │   mcp_server integration    │
│   Smart Model Routing                   │   │   (HA 2025.2+)              │
│   7-layer security                      │   │                             │
│   MCP clients (HA, future others)       │◀──┤   /mcp_server/sse (HTTP)   │
└─────────────────────────────────────────┘   └─────────────────────────────┘
```

---

## 5. Component design

### 5.1 Hermes deployment topology

**Pattern:** one Hermes container per user profile (D-5). For v1 the family has 1–5 users, so 1–5 containers. Each is identical in image, differs only in:

- Mounted profile directory: `./profiles/<user>:/data`
- Env vars: `HERMES_HOME=/data`, `API_SERVER_PORT=864N`, `API_SERVER_KEY=<per-user-bearer>`
- Port publish (internal Docker network only, never host-bound): `864N:864N`

**Image:** `nousresearch/hermes-agent:<pinned-version>` — we pin to a specific version in `deploy/docker/docker-compose.yml` and `deploy/pi/docker-compose.yml`. We do NOT track `:latest`.

**Network:** a single internal Docker network `sentient-internal` on which the gateway, Hermes containers, and the local-STT container communicate. Hermes containers do NOT have access to the external `sentient-external` network (which only the gateway uses for OpenRouter/Fish Audio). Hermes's outbound HTTP must go through an egress proxy container (see §8).

**Resource limits (Pi-tuned):**
- CPU: 1.0 per profile (tunable; Hermes itself is network-bound on Pi since LLM is remote)
- Memory: 512 MiB per profile (room for skills + session db)
- Pids-limit: 256 (Hermes default)
- Disk: `~/.hermes/profiles/<user>/` bind-mount, no size cap (SQLite + skills; bounded by natural growth rate)

**Profile bootstrap (new user onboarding):**
1. Gateway detects a new `userId` on auth.
2. Gateway writes a default `profiles/<user>/config.yaml` + `SOUL.md` + `USER.md` from templates.
3. Gateway triggers a supervisor to start the Hermes container on the next available port.
4. Gateway persists the mapping `userId → (port, bearerKey, conversationId)` in its session store.
5. First `POST /v1/responses` lazily creates the `conversation`.

### 5.2 Gateway↔Hermes adapter (`hermes-client`)

**File:** `gateway/src/cerebrum/hermes-client.ts` (new, replaces `runCognitiveCycle`).

**Interface:**

```ts
export interface HermesClient {
  /** Dispatch a cycle. Returns when the run completes or is interrupted. */
  dispatch(input: HermesCycleInput, signal: AbortSignal): AsyncGenerator<HermesEvent>;
}

export interface HermesCycleInput {
  userId: string;
  cycleId: string;
  userMessage: string;            // already-formatted, with labeled SA prefix per D-6
  conversationId: string | null;  // null = new conversation (first cycle of session)
  maxOutputTokens: number;        // from config.yaml
}

export type HermesEvent =
  | { type: "created"; responseId: string; conversationId: string }
  | { type: "text.delta"; delta: string }
  | { type: "tool.progress"; callId: string; toolName: string; argsPreview: string }
  | { type: "tool.result"; callId: string; toolName: string; status: "finished" | "failed"; summary: string }
  | { type: "completed"; usage: { inputTokens: number; outputTokens: number } }
  | { type: "error"; message: string };
```

**Implementation sketch:**

- One HTTP client per session (Bun's `fetch` is keep-alive-friendly; we reuse connections).
- `signal` wired to `AbortController` — on abort, we call `abort()` on the fetch and on the SSE reader. Hermes cancels the server-side run on connection drop (PR #3427).
- SSE parser follows W3C EventSource semantics. We use `@microsoft/fetch-event-source` or hand-roll (~30 LOC).
- Bearer key from `hermes.profiles[userId].apiKey` in gateway config.
- Idempotency: send `Idempotency-Key: <cycleId>` header on every request (Hermes de-duplicates within a 5-minute window — protects against our gateway restarts mid-cycle).

**Session continuity (D-7):**
- First cycle: omit `conversation`. Capture `conversationId` from `response.created` event. Persist on session state (`SessionPersistence`).
- Subsequent cycles in the same session: pass `conversation: conversationId` in the request body.
- Session expiry: on our inactivity timeout (`session.inactivity_timeout_ms`), we drop the `conversationId`. Next dispatch starts a new conversation. Hermes's own session DB keeps history for its own continuity searches.

**Rate-limit and backpressure:**
- Inherit AttentionGate's existing `max_per_hour` cap as a circuit-breaker. Breach → we emit `error` wire message and stop dispatching new cycles for the remainder of the window. Current cycle completes.
- If Hermes returns HTTP 429, back off with exponential jitter (250ms, 500ms, 1s, 2s, cap 5s). On 5 failures, surface error to webui.

**Error model (following clean-code § error-handling.md):**
- Network error / timeout → emit `HermesEvent{type:"error"}` → translated to wire `error` message → webui shows toast, session stays alive.
- 4xx (bad request, auth) → hard fail, log, emit error. Indicates gateway bug.
- 5xx (Hermes crash) → retry once, then hard fail. Supervisor restarts Hermes container.
- SSE malformed → abort, emit error.

### 5.3 Event translation: Hermes SSE → wire messages

Full table in **Appendix A**. Summary of the five critical translations:

| Hermes SSE | Our wire message | Notes |
|---|---|---|
| `response.created` | `cycle.started {cycleId, triggerKind, triggerSource}` | cycleId = our locally-assigned (not Hermes `responseId`). Store `responseId` in `SessionPersistence` for audit. |
| `response.output_text.delta` | `message.delta {cycleId, delta}` AND fork into TTS chain | `delta.delta` field carries the token-text. Same string goes to both sinks. |
| `response.output_item.added` where item.type=`function_call` | `task.update {taskId, toolName, cycleId, status:"running", argsPreview, startedAtMs}` | taskId = Hermes `callId`. argsPreview comes from `item.arguments` if present, else from first `hermes.tool.progress` event. |
| `response.output_item.done` (function_call) | `task.update {..., status:"finished" or "failed", endedAtMs}` | status derived from presence/absence of error in the item. |
| `response.completed` | `cycle.completed {cycleId, effectsInvoked:[toolNames]}` + `message.done {cycleId}` + `conversation.entry {kind:"assistant", content:<accumulated text>}` | Effects list is the set of toolNames seen this run. |

### 5.4 Input pipeline

Unchanged at the entry points:
- `text.input` (client message) → gateway `text-adapter` → ConversationMirror append + AttentionGate salience bump.
- STT final transcript → `conversation.transcript.final` wire message → ConversationMirror append + AttentionGate salience bump.
- HA event (new path, §5.6) → ShortTermContext inject → AttentionGate ambient bump.
- Future sensor sources (Pi mic ambient, wake-word, time-of-day) plug into ShortTermContext identically.

**At dispatch time**, AttentionGate builds one user-message string with labeled prefixes, in arrival order:

```
[trigger/homeassistant.state_changed] front_door binary_sensor: off → on at 21:04 (cooldown 30s enforced)
[sensor/tonic.evening_mode] living_room lights dim; user in evening routine
[user/speech] Did I lock the front door?
```

Rules:
- The final segment is the user-channel text (what they typed or said). If purely ambient, the final segment is `[trigger/attention.ambient_only] (agent-initiated check)`.
- Each segment ≤ 400 chars (truncated). Total message ≤ 2000 chars (truncated from the top ambient segments, never the user channel).
- State values are JSON-stringified when they could contain user-controlled text (entity friendly names, notes). Defense-in-depth against prompt injection — layered on top of Hermes's own Tirith scanner.

Sent to `hermes-client.dispatch()` with `conversationId` from the session state.

### 5.5 Output pipeline

Replace `gateway/src/effects/speak-effect.ts` + its sub-pipeline with a decorator chain that consumes `HermesEvent{type:"text.delta"}` stream:

```
text-delta stream
  │
  ▼
MarkdownStripper       (remove-markdown, drop on ``` code fences entirely, keep paragraphs)
  │
  ▼
EmojiStripper          (emoji-regex replace-with-empty)
  │
  ▼
UtteranceAggregator    (block on paragraph breaks or max_block_chars=600)
  │
  ▼
EmotionTagger          (Gemini Flash, 2s timeout, safety fallback)
  │
  ▼
FishAudioSynthesizer   (TextStreamSynthesizer interface)
  │
  ▼
ConnectorSink          → wire: connector.audio.start / .frame / .done
```

**Each stage = one decorator unit** per `.claude/rules/pipeline.md`: `AsyncGenerator` in, `AsyncGenerator` out, one file, one responsibility, one test file.

**New files:**
- `gateway/src/tts/stages/markdown-stripper.ts` (~40 LOC using `remove-markdown`)
- `gateway/src/tts/stages/emoji-stripper.ts` (~30 LOC using `emoji-regex`)

**Preserved files** (moved, interfaces unchanged):
- `gateway/src/tts/stages/utterance-aggregator.ts` (was `effects/utterance-aggregator.ts`)
- `gateway/src/tts/stages/emotion-tagger.ts` (was `effects/emotion-tagger.ts`) — emotion-tagger prompt is UPDATED: we no longer ask it to strip markdown (deterministic strippers own that); we ONLY ask for emotion tagging. Prompt is simpler, faster, cheaper.
- `gateway/src/tts/fish-audio-synthesizer.ts` (was `providers/fish-audio.ts`)
- `gateway/src/session-handlers/session-audio-wire.ts` (ConnectorSink, unchanged)

**What we lose vs. the 2026-04-19 speak-as-terminal-tool spec:**
- The model can no longer produce divergent "visible markdown report + short spoken summary." Everything assistant text = everything spoken.
- Mitigation: Hermes's SOUL.md prompt tells the model "You are a voice assistant. Your responses are always read aloud. Keep them concise, prosody-friendly, no markdown formatting." This is reliable with modern models. If the model slips and emits markdown, the stripper is defense-in-depth.
- Future reversal path: re-introduce `speak` as an explicit MCP tool exposed from our gateway to Hermes. The tool's handler streams the text arg through the same decorator chain. Text that wasn't inside a speak call goes to the visible feed only. Kept as an extensibility point (§10).

**Barge-in integration:**
- SessionAudioController owns the audio plane (unchanged). On barge-in: stop TTS playback immediately, drain decorator chain, drop in-flight frames. In parallel we abort the HermesClient SSE stream so Hermes stops generating. Token generation stops at the next iteration boundary (typically ≤ 200ms). Any in-flight tool calls complete their side effects — known gap (D-8).

### 5.6 Home Assistant: dual-path (observation + action)

**Disable** Hermes's built-in HA gateway:

```yaml
# ~/.hermes/profiles/<user>/config.yaml
platforms:
  homeassistant:
    enabled: false
```

**Observation path (our code, feeds AttentionGate):**
- New file: `gateway/src/sensors/home-assistant-observer.ts`.
- Connects to HA WebSocket (`ws://homeassistant.local:8123/api/websocket`), authenticates with its own LLAT (separate from the one Hermes uses).
- Subscribes to `state_changed` events.
- Filters by `watch_domains` + `watch_entities` (config in `gateway/config.yaml`; see §7).
- Translates each matched event to an `InjectEvent` and pushes to `ShortTermContext`.
- Salience key format: `sensor.ha.<domain>` (e.g., `sensor.ha.binary_sensor`, `sensor.ha.climate`). Salience map assigns weights.
- Human-readable formatting: ported from Hermes's built-in template table (short list, ~10 domains). Stored in `gateway/src/sensors/ha-event-templates.ts`.
- Cooldown: our salience debounce already coalesces events; we additionally drop duplicate state transitions within 10s per entity.

**Action path (Hermes MCP, Hermes code):**
- We use the **official HA MCP server** shipped in HA 2025.2+ (`mcp_server` integration, `/mcp_server/sse` HTTP endpoint).
- Exposure controlled via HA's "Settings → Voice assistants → Expose" page. Per-user HA long-lived tokens let us give different users different Exposed Entity sets (e.g., parents expose alarm; kids don't).
- Hermes config:

```yaml
mcp_servers:
  home_assistant:
    url: http://homeassistant.local:8123/mcp_server/sse
    headers:
      Authorization: "Bearer ${HA_MCP_TOKEN}"
    timeout: 15
    connect_timeout: 5
    tools:
      include: []    # empty = all exposed tools allowed (HA's allowlist is authoritative)
      exclude:
        - HassRestart
        - HassTurnOff_switch.main_water   # explicit double-lock on high-blast entities
```

**Fallback server** if HA 2025.2+ MCP isn't available on user's HA install: `voska/hass-mcp` (Docker image). Config provided in Appendix B. We do NOT use `homeassistant-ai/ha-mcp` because its 85 tools blow up the cacheable prompt prefix.

**Bootstrap order:**
1. HA must be reachable before Hermes starts (HA MCP is dialed during Hermes init).
2. Docker-compose `depends_on` with a healthcheck.
3. If HA is down, Hermes starts with the MCP server in "error" state; tool calls to HA return an error string. Our gateway's HA observer also shows as disconnected until HA returns. We publish a `connector.offline` wire message (needs verification against existing protocol — if not present, add as optional field on existing `error` message).

### 5.7 Memory, persona, skills partition

Hermes owns all of this:

- **Persona:** `profiles/<user>/SOUL.md` — voice-assistant flavored system prompt. Template lives in our repo (`gateway/templates/SOUL.md.tmpl`), rendered per user at profile bootstrap.
- **Long-term memory:** Hermes's built-in `MEMORY.md` + `USER.md`. Auto-curated by Hermes; we do not write to these.
- **Procedural memory (skills):** Hermes's `skills/` dir. Agent-created. User can browse via a future `/skills` webui panel (out of scope for v1).
- **Conversation history (for LLM):** Hermes's session store (SQLite + JSONL).

We retain for UI purposes only:

- **ConversationMirror** — a thin append-only log of user+assistant turns, used exclusively to populate `conversation.snapshot` and `conversation.entry` wire messages for session reconnect replay. Not read by any LLM-facing code.
- **TaskMirror** — live table of Hermes tool calls for the current cycle, used to drive `task.update` wire messages and the sidebar UI. Ephemeral; cleared on cycle completion.

What we **delete**:
- `gateway/src/cerebrum/conversation-history.ts` (as an LLM context store; the mirror above replaces its UI role)
- `gateway/src/cerebrum/context-assembler.ts`
- `gateway/src/memory/*` (all LOC from the Phase 5 memory plan, wherever it's been partially built)
- `gateway/src/skills/*`

### 5.8 MCP servers and tool allowlist

**v1 MCP roster** (configured in each profile's `config.yaml`):

| Server | Purpose | Transport | Auth |
|---|---|---|---|
| `home_assistant` | Smart-home action (see 5.6) | HTTP/SSE | Bearer (HA LLAT) |
| `time` (Hermes built-in) | Time + timezone queries | built-in | — |
| `memory_search` (Hermes built-in) | Search prior sessions | built-in | — |

**Intentionally excluded from v1:**
- `web_search` / `firecrawl` / `exa` — requires additional API keys; defer.
- `filesystem` — Pi local filesystem shouldn't be LLM-addressable.
- `github` / developer MCPs — irrelevant to family voice assistant.

**Future (v2+, listed as extensibility in §10):**
- Calendar (Google Calendar MCP or HA calendar integration)
- Weather (HA integration or dedicated MCP)
- Timer / alarm (Hermes built-in timer, wired into HA notification)

**Tool allowlist strategy (defense-in-depth):**
1. **Layer 1: HA Exposed Entities.** The UI on HA controls what entities even appear to MCP callers.
2. **Layer 2: Hermes `tools.exclude`** in config.yaml. Explicit blacklist for known-dangerous tool names.
3. **Layer 3: Hermes approvals.** `approvals.mode: smart` — any tool matching dangerous patterns (destructive, bulk, system) requires approval. In voice mode, approval requests surface as a `tool.confirm_request` wire message → modal in webui (already implemented).
4. **Layer 4: Rate-limit at the AttentionGate.** `max_per_hour` cycle cap → caps any action rate.

### 5.9 Multi-profile routing

**Gateway-side router** (`gateway/src/session-router.ts`, new):

```ts
interface HermesProfileBinding {
  userId: string;
  port: number;           // Hermes API port (8643, 8644, ...)
  apiKey: string;         // bearer for this profile
  conversationId: string | null;  // per-session; mutable on inactivity reset
}

interface SessionRouter {
  bind(sessionId: string, userId: string): HermesProfileBinding;
  release(sessionId: string): void;
}
```

**Binding lifecycle:**
1. WS open → auth → `userId` resolved.
2. Router looks up or allocates a port for `userId` (allocation on first login; persists in disk config).
3. If no Hermes container is running for that port, router calls supervisor (`scripts/supervise-hermes.sh` or Docker API) to start one. Wait for `/health` to return 200 (≤10s timeout).
4. Return binding. HermesClient uses it for all dispatches in this session.
5. WS close → `release()`. Container stays running (Hermes's own session persistence benefits from not being cold-started).

**Supervisor:** deferred to deployment layer. In dev: docker-compose brings all known profiles up. In prod (Pi): a systemd unit per profile, or a simple `docker compose up` of a generated compose file — specifics punted to `deploy/` planning.

**Cold-profile cost:** a freshly-started Hermes container takes ~3–5s to be ready. We show the webui "Connecting…" state during this. Subsequent cycles hit a warm process.

### 5.10 AttentionGate and salience preservation

**File:** `gateway/src/cerebrum/attention-gate.ts` — kept as-is structurally. Only the `onCycle` callback signature changes.

**Before:**
```ts
const outcome = await callbacks.onCycle({
  cycleId, sinceSeq, triggerReason, forceFinal,
});
// outcome: { aborted, shouldContinue }
```

**After:**
```ts
const outcome = await hermesDispatcher.runCycle({
  cycleId, sinceSeq, triggerReason, forceFinal,
  userId, conversationId,   // new
  userMessage,              // built by AttentionGate from conversation + ambient
});
// outcome: { aborted, shouldContinue }
// shouldContinue derived from whether the final Hermes event set includes non-terminal tool results
// (Hermes's ReAct already continues internally; our "continue" signal drives re-dispatch when we
//  want the model to process ACCUMULATED AMBIENT events that arrived mid-cycle.)
```

**Kept verbatim:**
- Salience map (`salience_map.yaml`)
- Debounce window (80ms), thresholds (50/100), max_per_hour (120), max_iterations (10)
- `clearPendingConversationSalience()` on interrupt (keeps ambient backlog — per `.claude/rules/architecture.md`)
- ReAct continuation loop

**Subtle change:** today we set `shouldContinue` based on whether the cycle emitted specific tool calls that imply "work not done." With Hermes, `shouldContinue` only fires when ambient signals arrived during the cycle that weren't included in the original dispatch. Hermes handles its own ReAct internally; our "continuation" is specifically about re-dispatching to include late-arriving ambient state. This is simpler and more correct.

---

## 6. Wire protocol preservation contract

**Commitment:** the wire protocol as implemented on 2026-04-21 is frozen for v1. No message types removed, no field removed. Additions allowed only if they're optional.

All existing messages are re-sourced from Hermes SSE per Appendix A. A small number of fields that today carry internally-interesting data will carry slightly different content:

| Field | Today | Under Hermes | User-visible impact |
|---|---|---|---|
| `cycle.completed.effectsInvoked` | our local effect names (`speak`, `configure`, …) | Hermes tool names from `function_call` output items | Webui shows tool names in the sidebar. These names become Hermes-provided (e.g., `HassCallService`, `search_memory`). A mapping table in the adapter translates common Hermes tool names to user-friendly labels (e.g., `HassCallService` → "Home Assistant"). |
| `task.update.toolName` | same as above | same as above | Same mitigation. |
| `conversation.entry` for assistant messages | constructed from our LLM stream | constructed from accumulated `response.output_text.delta` | Same shape, different source. |
| `cognition.status.state` | `idle`/`thinking`/`acting` from our state | derived from SSE events: `thinking` = between `response.created` and first `function_call`; `acting` = during any `function_call`; `idle` = between runs | Exact same three states. Mapping lives in HermesClient. |

**Added (optional) fields:**
- `session.ready.cerebrum: { provider: "hermes", version: string }` — optional, for diagnostics only. SDK ignores if absent.
- `cycle.started.triggerKind` gains new enum values: `ambient.homeassistant`, `ambient.sensor.tonic`, `ambient.attention.agent_initiated`. Existing values unchanged. SDK already renders unknowns as "…" per clean-code philosophy.

**Removed (planned):** none. Any wire-protocol removal requires its own deprecation cycle and is out of scope.

---

## 7. Configuration partitioning

Config lives in three places:

**`gateway/config.yaml`** — our gateway (unchanged sections listed briefly):
- `server`, `logging`, `tls`, `session`, `stt`, `tts`
- `cerebrum.cycle.*` (debounce, thresholds, max_per_hour, max_iterations — salience still ours)
- `cerebrum.salience_map_path`
- `webui.playback.*`

**New section in `gateway/config.yaml`:**
```yaml
hermes:
  # Per-user profile bindings.
  profiles:
    default:
      port: 8643
      api_key_env: HERMES_API_KEY_DEFAULT
      url: "http://hermes-default:8643"
  defaults:
    max_output_tokens: 512
    request_timeout_ms: 60000
    idempotency_window_s: 300
  home_assistant_observer:
    enabled: true
    url: "ws://homeassistant.local:8123/api/websocket"
    token_env: HA_OBSERVE_TOKEN
    watch_domains: [binary_sensor, climate, alarm_control_panel, light, lock, cover]
    watch_entities: []
    ignore_entities: []
    duplicate_state_window_ms: 10000
  tts:
    markdown_stripping_enabled: true
    emoji_stripping_enabled: true
```

**Deleted keys from `gateway/config.yaml`:**
- `llm.*` (provider, model, max_tokens, timeout_ms, use_tool_calling, stream) — moves to Hermes config.
- `cerebrum.conversation_history.max_entries` — we no longer bound history on our side; Hermes owns it. (Our ConversationMirror uses a fixed-size buffer, config via a new `cerebrum.conversation_mirror.max_entries` with default 500.)

**`~/.hermes/profiles/<user>/config.yaml`** — Hermes per-profile config. Authored from a template at profile bootstrap. See Appendix B for the full template.

**`~/.hermes/profiles/<user>/.env`** — secrets (API keys). Chmod 600. Injected via Docker secrets, not plain bind-mount.

---

## 8. Security hardening

Build on Hermes's defaults (§1) and add these layers:

### 8.1 Container isolation

**Dockerfile changes** (applied in our `deploy/docker/` compose overlay since we don't own the Hermes image):

```yaml
services:
  hermes-<user>:
    image: nousresearch/hermes-agent:<pinned>
    user: "1000:1000"
    read_only: true
    cap_drop: ["ALL"]
    security_opt:
      - no-new-privileges:true
      - seccomp:default
    pids_limit: 256
    tmpfs:
      - /tmp:size=512M,nosuid
      - /var/tmp:size=256M,noexec,nosuid
      - /run:size=64M,noexec,nosuid
    volumes:
      - type: bind
        source: ./profiles/<user>
        target: /data
        read_only: false   # Hermes writes memory/skills here
      - type: bind
        source: ./profiles/<user>/.env
        target: /data/.env
        read_only: true
    environment:
      HERMES_HOME: /data
      API_SERVER_ENABLED: "true"
      API_SERVER_PORT: "864N"
      API_SERVER_KEY_FILE: /run/secrets/hermes_<user>_key
    secrets:
      - hermes_<user>_key
    networks:
      - sentient-internal
    healthcheck:
      test: ["CMD", "curl", "-f", "-H", "Authorization: Bearer $(cat /run/secrets/hermes_<user>_key)", "http://localhost:864N/health"]
      interval: 30s
      timeout: 5s
      start_period: 30s
```

**Notes:**
- `user: "1000:1000"` — rootless. Hermes profile dir must be chowned to 1000:1000 by the host before start.
- `read_only: true` on root FS — Hermes writes only to `/data` (mounted) and tmpfs paths.
- `API_SERVER_KEY_FILE` — Docker secret rather than env. Requires Hermes to support file-based key (verify; fallback is env + chmod).
- No host port publish. Hermes is addressable only from the gateway container via the internal network.

### 8.2 Network isolation

Two Docker networks:
- `sentient-internal` — gateway, Hermes containers, local-STT. No external connectivity by default.
- `sentient-external` — gateway only. Outbound access to OpenRouter, Fish Audio, Deepgram.

Hermes needs outbound access for LLM calls (when using an external provider). We handle this via an **egress proxy container** (Squid or tinyproxy) on `sentient-internal`, with an allowlist of domains:

- `openrouter.ai`
- `api.anthropic.com` (if the Hermes Smart Router ever picks Anthropic)
- `api.openai.com`
- `homeassistant.local` (HA MCP)
- Explicit exclusion: no private network ranges, no cloud metadata endpoints.

Hermes's config points `providers.openrouter.base_url` at the egress proxy.

**HA WebSocket** (observer path) is a direct connection from our gateway container, which already has controlled egress.

### 8.3 Secret management

- **Gateway config:** `gateway/config.yaml` references env-sourced values via `${VAR}` syntax (our existing convention).
- **Secrets:** never committed. Loaded from `~/.sentient/.env` on the Pi, or from Docker secrets in compose.
- **HA long-lived tokens:** two per user — one for our observer (read-only scope if HA supports it; today HA LLAT is full-scope, so we accept the blast radius), one for Hermes MCP.
- **Hermes API keys:** one per profile, rotated every 90 days. Rotation requires both restarting the Hermes container and updating the gateway config.

### 8.4 Approval gates

Enable Hermes `approvals.mode: smart` in every profile. "Smart" approval triggers on:

- Destructive patterns (recursive delete, DB drops, shell pipe-to-interpreter)
- `ha_call_service` for domains `alarm_control_panel`, `lock`, and specific entity allowlists (defined per-user)
- Any tool installing new skills or modifying `SOUL.md`

Approvals surface as Hermes tool messages. We translate them to our existing `tool.confirm_request` wire message → modal in webui → `tool.confirm` response from client → forwarded to Hermes.

### 8.5 Prompt injection

Hermes ships its Tirith scanner, context-file injection detection, and MCP credential redaction. We add:

- **Input normalization at gateway boundary:** control chars stripped, zero-width chars stripped, whitespace normalized. Applies to STT output AND text input AND HA event text fields.
- **HA event sanitization** (§5.6): friendly names and state attributes containing user text are JSON-stringified before inclusion in the user message.
- **Canary token** in `SOUL.md`: a UUID that should never appear in any tool input. Gateway logs if it does. (Cheap, useful tripwire.)

### 8.6 Observability

- Every Hermes request logged with `requestId`, `userId`, `cycleId`, `conversationId`, input-token estimate, duration, output-token count.
- Tool calls logged with `toolName`, `callId`, `argsPreview` (truncated to 200 chars), status, duration.
- Errors never silenced (per `.claude/rules/error-handling.md`).
- Metrics exported for: cycles/hour/user, avg latency to first audio frame, tool failure rate, approval-request rate.

### 8.7 Update hygiene

- Hermes image is pinned to a specific tag. Updates require a PR that bumps the tag + re-runs integration tests against it.
- We subscribe (manually) to Hermes's security advisory feed. Critical CVEs get same-day updates.
- Weekly `docker image prune` in deployment playbooks.

---

## 9. Migration: what we delete, keep, adapt

### Delete

| Path | LOC (approx) | Reason |
|---|---|---|
| `gateway/src/cerebrum/cognitive-cycle.ts` | ~400 | Hermes owns the cycle |
| `gateway/src/cerebrum/cognitive-cycle-dispatch.ts` | ~250 | Hermes owns tool dispatch |
| `gateway/src/cerebrum/context-assembler.ts` | ~350 | Hermes assembles its own context |
| `gateway/src/cerebrum/conversation-history.ts` | ~500 | Replaced by ConversationMirror (~100 LOC) |
| `gateway/src/cerebrum/task-manager.ts` | ~400 | Replaced by TaskMirror (~80 LOC) |
| `gateway/src/effects/` (all except internal TTS stages) | ~1500 | Tool dispatch is Hermes's job. TTS stages move to `gateway/src/tts/stages/` |
| `gateway/src/providers/llm-provider.ts` + OpenRouter adapter | ~300 | Hermes owns LLM calls |
| `gateway/src/memory/*` (if any partial implementation exists from Phase 5 start) | varies | Hermes owns memory |
| `gateway/src/classifier/*` (if any) | varies | Hermes Smart Model Routing replaces |
| `gateway/src/security/*` injection-guard (if any) | varies | Hermes Tirith + our boundary sanitization |

Total estimated delete: **~4000–6000 LOC** depending on what's been partially built in unmerged branches.

### Keep

Everything in the "Inventory UX/SDK contract" subagent report §5 "Features we must preserve," plus:
- WebSocket server, session management, auth
- STT pipeline (Deepgram/Flux adapter)
- TTS pipeline (Fish Audio + emotion tagger + utterance aggregator)
- SessionAudioController + barge-in logic
- AttentionGate salience logic
- ShortTermContext (purpose unchanged)
- WebUI and SDK (fully frozen)
- `shared/protocol/` (wire protocol schemas)

### Adapt

| File | Change |
|---|---|
| `gateway/src/cerebrum/attention-gate.ts` | Swap `onCycle` → `hermesDispatcher.runCycle` (§5.10) |
| `gateway/src/effects/speak-effect.ts` | Delete; logic absorbed into TTS decorator chain (§5.5) |
| `gateway/src/effects/emotion-tagger.ts` | Move to `gateway/src/tts/stages/emotion-tagger.ts`; simplify prompt (no longer asks to strip markdown) |
| `gateway/src/effects/utterance-aggregator.ts` | Move to `gateway/src/tts/stages/utterance-aggregator.ts`; interface unchanged |
| `gateway/src/session-handlers/*` | Update to route new HermesClient dispatch path |
| `gateway/config.yaml` | §7 partitioning |
| `deploy/docker/docker-compose.yml` | Add hermes services; add sentient-internal network; add secrets |
| `deploy/pi/docker-compose.yml` | Same as above |

### Add

| File | Purpose |
|---|---|
| `gateway/src/cerebrum/hermes-client.ts` | SSE consumer, HTTP client |
| `gateway/src/cerebrum/hermes-event-translator.ts` | SSE → wire message |
| `gateway/src/cerebrum/conversation-mirror.ts` | Thin UI feed |
| `gateway/src/cerebrum/task-mirror.ts` | Thin UI task table |
| `gateway/src/sensors/home-assistant-observer.ts` | HA WS subscriber |
| `gateway/src/sensors/ha-event-templates.ts` | Domain → human-readable |
| `gateway/src/session-router.ts` | User → Hermes profile binding |
| `gateway/src/tts/stages/markdown-stripper.ts` | New decorator unit |
| `gateway/src/tts/stages/emoji-stripper.ts` | New decorator unit |
| `gateway/templates/SOUL.md.tmpl` | Per-user persona template |
| `gateway/templates/hermes-profile.yaml.tmpl` | Per-user Hermes config template |
| `scripts/supervise-hermes.sh` | Container lifecycle helper (dev; prod uses compose) |

---

## 10. Future extensibility

The design preserves the extension points needed for natural growth without rewriting.

**New sensor sources (Pi camera, mic ambient, time-of-day, weather pushes):**
- Each new sensor = new file under `gateway/src/sensors/`.
- Each emits `InjectEvent`s into ShortTermContext with a salience key.
- Add entries to `salience_map.yaml` for tuning.
- No change to HermesClient or wire protocol.

**New tools (web search, calendar, timer):**
- Mostly: add an MCP server to each profile's `config.yaml`. Zero gateway changes.
- If a tool needs audio side effects (e.g., a "play music" tool that should also pause TTS): requires a gateway-hosted MCP server that can reach back into SessionAudioController. Design sketch in §10.1.

**New messaging platforms (Telegram, Discord, SMS):**
- Not a gateway concern — those are Hermes gateway adapters. If the user ever wants them, they're configured in Hermes's own `config.yaml`. They bypass our voice-UX plane entirely. Expected rarely.

**Re-introducing `speak-as-tool`:**
- Add a gateway-hosted MCP server exposing a single `speak(text)` tool.
- Handler pipes text through the TTS decorator chain.
- Hermes's SOUL.md updates to instruct the model: "For user-facing responses, call `speak(...)` with TTS-ready text. Keep visible assistant messages short; use `speak` for the spoken version."
- TTS decorator chain no longer consumes `response.output_text.delta`; instead consumes the tool arg stream.
- Wire protocol unchanged.

**Switching LLM providers:**
- Change `model` in Hermes per-profile config. Zero gateway code change.
- Smart Model Routing already lets us use different models per task class without config gymnastics.

**Per-family global skills / shared memory:**
- Hermes supports profile inheritance via `config.yaml` `extends:`. A family-level profile defines shared skills; per-user profiles extend it.
- Not in scope for v1; notable that the architecture supports it.

### 10.1 Gateway-hosted MCP (sketch, deferred)

For tools that need to reach back into the gateway (audio control, profile config), we can run a local MCP server inside the gateway process, listening on a Unix socket that Hermes dials via `command: nc -U /var/run/sentient-mcp.sock`. Hermes calls tools like `pause_audio()`, `set_channel(voice|text)` via MCP; the handlers are in-process. Deferred to v2; documented here to note the architecture admits it without rework.

---

## 11. Edge cases

This section enumerates every failure/race/corner I could think of, with a designed response.

### 11.1 Hermes container crashes mid-cycle

- SSE connection errors → HermesClient emits `error`.
- Supervisor restarts the container (Docker `restart: on-failure`).
- Current cycle is aborted; we emit `cycle.aborted {reason:"upstream_failure"}`.
- On next user input, a fresh dispatch tries. If the container isn't healthy within 10s, we surface a user-facing error.
- Session's `conversationId` may or may not be valid after restart. Strategy: on `ConversationNotFound` error from Hermes, drop the `conversationId` and retry with a new conversation, prefixing the user message with a synthesized "[context/session-restart] Previous conversation may be lost." note. One-time per recovery.

### 11.2 Hermes container slow (>5s to first token)

- Already handled by our existing `session.ready.playback` preempt logic: the placeholder bubble + "thinking" state cover the gap.
- If the first token takes > `request_timeout_ms` (60s), we abort and error. User-actionable.

### 11.3 User interrupts during a mutating tool call

- Audio stops instantly (our audio plane).
- SSE disconnected → Hermes stops generating.
- In-flight tool call completes. If it was a mutator (e.g., `HassCallService` turning lights on), the side effect lands.
- TaskMirror records the tool as `finished` (since Hermes's `response.output_item.done` may still arrive before we fully disconnect, or we infer finality from the disconnect).
- `conversation.entry` for the assistant is committed with whatever text was accumulated — but since Hermes discards incomplete responses (per agent-loop doc: "No partial response is injected into conversation history"), the NEXT user message doesn't see this text in the server-side history. Mismatch: our ConversationMirror shows the partial text; Hermes's history does not.
- **Resolution:** our ConversationMirror stamps interrupted assistant entries with `cutoff: { kind: "interrupt", cancelledTaskIds }` (existing field). The UI shows the cutoff badge. On the next dispatch, the user's new message stands alone — no references to the interrupted turn in the LLM context. This matches Claude's UX.

### 11.4 Barge-in vs simultaneous ambient event

- Barge-in fires `bargeIn()` (clears conversation salience only; keeps ambient per `.claude/rules/architecture.md`).
- An ambient event arriving in the same tick gets accumulated.
- Current cycle aborted; audio drained; SSE disconnected.
- Next salience evaluation either dispatches immediately (if ambient + incoming user speech exceed threshold) or waits on debounce.

### 11.5 User sends a new message before current cycle completes

- Gateway's AttentionGate wakes on the new user message. If the current cycle is mid-dispatch, we:
  a. Abort current SSE (similar to interrupt).
  b. Discard any accumulated assistant text (don't commit to ConversationMirror).
  c. Dispatch a new cycle with the new user message. Ambient events accumulated during the aborted cycle are included.
- Matches Hermes's own interrupt semantics (issue #5057 — new message implies interrupt).

### 11.6 HA WebSocket disconnects

- Observer enters reconnect loop (exponential backoff, cap 60s).
- While disconnected, no ambient HA events are injected. Hermes's HA MCP may also fail on tool calls if HA is down — returns a tool error.
- We emit a diagnostic `error` wire message (optional to surface in UI; probably silent with log-only).
- On reconnection, we don't try to "replay" missed events.

### 11.7 Hermes SSE contains a tool call we don't expect

- Possible if Hermes's Smart Routing swaps models mid-session and the new model advertises a different tool shape.
- Our event translator is permissive: unknown tool names still generate `task.update` messages; args preview is truncated; no crash.
- `conversation.entry` for tool results uses the tool name as-is.

### 11.8 Hermes's Tirith scanner rejects our labeled user message prefix as suspicious

- Mitigation: we emit labeled prefixes in a format Hermes's scanner is known-safe for (`[<source>/<key>] <text>`). We test this assumption in integration tests.
- If Tirith does reject, Hermes returns an error; we degrade to a plain user message with no prefix and log the incident. Salience context for that cycle is lost but conversation continues.

### 11.9 Profile onboarding races

- Two concurrent first-logins for the same new user could try to allocate the same port.
- Mitigation: SessionRouter `bind()` is synchronized (single mutex for port allocation). First caller wins, allocates, persists. Second caller waits briefly then gets the resolved binding.

### 11.10 Bearer key rotation

- Gateway reads the current bearer from env at dispatch time (not startup). A rotated key is picked up on the next cycle without restart.
- Rotation script (`deploy/scripts/rotate-hermes-key.sh`) updates the Docker secret and emits SIGHUP to the gateway (or signals a config-reload endpoint).

### 11.11 Pi restart

- All Docker containers come up via compose.
- Gateway re-binds profiles lazily on first user login post-restart.
- Hermes's session state (SQLite) survives restart. Our `conversationId` references survive since they're persisted in gateway session state (Phase 3.5 feature).

### 11.12 Mid-cycle message delta is empty

- Some models emit empty deltas. We no-op on empty delta in wire emission AND in TTS chain.

### 11.13 Model emits markdown despite SOUL.md instructions

- Defense-in-depth: `remove-markdown` strips it. Emotion tagger sees plain prose.
- If the model emits a pathological amount of markdown (e.g., a giant code block), the stripper reduces it to whitespace. UtteranceAggregator coalesces or drops empty blocks.

### 11.14 Emotion tagger timeout

- Already handled: existing safety fallback re-emits untagged text with neutral prosody.
- No new logic needed.

### 11.15 Hermes tool call result is binary

- Shouldn't happen for our v1 tool set (HA returns text/JSON).
- If it does: we render as `[binary data]` in task argsPreview, skip TTS for tool result (tool results aren't spoken anyway; only `response.output_text.delta` goes to TTS).

### 11.16 Concurrent cycles per user (not allowed, but possible race)

- AttentionGate today guarantees at most one active cycle per session. HermesClient enforces: if a dispatch arrives while a dispatch is in flight, we queue the new one and process after the current aborts/completes.
- Idempotency-Key prevents double-dispatch to Hermes if our gateway retries due to transient network error.

### 11.17 Very long tool results consume the prompt cache prefix

- Per `.claude/rules/llm-protocol.md`: avoid changing tool-name lists or tool-definition bytes mid-session. Tool results (role:tool messages) are fine since they're append-only.
- The MCP `tools.include`/`exclude` list must be stable for the session. If we ever dynamically adjust it (e.g., disable HA tool after a failure), we pay a full cache rebuild. v1 keeps the tool list static.

### 11.18 User changes language mid-session

- Existing `session.configure {language: "en"|"zh"}` still works.
- Gateway updates session state. Emotion tagger prompt swaps language. STT adapter reconfigures.
- Hermes: we emit a `configure` tool call to Hermes (via a gateway-hosted MCP? Or as a labeled system message?). For v1, simpler: language is part of the per-cycle user message labeled prefix `[meta/language] zh`. Hermes's SOUL.md includes "If you see `[meta/language] zh`, respond in Chinese."

### 11.19 Webui opens without voice mode (text-only)

- `session.configure.capabilities.supports` omits `audio`. TTS chain is short-circuited; no audio frames emitted.
- Everything else (chat feed, task cards, interrupt) works identically.

### 11.20 Gateway runs standalone without Hermes (unit test)

- HermesClient has an interface; we ship a `MockHermesClient` for integration tests.
- Unit tests never hit Hermes. Integration tests (Phase 5 below) exercise a real Hermes container.

### 11.21 Hermes runs out of memory (OOM kill)

- Docker `restart: on-failure` recovers. Same flow as 11.1.
- If OOM is chronic, alert surface in logs; operator increases `memory` limit.

### 11.22 Skill autogenerated by Hermes that calls a non-exposed tool

- Hermes's approval gate (`smart`) catches it.
- If the skill calls an MCP tool outside our include list, MCP rejects.

### 11.23 Conversation DB grows unbounded

- Hermes has internal compaction (`compression.enabled`). Configured defaults in profile template.
- Our responsibility is bounded: monitor disk usage in `~/.hermes/profiles/<user>/`; alert at 1 GiB.

---

## 12. Testing strategy

Follows `.claude/rules/testing.md` and the Voice Pipeline Test Philosophy.

### 12.1 Unit tests (gateway side)

- HermesClient with a mocked SSE source: verify translation of every event type in Appendix A produces the expected wire message.
- HermesEventTranslator: given a sequence of SSE events, produces the expected sequence of wire messages. Table-driven, ~30 test cases.
- HomeAssistantObserver: given a sequence of HA WS events, produces the expected InjectEvents with correct salience keys.
- Each TTS decorator stage tested in isolation per pipeline rules.
- SessionRouter: port allocation, lazy bootstrap, cleanup on session end.

### 12.2 Contract tests (wire protocol)

- For every existing webui test that asserts "gateway emits X," duplicate with the new adapter path. Ensure zero regression.
- Connector-protocol tests (`.claude/rules/testing.md`): our mocks emit the exact Hermes SSE events, not a convenient wrapper. This is non-negotiable.

### 12.3 Integration tests (real Hermes)

- New test target: `gateway/tests/integration/hermes/`. Requires a real `nousresearch/hermes-agent:<pinned>` container brought up via testcontainers-style helper.
- Golden-path test: user message → full cycle → assistant text streams → TTS → completed. Verify wire protocol at each step.
- Tool-call test: a scripted MCP tool fires a deterministic result; verify task.update lifecycle.
- Interrupt test: start a long cycle, disconnect mid-stream, verify audio stops and next message is coherent.
- Multi-profile test: two concurrent users, two Hermes containers, verify isolation.
- HA failure test: tear down HA MCP mid-cycle, verify graceful tool failure.

### 12.4 Smoke test on Pi

- After deploy, a scripted interaction: voice + HA query + HA action + interrupt. Manual confirmation.
- Runs as part of Phase 2 of the implementation plan (see §15).

### 12.5 Load / chaos (light)

- Deliberately kill a Hermes container during a cycle; assert supervisor restarts and next cycle succeeds.
- Deliberately produce a burst of 50 HA events in 1s; assert AttentionGate coalesces into a single dispatch.

### 12.6 Ignored (explicitly)

- Load testing beyond 5 concurrent users — out of scope.
- Fuzz testing Hermes's own APIs — upstream's job.

---

## 13. Upstream contributions / local patches

**F-1 (high priority):** Upstream fix for Hermes issue #5244 (mid-tool-call interrupt). Add ability to abort individual tool calls via a `DELETE /v1/runs/{id}/tools/{callId}` endpoint or by extending the `/stop` semantics to cascade through running tool subprocesses. Estimated 1–2 days of upstream work. Not a v1 blocker.

**F-2 (medium):** Upstream fix for Hermes issue #5021 (per-turn session flush configuration). Default is to flush only at turn boundaries, which can lose in-progress tool chain state on interrupt. The proposed `flush_per_turn: true` config flag solves our voice UX case. We'd ship a local patch if not merged by our v1 date.

**F-3 (low):** Publish a reusable `sentient-hermes-voice-template` as an OSS contrib back: SOUL.md template tuned for voice, salience map tuned for family smart-home, docker-compose for Pi. Community artifact; doesn't block.

**Local patches (if needed, kept minimal):**
- Version-pinned copy of Hermes with F-2 applied, built with a marker suffix like `:v0.10.3-sentient1`.
- Maintained as a branch on our fork; rebased on upstream releases monthly.

---

## 14. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Hermes's API surface changes in a breaking way before our v1 ships | Medium | High | Pin Hermes version. Integration tests catch schema drift. Weekly look at upstream release notes. |
| Pi 5 can't handle 2–5 Hermes containers concurrently | Low-Medium | Medium | Lazy start (only on login). Remote LLM (no on-device model). If RAM bound, reduce to one-container-active-at-a-time with warm-swap. |
| Hermes's SSE event semantics differ subtly from OpenAI Responses spec | Medium | Medium | Integration tests use real Hermes. Event translator is defensive: unknown events logged and ignored. |
| HA 2025.2+ MCP integration isn't reliable yet | Medium | Medium | Fallback to `voska/hass-mcp` Docker container. Document both configs. |
| `remove-markdown` misses a case that breaks TTS | Low | Low | Emotion tagger has safety fallback; also a nightly evaluation suite on representative LLM outputs catches drift. |
| Mid-tool-call interrupt regression (D-8) confuses users | Medium | Low | UX copy in webui: "in-flight actions may complete." Approval mode blocks surprise mutations. |
| Prompt-cache invalidation from tool definition drift | Low | Medium | Tool list is static within a session (§11.17). MCP server list frozen per session. |
| Hermes's built-in Tirith scanner flags legitimate input | Low | Low | Boundary sanitization removes obvious triggers. Test suite covers family-realistic messages. |
| New labeled-prefix format confuses the model | Low | Low | SOUL.md includes explicit examples of labeled prefixes. Validated with a small eval set. |
| Bearer key rotation takes down a session | Low | Low | Rotation documented as a maintenance event; schedule during low-use windows. |
| Docker secrets complexity vs plain env vars | Low | Low | Start with env + `chmod 600`; move to secrets in v1.1. |

---

## 15. Implementation phases (outline)

Detailed plans authored via `superpowers:writing-plans` after this spec is approved. Outline only:

**Phase 1 — Scaffolding + HermesClient (green-field deletes NOT done yet).**
- Add HermesClient + event translator with mocked SSE.
- Add per-profile Hermes container to dev docker-compose.
- Add SessionRouter + profile bootstrap.
- Integration test: gateway can dispatch a cycle to real Hermes, accumulate text, emit wire events.
- **Deliverable:** existing cognitive cycle still works; new HermesClient code is dead but tested.

**Phase 2 — TTS decorator chain.**
- Extract existing emotion tagger + utterance aggregator to `tts/stages/`.
- Add markdown-stripper and emoji-stripper stages.
- Wire into a `TextToSpeechPipeline` that consumes an AsyncGenerator of text deltas.
- Unit + integration tests.
- **Deliverable:** pipeline swappable behind a feature flag.

**Phase 3 — Switchover under flag.**
- Gate at AttentionGate: new flag `cerebrum.provider: "hermes"` vs `"in-process"`.
- When `hermes`, dispatch via HermesClient + TTS decorator chain.
- Old code path still present. Integration tests pass for both paths.
- **Deliverable:** can flip a flag and run a full voice session against Hermes on dev.

**Phase 4 — HA dual-path.**
- HomeAssistantObserver (our WS subscriber) with salience injection.
- Hermes MCP config for HA (official integration preferred; fallback to hass-mcp).
- End-to-end smoke: say "turn on living room lights"; hear confirmation.

**Phase 5 — Security hardening + production compose.**
- Apply all §8 hardening to compose files.
- Rootless, read-only FS, network isolation, egress proxy, secrets, approval gates.
- Rotate Hermes API keys via scripts.
- Smoke-test on Pi.

**Phase 6 — Delete old code.**
- Remove cognitive-cycle, dispatch, context-assembler, effects (except TTS stages moved in Phase 2), etc.
- Remove Phase 4/5 plan files from `docs/superpowers/plans/` (or mark superseded in their headers).
- **Deliverable:** ~4000+ LOC removed; codebase is dramatically smaller.

**Phase 7 — Polish.**
- Multi-profile UX (user picker on webui; auth for each).
- Metrics dashboard.
- Documentation updates (CLAUDE.md, agents/docs/*).
- Community artifact (F-3) if time permits.

Each phase ends with a working system (feature-flagged in Phases 1–3). No big-bang cutover.

---

## Appendix A: Complete Hermes SSE → wire-message mapping

Based on Hermes's Responses API docs (OpenAI-compatible event spec) plus Hermes-specific extensions.

| Hermes SSE event | Payload fields | Our wire message | Mapping notes |
|---|---|---|---|
| `response.created` | `response.id`, `response.created_at`, `response.conversation` | `cycle.started` | Capture `response.id` into `TaskMirror` as `responseId`; capture `conversation` into session state. `cycleId` is OUR pre-assigned value. |
| `response.output_item.added` where `item.type="message"` | `item.id`, `item.role`, `item.content[]` | — (no wire emission) | Boundary marker; we don't emit. |
| `response.output_text.delta` | `delta.delta` (string) | `message.delta {cycleId, delta}` | AND fork into TTS decorator chain. |
| `response.output_item.done` where `item.type="message"` | `item.id`, `item.content[].text` | — (no wire emission) | Boundary marker; ConversationMirror accumulates final content on `response.completed`. |
| `response.output_item.added` where `item.type="function_call"` | `item.id` (callId), `item.name`, `item.arguments` (JSON string, may be empty initially) | `task.update {taskId:callId, toolName:item.name, cycleId, status:"running", argsPreview:truncate(item.arguments,200), startedAtMs:now}` | We store callId in TaskMirror. |
| `response.function_call_arguments.delta` | `item_id` (callId), `delta` (JSON fragment) | — (accumulated internally; no wire emission per delta) | TaskMirror accumulates args for eventual finalization. |
| `response.function_call_arguments.done` | `item_id` (callId), `arguments` (complete JSON) | — | TaskMirror updates argsPreview. Optional: emit a `task.update {argsPreview:…}` if args differ from initial. |
| `response.output_item.done` where `item.type="function_call"` | `item.id`, `item.status` | `task.update {taskId:callId, status:"finished" or "failed", endedAtMs:now}` | Status mapped from `item.status` ("completed" → "finished"; error states → "failed"). |
| `response.output_item.added` where `item.type="function_call_output"` | `item.id`, `call_id`, `output` (string) | — (handled as part of prior task lifecycle) | The tool result text is captured; may inform the next cycle's context but we don't emit wire for it. |
| `hermes.tool.progress` | `call_id`, `tool_name`, `state` ("start"/"end"), optional `message` | `task.update {status:"running", argsPreview}` on start; no-op on end (handled by `response.output_item.done`) | Fills in the gap when function_call args are slow to arrive. |
| `response.completed` | `response.id`, `usage.input_tokens`, `usage.output_tokens` | `cycle.completed {cycleId, effectsInvoked:[…toolNames]}` + `message.done {cycleId}` + `conversation.entry {kind:"assistant", content:<accumulated>}` | End-of-run. We also update the ConversationMirror. |
| `response.error` or SSE error | `error.code`, `error.message` | `error {code, message}` + `cycle.aborted {cycleId, reason:"error"}` | Hard abort. |
| `response.incomplete` | `reason` (e.g., "max_output_tokens") | `cycle.completed {cycleId, effectsInvoked}` + `message.done {cycleId, truncated:true}` + `conversation.entry {cutoff:{kind:"length-cap"}}` | Treat as a soft truncation. `cutoff.kind="length-cap"` is a new optional enum value. |

---

## Appendix B: Sample `~/.hermes/profiles/<user>/config.yaml`

```yaml
# Auto-generated by Sentient gateway at profile bootstrap.
# Secrets live in adjacent .env; NEVER edit by hand while the container is running.

model:
  provider: openrouter
  model: google/gemini-2.5-flash

providers:
  openrouter:
    base_url: http://egress-proxy:3128/openrouter  # egress-proxy container
    api_key_env: OPENROUTER_API_KEY

agent:
  max_turns: 6
  reasoning_effort: medium
  tool_use_enforcement: balanced

memory:
  memory_enabled: true
  user_profile_enabled: true
  char_limits:
    memory: 20000
    user_profile: 8000

compression:
  enabled: true
  threshold: 0.8
  target_ratio: 0.5
  protect_last_n: 4
  flush_per_turn: true   # requires F-2 or local patch

api_server:
  # Note: these are set by env in the container; config here is a reference.
  # API_SERVER_ENABLED=true
  # API_SERVER_PORT=864N
  # API_SERVER_KEY via secret

approvals:
  mode: smart
  timeout_seconds: 60
  fail_closed: true
  allowlist:
    - HassTurnOn_light.*
    - HassTurnOff_light.*
    - HassTurnOn_scene.*

terminal:
  backend: local   # Hermes's own sandboxing is bypassed; our Docker provides isolation

security:
  redact_secrets: true
  tirith:
    enabled: true

privacy:
  redact_pii: false   # family assistant context; we trust household input

platforms:
  homeassistant:
    enabled: false   # we handle HA observation ourselves

mcp_servers:
  home_assistant:
    url: http://homeassistant.local:8123/mcp_server/sse
    headers:
      Authorization: "Bearer ${HA_MCP_TOKEN}"
    timeout: 15
    connect_timeout: 5
    tools:
      exclude:
        - HassRestart
        - HassTurnOff_switch.main_water
        - HassUnlock

display:
  tool_progress: true
  streaming: true
  show_reasoning: false    # voice assistant; no surfaced reasoning
  personality: minimal

# Persona lives in SOUL.md (rendered from our template at bootstrap).
```

---

## Appendix C: `deploy/docker/docker-compose.yml` excerpt

```yaml
networks:
  sentient-internal:
    driver: bridge
    internal: true
  sentient-external:
    driver: bridge

secrets:
  hermes_default_key:
    file: ./secrets/hermes_default_key
  ha_mcp_token:
    file: ./secrets/ha_mcp_token
  ha_observe_token:
    file: ./secrets/ha_observe_token
  openrouter_api_key:
    file: ./secrets/openrouter_api_key

services:
  egress-proxy:
    image: minimum/tinyproxy:latest
    networks: [sentient-internal, sentient-external]
    volumes:
      - ./egress-proxy/tinyproxy.conf:/etc/tinyproxy/tinyproxy.conf:ro
    restart: unless-stopped

  gateway:
    build: ./gateway
    networks: [sentient-internal, sentient-external]
    ports: ["8888:8888"]
    environment:
      HERMES_API_KEY_DEFAULT_FILE: /run/secrets/hermes_default_key
      HA_OBSERVE_TOKEN_FILE: /run/secrets/ha_observe_token
    secrets:
      - hermes_default_key
      - ha_observe_token
    depends_on:
      hermes-default:
        condition: service_healthy
    restart: unless-stopped

  hermes-default:
    image: nousresearch/hermes-agent:v0.10.3-sentient1
    user: "1000:1000"
    read_only: true
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
    pids_limit: 256
    tmpfs:
      - /tmp:size=512M,nosuid
      - /var/tmp:size=256M,noexec,nosuid
      - /run:size=64M,noexec,nosuid
    volumes:
      - ./profiles/default:/data
    environment:
      HERMES_HOME: /data
      API_SERVER_ENABLED: "true"
      API_SERVER_PORT: "8643"
      API_SERVER_KEY_FILE: /run/secrets/hermes_default_key
      HA_MCP_TOKEN_FILE: /run/secrets/ha_mcp_token
      OPENROUTER_API_KEY_FILE: /run/secrets/openrouter_api_key
    secrets:
      - hermes_default_key
      - ha_mcp_token
      - openrouter_api_key
    networks: [sentient-internal]
    healthcheck:
      test: ["CMD-SHELL", "curl -f -H \"Authorization: Bearer $$(cat /run/secrets/hermes_default_key)\" http://localhost:8643/health || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
    mem_limit: 512m
    cpus: "1.0"
    restart: on-failure

  # Additional profiles follow the same template with different ports, keys, and volumes.
```

---

## Appendix D: Glossary

| Term | Definition |
|---|---|
| **AttentionGate** | Gateway component that accumulates salience across conversation and ambient signals and dispatches cycles when thresholds are crossed. Preserved from pre-Hermes architecture. |
| **Cerebrum** | Informal name for the LLM-brain layer. Pre-Hermes: our own code. Post-Hermes: Hermes itself. |
| **ConversationMirror** | New thin per-session append-only log used only to populate `conversation.snapshot`/`conversation.entry` wire messages. Not read by any LLM-facing code. |
| **Decorator unit** | A single-responsibility pipeline stage: `AsyncGenerator` in, `AsyncGenerator` out, one file, one test. Enforced by `.claude/rules/pipeline.md`. |
| **Hermes** | NousResearch Hermes Agent, MIT-licensed agentic framework (v0.10, April 2026). |
| **HermesClient** | New gateway component. HTTP client that calls Hermes `/v1/responses` and translates SSE events to our wire messages. |
| **Labeled prefix** | User message format `[<source>/<key>] <text>\n` carrying per-cycle situation awareness. Per `.claude/rules/llm-protocol.md`. |
| **MCP** | Model Context Protocol. Standard for exposing tools to LLMs. Hermes is a first-class MCP client. |
| **Profile** | Hermes's per-user isolation unit. Directory: `~/.hermes/profiles/<user>/`. One container per profile. |
| **Salience map** | Static YAML mapping event source keys to salience weights. Gateway-owned. |
| **SessionRouter** | New gateway component. Maps `userId` to Hermes profile port + bearer key. |
| **SOUL.md** | Hermes's persona file. Rendered from a template per user at profile bootstrap. |
| **TaskMirror** | New thin ephemeral structure tracking live tool calls within the current cycle for UI. |
| **Tirith** | Hermes's built-in prompt-injection scanner. |
| **Tool Gateway** | Hermes's paid-service tool bundle (web search, image gen, TTS). We don't use it. |
