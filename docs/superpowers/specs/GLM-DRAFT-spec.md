# GLM Draft Spec: Dockerized Hermes Agent as Cerebrum Replacement

> **Status**: Draft — 2026-04-21
> **Author**: Claude (GLM) with full research synthesis
> **Scope**: Replace the custom cerebrum (CognitiveCycle + AttentionGate + EffectDispatch) with a dockerized Hermes Agent sidecar, making the gateway a thin connector of "ears" and "eyes" to the home.

---

## 1. Executive Summary

This spec proposes replacing the sentient gateway's custom LLM orchestration layer (cerebrum) with [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) (v0.10.0, MIT, 107K+ stars, Python). The gateway becomes a thin TypeScript connector that handles real-time audio I/O (STT/TTS streaming, barge-in, WebSocket protocol) and delegates all LLM reasoning, tool calling, memory, and skill execution to Hermes running in an isolated Docker container.

**Why this change**: The cerebrum is the most complex, most failure-prone, and hardest-to-maintain part of the gateway. Replacing it with a battle-tested open-source agent framework gives us: (1) a community-maintained LLM loop with automatic provider failover, (2) a mature tool/skill/MCP ecosystem, (3) persistent memory and self-improving behavior, and (4) multi-platform reach (Telegram, Discord, etc.) for near-zero marginal cost.

**Key challenge**: Hermes has no real-time voice pipeline. It is request-response, batch STT/TTS, with no barge-in, no AttentionGate, and no streaming overlap. The gateway must own everything audio and bridge the gap between real-time voice UX and Hermes's text-oriented agent loop.

---

## 2. Current State Analysis

### 2.1 What the Cerebrum Does Today

The cerebrum is a ReAct loop that:

1. **AttentionGate**: Accumulates salience from conversation events and ambient sensor data. Dispatches a cognitive cycle when accumulated salience crosses a threshold. Supports debounce (80ms), immediate wake (salience >= 100), and ReAct continuation (back-to-back cycles, max 10).
2. **CognitiveCycle**: Projects short-term context, assembles the LLM prompt (stable system + salience-gated tools + per-cycle ephemeral + rolling history), streams tokens from the LLM, routes tool_call_deltas to the StreamingEffectCoordinator, dispatches non-streaming effects after stream close.
3. **EffectDispatch**: 10-step pipeline per tool call — schema validation, role gate, capability check, rate limit, confirmation, audit, task registration, handler execution, output sanitization, audit complete.
4. **Interruption**: Three cancel primitives — bargeIn (mic-onset, cancels TTS only), interrupt (UI button, cancels cycle + TTS + interruptable tasks), cancelTask/cancelAllTasks (LLM-callable).
5. **Streaming**: TTS starts on first sentence while LLM continues generating. Speak effect is a terminal tool with streaming args (text field streamed token-by-token to TTS).
6. **Context management**: ConversationHistory (FIFO, 10K entries, token-budgeted transcript), ShortTermContext (ambient events, task table, salience), PreferenceManager (session preferences).

### 2.2 What Must Be Preserved

Every feature below is a **non-negotiable UX requirement** derived from the original spec and current implementation:

| Feature | Why It Matters |
|---------|---------------|
| Toggle-to-talk voice interaction | Core UX model — not push-to-hold |
| Barge-in (mic-onset stops TTS) | Natural conversation feel |
| Hard interrupt (UI button) | Safety and control |
| Streaming text (typewriter buffer) | Perceived responsiveness |
| Streaming overlap (TTS starts mid-LLM) | 50-70% latency reduction |
| Salience-gated tool exposure | Only relevant tools offered per cycle |
| AttentionGate wake on ambient events | Proactive assistance (sensor-driven) |
| Conversation history sync | Client must see full transcript |
| Pending user messages | Instant UI feedback before gateway confirms |
| Cycle lifecycle events | Client tracks thinking/acting/streaming/speaking/idle |
| Per-user memory (when implemented) | Persistent knowledge across sessions |
| Family-aware role gating | Adults/children/guests get different tool access |
| Task status tracking | Live pill display of running tool calls |
| Echo suppression during TTS | Prevents bot from hearing itself |

---

## 3. Architecture Options Considered

### Option A: Hermes as Sidecar (RECOMMENDED)

Gateway (TS/Bun) owns audio pipeline, WebSocket protocol, and all real-time UX. Hermes runs in an isolated Docker container as a reasoning engine. Communication via a local IPC bridge (Unix domain socket or localhost HTTP).

```
[Client WebSocket]
      |
[Gateway (TS/Bun)] ── owns: STT, TTS, audio, barge-in, interrupt, protocol
      |                          bridges: LLM requests ↔ Hermes
      | ─── Unix Socket / HTTP ──►
[Hermes Container (Python)] ── owns: LLM loop, tool calling, memory, skills, MCP
      |
[MCP Servers / Tool Containers] ── isolated tool execution
```

**Pros**: Clean separation, minimal gateway changes, Hermes benefits (memory, skills, MCP, failover), security isolation, independently upgradable.

**Cons**: IPC latency (1-5ms localhost), two runtimes to monitor, Hermes's known issues (SQLite corruption, session fragmentation), language mismatch complicates debugging.

### Option B: Hermes Agent Loop Patterns in TypeScript

Extract Hermes's ReAct loop, tool dispatch, and memory concepts. Reimplement in TypeScript as a native gateway module. No Python runtime.

**Pros**: Single runtime, no IPC latency, full control, no language mismatch.

**Cons**: Abandons the community ecosystem, reimplements what Hermes already does well, ongoing maintenance burden falls entirely on us, loses MCP/plugin ecosystem.

### Option C: Replace with a TS-native Agent Framework

Use a TypeScript-first agent framework (e.g., Mastra, Vercel AI SDK, LangChain.js) for the LLM loop, keeping the gateway in one runtime.

**Pros**: Single runtime, community-maintained, TypeScript-native.

**Cons**: No framework matches Hermes's maturity for tool calling, memory, and self-improvement. Mastra and Vercel AI SDK lack multi-turn agent loops with tool calling. LangChain.js is less battle-tested than Python LangGraph. Would need to build AttentionGate, memory, and skill systems from scratch.

### Decision: Option A

Option A maximizes leverage of Hermes's mature agent capabilities while preserving our real-time voice UX. The IPC latency of 1-5ms on localhost is negligible compared to LLM round-trip (200-2000ms). The two-runtime cost is offset by gaining a 107K-star community ecosystem, persistent memory, MCP integration, and automatic provider failover.

---

## 4. Recommended Architecture

### 4.1 Container Topology

```yaml
# docker-compose.yml (production)
services:
  gateway:
    image: sentient-gateway:latest
    build:
      context: ./gateway
      platform: linux/arm64  # RPi5 target
    ports:
      - "8888:8888"          # HTTPS/WSS
      - "8443:8443"          # Alt TLS
    volumes:
      - ./config:/app/config:ro
      - ./data/sessions:/app/data/sessions
    environment:
      - HERMES_SOCKET=/var/run/hermes/hermes.sock
      - LOG_LEVEL=${LOG_LEVEL:-info}
    depends_on:
      hermes:
        condition: service_healthy
    networks:
      - lan-facing          # Exposed to home LAN
      - hermes-net           # Internal to Hermes

  hermes:
    image: nousresearch/hermes-agent:0.10.0
    volumes:
      - hermes-data:/opt/data
      - ./hermes/config:/opt/data/config:ro
    environment:
      - HERMES_GATEWAY_MODE=true
      - HERMES_API_PORT=8642
    cap_drop:
      - ALL
    cap_add:
      - DAC_OVERRIDE
      - CHOWN
      - FOWNER
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp
    deploy:
      resources:
        limits:
          cpus: '2.0'
          memory: 4G
        reservations:
          cpus: '0.5'
          memory: 512M
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8642/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    networks:
      - hermes-net            # Internal only, no LAN access

  # Optional: API proxy for controlled egress
  api-proxy:
    image: sentient-api-proxy:latest
    networks:
      - hermes-net
    environment:
      - ALLOWED_HOSTS=api.openrouter.ai,api.deepgram.com,api.fish.audio
    deploy:
      resources:
        limits:
          cpus: '0.25'
          memory: 128M

networks:
  lan-facing:
    driver: bridge
  hermes-net:
    driver: bridge
    internal: true            # No external access

volumes:
  hermes-data:
```

**Key design decisions**:
- **Hermes has no LAN access** — `hermes-net` is `internal: true`. All outbound API calls go through `api-proxy` which allowlists only required hosts.
- **Gateway bridges both networks** — faces LAN for clients, faces hermes-net for agent communication.
- **Unix domain socket for IPC** — lowest latency, no TCP overhead, filesystem permissions for auth.
- **Gateway is the only externally reachable service** — Hermes is never directly accessible from the home network.

### 4.2 IPC Protocol: Agent Bridge

The gateway communicates with Hermes via a JSON-over-UnixSocket protocol called the **Agent Bridge**. This is a bidirectional, message-based protocol with distinct channels.

```
┌─────────────┐                          ┌─────────────────┐
│   Gateway   │                          │     Hermes      │
│  (TS/Bun)   │                          │    (Python)     │
│             │                          │                 │
│  Audio I/O  │                          │                 │
│  STT/TTS    │                          │                 │
│  BargeIn    │                          │   LLM Loop      │
│  Interrupt  │                          │   Tool Call     │
│  Protocol   │                          │   Memory        │
│             │                          │   Skills        │
│             │    Unix Socket / HTTP     │                 │
│  AgentBridge├──────────────────────────►│  HermesPlugin   │
│  Client     │                          │                 │
│             │◄──────────────────────────┤                 │
│             │    (streaming events)     │                 │
└─────────────┘                          └─────────────────┘
```

#### 4.2.1 Request Messages (Gateway → Hermes)

```typescript
interface AgentBridgeRequest {
  id: string;                    // UUID for request-response correlation
  type: "turn" | "interrupt" | "cancel_task" | "configure" | "inject_context";
  payload: TurnPayload | InterruptPayload | CancelTaskPayload | ConfigurePayload | InjectContextPayload;
}

interface TurnPayload {
  // Context for one agent turn (may involve multiple ReAct iterations)
  newEvents: ConversationEntry[];     // Only new events since last turn (deltas)
  systemPrompt: string;                // Stable system prompt (persona + rules)
  ephemeralContext: string;            // Per-turn volatile state (preferences, sensors, tasks)
  availableTools: ToolDefinition[];   // Salience-gated tool list
  toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
  model?: string;                      // Override default model
  maxTokens?: number;                  // Override default max tokens
  maxIterations?: number;              // ReAct loop cap (default: 10)
  abortSignal?: string;               // Correlation ID for cancel/interrupt
}

interface InterruptPayload {
  cycleId: string;
  reason: "barge_in" | "user_interrupt";
  cancelledTaskIds?: string[];
}

interface CancelTaskPayload {
  taskId: string;
}

interface ConfigurePayload {
  preferences: {
    language?: string;
    channel?: "voice" | "text";
    role?: "adult" | "child" | "guest";
  };
}

interface InjectContextPayload {
  // Ambient sensor data, proactive triggers
  entries: ContextEntry[];
}
```

#### 4.2.2 Event Messages (Hermes → Gateway)

```typescript
interface AgentBridgeEvent {
  turnId: string;               // Correlation ID for the entire agent turn
  iterationIndex?: number;     // Which ReAct iteration within the turn (0-based)
  type: "text_delta" | "tool_call_start" | "tool_call_delta" | "tool_call_end"
      | "task_update" | "iteration_start" | "iteration_end" | "turn_end" | "memory_update" | "error";
  payload: Record<string, unknown>;
}

// Specific event payloads:
interface TextDeltaEvent {
  delta: string;                // Streaming LLM text chunk
}

interface ToolCallStartEvent {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>; // Initial args (for non-streaming tools)
  streamingArgs?: string[];     // Fields that will stream (e.g., ["text"] for speak)
  impact: "auto" | "confirm" | "admin";
  interruptable: boolean;
  terminal: boolean;
}

interface ToolCallDeltaEvent {
  toolCallId: string;
  field: string;                // Streaming arg field name
  delta: string;                // Incremental text for that field
}

interface ToolCallEndEvent {
  toolCallId: string;
  result: unknown;
  status: "completed" | "cancelled" | "failed";
  error?: string;
}

interface TaskUpdateEvent {
  taskId: string;
  toolName: string;
  status: "running" | "finished" | "cancelled" | "failed";
  result?: unknown;
}

interface TurnEndEvent {
  iterationsCompleted: number;  // How many ReAct iterations ran
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  cutoff?: {
    kind: "barge_in" | "interrupt";
    cancelledTaskIds: string[];
  };
}

interface IterationStartEvent {
  iterationIndex: number;     // Which ReAct iteration is starting
  toolCallsPending?: string[]; // Tool names being executed
}

interface IterationEndEvent {
  iterationIndex: number;
  textGenerated: boolean;     // Whether this iteration produced text
  toolCallsCompleted: number;
}

interface MemoryUpdateEvent {
  key: string;
  operation: "add" | "update" | "delete";
  value?: string;
}
```

#### 4.2.3 IPC Design Rationale

- **Request-response for turns**: The gateway sends a `turn` request and receives a stream of events back. A single turn may involve multiple ReAct iterations (LLM calls + tool executions) within Hermes. The gateway relays events to the client in real-time.
- **Interrupt as out-of-band**: Interrupts can arrive mid-turn. The gateway sends an `interrupt` message; Hermes must abort within 200ms and send a `turn_end` with `cutoff`. Barge-ins do NOT send an interrupt to Hermes — only TTS is cancelled locally.
- **Streaming tool args**: The `tool_call_delta` event type enables the speak effect to stream text to TTS before the LLM finishes generating. This is the critical bridge for streaming overlap. See Section 4.7.2 for implementation details.
- **Inject context**: For ambient sensor data and proactive triggers that don't require a full turn. Hermes accumulates this in its working memory and includes it in the next turn.

### 4.3 Gateway Responsibilities (Unchanged or Extended)

| Responsibility | Owner | Change |
|---------------|-------|--------|
| WebSocket protocol (client-facing) | Gateway | Unchanged |
| STT (Deepgram streaming) | Gateway | Unchanged |
| TTS (Fish Audio streaming) | Gateway | Unchanged |
| Audio playback + barge-in | Gateway | Unchanged |
| Energy gate + echo suppression | Gateway | Unchanged |
| Interrupt / cancel propagation | Gateway | **Extended** — must propagate to Hermes via IPC |
| Session lifecycle | Gateway | Unchanged |
| ConversationHistory | Gateway | **Extended** — also syncs to Hermes for memory |
| AttentionGate | Gateway | **Extended** — dispatches cycle via AgentBridge instead of in-process |
| Context assembly | Gateway | **Changed** — salience-gated tool list sent to Hermes, Hermes executes |
| LLM streaming | Hermes | **Moved** — gateway relays events, doesn't stream from LLM directly |
| Tool calling | Hermes | **Moved** — Hermes owns the ReAct loop and tool dispatch |
| Memory (persistent) | Hermes | **New** — Hermes has built-in persistent memory |
| Skills | Hermes | **New** — Hermes has built-in skill creation/management |

### 4.4 Hermes Plugin: Sentient Bridge

We write a **Hermes plugin** (`sentient-bridge`) that:

1. **Registers as a lifecycle hook**: `on_session_start`, `on_session_end`, `pre_tool_call`, `post_tool_call`, `pre_llm_call`, `post_llm_call`
2. **Exposes the AgentBridge server**: A Unix domain socket server that accepts requests from the gateway
3. **Intercepts the agent loop**: Hooks into streaming callbacks to emit `text_delta`, `tool_call_start`, `tool_call_delta`, `tool_call_end` events back to the gateway
4. **Handles interrupts**: Gateway sends interrupt → plugin cancels the in-flight LLM call and tool executions
5. **Manages tool registration**: Registers Sentient-specific tools (speak, configure, cancel_task, cancel_all_tasks, home_control, etc.) that the gateway defines via the `configure` message
6. **Streams tool arg deltas**: For the `speak` tool, the plugin intercepts streaming arg deltas and forwards them to the gateway for TTS processing

```python
# ~/.hermes/plugins/sentient-bridge/plugin.yaml
name: sentient-bridge
version: 1.0.0
provides_tools:
  - speak
  - configure
  - cancel_task
  - cancel_all_tasks
provides_hooks:
  - pre_llm_call
  - post_llm_call
  - pre_tool_call
  - post_tool_call
  - on_session_start
  - on_session_end
requires_env:
  - SENTIENT_BRIDGE_SOCKET  # Unix domain socket path
```

### 4.5 Interrupt Propagation Across Process Boundary

This is one of the hardest problems in the migration. Currently, interrupts propagate in-process via AbortController. With Hermes as a sidecar, cancellation must cross a process boundary.

**Two distinct cancellation paths** (see Section 4.7.3 for detailed rationale):

**Barge-in (mic-onset during TTS):**
- Gateway-owned. Hermes is NOT notified.
- Gateway cancels TTS locally, sets "barge-in active" flag to discard further speak deltas.
- When Hermes turn completes, gateway commits the assistant entry with `cutoff: { kind: "barge-in" }`.
- Gateway fires a new AttentionGate dispatch with the barge-in transcript.

**Hard interrupt (UI button / Escape key):**
- Cross-process cancellation. Gateway sends interrupt to Hermes via AgentBridge.

```
User presses Stop (interrupt)
  │
  ├─► Gateway: immediately stops TTS, clears audio buffer
  │    sends playback.stop to client
  │
  └─► Gateway: sends { type: "interrupt", turnId, reason: "interrupt" } over AgentBridge
       │
       └─► Hermes Plugin: cancels in-flight LLM API call
                          cancels running tool executions
                          sends { type: "turn_end", cutoff: { kind: "interrupt" } }
```

**Latency budget**: Gateway stops audio in <5ms (in-process). Hermes abort latency must be <200ms (LLM API call cancellation + tool abort). The user perceives audio stopping instantly; the 200ms delay in LLM/tool cleanup is acceptable because audio has already stopped.

**Implementation**:
- Gateway sends interrupt over AgentBridge as an out-of-band message (not on the turn stream).
- Hermes plugin calls `response.cancel()` on the OpenAI SDK stream (OpenAI SDK supports this natively).
- For running tools, the plugin sets a cancellation flag. Long-running tools must check this flag periodically.
- If Hermes doesn't acknowledge within 500ms, the gateway discards the turn and starts fresh on the next AttentionGate dispatch.

### 4.6 Barge-In Flow (Gateway-Owned, Hermes Unaware)

Barge-in is entirely gateway-owned. Hermes is NOT notified of barge-ins. The gateway detects mic-onset during TTS playback, stops TTS locally, and lets the Hermes turn continue to completion. The user's barge-in transcript is accumulated for the next turn.

```
User speaks during TTS playback
  │
  ├─► BargeInController detects speech onset
  │    confidence > threshold && outside no-interrupt window
  │
  ├─► Gateway cancels all terminal tasks (speak effect) — in-process, <5ms
  │    sends playback.stop { reason: "barge-in" } to client
  │
  ├─► Gateway sets "barge-in active" flag
  │    - Discards any further speak tool_call_delta events from Hermes
  │    - Still receives text_delta events (for conversation history)
  │    - Does NOT send interrupt to Hermes
  │
  └─► When Hermes turn completes (cycle_end):
       - Gateway commits the assistant entry with cutoff: { kind: "barge-in" }
       - Gateway accumulates the barge-in transcript in ShortTermContext
       - AttentionGate fires a new turn with the barge-in context
```

Key difference from the current architecture: in the current system, the LLM stream continues after a barge-in and the gateway just discards TTS output. In the new architecture, the Hermes turn also continues — the gateway just discards speak deltas. When the turn completes, a new turn starts with the user's barge-in text. This is functionally equivalent from the user's perspective: TTS stops instantly, and the next response incorporates the barge-in.

---

## 4.7 Critical Architecture Challenges

These are the problems that require the most careful design. Failure to solve any of them would break core UX.

### 4.7.1 Turn-Based vs. Cycle-Based Execution

**Problem**: Our current cerebrum runs one LLM call per "cycle." The AttentionGate fires multiple cycles for ReAct continuation. Hermes runs a complete agent turn (potentially multiple LLM calls) internally. The gateway cannot control individual ReAct iterations within a Hermes turn.

**Resolution**: The gateway sends a **turn request** (not a cycle request). Hermes runs its full ReAct loop. The gateway receives a stream of events for the entire turn. This means:

- **AttentionGate fires once per user utteration**, not per ReAct iteration. The "when to wake" decision stays in the gateway; the "how many steps to take" decision moves to Hermes.
- **Hermes's `max_turns`** replaces our `maxIterations`. We configure it to 10 to match the current cap.
- **ReAct continuation is automatic** within Hermes. The gateway doesn't need to dispatch separate cycles for tool-call chains.
- **The client still sees cycle-level events.** The gateway synthesizes `cycle.started`/`cycle.completed` events from the AgentBridge stream. Each LLM call within the Hermes turn maps to one client-visible cycle. The gateway tracks these by monitoring `text_delta` start/stop and `tool_call_start`/`tool_call_end` boundaries.

### 4.7.2 Streaming Overlap with Batch Tool Execution

**Problem**: The current `StreamingEffectCoordinator` intercepts `tool_call_delta` chunks directly from the LLM stream and routes them to TTS in real time. In Hermes, tool calls are executed only after the full LLM response is received. The `stream_delta_callback` and `tool_gen_callback` are display callbacks, not execution interception points.

**If we can't intercept streaming tool args before Hermes executes the tool, we lose the 50-70% latency reduction from streaming overlap.**

**Resolution**: The `sentient-bridge` plugin uses the `stream_delta_callback` and `tool_gen_callback` hooks to intercept the LLM stream in real time. When these callbacks indicate a `speak` tool call is being generated:

1. `tool_gen_callback` fires when the tool call name is first parsed from the stream (before args are complete)
2. The plugin begins forwarding `stream_delta_callback` tokens that belong to the speak tool's `text` arg to the gateway via AgentBridge
3. The gateway starts TTS on the first sentence boundary
4. When the full tool call is received by Hermes's agent loop, the plugin's `pre_tool_call` hook marks it as "already executed by gateway" and returns a synthetic result

This requires the plugin to parse streaming token deltas to identify which tokens belong to the `speak` tool's `text` argument. This is feasible because the OpenAI streaming format includes `tool_call.function.arguments` deltas with index-based identification. The plugin tracks: "at stream index N, we're inside tool call X, field Y."

**Risk**: If Hermes changes its streaming callback API, this interception breaks. **Mitigation**: Pin Hermes version; version the plugin against specific Hermes releases. The `stream_delta_callback` is a core part of Hermes's CLI and gateway functionality, so it's unlikely to change without a major version bump.

**Fallback**: If streaming interception proves unreliable, we can fall back to "first-sentence TTS" — wait for the speak tool call to complete (not streamed), then start TTS on the first sentence. This is slower than streaming overlap but still faster than batch TTS (the LLM continues generating while TTS processes the first sentence).

### 4.7.3 Barge-In vs. Interrupt Semantics

**Problem**: Currently, barge-in cancels only terminal tasks (speak/TTS) while the LLM stream continues. Interrupt cancels everything (cycle + TTS + interruptable tasks). With Hermes owning the full agent turn, a barge-in should NOT abort the Hermes turn — only the TTS output.

**Resolution**: Two distinct cancellation paths:

- **Barge-in**: Gateway cancels TTS locally (in-process). Does NOT send an interrupt to Hermes. Instead, gateway sends `inject_context` with the barge-in transcript so Hermes can incorporate the user's new input in its next response. The LLM continues generating; the gateway discards any further `speak` tool call deltas for this turn. When the Hermes turn ends, the gateway starts a new turn with the barge-in context.

- **Interrupt**: Gateway cancels TTS locally AND sends `interrupt` to Hermes via AgentBridge. Hermes aborts the in-flight LLM call and all running tools. Hermes sends `cycle_end` with `cutoff: { kind: "interrupt" }`.

This means barge-in is **fully gateway-owned** with no Hermes involvement, while interrupt is a **cross-process cancellation** that requires Hermes cooperation.

### 4.7.4 Parallel Tool Calls

**Problem**: Hermes may call multiple tools in a single LLM response (parallel tool calling). The current system dispatches effects in parallel with a TaskManager. With Hermes, parallel tool calls are executed by Hermes's `ThreadPoolExecutor`, and the gateway only sees the results.

**Resolution**: For non-speak tools, this is fine — Hermes handles parallelism internally. For speak (which must stay in the gateway), the plugin must serialize speak calls within a turn. Only one speak call can be active at a time (this matches the current `singletonPerCycle` constraint). If the LLM generates multiple speak calls in one response, the plugin queues them and executes sequentially.

The gateway maps each Hermes tool call to a `task.update` event for the client. Task IDs are generated by the gateway (not Hermes) and correlated with Hermes's internal tool call IDs.

### 4.7.5 Conversation History Source of Truth

**Problem**: Both gateway and Hermes maintain conversation history. Hermes has its own session management, context compression, and persistent memory. If we send full history each cycle, we waste tokens. If we let Hermes manage history, we lose control over what the client sees.

**Resolution**: **Dual history, gateway authoritative.**

- **Gateway** owns the client-facing conversation history (what the client sees). This includes barge-in markers, interrupt markers, pending messages, and task status.
- **Hermes** owns the LLM-facing conversation history (what the model sees). This includes context compression, tool results, and persistent memory.
- **On each turn**, the gateway sends only the **new events** since the last turn (not the full history). Hermes maintains its own rolling context.
- **On conflict** (e.g., gateway adds an interrupt marker that Hermes didn't see), the gateway injects a correction via `inject_context`.
- **Memory sync**: Hermes's persistent memory is supplementary. The gateway's `ConversationHistory` is the primary context source for LLM prompts. Hermes's memory is used for cross-session recall (user preferences, learned facts).

This replaces the earlier design (Section 5.4) which sent full history each cycle. Sending only deltas is more efficient and avoids context duplication.

---

## 5. Preserving UX Features

### 5.1 Voice Interaction (Preserved — Gateway-Owned)

All voice UX stays in the gateway. Hermes never sees audio, never processes audio, never controls audio.

| UX Feature | Implementation | Change |
|-----------|---------------|--------|
| Toggle-to-talk | Gateway | None |
| Barge-in detection | Gateway (BargeInController) | None |
| Barge-in TTS cancellation | Gateway (cancel terminal tasks) | None |
| Hard interrupt | Gateway + AgentBridge interrupt message | **New**: propagates to Hermes |
| Echo suppression | Gateway (energy gate + cooldown) | None |
| Streaming text to client | Gateway (message.delta from Hermes events) | Relay from Hermes |
| Typewriter buffer | Gateway (client-side hook) | None |
| Pending user messages | Gateway (client-side) | None |
| Cycle lifecycle events | Gateway (derived from AgentBridge events) | Source changes |

### 5.2 Streaming Overlap (Critical — Requires Plugin Interception)

This is the most technically challenging feature to preserve. The current system intercepts LLM token streams in-process and starts TTS before the LLM finishes generating. With Hermes as a sidecar, we need the `sentient-bridge` plugin to intercept streaming tokens and forward them to the gateway before Hermes executes the speak tool.

**How it works** (see Section 4.7.2 for detailed analysis):

1. Hermes's `stream_delta_callback` fires for each LLM token
2. The plugin detects a `speak` tool call via `tool_gen_callback` (fires when tool name is first parsed from stream)
3. Plugin begins forwarding `text` arg deltas to the gateway via AgentBridge `tool_call_delta` events
4. Gateway receives deltas, feeds them to UtteranceAggregator → EmotionTagger → FishAudioSynthesizer
5. TTS starts producing audio before the LLM finishes the speak tool call
6. When the full speak call is received by Hermes, the plugin's `pre_tool_call` hook returns a synthetic result (TTS already started by the gateway)

**IPC latency**: ~1-5ms per delta on localhost Unix domain socket, negligible compared to TTS processing (~50-100ms per sentence).

**Fallback**: If streaming interception proves unreliable, fall back to "first-sentence TTS" — start TTS after the speak call completes, using the first sentence while the LLM continues generating. This is slower than streaming overlap but still faster than batch TTS.

### 5.3 AttentionGate and Salience (Preserved — Gateway-Owned)

AttentionGate stays in the gateway. It decides **when** to wake the agent, not **what** the agent does.

```
ShortTermContext accumulates events
  │
  └─► AttentionGate evaluates salience
       │
       ├─► Below threshold → continue accumulating
       │
       └─► Above threshold → fire cycle
            │
            └─► Gateway sends CyclePayload to Hermes
                 (includes context, tools, preferences)
```

The gateway still owns salience accumulation, debounce, and rate limiting. Hermes only sees cycle requests.

### 5.4 Conversation History (Dual, Gateway Authoritative)

Two separate histories, with the gateway as the authoritative source for client-visible state.

- **Gateway history**: The client-facing conversation that the client sees. Includes barge-in markers, interrupt markers, pending messages, task status. This is the source of truth for what happened in the conversation.
- **Hermes history**: The LLM-facing context that the model sees. Includes context compression, tool results, persistent memory. Hermes manages this internally.
- **Synchronization**: On each turn, the gateway sends only **new events** (deltas) since the last turn — not the full history. This avoids token waste and context duplication.
- **On conflict**: If the gateway adds an interrupt marker that Hermes didn't see, the gateway injects a correction via `inject_context`.
- **Memory**: Hermes's persistent memory is supplementary. It stores cross-session facts (user preferences, learned skills). The gateway's ConversationHistory is the primary context source for real-time conversation.

This approach avoids the token waste of sending full history each cycle while maintaining consistency between what the client sees and what the model sees.

### 5.5 Task Status Tracking (Preserved — Bridged)

The current `TaskManager` in the gateway tracks running/completed/failed tasks. In the new architecture:

- Hermes owns tool execution and reports `task_update` events to the gateway
- Gateway maps Hermes task IDs to client-visible task snapshots
- Gateway sends `task.update` to the client (unchanged protocol)
- Gateway handles `cancel_task` and `cancel_all_tasks` by sending `cancel_task` messages over AgentBridge

### 5.6 Family-Aware Role Gating (Preserved — Gateway-Owned)

Role gating stays in the gateway. The `effect-wrapper` pipeline (role check, capability check, confirmation gate) is applied **before** tools are offered to Hermes. Only tools the user is allowed to use appear in the `availableTools` list sent in the `CyclePayload`. Hermes never sees tools the user can't access.

This is stronger than the current architecture: currently, all effect definitions exist in the gateway but are gated at dispatch time. With Hermes, the tool definitions themselves are filtered before they leave the gateway.

### 5.7 Cycle Lifecycle Mapping (Turn-Based Model)

A single Hermes turn may involve multiple ReAct iterations. Each iteration corresponds to one "cycle" in the client protocol. The gateway synthesizes cycle events from the AgentBridge stream:

| Current Event | New Architecture Event |
|--------------|----------------------|
| `cycle.started` (gateway) | Gateway receives `iteration_start` from Hermes, emits `cycle.started` to client |
| `message.delta` (gateway) | Gateway receives `text_delta` from Hermes, emits `message.delta` to client |
| `message.done` (gateway) | Gateway receives last `text_delta` for an iteration, emits `message.done` |
| `connector.audio.start` (gateway) | Gateway receives `tool_call_start` for `speak`, starts TTS |
| `connector.audio.frame` (gateway) | Gateway receives `tool_call_delta` for `speak.text`, feeds to TTS |
| `connector.audio.done` (gateway) | Gateway receives `tool_call_end` for `speak`, finishes TTS |
| `task.update` (gateway) | Gateway receives `task_update` from Hermes, maps to client event |
| `cognition.status` (gateway) | Gateway derives from AgentBridge event stream (`text_delta` → thinking/streaming, `tool_call` → acting) |
| `cycle.completed` (gateway) | Gateway receives `iteration_end` from Hermes, emits `cycle.completed` (if more iterations follow) |
| Final `cycle.completed` (gateway) | Gateway receives `turn_end` from Hermes, emits final `cycle.completed` |
| `cycle.aborted` (gateway) | Gateway receives `turn_end` with `cutoff`, emits `cycle.aborted` |

The client doesn't know about turns vs. iterations — it still sees individual cycles, just like today.

---

## 6. Security Hardening

### 6.1 Container Isolation

Hermes runs in a hardened Docker container with defense-in-depth:

| Layer | Configuration |
|-------|--------------|
| Capabilities | `--cap-drop=ALL` + `cap_add: [DAC_OVERRIDE, CHOWN, FOWNER]` |
| Security | `no-new-privileges:true`, read-only filesystem |
| Network | `internal: true` — no LAN/Internet access except via api-proxy |
| Resources | CPU: 2, Memory: 4GB (RPi5 has 8GB) |
| Filesystem | `read_only: true`, tmpfs on `/tmp`, persistent data on named volume |
| Seccomp | Custom profile blocking 85% of syscalls (future: use Docker's built-in default profile) |

The gateway, by contrast, needs LAN access and is less restricted — it handles client connections, STT, TTS, and file serving.

### 6.2 Network Isolation

```
Home LAN (192.168.x.x)
    │
    ├── Gateway (lan-facing network)
    │   ├── Port 8888 (WSS)
    │   └── Port 8443 (HTTPS)
    │
    └── hermes-net (internal-only bridge)
        ├── Hermes (no external access)
        └── API Proxy (egress to allowlisted hosts only)
            ├── api.openrouter.ai:443
            ├── api.fish.audio:443
            └── (future: home automation APIs)
```

The API proxy allowlists only required external hosts. Hermes cannot reach the home network, the gateway's filesystem, or any other device. All API calls go through the proxy, which logs and rate-limits outbound requests.

### 6.3 Agent Bridge Security

The Unix domain socket is the only communication channel between gateway and Hermes:

- **Filesystem permissions**: Socket file is `0600`, owned by the gateway process. Hermes connects, gateway accepts.
- **No network exposure**: Unix domain sockets don't have network ports. No port to scan.
- **Message validation**: Both sides validate message schema with Zod (gateway) and Pydantic (Hermes plugin). Malformed messages are rejected.
- **Cycle ID correlation**: Every request has a UUID. Responses reference the same UUID. No cross-talk between sessions.
- **Timeout**: If Hermes doesn't respond to a cycle request within 60 seconds (configurable), the gateway aborts and sends an error to the client.

### 6.4 Prompt Injection Defense (Enhanced)

The current 6-layer defense is preserved and extended:

| Layer | Current | New |
|-------|---------|-----|
| 1. Input sanitization | In-process (gateway) | **Unchanged** — STT text is sanitized before entering any pipeline |
| 2. Heuristic filter | In-process (gateway) | **Unchanged** — regex patterns + fuzzy matching |
| 3. Structural separation | In-process (gateway) | **Enhanced** — now enforced at the AgentBridge level. The gateway assembles the prompt structure; Hermes never sees raw user text outside designated slots |
| 4. Privilege reduction | In-process (gateway) | **Enhanced** — tools are filtered by role before being sent to Hermes. Hermes never sees tools the user can't use |
| 5. Canary tokens | In-process (gateway) | **Unchanged** — embedded in system prompt |
| 6. Output filter | In-process (gateway) | **Moved downstream** — applied to Hermes's text_delta events before forwarding to TTS or client |
| 7. Tool-result sanitization | N/A | **NEW** — Hermes tool results are scanned for injection patterns before being added to context |
| 8. STT-layer filtering | Implicit (Deepgram output) | **NEW** — explicit injection pattern scan on STT transcript before it enters the LLM context |
| 9. Policy-as-code at tool boundary | Implicit (effect-wrapper) | **NEW** — explicit policy engine validates every tool call against a rule set before execution. Not LLM-dependent |

### 6.5 Session Risk Accumulation

A new defense layer: track cumulative risk across conversation turns.

```yaml
# config.yaml (new section)
security:
  risk_accumulator:
    enabled: true
    ttl_seconds: 300          # Risk decays over 5 minutes
    threshold_warn: 50        # Log warning
    threshold_escalate: 80    # Require confirmation for all tools
    threshold_block: 100      # End session
    injection_patterns_weight: 30   # Each detected injection pattern adds 30 points
    repeated_offense_weight: 20      # Second occurrence in TTL adds 20 more
    role_violation_weight: 60        # Attempting to use tools above role adds 60
```

This prevents slow-drip injection attacks that try one benign-seeming manipulation per turn.

### 6.6 MCP Security

If Hermes connects to MCP servers for tool integration (Section 8), the following defenses apply:

- **Authentication required**: All MCP servers must use authentication. No anonymous access.
- **Parameter validation**: Gateway validates all MCP tool parameters against strict schemas before Hermes executes them.
- **Output sanitization**: All MCP tool results are scanned for injection patterns before being added to LLM context.
- **Description pinning**: MCP tool description hashes are pinned. Changes require manual review.
- **Container isolation**: MCP servers run in their own containers with `--cap-drop=ALL` and no network access beyond what's needed.

### 6.7 Auth Token Model

Current: PASETO v4.local tokens for WebSocket auth. Session: anonymous with adult role.

Extended for Hermes:
- **Client ↔ Gateway**: PASETO v4.local (unchanged)
- **Gateway ↔ Hermes**: Shared secret on Unix domain socket (filesystem permission = auth)
- **Gateway ↔ STT**: Shared bearer token via sentient-auth (unchanged)
- **Gateway ↔ TTS**: Shared bearer token via sentient-auth (unchanged)
- **Hermes ↔ LLM APIs**: API keys stored in Hermes's `.env` (mode 0600, not accessible to gateway)
- **In-band token refresh**: Gateway sends PASETO token refresh over existing WebSocket without dropping connection. Long-lived sessions re-authenticate every 15 minutes.

---

## 7. Tool & Sensor Integration

### 7.1 Tool Architecture: Gateway-Defined, Hermes-Executed

Tools are defined in the gateway (for salience gating, role gating, capability checks) but executed by Hermes (for ReAct loop integration). This split preserves all existing gateway controls while leveraging Hermes's tool dispatch.

```typescript
// Gateway defines which tools are available this cycle
const availableTools = effectRegistry.getAvailableTools({
  role: session.role,           // "adult" | "child" | "guest"
  capabilities: session.capabilities,  // ["audio.output", ...]
  salience: accumulatedSalience,  // from AttentionGate
  alwaysAvailable: true,         // speak, configure, cancel_*
});

// Sent to Hermes in CyclePayload
cyclePayload.availableTools = availableTools.map(t => ({
  name: t.name,
  description: t.description,
  parameters: t.schema,
  impact: t.impact,
  interruptable: t.interruptable,
  terminal: t.terminal,
  streamingArgs: t.streamingArgs,
}));
```

### 7.2 Built-in Tools

| Tool | Impact | Where Executed | Notes |
|------|--------|----------------|-------|
| `speak` | auto | **Gateway** | Streaming TTS — must stay in gateway for real-time audio |
| `configure` | auto | Gateway | Session preference changes |
| `cancel_task` | auto | Hermes + Gateway | Cancel a specific running task |
| `cancel_all_tasks` | auto | Hermes + Gateway | Cancel all interruptable tasks |
| `home_control` | write | **Hermes** | Smart home device control via Home Assistant |
| `weather` | read | Hermes | Weather API |
| `timer` | write | Hermes | Set/cancel timers |
| `shopping_list` | write | Hermes | Shopping list management |
| `calendar` | write | Hermes | Calendar integration |
| `remember` | write | Hermes | Persistent memory (Hermes-native) |
| `web_search` | read | Hermes | Web search (MCP or built-in) |

**Key distinction**: Tools that produce real-time output (speak) or control gateway state (configure, cancel_task) are **gateway-executed**. Hermes calls them but the gateway handles execution. All other tools are **Hermes-executed** — the gateway only sees the result.

### 7.3 Speak Tool: The Critical Bridge

The `speak` tool is special. It's the only tool that produces real-time streaming output (audio). It must stay in the gateway for latency reasons.

When Hermes decides to call `speak`:
1. Hermes emits `tool_call_start` with `streamingArgs: ["text"]`
2. For each LLM token that contributes to the `text` arg, Hermes emits `tool_call_delta` with the incremental text
3. Gateway receives deltas, feeds them to UtteranceAggregator → EmotionTagger → FishAudioSynthesizer
4. TTS audio frames flow to the client in real time
5. When the `speak` tool call completes, Hermes emits `tool_call_end`

This is the same streaming-overlap pipeline as today, just with the StreamingEffectCoordinator replaced by the AgentBridge event stream.

### 7.4 Sensor Integration: AttentionGate + Hermes inject_message

The current pattern of accumulating sensor events in ShortTermContext and dispatching via AttentionGate is preserved. When a cycle fires:

1. Gateway projects ShortTermContext (situation awareness, tonic state, task table, salience)
2. Gateway includes projected context in the `CyclePayload.ephemeralContext`
3. Hermes receives this as the per-cycle system message

For proactive agent behavior (Hermes waking itself based on events), we use Hermes's `ctx.inject_message()` plugin hook:

```python
# In the sentient-bridge plugin
class SentientBridgePlugin:
    def on_sensor_event(self, event: dict):
        """Called by gateway via AgentBridge inject_context message."""
        # Gateway sends structured sensor data
        # Plugin injects it into Hermes's working memory
        self.ctx.inject_message(
            role="user",
            content=f"[trigger/sensor.{event['type']}] {event['summary']}"
        )
```

This enables two wake paths:
1. **AttentionGate-driven** (gateway-controlled): Gateway decides when to fire a cycle based on salience thresholds. This is the primary path.
2. **Hermes self-wake** (agent-driven): Hermes can wake itself based on injected context (e.g., timer fires, sensor threshold crossed). This is the secondary path for future proactive behavior.

### 7.5 Home Automation Integration

Home automation integration uses Hermes's MCP client capability:

```yaml
# hermes/config.yaml
mcp_servers:
  homeassistant:
    transport: stdio
    command: python
    args: ["-m", "homeassistant_mcp"]
    env:
      HA_URL: http://homeassistant.local:8123
      HA_TOKEN: ${HA_LONG_LIVED_TOKEN}
```

The gateway defines the `home_control` tool with role gating and confirmation requirements. When Hermes wants to control a device:
1. Hermes includes `home_control` in its tool call
2. Plugin checks impact level and user role (via gateway's tool definition)
3. If `impact: confirm`, plugin requests confirmation from the client (via gateway → client → gateway round-trip)
4. If approved, plugin calls the Home Assistant MCP server
5. Result flows back: MCP → Hermes plugin → AgentBridge → gateway → client

### 7.6 Future Sensor Expansion

```yaml
# Future MCP servers (add without gateway code changes)
mcp_servers:
  homeassistant:
    transport: stdio
    command: python
    args: ["-m", "homeassistant_mcp"]
    env:
      HA_URL: http://homeassistant.local:8123
      HA_TOKEN: ${HA_LONG_LIVED_TOKEN}

  weather:
    transport: stdio
    command: python
    args: ["-m", "weather_mcp"]
    env:
      OPENWEATHER_API_KEY: ${OPENWEATHER_API_KEY}

  calendar:
    transport: stdio
    command: python
    args: ["-m", "google_calendar_mcp"]
    env:
      GOOGLE_CREDENTIALS: ${GOOGLE_CREDENTIALS_JSON}
```

Adding a new tool/sensor is:
1. Add the MCP server config to Hermes's `config.yaml`
2. Add the tool definition to the gateway's effect registry (for salience gating and role gating)
3. No gateway code changes needed — Hermes discovers MCP tools automatically

---

## 8. Hermes Power Usage

### 8.1 What We Gain from Hermes

| Capability | Current (Custom Cerebrum) | With Hermes |
|-----------|--------------------------|-------------|
| LLM provider failover | None — single OpenRouter config | Automatic failover on 429/5xx/401/403 across all configured providers |
| Model switching | Config change + restart | `hermes model` at runtime, or per-cycle model override in CyclePayload |
| Persistent memory | Not implemented (planned) | 5-layer memory system: short-term, procedural skills, vector store, user modeling, FTS5 search |
| Skill creation | Not implemented (planned) | Auto-created from completed tasks, portable via agentskills.io standard |
| Subagent delegation | Not implemented | Up to 3 concurrent subagents with independent budgets |
| Context compression | Simple FIFO truncation | Smart compression at 50%/85% context, preserving tool call/result pairs |
| Multi-platform messaging | Web only | Telegram, Discord, Slack, WhatsApp, Signal, Matrix (if desired) |
| MCP integration | Not implemented | Native MCP client with stdio and HTTP transports, auto-reconnection |
| Security | 6-layer defense | 7+ layer: user auth, command approval, container isolation, MCP credential filtering, context scanning, session isolation, SSRF protection, input sanitization |
| Cron/scheduling | Not implemented | Built-in cron scheduler for recurring tasks |
| Tool registry | Manual registration | Auto-discovery + plugin system + MCP dynamic tool discovery |

### 8.2 What We Lose or Must Rebuild

| Capability | Impact | Mitigation |
|-----------|--------|-----------|
| Streaming overlap (TTS starts mid-LLM) | **Critical** — Hermes is batch TTS | Gateway owns TTS pipeline; speak tool bridges streaming args via AgentBridge |
| Barge-in (mic-onset stops TTS) | **Critical** — no barge-in in Hermes | Gateway owns barge-in entirely; Hermes is not involved |
| AttentionGate (salience dispatch) | **Critical** — no equivalent in Hermes | Gateway owns AttentionGate; Hermes only receives cycle requests |
| In-process AbortController | **High** — IPC adds latency | AgentBridge interrupt message; <200ms abort budget |
| TypeScript-native | **Medium** — two runtimes, two debug toolchains | Docker Compose unifies deployment; logs aggregate to gateway |
| Config-driven thresholds | **Medium** — Hermes has its own config | Gateway controls cycle parameters; Hermes config is for LLM/memory |
| Echo suppression | **None** — stays in gateway | Unchanged |

### 8.3 Known Hermes Issues to Mitigate

| Issue | Severity | Mitigation |
|-------|----------|-----------|
| SQLite state.db corruption (concurrent writes) | High | Use single-writer pattern: only the gateway process triggers state writes via Hermes plugin. Never run CLI and gateway against same data dir simultaneously. Add periodic WAL checkpoint. |
| Session fragmentation / token waste | Medium | Gateway controls conversation history sent to Hermes. Token budgets enforced at the gateway level. Hermes's own compression is a safety net, not the primary mechanism. |
| Silent loop termination (`_last_content_with_tools` fallback) | Medium | AgentBridge protocol requires Hermes to always emit `cycle_end`. Gateway timeout (60s) catches silent failures. |
| Memory 2,200 char limit | Low | Hermes's memory is supplementary; the gateway's ConversationHistory is the primary context source. |
| PYTHONPATH injection (Issue #8028) | High | Mitigated by container isolation: `--cap-drop=ALL`, `read_only`, `no-new-privileges`. Hermes cannot read `.env` from host. |
| No ARM/RPi-specific image | Medium | Build custom ARM64 image from the Dockerfile. The RPi5 has sufficient RAM/CPU for both containers. |

### 8.4 Resource Allocation on Raspberry Pi 5 (8GB)

| Component | Memory | CPU | Notes |
|-----------|--------|-----|-------|
| Gateway (TS/Bun) | 128-256 MB | 0.5 core | Lightweight; mostly I/O bound |
| Hermes (Python) | 1-2 GB | 1-2 cores | LLM API calls are network-bound; Python overhead is modest |
| API Proxy | 32-64 MB | 0.1 core | Simple allowlist proxy |
| System | 512 MB | 0.5 core | OS + overhead |
| **Total** | **2-3 GB** | **2-3 cores** | **Comfortable fit on 8GB RPi5** |

---

## 9. Maintainability

### 9.1 What We Don't Have to Build

By using Hermes, we avoid building:

1. **LLM provider abstraction** — Hermes handles OpenRouter, OpenAI, Anthropic, etc. with automatic failover
2. **ReAct loop** — Hermes has a mature iteration budget system with concurrent tool execution
3. **Tool registry and dispatch** — Hermes has auto-discovery, plugin system, and MCP integration
4. **Context compression** — Hermes has smart compression preserving tool call/result pairs
5. **Persistent memory** — Hermes has 5-layer memory with FTS5 search
6. **Skill system** — Hermes has auto-created, self-improving skills via agentskills.io standard
7. **Multi-platform messaging** — Available if we want it (Telegram, Discord, etc.)
8. **Security hardening** — Hermes has 7+ layer defense; we add gateway-specific layers

### 9.2 What We Still Own

1. **Real-time voice pipeline** (STT, TTS, audio I/O, echo suppression) — this is our core value
2. **WebSocket protocol** (client-facing) — our UX differentiation
3. **AttentionGate** (when to wake the agent) — our salience model
4. **Barge-in / interrupt** (real-time cancellation) — voice UX requirement
5. **Session management** (client lifecycle) — our protocol
6. **AgentBridge plugin** (IPC bridge) — thin adapter
7. **Gateway-side effects** (speak, configure, cancel) — real-time control

### 9.3 Testing Strategy

| Layer | Strategy |
|-------|---------|
| AgentBridge protocol | Contract tests with mock Hermes (JSON schema validation) |
| Hermes plugin | Unit tests with mock gateway (Python pytest) |
| Gateway integration | Integration tests with real Hermes container (Docker Compose test env) |
| End-to-end | Smoke tests with real STT/TTS (existing test suite) |
| Interrupt propagation | Chaos tests: send interrupt at random points in cycle, verify <200ms abort |
| Streaming overlap | Latency tests: measure TTS-first-sentence latency with and without Hermes |

### 9.4 Open Source Dependencies

| Dependency | License | Risk | Mitigation |
|-----------|---------|------|-----------|
| Hermes Agent | MIT | Low | Can fork if upstream diverges; Python plugin is isolated |
| Home Assistant MCP | MIT | Low | Community-maintained; can write our own adapter |
| Docker | Apache 2.0 | None | Standard infrastructure |
| Unix domain socket | OS-level | None | POSIX standard |

### 9.5 Upgrade Path

- **Hermes upgrades**: Pull new Docker image, restart container. AgentBridge protocol is versioned. Breaking changes require plugin updates, not gateway changes.
- **Gateway upgrades**: Independent of Hermes. Build and deploy gateway image separately.
- **Protocol versioning**: AgentBridge includes a `version` field. Gateway and plugin negotiate on startup. Mismatches result in clear error messages.

---

## 10. Edge Cases

### 10.1 Hermes Crash or Unresponsive

**Detection**: Gateway healthcheck polls Hermes's `/health` endpoint every 10s. If Hermes is unreachable for 30s:
1. Gateway sends `error` message to client: "Agent temporarily unavailable"
2. Gateway queues any pending cycle requests (max 1, since cycles are serial)
3. When Hermes recovers, gateway replays the queued request
4. If Hermes is down for >5 minutes, gateway disconnects the client with `session.expired`

**Graceful degradation**: If Hermes is down, the gateway still accepts WebSocket connections and processes STT. It just can't produce LLM responses. The client shows "connecting to agent..." state.

### 10.2 Partial Stream Failure

If Hermes starts streaming a response but crashes mid-stream:
1. The AgentBridge connection drops
2. Gateway detects the broken connection within the IPC timeout (5s)
3. Gateway sends `cycle.aborted` to the client with reason "agent_error"
4. Gateway attempts to reconnect to Hermes
5. The incomplete response is committed to ConversationHistory with a `cutoff: { kind: "interrupt", cancelledTaskIds: [] }` marker

### 10.3 Race Condition: Barge-In During Tool Execution

User barge-in while Hermes is executing a long-running tool (e.g., `home_control`):
1. Gateway sends `interrupt` over AgentBridge
2. Hermes plugin sets cancellation flag
3. Tool checks flag periodically (every 100ms for long-running tools)
4. Tool returns `{ status: "cancelled" }`
5. Hermes emits `cycle_end` with `cutoff: { kind: "barge_in" }`
6. If tool doesn't cancel within 2s, Hermes force-aborts it

### 10.4 Race Condition: Interrupt During TTS Streaming

User presses Stop while TTS is playing audio from a speak call:
1. Gateway immediately stops audio playback (in-process, <5ms)
2. Gateway sends `playback.stop` to client
3. Gateway sends `interrupt` over AgentBridge
4. Hermes aborts the cycle
5. Gateway sends `cycle.aborted` to client
6. Audio has already stopped — no perceptible delay for the user

### 10.5 Multiple Concurrent Clients

The current gateway supports up to 10 concurrent sessions (configurable). With Hermes:
- Each session gets its own Hermes conversation (via `conversation` parameter in the AgentBridge protocol)
- Hermes supports multiple concurrent conversations in a single process
- The `sentient-bridge` plugin multiplexes sessions over the Unix domain socket
- Gateway enforces the session cap independently

### 10.6 Hermes Memory Across Sessions

Hermes's persistent memory persists across sessions. This is a feature, not a bug:
- **Pro**: The assistant remembers user preferences, past conversations, and learned skills
- **Con**: Memory from one user could leak to another (family scenario)
- **Mitigation**: The `sentient-bridge` plugin scopes memory by `sessionId`. Each session gets its own Hermes conversation and memory namespace. Cross-session memory sharing is opt-in via a `shared_memory` config flag.

### 10.7 Token Budget Exhaustion

If Hermes's context compression fails or the conversation exceeds maximum context:
1. Hermes triggers compression at 50% (preflight) or 85% (gateway) of context window
2. If compression fails, Hermes emits an `error` event with `code: "context_overflow"`
3. Gateway handles this by starting a fresh conversation with a summary of the previous one
4. Gateway sends `conversation.snapshot` to the client with the new history

### 10.8 Network Partition

If the home network goes down (no LLM API access):
1. Hermes's provider failover attempts all configured providers
2. All providers fail → Hermes emits `error` with `code: "provider_unavailable"`
3. Gateway sends `error` message to client: "I can't reach my thinking service right now"
4. STT still works locally (if using local STT)
5. When connectivity returns, Hermes auto-retries on the next cycle

### 10.9 Dual-Write Conversation History

Both gateway and Hermes maintain conversation history. They can diverge if:
- Hermes compresses context (removes old messages)
- Gateway adds barge-in/interrupt markers that Hermes doesn't know about
- User edits or deletes messages on the client

**Resolution**: Gateway is the source of truth. Each cycle, gateway sends the full token-budgeted history to Hermes. Hermes uses its own history for context compression and memory, but the authoritative transcript is gateway-owned. Any divergence is resolved at the start of the next cycle.

### 10.10 Clock Drift Between Containers

Gateway and Hermes run in separate containers with potentially different clock sources. For IPC, this is irrelevant — Unix domain sockets are synchronous within the same kernel. For timestamp-based operations (session expiry, memory TTL), both containers use NTP-synchronized clocks. The gateway's PASETO tokens include absolute expiry times.

---

## 11. Migration Strategy

### 11.1 Phase 0: AgentBridge Protocol (Week 1-2)

- Define the AgentBridge JSON schema (messages from Section 4.2)
- Implement the gateway-side AgentBridge client (Unix domain socket)
- Write contract tests with a mock Hermes server
- Validate message schema with Zod (gateway) and Pydantic (Hermes)

### 11.2 Phase 1: Hermes Plugin (Week 2-4)

- Write the `sentient-bridge` Hermes plugin
- Implement lifecycle hooks: `pre_llm_call`, `post_llm_call`, `pre_tool_call`, `post_tool_call`
- Implement streaming event emission (text_delta, tool_call_start, tool_call_delta, tool_call_end)
- Implement interrupt handling (cancel in-flight LLM call + running tools)
- Implement speak tool bridge (streaming text arg → AgentBridge event → gateway TTS)
- Test with mock gateway

### 11.3 Phase 2: Gateway Integration (Week 3-5)

- Replace CognitiveCycle with AgentBridge cycle dispatch
- Replace StreamingEffectCoordinator with AgentBridge event stream processing
- Keep AttentionGate, BargeInController, InterruptController in gateway
- Keep all audio pipeline components unchanged (STT, TTS, echo suppression)
- Implement dual-write: ConversationHistory (gateway) + Hermes memory (sidecar)
- Docker Compose setup: gateway + hermes + api-proxy

### 11.4 Phase 3: Tool Migration (Week 5-7)

- Migrate `speak` to AgentBridge streaming (gateway-executed)
- Migrate `configure`, `cancel_task`, `cancel_all_tasks` to AgentBridge (gateway-executed)
- Add `home_control` via Home Assistant MCP (Hermes-executed)
- Add `remember` tool (Hermes-native persistent memory)
- Add `timer`, `weather`, `calendar` via MCP or built-in Hermes tools
- Implement confirmation flow for `impact: confirm` tools (client round-trip)

### 11.5 Phase 4: Security Hardening (Week 6-8)

- Container hardening (seccomp profile, read-only filesystem, network isolation)
- API proxy with host allowlisting
- Tool-result sanitization layer
- STT-layer injection filtering
- Session risk accumulator
- Policy-as-code validation at tool-call boundary

### 11.6 Phase 5: Testing & Rollout (Week 7-9)

- Contract tests for AgentBridge protocol
- Integration tests with real Hermes container
- Smoke tests with real STT/TTS
- Chaos tests (interrupt at random points, Hermes crash recovery)
- Latency benchmarks (compare with current in-process cerebrum)
- Rollout to Pi with Watchtower (existing deployment pipeline)

---

## 12. Risk Assessment

### 12.1 High Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|-----------|
| Streaming overlap relies on plugin intercepting LLM stream | If interception fails, TTS latency increases 50-70% | Medium | Fallback to first-sentence TTS (speak completes before TTS starts). Pin Hermes version; test streaming callbacks thoroughly. |
| Hermes turn model vs. our cycle model | AttentionGate fires per-turn, not per-cycle; ReAct iterations hidden inside turns | Low | Gateway synthesizes cycle events from iteration_start/iteration_end events. Client sees same lifecycle. |
| IPC latency too high for streaming overlap | TTS starts late, perceived latency increases | Low (1-5ms on localhost) | Benchmark early in Phase 1; fallback to in-process if >20ms |
| Hermes crash during conversation | User sees "agent unavailable" | Medium | Graceful degradation; auto-reconnect; turn replay |
| Interrupt not propagated within 200ms | LLM continues generating after user pressed Stop | Low | Healthcheck + timeout; Hermes plugin uses response.cancel() |
| SQLite corruption in Hermes | Memory loss, session errors | Medium | Single-writer pattern; periodic WAL checkpoint; backup script |
| Python/TS language mismatch | Debugging complexity, two build systems | Medium | Docker Compose unifies deployment; structured logging across both |
| Hermes plugin API changes break streaming interception | Speak tool bridge stops working | Medium | Pin Hermes version; version the plugin against specific releases; fallback to first-sentence TTS |

### 12.2 Medium Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|-----------|
| Hermes API changes between versions | Plugin breaks on upgrade | Medium | Pin Hermes version; versioned AgentBridge protocol |
| Memory leak in Hermes container | Degraded performance over time | Low | Memory limits in Docker Compose; periodic container restart |
| MCP server vulnerabilities | 82% of MCP servers have known vulns | Medium | Auth required; output sanitization; container isolation |
| RPi5 resource contention | Both containers compete for CPU | Low | CPU limits in Docker Compose; gateway is lightweight |

### 12.3 Low Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|-----------|
| AgentBridge protocol version mismatch | Connection refused | Low | Version negotiation on startup |
| Clock drift between containers | Timestamp issues | Very Low | NTP on both containers |
| Hermes plugin ecosystem conflicts | Plugin incompatibility | Low | Test in staging; pin versions |

---

## 13. Success Metrics

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| Time to first audio (TTFA) | ~800ms | <900ms | End-to-end latency benchmark |
| Barge-in response time | ~5ms | <10ms | Time from mic-onset to audio stop |
| Interrupt propagation | ~5ms (in-process) | <200ms (IPC) | Time from UI button to LLM abort |
| Tool call success rate | ~98% | >97% | Successful tool completions / total |
| Hermes crash recovery time | N/A | <30s | Time from crash detection to cycle replay |
| Memory usage (total) | ~90MB (gateway only) | <3GB (both containers) | Docker stats |
| CPU usage (idle) | ~5% | <15% | Top/htop on RPi5 |

---

## 14. Alternatives Considered and Rejected

| Alternative | Why Rejected |
|------------|-------------|
| **In-process Hermes (Python embedded in Bun)** | No stable Python-in-Bun runtime; would require Pyodide or WASM with massive overhead; loses process isolation |
| **LangGraph.js** | Immature; lacks Hermes's tool ecosystem, memory, and self-improvement; would need to build AttentionGate, memory, skills from scratch |
| **OpenAI Agents SDK** | TypeScript-native, best cancellation API, but tied to OpenAI models; no persistent memory; no self-improvement; no MCP support |
| **Custom cerebrum (status quo)** | Highest maintenance burden; no community; no memory; no skill system; every LLM provider change requires custom code |
| **Rewrite cerebrum in TypeScript using Hermes patterns** | Reinvents the wheel; loses community ecosystem; ongoing maintenance burden; no clear benefit over Option A |