# Voice Gateway Architecture: Research Findings

_Date: 2026-04-03_

---

## Table of Contents

1. [Existing Frameworks Analysis](#1-existing-frameworks-analysis)
2. [Pipeline Architecture](#2-pipeline-architecture)
3. [API Design](#3-api-design)
4. [Pluggable Backend Abstraction](#4-pluggable-backend-abstraction)
5. [Session Management](#5-session-management)
6. [Tech Stack Analysis](#6-tech-stack-analysis)
7. [Configuration System](#7-configuration-system)
8. [Deployment](#8-deployment)
9. [Observability](#9-observability)
10. [Recommended Architecture](#10-recommended-architecture)

---

## 1. Existing Frameworks Analysis

### 1.1 Pipecat

**Architecture: Frame-Based Streaming Pipeline**

Pipecat is an open-source Python framework built around a central abstraction: the _frame_. Every datum flowing through the system — a chunk of audio, a token of text, a control signal, a VAD event — is wrapped in an immutable frame object and pushed through an ordered list of `FrameProcessor` instances connected into a `Pipeline`. The `Pipeline` is driven by Python `asyncio` and runs each processor concurrently, so processors do not block each other.

**How it works**

Frames are divided into two priority classes:

- **`SystemFrame`** — processed immediately, bypassing the normal queue. Examples: `StartFrame`, `EndFrame`, `CancelFrame`, `InterruptionFrame`. These are control signals that need to propagate instantly (e.g., aborting an in-flight TTS stream when the user speaks).
- **`DataFrame`** — processed in order. Examples: `AudioRawFrame` (raw PCM bytes + sample rate + channel count), `TextFrame` (LLM output tokens), `TranscriptionFrame` (finalized STT output), `UserStartedSpeakingFrame`, `UserStoppedSpeakingFrame`.

Frames flow **downstream** (source to sink, the happy path) and **upstream** (sink to source, for feedback such as barge-in events). A typical minimal pipeline looks like:

```
Transport In -> VAD -> STT -> LLM -> TTS -> Transport Out
```

Each stage receives frames, does its work, and emits new frames for the next stage. The modularity means any stage can be replaced by swapping one `FrameProcessor` for another without touching the rest of the graph.

**Strengths**

- Extremely flexible: supports arbitrary topologies, custom processors, and multi-modal pipelines (audio + video + text).
- Excellent provider coverage: Deepgram, AssemblyAI, ElevenLabs, Cartesia, OpenAI, Anthropic, Azure, and many others have first-class plugin packages.
- Fine-grained control over frame flow makes unusual requirements (e.g., logging every audio chunk, injecting synthetic events for testing) straightforward.
- Strong community growth in 2025; used by AWS Bedrock teams and demonstrated in production at scale.

**Weaknesses**

- **Verbose configuration**: a production pipeline requires wiring together 8-15 objects before any audio flows. There is no "convention-over-configuration" shortcut.
- **Turn-taking requires manual tuning**: Pipecat ships with Silero VAD as its primary end-of-turn signal. There is no built-in semantic turn classifier. A bug discovered in 2025 showed that `LocalSmartTurnAnalyzerV3` silently produced incorrect predictions when the pipeline ran at 8 kHz (telephony rate) because Whisper's feature extractor hardcoded 16 kHz internally -- a subtle misconfiguration that is hard to diagnose.
- **Transport is not bundled**: Pipecat provides a `Daily` transport adapter and a raw WebSocket adapter, but production WebRTC infrastructure must be supplied externally. LiveKit and similar platforms are not officially supported out of the box.
- **Deployment story is immature**: As one practitioner noted, Pipecat is "the hardest way to deploy voice AI" because there is no official managed hosting, and self-hosted blueprints were still marked experimental as of early 2026.

**Tech Stack**

- Language: Python 3.10+
- Concurrency: `asyncio` throughout; processors are coroutines.
- Audio processing: numpy arrays, with codec adaptation happening at transport boundaries.
- Deployment: typically a single asyncio process per session, managed by an external supervisor (e.g., Docker + a fleet manager, or Pipecat Cloud in beta).

**Deployment Patterns**

- **One process per call**: each inbound session spawns an isolated asyncio event loop running the full pipeline. Crash isolation is good; memory per session is moderate (~80-200 MB depending on loaded models).
- **Pipecat Cloud** (beta as of 2026): managed fleet, auto-scaling, billing per minute. Abstracts the transport and worker fleet complexity.
- **Self-hosted with Daily**: use Daily.co's room-based WebRTC as the transport, run Python workers on EC2/GCE/Fly.io, implement your own session dispatch.

---

### 1.2 LiveKit Agents

**Architecture: WebRTC SFU + Agent Pipeline**

LiveKit Agents couples a production-grade WebRTC Selective Forwarding Unit with a Python (and Node.js) SDK that exposes an opinionated `VoicePipelineAgent` abstraction. The SFU -- written in Go -- handles all media routing, DTLS/SRTP, adaptive bitrate, and ICE negotiation. The agent SDK connects to a LiveKit room as a participant and processes audio arriving over the room's tracks.

**Sequential Pipeline: STT -> LLM -> TTS**

The canonical pipeline is:

```
Microphone -> WebRTC -> LiveKit SFU -> AudioTrack -> VAD -> STT -> ChatContext -> LLM -> TTS -> AudioTrack -> WebRTC -> Speaker
```

All stages are streaming: STT emits partial transcripts continuously, LLM tokens stream into TTS as they are generated, and TTS begins emitting audio before the LLM response is complete. LiveKit's internal benchmarks target sub-1-second total perceived latency across this chain when inference is co-located with the media server.

**Strengths**

- **Clean API**: `VoicePipelineAgent` wraps turn detection, interruption handling, and context management behind a high-level interface. Minimal boilerplate.
- **Built-in turn detection**: LiveKit ships an open-source, open-weights semantic turn detection model as a plugin (`livekit-plugins-turn-detector`). Unlike VAD-only solutions, the model reads the partial transcript and classifies semantic completeness -- handling cases like "can you hold on a sec, I'm just..." without false-triggering. The model is multilingual (14 languages), requires ~400 MB RAM, and infers in ~25 ms.
- **Production-grade WebRTC**: global TURN infrastructure, adaptive bitrate, echo cancellation in the browser/mobile SDKs, and a Go-based SFU that can handle thousands of concurrent rooms on a single server.
- **Stateful worker pool**: the framework dispatches sessions to worker processes with awareness of CPU and memory load, and sessions remain pinned to their worker for the lifetime of the call (ensuring streaming state is not disrupted).

**Weaknesses**

- **Tied to LiveKit infrastructure**: the agent SDK depends on LiveKit rooms and the LiveKit server. You cannot use a raw WebSocket or SIP trunk without a third-party bridge. This is a real constraint for telephony integrations where you need to speak to a carrier directly via SIP/RTP.
- **Python only for agents** (as of early 2026): the Go SFU is high-performance, but all agent logic runs in Python, which means the CPU-bound parts of VAD and audio preprocessing compete with the asyncio event loop.
- **Less composable than Pipecat**: `VoicePipelineAgent` trades flexibility for convenience. Unusual pipeline topologies (e.g., injecting a translation layer between STT and LLM) require subclassing internal classes or monkey-patching.

**Open-Source Turn Detection Model**

LiveKit's turn detection model was announced in December 2024 and published on PyPI as `livekit-plugins-turn-detector`. It uses a small transformer (classification head on top of a multilingual language model) trained specifically to distinguish "speaker is mid-thought with a natural pause" from "speaker has finished their turn." The model was the first open-weights model purpose-built for this task and has since influenced Pipecat and TEN Framework to develop similar solutions.

**Tech Stack**

- SFU server: Go (open-source, Apache 2.0)
- Agent SDK: Python (primary), Node.js (secondary)
- Turn detection: ONNX model, runs on CPU, ~25 ms inference
- Transport: WebRTC (DTLS/SRTP over UDP)
- Deployment: Docker-compose for dev; Kubernetes with LiveKit Helm chart for production

---

### 1.3 Vocode

**Architecture and Current Status**

Vocode Core is a Python framework organized around three abstract interfaces -- `Transcriber`, `Agent`, and `Synthesizer` -- coordinated by a `ConversationOrchestrator`. The architecture predates most current frameworks (first released 2023) and was influential in establishing the modular, swappable-component pattern that Pipecat and others later adopted.

Vocode Core targets two deployment modes: (1) real-time streaming conversations via WebSocket or WebRTC, and (2) phone call automation via SIP integration. The company also operates Vocode API, an enterprise cloud product built on top of the open-source core.

**Strengths**

- Earliest open-source framework in this space with significant community adoption.
- Strong telephony story: native SIP integration and phone number management.
- The `Transcriber`/`Agent`/`Synthesizer` interface hierarchy is clean and influenced later designs.
- Supports Zoom meeting bots, phone calls, and WebSocket clients from a single codebase.

**Weaknesses**

- Development velocity has slowed significantly compared to Pipecat and LiveKit Agents. Major GitHub activity declined in late 2024.
- Turn detection is primitive -- primarily VAD-based with fixed silence thresholds.
- No semantic interruption model; barge-in is coarse.
- Less actively maintained; some provider integrations are stale.
- The orchestrator is a monolith rather than a composable pipeline; inserting custom logic requires subclassing internal classes.

**Recommended role**: reference implementation and inspiration for interface design; not recommended as primary runtime for new systems as of 2026.

---

### 1.4 Other Projects

**local-talking-llm**

A minimal proof-of-concept Python project demonstrating a fully local voice pipeline: Whisper (STT) -> Ollama (LLM) -> ChatterBox/Coqui (TTS), all running offline. Architecture is strictly sequential (no streaming overlap). Notable for its pedagogical clarity and for demonstrating that the full stack can run on commodity hardware without cloud APIs. Not production-grade: no VAD, no barge-in, no session management.

**KokoDOS**

A self-hosted voice assistant derived from the GlaDOS project, using Kokoro-FastAPI for TTS synthesis. Key architectural choices: minimizes Python dependencies (no PyTorch at runtime, uses pre-compiled ONNX), integrates vision capabilities via screen-sharing, and targets low-overhead hardware deployment. Requires 12 GB VRAM for real-time operation. Like local-talking-llm, it is a personal assistant project rather than a gateway framework.

**TEN Framework (Transformative Extensions Network)**

TEN is an open-source framework from Agora targeting production real-time multimodal voice AI. Unlike Pipecat's linear pipeline, TEN uses a **directed graph** model where each extension is a node, and edges define the data flow. Extensions can be written in C++, Go, Python, or JavaScript/TypeScript, enabling tight polyglot integration.

Key differentiators:
- **TEN VAD**: open-source voice activity detector, published as ONNX, deployable on any hardware.
- **TEN Turn Detection (TTD)**: claims 98% accuracy on conversational turn-taking as of late 2025. Open-sourced ONNX model.
- Sub-500ms end-to-end latency in production benchmarks.
- Supports Windows, Mac, Linux, and mobile (iOS/Android) through its extension model.
- Provides 10+ open-source agent templates covering phone bots, transcription services, and SIP integration.

TEN is architecturally more ambitious than Pipecat but has a steeper learning curve due to its graph model and multi-language extension system.

**Commercial Platforms: Architecture Insights**

_Retell AI_: Positions as a modular voice platform. Architecture separates voice engine (STT/LLM/TTS pipeline) from telephony and business logic. Transparent component pricing ($0.07-0.08/min voice engine + $0.05-0.08/min LLM + $0.015/min telephony). Recent additions: Cartesia Sonic-3 for emotion control, Role-Based Access Control for enterprise multi-tenancy, knowledge base integration within conversation flows.

_Vapi_: "Voice AI for Developers" with an API-first design. Achieves sub-600ms latency. Manages 4-6 vendor relationships transparently (ASR provider, LLM provider, TTS provider, telephony, Vapi orchestration). Pricing is $0.15-0.36/min all-in depending on component selection. Webhook-driven control flow for complex call logic.

_Bland AI_: Enterprise-grade, developer-configurable via HTTP APIs and webhooks. Strong audit logging. Designed for outbound campaign automation at scale. Voice cloning and custom neural voices supported. Latency competitive with Vapi (~600 ms).

The common thread across commercial platforms: the _voice engine_ (real-time audio pipeline) is separated from the _orchestration layer_ (business logic, CRM integration, billing). This separation is the primary architectural lesson for custom gateway design.

---

## 2. Pipeline Architecture

### 2.1 Streaming Overlap: STT -> LLM -> TTS

The naive implementation waits for each stage to fully complete before starting the next. End-to-end latency is therefore the _sum_ of all stage latencies: a typical sequential pipeline adds up to 2-4 seconds.

A streaming pipeline converts serial waits into parallel work, making end-to-end latency closer to the _maximum_ of overlapping windows rather than their sum:

```
Timeline (ms from user silence):
  0    100   200   300   400   500   600   700   800
  |                                                  |
  [===STT partial emission=====]
              [====LLM TTFT====]
                          [====TTS first chunk===]
                                      [==Audio plays=]
```

**Stage-by-stage streaming behavior**

1. **STT partial results**: Modern ASR engines (Deepgram Nova-3, AssemblyAI Streaming, Azure Cognitive Services) emit partial transcripts every 20-100 ms while the user is still speaking. These partials are lower accuracy than finals but give the downstream pipeline a head start. A practical heuristic is to wait for a partial with a stability/confidence score >= 0.8 and at least 3-5 words before forwarding to the LLM. This saves 200-400 ms on typical utterances.

2. **LLM streaming tokens**: Once the STT produces a sufficiently confident partial (or a final on turn-end), the LLM prompt is sent and tokens are streamed back as they are generated. The key metric is **Time to First Token (TTFT)** -- Groq achieves ~350 ms TTFT consistently; OpenAI GPT-4o is ~400-600 ms depending on region and load.

3. **TTS streaming**: TTS should begin synthesis as soon as the LLM emits the first _sentence boundary_ -- not after the full response is complete. Detecting sentence boundaries in a token stream requires a simple heuristic: flush to TTS on `.`, `!`, `?`, or after N tokens without punctuation. Starting TTS at the first sentence while the LLM generates the rest reduces perceived latency by roughly 30% in production measurements.

4. **Audio playback chunking**: TTS engines (ElevenLabs, Cartesia, Azure Neural TTS) support streaming synthesis and return audio in small chunks (typically 20-40 ms of PCM at 24 kHz). These chunks should be pushed to the audio buffer immediately rather than buffering the full synthesis.

**Real-world latency targets**

| Stage | Target (P50) | Notes |
|---|---|---|
| Audio transport (WebRTC) | < 50 ms | Global low-latency media network |
| STT first partial | 100-200 ms | Streaming required |
| LLM time-to-first-token | 200-400 ms | Model size and infrastructure dependent |
| TTS time-to-first-audio | 100-300 ms | Streaming synthesis required |
| **Total perceived** | **< 700 ms** | Natural conversation threshold |

**Pipeline orchestration patterns**

- **Async channel/queue**: each stage reads from an input channel and writes to an output channel. Back-pressure is handled by bounded channel sizes. This is the Pipecat frame model.
- **Generator chaining**: Python async generators can be chained with the streaming happening automatically via `yield`.
- **Actor model**: TEN Framework uses graph nodes as actors communicating via message-passing. Useful when stages run in different language runtimes.
- **Thread pool + shared queue**: useful when a stage (e.g., local VAD running in C++) needs to run off the asyncio event loop.

---

### 2.2 Barge-In / Interruption

Barge-in is the ability for the user to interrupt the agent while it is speaking. Users _expect_ this to work; failure to support it is one of the top complaints about production voice agents.

**Detecting user speech during TTS playback**

VAD must run continuously on the microphone input track, _even while TTS audio is playing_. This requires:

1. **Echo cancellation on the client**: the client SDK (browser WebRTC, mobile SDK) must subtract the locally played TTS audio from the microphone input before transmitting. Without AEC, the microphone picks up the speaker and the VAD falsely triggers on the agent's own voice.
2. **Always-on VAD**: the server-side VAD continues processing audio frames during TTS playback. When voice energy exceeds threshold for >= 3 consecutive 20 ms frames, an `InterruptionDetected` event is raised.
3. **Confidence gating**: filler sounds ("mm", "uh-huh") should not always interrupt. A brief hold-off of 100-200 ms after VAD trigger, combined with a confidence check on the partial STT, prevents over-triggering.

**Cancelling in-flight TTS audio**

When interruption is detected:

1. Stop pushing audio chunks to the output buffer immediately.
2. Send a `cancel` command to the TTS provider's streaming API to terminate the connection and stop billing for unrendered audio.
3. Flush the local audio output queue (the jitter buffer / playback queue on the transport layer).
4. Emit a `CancelFrame` (or equivalent) downstream so the pipeline knows the current turn is aborted.

The key implementation detail is that TTS audio chunks may be in-flight in multiple buffers: the TTS provider's streaming buffer, the gateway's internal audio queue, and the client's jitter buffer. All three must be flushed. The LiveKit Agents framework handles this via an `InterruptionFrame` that propagates upstream through the pipeline, cancelling in-flight tasks at each stage.

**Cancelling in-flight LLM generation**

Cancelling the LLM request depends on the provider:

- **OpenAI/Anthropic streaming**: cancel the HTTP/2 request body; the server stops generating tokens. In Python, close the `aiohttp` response object.
- **Local inference (vLLM, Ollama)**: send an abort to the inference server's request ID.
- The partially generated response text should be truncated to what was _actually synthesized_ (using TTS word-level timestamps if available) before being stored in conversation history. Storing a response the user never heard corrupts the context window.

**Event propagation through the pipeline**

An interruption event must propagate in both directions:

- **Downstream cancellation**: `CancelFrame` sent forward cancels the TTS stage and flushes the output buffer.
- **Upstream notification**: the pipeline signals the LLM stage to abort the current generation.
- **Context update**: the conversation history manager receives the truncated assistant turn so subsequent LLM prompts reflect what was actually said.

**Implementation approach (pseudocode)**

```python
async def on_user_speech_detected(pipeline_ctx):
    # 1. Cancel the current TTS stream
    await pipeline_ctx.tts.cancel()
    # 2. Drain the audio output queue
    pipeline_ctx.audio_output.drain()
    # 3. Cancel the LLM generation task
    if pipeline_ctx.llm_task and not pipeline_ctx.llm_task.done():
        pipeline_ctx.llm_task.cancel()
    # 4. Truncate the in-progress assistant message
    pipeline_ctx.conversation.truncate_assistant_turn(
        up_to_timestamp=pipeline_ctx.tts.last_rendered_timestamp
    )
    # 5. Re-enter listening state
    await pipeline_ctx.enter_listening_state()
```

A real system also needs to handle mid-tool-call interruptions (where the LLM has triggered a function call) -- in those cases interruption should typically be disallowed until the tool call completes, to avoid leaving external side effects in an inconsistent state.

---

### 2.3 Error Handling

**TTS fails mid-stream**

A mid-stream TTS failure (HTTP 500 from the provider, connection reset, timeout) leaves the user hearing silence after a partial response. Handling strategies:

1. **Retry with back-off**: re-submit the remaining text (from the last successfully synthesized sentence boundary) to the TTS API. Retry up to 2 times with 100 ms and 300 ms delays. This covers transient provider failures.
2. **Fallback TTS provider**: maintain a secondary TTS provider configuration. On provider failure (after one retry), switch to the fallback and continue from the last sentence boundary. ElevenLabs -> Cartesia is a common primary/fallback pairing.
3. **Silence insertion**: if both providers fail, insert 500 ms of silence followed by a synthesized apology using a pre-cached audio clip. This prevents the user from experiencing a dead line.
4. **Never retry partial audio blindly**: if audio has already been sent to the client, retrying from the beginning will produce duplicate speech. Sentence-boundary tracking is essential for correct retry logic.

**LLM timeout**

LLM inference is the highest-latency stage and the most likely to timeout under load. Strategy:

1. **Aggressive timeout**: 8-12 seconds for a full LLM turn. If TTFT exceeds 5 seconds, the user has likely already lost the thread of conversation.
2. **Circuit breaker**: track failure rate over a 60-second window. If >20% of requests fail or timeout, open the circuit and route to a fallback model (e.g., a smaller, faster model, or a scripted response).
3. **Scripted graceful fallback**: if the LLM is unavailable, respond with a canned message: "I'm having trouble thinking right now -- can you try again in a moment?" Pre-synthesize this audio as a WAV file for zero-latency delivery.
4. **Exponential back-off on retry**: 1 s -> 2 s -> 4 s. Do not retry more than twice within a single turn; the user cannot wait 7+ seconds for a response.

**STT returns garbage**

Low-confidence or garbled STT output (e.g., heavy background noise, codec mismatch, speaker with heavy accent on an untrained model) can cause the LLM to produce nonsensical responses:

1. **Confidence-based filtering**: most streaming STT providers return a confidence score (0-1.0) with final transcripts. Below a threshold (0.6-0.7 depending on use case), discard the transcript and prompt the user: "I didn't quite catch that -- could you repeat?"
2. **Word Error Rate monitoring**: track WER via human review or automatic comparison against a reference set. If WER climbs above 5-8%, flag for investigation (potential codec misconfiguration or model degradation).
3. **Fallback to a different model**: some providers offer multiple model tiers (e.g., Deepgram Nova-3 vs. Nova-2). On repeated low-confidence results, switch models.
4. **Noise floor calibration**: on session start, measure the ambient noise energy for 500 ms and set a dynamic VAD threshold to 15-20 dB above the noise floor.

**Connection drops: resumption strategy**

WebSocket and WebRTC connections drop due to network instability. A well-designed gateway handles this transparently:

1. **Session ID on connect**: the client sends a `session_id` on reconnection. The gateway looks up the session in Redis and restores conversation history and pipeline state.
2. **Idempotent reconnection**: the pipeline should be in a clean "listening" state on reconnect -- not mid-TTS or mid-LLM. Any in-flight turns are discarded and the last complete turn is re-synthesized if the client requests it.
3. **Grace period**: hold session state in Redis for 60 seconds after disconnect. After 60 seconds without reconnection, close the session and write final state to durable storage (PostgreSQL).
4. **Partial audio delivery**: if the connection dropped mid-TTS, the client may not know how much audio was received. The client should report its playback position on reconnect so the gateway can either continue from the right offset or restart the turn.

---

## 3. API Design

### 3.1 REST Endpoints

REST is used for _control plane_ operations: session lifecycle, configuration, and query. Audio does not flow over REST.

```
POST   /v1/sessions
       Body: { config_id, overrides, metadata }
       Returns: { session_id, ws_url, token, expires_at }

GET    /v1/sessions/{session_id}
       Returns: { session_id, state, created_at, turn_count, config }

DELETE /v1/sessions/{session_id}
       Terminates the session, flushes state to durable storage

GET    /v1/sessions/{session_id}/transcript
       Returns: full conversation history as JSON array of turns

POST   /v1/sessions/{session_id}/inject
       Body: { role: "assistant" | "system", text }
       Inject a synthetic message into the conversation

GET    /v1/configs
       List available named configurations

POST   /v1/configs
       Create or update a named configuration

GET    /v1/configs/{config_id}
PUT    /v1/configs/{config_id}
DELETE /v1/configs/{config_id}

GET    /v1/health
       Returns: { status: "ok", version, uptime_seconds }
GET    /v1/metrics          (Prometheus text format)
```

### 3.2 WebSocket Protocol

The WebSocket connection carries bidirectional binary/JSON frames. The session is initialized via REST (`POST /v1/sessions`), which returns a short-lived token and `ws_url`. The client connects to the WebSocket URL with the token in the query string or `Authorization` header.

**Message format**: each message is a JSON envelope with a `type` field. Audio data is sent as binary frames (raw PCM) or as base64 in JSON depending on client capability.

**Client -> Gateway messages**

```json
// Audio chunk (binary frame, 20ms of PCM at 16kHz mono 16-bit LE)
// No JSON envelope; frame type is inferred from WebSocket opcode (binary vs text)

// Or, JSON audio chunk for clients that cannot send binary:
{ "type": "audio_chunk", "data": "<base64 PCM>", "sample_rate": 16000, "channels": 1 }

// Client signals end of audio stream (call ended)
{ "type": "audio_end" }

// Client reports playback position (for resumption after reconnect)
{ "type": "playback_position", "turn_id": "t_xyz", "offset_ms": 1240 }

// Client requests a text injection (user has typed something)
{ "type": "text_input", "text": "..." }
```

**Gateway -> Client messages**

```json
// Session ready
{ "type": "session_ready", "session_id": "s_abc", "config": { ... } }

// Partial STT result
{ "type": "transcript_partial", "text": "...", "confidence": 0.84 }

// Final STT result
{ "type": "transcript_final", "text": "...", "turn_id": "t_xyz" }

// LLM response token (streaming)
{ "type": "llm_token", "token": "Hello", "turn_id": "t_xyz" }

// TTS audio chunk (binary frame, PCM or Opus depending on negotiation)
// Or JSON envelope:
{ "type": "audio_chunk", "data": "<base64>", "turn_id": "t_xyz", "offset_ms": 0 }

// TTS playback complete for this turn
{ "type": "turn_complete", "turn_id": "t_xyz", "duration_ms": 3200 }

// Barge-in detected -- client should stop playback
{ "type": "interruption", "turn_id": "t_xyz", "at_offset_ms": 1800 }

// Error
{ "type": "error", "code": "tts_provider_error", "message": "...", "retryable": true }
```

### 3.3 API Shape for a Pluggable Gateway

The gateway exposes a uniform API regardless of which STT, LLM, or TTS backends are configured. Backend selection happens at session creation time via the `config_id` and per-session `overrides`. Clients never reference backends directly.

```json
POST /v1/sessions
{
  "config_id": "customer-support-en",
  "overrides": {
    "llm": { "model": "gpt-4o", "temperature": 0.7 },
    "tts": { "voice_id": "rachel", "speed": 1.0 },
    "turn_detection": { "mode": "semantic", "silence_ms": 600 }
  },
  "metadata": { "caller_id": "+1-555-0100", "campaign": "support" }
}
```

The `config_id` resolves to a full backend configuration stored server-side. `overrides` allows per-session customization without creating new configs.

---

## 4. Pluggable Backend Abstraction

### 4.1 Interface Design

Each backend category is defined by a minimal interface. Implementations are registered by name in a provider registry and instantiated per-session.

**STT Backend Interface**

```python
class STTBackend(Protocol):
    async def stream(
        self,
        audio: AsyncIterator[bytes],   # 16kHz 16-bit mono PCM chunks
        language: str = "en",
    ) -> AsyncIterator[STTEvent]:
        """Yields PartialTranscriptEvent and FinalTranscriptEvent."""
        ...

@dataclass
class PartialTranscriptEvent:
    text: str
    confidence: float
    is_final: bool = False

@dataclass
class FinalTranscriptEvent:
    text: str
    confidence: float
    words: list[WordTimestamp]  # optional, for interruption truncation
    is_final: bool = True
```

**LLM Backend Interface**

```python
class LLMBackend(Protocol):
    async def complete(
        self,
        messages: list[ChatMessage],
        tools: list[ToolDefinition] | None = None,
        max_tokens: int = 512,
        temperature: float = 0.8,
    ) -> AsyncIterator[LLMEvent]:
        """Yields TokenEvent, ToolCallEvent, and DoneEvent."""
        ...
```

**TTS Backend Interface**

```python
class TTSBackend(Protocol):
    async def synthesize(
        self,
        text_stream: AsyncIterator[str],  # token-level stream
        voice_id: str,
        output_format: AudioFormat = AudioFormat.PCM_16K_16BIT_MONO,
    ) -> AsyncIterator[bytes]:
        """Yields raw audio bytes as they are synthesized."""
        ...

    async def cancel(self) -> None:
        """Abort in-flight synthesis immediately."""
        ...
```

**VAD Backend Interface**

```python
class VADBackend(Protocol):
    def process_frame(self, audio: bytes, sample_rate: int) -> VADResult:
        """Synchronous; called on every 20ms audio frame."""
        ...

@dataclass
class VADResult:
    is_speech: bool
    confidence: float
    start_of_speech: bool   # rising edge
    end_of_speech: bool     # falling edge (after silence threshold)
```

### 4.2 Provider-Agnostic Configuration

Backends are selected by string key, and their constructor parameters are passed as a typed config object:

```yaml
# config: customer-support-en
stt:
  provider: deepgram
  model: nova-3
  language: en-US
  punctuate: true
  interim_results: true

llm:
  provider: openai
  model: gpt-4o
  system_prompt: "You are a helpful customer support agent for Acme Corp..."
  max_tokens: 256
  temperature: 0.7

tts:
  provider: elevenlabs
  voice_id: rachel
  model_id: eleven_turbo_v2_5
  output_format: pcm_16000

vad:
  provider: silero
  threshold: 0.5
  min_speech_duration_ms: 250
  min_silence_duration_ms: 600

turn_detection:
  mode: semantic          # "vad_only" | "semantic" | "hybrid"
  semantic_model: livekit_turn_detector_v1
  silence_fallback_ms: 1200
```

Providers are registered in a central registry:

```python
REGISTRY = {
    "stt": {
        "deepgram": DeepgramSTT,
        "assemblyai": AssemblyAISTT,
        "azure": AzureSTT,
        "whisper_local": WhisperLocalSTT,
    },
    "llm": {
        "openai": OpenAILLM,
        "anthropic": AnthropicLLM,
        "groq": GroqLLM,
        "ollama": OllamaLLM,
    },
    "tts": {
        "elevenlabs": ElevenLabsTTS,
        "cartesia": CartesiaTTS,
        "azure": AzureNeuralTTS,
        "kokoro_local": KokoroLocalTTS,
    },
    "vad": {
        "silero": SileroVAD,
        "ten_vad": TenVAD,
        "webrtcvad": WebRTCVad,
    },
}
```

### 4.3 Hot-Swapping Backends

Hot-swapping a backend mid-session requires that:

1. The new backend is instantiated and initialized before the swap.
2. The swap happens at a _turn boundary_ -- not mid-synthesis or mid-generation -- to avoid audio glitches.
3. The pipeline is paused briefly (<= 100 ms) while the swap occurs.
4. Session state (conversation history, audio format) is passed to the new backend instance.

The mechanism is a `swap_backend(stage, new_config)` call on the pipeline controller, which schedules the swap for the next turn boundary. This is useful for A/B testing TTS voices, switching LLM models based on conversation complexity, or failing over from a degraded provider.

---

## 5. Session Management

### 5.1 Conversation History Storage

Conversation history is stored as an ordered list of turns, each with:

```json
{
  "turn_id": "t_xyz",
  "role": "user | assistant | system | tool",
  "content": "...",
  "timestamp_utc": "2026-04-03T10:23:41.123Z",
  "metadata": {
    "stt_confidence": 0.91,
    "tts_duration_ms": 3200,
    "tts_rendered_up_to_ms": 1800,
    "llm_model": "gpt-4o",
    "llm_ttft_ms": 380,
    "tool_calls": []
  }
}
```

**Storage tiers**:

- **Hot (in-memory)**: the last N turns (default: 20) are held in process memory as the active `ChatContext` passed to the LLM. This is the zero-latency path.
- **Warm (Redis)**: the full session history for the current call is written to Redis with a TTL of 60 seconds beyond the last activity. Key: `session:{session_id}:history`. This enables reconnection without data loss.
- **Cold (PostgreSQL)**: on session close, the full history is written to a relational database for analytics, compliance, and long-term retrieval.

### 5.2 Multi-Turn Context Management

The LLM prompt includes the system prompt, conversation history, and any tool results. As conversations grow, token cost and latency increase:

- **Sliding window**: keep only the most recent K turns in the active context. K is tuned per use case (call center: 10-15 turns; personal assistant: 30+).
- **Summarization**: when the history exceeds the window, summarize older turns into a compact paragraph and prepend it as a system message. Redis stores the summary keyed by session ID.
- **Hierarchical storage**: distinguish between _episodic memory_ (specific turns) and _semantic memory_ (summarized facts about the user or conversation). The Redis Agent Memory Server (open-source, from Redis Labs) provides this abstraction with vector search for relevant context retrieval. Properly implemented hierarchical storage reduces token consumption by 60-80% while maintaining or improving agent performance.
- **Token budget enforcement**: set a hard `max_context_tokens` limit in the LLM backend. If the assembled prompt exceeds the limit, evict oldest turns until it fits.

### 5.3 Session Lifecycle

```
CREATED -> CONNECTING -> ACTIVE -> INTERRUPTED -> ACTIVE
                                               |
                                  CLOSING -> CLOSED
```

- **CREATED**: REST call returns session credentials; no WebSocket yet.
- **CONNECTING**: WebSocket handshake in progress; pipeline not yet started.
- **ACTIVE**: audio is flowing; pipeline running normally.
- **INTERRUPTED**: connection dropped; grace period (60 s) is active; state preserved in Redis.
- **CLOSING**: `audio_end` message received or maximum session duration exceeded; pipeline draining.
- **CLOSED**: pipeline stopped; history written to cold storage; Redis key TTL set to 24 h for audit.

Session metadata stored per session: session ID, config ID, caller metadata, start/end timestamps, total turn count, total audio duration (seconds), accumulated token usage, error events.

---

## 6. Tech Stack Analysis

| Stack | Streaming Perf | Ecosystem | Dev Speed | Deployment | Verdict |
|---|---|---|---|---|---|
| **Go** | Excellent -- non-blocking I/O, goroutines, minimal GC pause | Good -- gRPC, Prometheus native, mature HTTP libs | Moderate -- verbose but explicit | Excellent -- static binaries, small containers | Strong choice for gateway core; limited AI/ML library support |
| **Rust** | Best -- zero-cost abstractions, no GC, deterministic latency | Moderate -- Tokio async runtime, growing audio libs | Slow -- ownership system has steep learning curve | Excellent -- tiny binaries, lowest memory | Best for latency-critical hot paths; overkill for prototyping |
| **Python asyncio** | Adequate -- GIL limits CPU concurrency; excellent for I/O-bound stages | Excellent -- every AI provider has a Python SDK; ML models native | Fast -- rapid iteration, excellent docs | Moderate -- larger containers, GIL-related scaling limits | Best for AI pipeline logic; pair with Go or Rust for transport |
| **Node.js** | Good -- event loop well-suited to streaming; no GIL | Large -- npm ecosystem; WebSocket libraries mature | Fast -- familiar for web developers | Good -- small containers, horizontal scaling easy | Good choice if team is JS-native; ecosystem less complete for audio |

**Performance context**: Rust consistently runs 2x faster than Go and ~60x faster than Python for CPU-bound tasks. For real-time audio with deterministic latency, Rust's ownership model provides predictable resource cleanup that Go's GC does not. However, for the I/O-bound work that dominates a voice gateway (waiting on STT/LLM/TTS API responses), Go and Python asyncio perform comparably.

**Recommendation**: a hybrid architecture wins. Use **Go** for the WebSocket/WebRTC transport layer and session management (high-concurrency I/O, deterministic latency), and **Python asyncio** for the AI pipeline stages (STT, LLM, TTS adapter logic, and turn detection models). Communicate between Go and Python via a local gRPC socket or Unix domain socket. This pattern is validated by LiveKit (Go SFU + Python agent SDK).

Rust is justified only for custom VAD or audio codec processing where microsecond latency matters. It is not justified for the full gateway unless the team has strong Rust expertise.

---

## 7. Configuration System

### 7.1 Core Configuration Schema

Named configurations (stored as YAML or JSON in a database or config file) define the full pipeline:

```yaml
id: customer-support-en-v2
description: "English customer support, ElevenLabs Rachel voice, GPT-4o"

audio:
  input_format: pcm_16k_16bit_mono      # from client
  output_format: pcm_24k_16bit_mono     # to client (negotiated down if needed)
  chunk_size_ms: 20                     # 20ms = 320 bytes at 16kHz
  jitter_buffer_ms: 40                  # absorbs network jitter

vad:
  provider: silero
  threshold: 0.5
  min_speech_ms: 250
  min_silence_ms: 600

stt:
  provider: deepgram
  model: nova-3
  language: en-US
  smart_format: true
  interim_results: true
  confidence_threshold: 0.65

turn_detection:
  mode: semantic
  model: livekit_turn_detector_v1
  silence_fallback_ms: 1200
  hold_off_after_vad_ms: 150           # debounce filler words

llm:
  provider: openai
  model: gpt-4o
  system_prompt_ref: "prompts/customer-support-en.txt"
  max_tokens: 256
  temperature: 0.7
  timeout_ms: 10000
  fallback_model: gpt-4o-mini          # on timeout or error

tts:
  provider: elevenlabs
  voice_id: "21m00Tcm4TlvDq8ikWAM"    # Rachel
  model_id: eleven_turbo_v2_5
  output_format: pcm_16000
  sentence_flush: true                 # start TTS at first sentence boundary
  fallback_provider: cartesia
  fallback_voice_id: "sonic-english"

barge_in:
  enabled: true
  min_speech_frames: 3                 # 3 x 20ms = 60ms of speech required
  echo_cancellation: client_side       # "client_side" | "server_side" | "disabled"

context:
  max_turns: 20
  summarize_after_turns: 15
  max_context_tokens: 4096
```

### 7.2 Per-Session Overrides

Session creation accepts an `overrides` block that deep-merges with the base config:

```json
{
  "config_id": "customer-support-en-v2",
  "overrides": {
    "llm.model": "gpt-4o",
    "llm.temperature": 0.5,
    "tts.voice_id": "custom-voice-abc123",
    "context.max_turns": 30
  }
}
```

Overrides are validated against the config schema. Unknown keys are rejected. Overrides are stored with the session record for audit purposes.

### 7.3 Audio Format Negotiation

Clients and gateways must agree on audio formats at session start. The negotiation flow:

1. Client sends capabilities in the `session_ready` acknowledgement: `{ "supported_formats": ["pcm_16k", "pcm_8k", "opus_16k", "mulaw_8k"] }`.
2. Gateway selects the highest-quality format it can handle and the client supports. Preference order: PCM 16kHz > Opus 16kHz > PCM 8kHz > mu-law 8kHz.
3. Negotiated format is confirmed in the `session_config` message: `{ "audio_input_format": "pcm_16000", "audio_output_format": "pcm_24000" }`.

Format considerations:
- **PCM 16kHz 16-bit mono**: universal baseline; zero codec latency; high bandwidth (~256 kbps).
- **Opus 16kHz**: preferred for browser/mobile clients; ~32 kbps; adds ~5 ms encoding latency.
- **mu-law (G.711) 8kHz**: required for PSTN/telephony (Twilio, Vonage, Telnyx); degrades STT accuracy on noise-heavy calls; Deepgram Nova-3 handles it natively.
- **PCM 24kHz**: preferred for TTS output (ElevenLabs, Azure TTS native rate); downsampled to 16kHz or 8kHz if needed for client.

Production note: a 2025 post-mortem on a production system documented silent failures caused by audio format mismatches (PCM/MP3/Opus, 16kHz/24kHz) when swapping TTS providers. Format negotiation must be explicit and validated end-to-end, not assumed.

---

## 8. Deployment

### 8.1 Docker Compose for Development

A development deployment runs all components locally:

```yaml
# docker-compose.yml (development)
services:
  gateway:
    build: ./gateway
    ports: ["8080:8080"]
    environment:
      - OPENAI_API_KEY
      - DEEPGRAM_API_KEY
      - ELEVENLABS_API_KEY
      - REDIS_URL=redis://redis:6379
      - DATABASE_URL=postgresql://postgres:5432/gateway
    depends_on: [redis, postgres]

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  postgres:
    image: postgres:16-alpine
    ports: ["5432:5432"]
    environment:
      POSTGRES_DB: gateway
      POSTGRES_PASSWORD: dev

  otel-collector:
    image: otel/opentelemetry-collector-contrib:latest
    volumes: ["./otel-config.yaml:/etc/otel/config.yaml"]
    ports: ["4317:4317"]   # gRPC receiver

  prometheus:
    image: prom/prometheus:latest
    volumes: ["./prometheus.yml:/etc/prometheus/prometheus.yml"]
    ports: ["9090:9090"]

  grafana:
    image: grafana/grafana:latest
    ports: ["3000:3000"]
    depends_on: [prometheus]
```

### 8.2 Kubernetes for Production

Production uses Kubernetes with the following resource structure:

```
Namespace: voice-gateway
  Deployment: gateway          (N replicas, HPA on CPU + custom metrics)
  Deployment: otel-collector   (daemonset)
  Service: gateway             (ClusterIP + LoadBalancer for WebSocket)
  StatefulSet: redis-cluster   (3 nodes, Redis Cluster mode)
  ExternalName: postgres       (managed PostgreSQL, e.g., Cloud SQL / RDS)
  HorizontalPodAutoscaler: gateway  (min 2, max 50, target CPU 60%)
  PodDisruptionBudget: gateway      (minAvailable 1)
```

Key Kubernetes considerations:

- **WebSocket affinity**: WebSocket connections are long-lived (minutes per call). Standard round-robin load balancing drops connections on pod scaling. Use `sessionAffinity: ClientIP` on the Kubernetes Service, or deploy an ingress controller (NGINX, Envoy) with cookie-based session affinity.
- **Graceful shutdown**: the gateway pod must drain active sessions before termination. Set `terminationGracePeriodSeconds: 120` to allow in-flight calls to complete. The gateway's SIGTERM handler should stop accepting new sessions and wait for active sessions to close.
- **Resource requests/limits**: each gateway pod handling 50 concurrent sessions needs approximately 2 CPU and 4 GB RAM. Set conservative requests (1 CPU, 2 GB) and higher limits (4 CPU, 8 GB) to allow burst.

### 8.3 Scaling Considerations

**Stateless design**: the core gateway is designed stateless -- all session state lives in Redis, not in the gateway process. This enables horizontal scaling without sticky sessions for REST. However, active WebSocket sessions are sticky to a gateway instance by definition (the connection is persistent). The implication:

- New sessions can land on any gateway instance (load balanced).
- Active sessions stay on their instance for the duration of the call.
- Reconnecting sessions (after a drop) are routed to any instance, which reads state from Redis.

**Session density**: a single gateway process (2 vCPU, 4 GB RAM) can handle approximately 20-50 concurrent active sessions depending on:
- Whether STT/LLM/TTS processing is offloaded to external APIs (higher density) or local models (lower density).
- Average silence ratio per call (active listening uses less CPU than active generation).

**GPU nodes**: if running local TTS or STT models, deploy on GPU-enabled node pools with NVIDIA device plugin. Use Kubernetes node selectors (`accelerator: nvidia-tesla-t4`) and GPU resource limits (`nvidia.com/gpu: 1`). Use Karpenter for node provisioning and KEDA for event-driven scaling.

### 8.4 Resource Planning

| Component | CPU (per 50 sessions) | RAM (per 50 sessions) | Notes |
|---|---|---|---|
| Gateway process (Go) | 1-2 vCPU | 512 MB | Scales linearly |
| AI pipeline (Python) | 2-4 vCPU | 1-2 GB | GIL limits; use multiple processes |
| Local VAD (Silero ONNX) | 0.5 vCPU | 100 MB | CPU-only, fast |
| Local turn detection | 0.5 vCPU | 400 MB | ~25ms inference |
| Redis (warm cache) | 1 vCPU | 2-4 GB | Per cluster node |
| PostgreSQL | 2 vCPU | 4 GB | Managed service preferred |

---

## 9. Observability

### 9.1 OpenTelemetry for Distributed Tracing

Each voice session generates a root trace span. Child spans are created for every pipeline stage:

```
Trace: session_s_abc
  Span: stt.stream (30 s total)
    Span: stt.partial_result (x12, avg 180ms each)
    Span: stt.final_result
  Span: llm.complete (turn 1)
    Attribute: llm.model = "gpt-4o"
    Attribute: llm.ttft_ms = 380
    Attribute: llm.tokens_generated = 42
  Span: tts.synthesize (turn 1)
    Attribute: tts.provider = "elevenlabs"
    Attribute: tts.first_chunk_ms = 220
    Attribute: tts.total_ms = 3200
    Attribute: tts.interrupted = false
  Span: interruption.handle (turn 2)
    Attribute: interrupted_at_ms = 1800
```

Spans are exported via OTLP (gRPC) to an OTel Collector, which fans out to Jaeger (trace UI) and Prometheus (metrics via spanmetrics connector).

Instrumentation example:

```python
from opentelemetry import trace

tracer = trace.get_tracer("voice-gateway")

async def run_tts(text_stream, voice_id):
    with tracer.start_as_current_span("tts.synthesize") as span:
        span.set_attribute("tts.provider", config.tts.provider)
        span.set_attribute("tts.voice_id", voice_id)
        first_chunk = True
        async for chunk in tts_backend.synthesize(text_stream, voice_id):
            if first_chunk:
                span.set_attribute("tts.first_chunk_ms", elapsed_ms())
                first_chunk = False
            yield chunk
```

### 9.2 Per-Stage Latency Metrics

Key Prometheus metrics to instrument:

```
# Session metrics
voice_gateway_sessions_active                     (gauge)
voice_gateway_sessions_total                      (counter, labels: config_id, outcome)
voice_gateway_session_duration_seconds            (histogram)

# Per-stage latency
voice_gateway_stt_partial_latency_ms              (histogram, labels: provider)
voice_gateway_stt_final_latency_ms                (histogram, labels: provider)
voice_gateway_llm_ttft_ms                         (histogram, labels: provider, model)
voice_gateway_llm_total_ms                        (histogram, labels: provider, model)
voice_gateway_tts_first_chunk_ms                  (histogram, labels: provider)
voice_gateway_tts_total_ms                        (histogram, labels: provider)

# End-to-end turn latency (user silence to first TTS audio)
voice_gateway_turn_latency_ms                     (histogram, labels: config_id)

# Quality metrics
voice_gateway_stt_confidence                      (histogram, labels: provider)
voice_gateway_interruptions_total                 (counter, labels: config_id)
voice_gateway_errors_total                        (counter, labels: stage, error_code)
voice_gateway_tts_cancellations_total             (counter, labels: provider)

# Provider availability
voice_gateway_provider_errors_total               (counter, labels: provider, stage)
voice_gateway_circuit_breaker_state               (gauge, labels: provider)  # 0=closed, 1=open
```

Target SLOs for a production system:

| Metric | Target |
|---|---|
| Turn latency P50 | < 600 ms |
| Turn latency P90 | < 1200 ms |
| Turn latency P99 | < 3000 ms |
| STT confidence P50 | > 0.85 |
| TTS first chunk P90 | < 400 ms |
| Session error rate | < 1% |

### 9.3 Prometheus/Grafana Dashboards

Recommended dashboard panels:

1. **Active Sessions** (gauge): current concurrent sessions by config.
2. **Turn Latency Heatmap**: histogram heatmap of end-to-end turn latency over time.
3. **Per-Stage Breakdown**: stacked time-series of P50 latency for STT, LLM TTFT, TTS first chunk.
4. **Error Rate by Stage**: counter-rate of errors for each stage, with drill-down to error codes.
5. **Provider Health**: per-provider error rate and circuit breaker state.
6. **Interruption Rate**: interruptions per session, indicator of turn detection quality.
7. **Token Consumption**: LLM tokens per session (cost proxy).
8. **Connection Drop Rate**: reconnect events per session (network quality indicator).

Alert rules (Alertmanager):

```yaml
- alert: TurnLatencyHigh
  expr: histogram_quantile(0.90, voice_gateway_turn_latency_ms_bucket) > 2000
  for: 5m
  labels: { severity: warning }

- alert: ProviderErrorRateHigh
  expr: rate(voice_gateway_provider_errors_total[5m]) > 0.05
  for: 2m
  labels: { severity: critical }

- alert: CircuitBreakerOpen
  expr: voice_gateway_circuit_breaker_state == 1
  for: 1m
  labels: { severity: critical }
```

---

## 10. Recommended Architecture

### 10.1 Proposed Concrete Architecture

Based on the research above, the recommended architecture for a production voice gateway is:

**Design principles**:
1. Separate transport (real-time audio I/O) from AI pipeline (STT/LLM/TTS logic).
2. All session state is externalised to Redis; the gateway process is stateless across reconnects.
3. Every AI backend is accessed via a typed provider interface; switching providers requires only a config change.
4. Streaming overlap is mandatory at every stage; no blocking waits between stages.
5. Barge-in and interruption handling are first-class concerns, not afterthoughts.
6. The voice engine has zero awareness of business logic; an external orchestration service subscribes to session events via webhooks.

### 10.2 Component Diagram Description

```
+-------------------------------------------------------------+
|                        Clients                              |
|   Browser (WebRTC/WS)   Mobile App   SIP/Telephony Trunk    |
+----------+------------------+--------------+---------------+
           | WebSocket/WebRTC |              | SIP/RTP
           v                  v              v
+-------------------------------------------------------------+
|                    Transport Layer (Go)                      |
|  +--------------+  +--------------+  +------------------+  |
|  |  WS Gateway  |  |  WebRTC SFU  |  |   SIP Proxy      |  |
|  |  (HTTP/WS)   |  | (LiveKit /   |  | (FreeSWITCH /    |  |
|  |              |  |  custom Go)  |  |  Asterisk)       |  |
|  +------+-------+  +------+-------+  +--------+---------+  |
|         +------------------+------------------+            |
|                          |  Raw PCM audio + events         |
+--------------------------|----------------------------------+
                           | gRPC / Unix socket
+--------------------------|----------------------------------+
|                    AI Pipeline Layer (Python)               |
|                          |                                 |
|  +--------------------+--v-----------------------------+   |
|  |               Pipeline Orchestrator                 |   |
|  |  +---------+  +------+  +-------------+  +-------+  |   |
|  |  |   VAD   |->| STT  |->|  Turn Det.  |->|  LLM  |  |   |
|  |  |(Silero/ |  |(DG / |  |(LK Detector |  |(OAI / |  |   |
|  |  | TEN VAD)|  | ASAI)|  |/ VAD hybrid)|  | Groq) |  |   |
|  |  +---------+  +------+  +-------------+  +---+---+  |   |
|  |                                               |       |   |
|  |  +--------------------------------------------v----+  |   |
|  |  |                TTS Stage                        |  |   |
|  |  |  sentence_flush=true -> ElevenLabs / Cartesia   |  |   |
|  |  |  fallback: pre-cached error audio               |  |   |
|  |  +--------------------------------------------+----+  |   |
|  +--------------------------------------------------------+   |
|                                                              |
|  +----------------------------------------------------------+  |
|  |              Barge-In / Interruption Controller          |  |
|  |   Always-on VAD -> InterruptionEvent -> Cancel(TTS+LLM)  |  |
|  +----------------------------------------------------------+  |
|                                                              |
|  +-------------------+    +------------------------------+   |
|  |  Session Manager  |    |   Config / Provider Registry  |   |
|  |  <-> Redis (warm) |    |   (YAML + hot-swap support)   |   |
|  |  <-> Postgres(cold|    +------------------------------+   |
|  +-------------------+                                       |
+--------------------------------------------------------------+
                           | OTLP gRPC
+--------------------------|----------------------------------+
|                   Observability Stack                        |
|   OTel Collector -> Jaeger (traces)                         |
|                  -> Prometheus -> Grafana (metrics/alerts)   |
+-------------------------------------------------------------+
```

### 10.3 Technology Choices with Rationale

| Component | Technology | Rationale |
|---|---|---|
| Transport layer | Go + gorilla/websocket | Low-overhead goroutines handle thousands of concurrent WebSocket connections; no GIL; small binary |
| WebRTC SFU | LiveKit server (Go, open-source) | Production-grade, ICE/DTLS handled, global TURN network, Apache 2.0 license |
| SIP/Telephony | FreeSWITCH (optional module) | Industry-standard, proven at carrier scale; mu-law/alaw codec support |
| AI pipeline orchestration | Python 3.12 asyncio | Every provider SDK is Python-native; async generators simplify streaming chains |
| VAD | Silero ONNX or TEN VAD | Both are CPU-only, <100 MB, <5 ms inference; open-source; ONNX deployable anywhere |
| Turn detection | LiveKit turn detector (ONNX) | Best open-source semantic turn model; 14 languages; 25 ms inference; proven in production |
| STT | Deepgram Nova-3 (primary) | Best streaming WER+latency combination; native mu-law support; `utterance_end_ms` tunable |
| LLM | OpenAI GPT-4o via streaming API | Best TTFT-to-quality ratio; robust streaming; function calling; fallback to gpt-4o-mini |
| TTS | ElevenLabs Turbo v2.5 (primary), Cartesia Sonic (fallback) | ElevenLabs: best voice quality; Cartesia: lowest TTFT (~100 ms); both support sentence-level streaming |
| Session state (warm) | Redis Cluster | Sub-millisecond reads; native TTL; pub/sub for reconnection events |
| Session state (cold) | PostgreSQL 16 | Reliable, queryable, managed (Cloud SQL / RDS) |
| Configuration | YAML files + PostgreSQL config table | YAML for version-controlled base configs; DB for runtime overrides |
| Observability | OpenTelemetry + Prometheus + Grafana | Industry standard; OTLP spans flow through otel-collector to both Jaeger and Prometheus spanmetrics |
| Container orchestration | Kubernetes + Helm | Standard for production; HPA on custom metrics (active_sessions); PDB for graceful rolling updates |
| Development environment | Docker Compose | All dependencies reproducible locally; matches production service graph |

### 10.4 Critical Implementation Decisions

1. **Start TTS at sentence boundary, not turn completion**: this single change reduces perceived latency by 25-35% and is the highest-leverage optimization available.

2. **Semantic turn detection over VAD-only**: VAD-only end-of-turn detection has high false-positive rates (pauses mid-sentence trigger premature responses). The LiveKit turn detector or equivalent reduces false triggers significantly with only 25 ms overhead.

3. **Separate voice engine from orchestration**: the voice pipeline should have zero awareness of business logic (CRM updates, billing, routing rules). An external orchestration service subscribes to session events via webhooks and handles business concerns. This separation makes the voice engine faster, simpler, and independently deployable. Total per-minute cost for a self-built stack on commodity infrastructure can be as low as $0.035/min (vs. $0.07-0.15/min for hosted platforms).

4. **Pre-synthesize error audio**: cache WAV files for all fallback messages ("I didn't catch that", "I'm having trouble right now", "Let me put you on hold") so that error responses have zero TTS latency.

5. **Echo cancellation in the client**: server-side echo cancellation is unreliable and adds latency. Client SDKs (WebRTC browsers, mobile) should handle AEC. Document this requirement clearly for integration teams.

6. **Circuit breakers on every external API**: with three external API calls per turn (STT, LLM, TTS), a single provider outage can cascade to all sessions. Circuit breakers (half-open after 30 s, trip at 20% error rate over 60 s) protect the gateway from cascading failures and enable fast failover.

7. **Validate audio format end-to-end**: format mismatches between PCM rates, codec choices (Opus vs. mu-law), and sample rate assumptions are the most common source of silent quality degradation when changing providers. Integration tests must send real audio through the full stack and validate output quality, not just response codes.

---

## Sources

- [Pipeline & Frame Processing -- Pipecat Documentation](https://docs.pipecat.ai/guides/learn/pipeline)
- [GitHub: pipecat-ai/pipecat](https://github.com/pipecat-ai/pipecat)
- [Voice Agent Frameworks: LiveKit & Pipecat -- Arun Baby](https://www.arunbaby.com/ai-agents/0018-voice-agent-frameworks/)
- [Pipecat Architecture: Agent Factory / Panaversity](https://agentfactory.panaversity.org/docs/Building-Realtime-Voice-Agents/pipecat/frame-pipeline-architecture)
- [Building Intelligent AI Voice Agents with Pipecat and Amazon Bedrock -- AWS Blog](https://aws.amazon.com/blogs/machine-learning/building-intelligent-ai-voice-agents-with-pipecat-and-amazon-bedrock-part-1/)
- [Hardening Pipecat: A Month of Fixing What Matters -- DEV Community](https://dev.to/kollaikalrupesh/hardening-pipecat-a-month-of-fixing-what-matters-44l)
- [Pipecat: The Hardest Way to Deploy Voice and Multimodal AI -- Medium](https://medium.com/@thom.leigh/pipecat-the-hardest-way-to-deploy-voice-and-multimodal-conversational-ai-0706ae7a21cd)
- [Self-hosted deployment blueprints -- Pipecat GitHub Issue #3987](https://github.com/pipecat-ai/pipecat/issues/3987)
- [GitHub: livekit/agents](https://github.com/livekit/agents)
- [Voice Agent Architecture: STT, LLM, and TTS Pipelines Explained -- LiveKit Blog](https://livekit.com/blog/voice-agent-architecture-stt-llm-tts-pipelines-explained)
- [Sequential Pipeline Architecture for Voice Agents -- LiveKit Blog](https://livekit.com/blog/sequential-pipeline-architecture-voice-agents)
- [Turn Detection for Voice Agents: VAD, Endpointing, and Model-Based Detection -- LiveKit](https://livekit.com/blog/turn-detection-voice-agents-vad-endpointing-model-based-detection)
- [Improving Voice AI Turn Detection with Transformers -- LiveKit Blog](https://blog.livekit.io/using-a-transformer-to-improve-end-of-turn-detection)
- [LiveKit Turn Detector Plugin -- LiveKit Documentation](https://docs.livekit.io/agents/logic/turns/turn-detector/)
- [livekit-plugins-turn-detector -- PyPI](https://pypi.org/project/livekit-plugins-turn-detector/)
- [LiveKit Agents Architecture -- Moravio Blog](https://www.moravio.com/blog/livekit-agents-for-building-real-time-ai-agents)
- [Reducing Voice Agent Latency with Parallel SLMs and LLMs -- WebRTC.ventures](https://webrtc.ventures/2025/06/reducing-voice-agent-latency-with-parallel-slms-and-llms/)
- [GitHub: vocodedev/vocode-core](https://github.com/vocodedev/vocode-core)
- [Vocode Documentation](https://docs.vocode.dev/welcome)
- [GitHub: TEN-framework/ten-framework](https://github.com/TEN-framework/ten-framework)
- [TEN Framework: One Year On -- Open Source For You](https://www.opensourceforu.com/2025/11/one-year-on-ten-framework-redefines-open-source-voice-ai-development/)
- [TEN VAD -- Hugging Face](https://huggingface.co/TEN-framework/ten-vad)
- [TEN Framework Documentation](https://theten.ai/docs)
- [Building Real-Time Voice AI with WebSockets -- TEN Framework Blog](https://theten.ai/blog/building-real-time-voice-ai-with-websockets)
- [GitHub: kaminoer/KokoDOS](https://github.com/kaminoer/KokoDOS)
- [GitHub: vndee/local-talking-llm](https://github.com/vndee/local-talking-llm)
- [Building a Production Voice AI Platform from Scratch -- DEV Community](https://dev.to/mredman75/building-a-production-voice-ai-platform-from-scratch-architecture-latency-and-lessons-1b9o)
- [11 Voice Agent Platforms Compared: Vapi, Retell, Bland, ElevenLabs -- Softcery](https://softcery.com/lab/choosing-the-right-voice-agent-platform-in-2025)
- [Real-Time vs Turn-Based Voice Agent Architecture -- Softcery](https://softcery.com/lab/ai-voice-agents-real-time-vs-turn-based-tts-stt-architecture)
- [Real-Time Barge-In AI for Voice Conversations -- Gnani.ai](https://www.gnani.ai/resources/blogs/real-time-barge-in-ai-for-voice-conversations-31347)
- [Optimizing Voice Agent Barge-In Detection -- Sparkco Blog](https://sparkco.ai/blog/optimizing-voice-agent-barge-in-detection-for-2025)
- [Implementing VAD and Turn-Taking for Natural Voice AI Flow -- DEV Community](https://dev.to/callstacktech/implementing-vad-and-turn-taking-for-natural-voice-ai-flow-my-experience-1bdf)
- [Interruption Handling in Conversational AI -- Zoice](https://zoice.ai/blog/interruption-handling-in-conversational-ai/)
- [Designing Concurrent Pipelines for Real-Time Voice AI -- Gladia Blog](https://www.gladia.io/blog/concurrent-pipelines-for-voice-ai)
- [Engineering for Real-Time Voice Agent Latency -- Cresta Blog](https://cresta.com/blog/engineering-for-real-time-voice-agent-latency)
- [How to Optimise Latency for Voice Agents -- Nikhil R](https://rnikhil.com/2025/05/18/how-to-reduce-latency-voice-agents)
- [Toward Low-Latency End-to-End Voice Agents -- arXiv 2508.04721](https://arxiv.org/abs/2508.04721)
- [Chained Voice Agent Architectures -- Brain.co Blog](https://brain.co/blog/chained-voice-agent-architectures-speech-to-speech-vs-chained-pipeline-vs-hybrid-approaches)
- [Building Real-Time Voice AI: Sub-400ms Infrastructure -- SimpliSmart Blog](https://simplismart.ai/blog/real-time-voice-ai-sub-400ms-latency)
- [Voice AI Infrastructure Guide -- Introl Blog](https://introl.com/blog/voice-ai-infrastructure-real-time-speech-agents-asr-tts-guide-2025)
- [AI Agent Observability -- OpenTelemetry Blog](https://opentelemetry.io/blog/2025/ai-agent-observability/)
- [LiveKit Agent Monitoring: Prometheus, Grafana & Alerts -- Hamming AI](https://hamming.ai/resources/livekit-agent-monitoring-prometheus-grafana-alerts)
- [AI Agents Observability with OpenTelemetry and VictoriaMetrics](https://victoriametrics.com/blog/ai-agents-observability/)
- [Running Real-Time AI Voice Assistants in Kubernetes -- L7mp Technologies](https://medium.com/l7mp-technologies/running-reel-time-ai-voice-assistants-in-kubernetes-136662bd031f)
- [Voice AI Agent Architecture Patterns -- Bluejay](https://getbluejay.ai/resources/voice-ai-agent-architecture)
- [Develop and Deploy Voice AI Apps with Docker -- Docker Blog](https://www.docker.com/blog/develop-deploy-voice-ai-apps/)
- [Redis as the Engine Behind Real-Time Intelligent Chatbots -- Redis Blog](https://redis.io/blog/redis-as-the-engine-behind-real-time-intelligent-chatbots/)
- [AI Agent Memory: Types, Architecture & Implementation -- Redis Blog](https://redis.io/blog/ai-agent-memory-stateful-systems/)
- [How to Implement Context Retention in Voice AI Applications -- DEV Community](https://dev.to/callstacktech/how-to-implement-context-retention-in-voice-ai-applications-4kgk)
- [Building Production-Ready STT/TTS Implementations -- CallStack.tech](https://callstack.tech/blog/building-production-ready-stt-tts-implementations-with-llms-lessons-learned)
- [Building Voice AI Agents That Don't Suck -- Medium](https://charlesadewoye.medium.com/building-voice-ai-agents-that-dont-suck-lessons-from-production-448fc1ef3155)
- [Go vs Python vs Rust: Performance Comparison 2025 -- Pullflow Blog](https://pullflow.com/blog/go-vs-python-vs-rust-complete-performance-comparison/)
- [Rust vs Go in 2025 -- Evrone Blog](https://evrone.com/blog/rustvsgo)
- [The Voice AI Stack for Building Agents in 2026 -- AssemblyAI Blog](https://www.assemblyai.com/blog/the-voice-ai-stack-for-building-agents)
- [API Gateway WebSocket: Real-Time Communication at Scale -- VideoSDK](https://www.videosdk.live/developer-hub/websocket/api-gateway-websocket)
- [Switching AI Voice Agent from WebSocket to WebRTC -- DEV Community](https://dev.to/aws-builders/switching-my-ai-voice-agent-from-websocket-to-webrtc-what-broke-and-what-i-learned-3dkn)
- [Audio Format Negotiation -- Voice Mode Documentation](https://voice-mode.readthedocs.io/en/stable/audio-format-migration/)
- [Introduction to Audio Encoding -- Google Cloud Speech-to-Text](https://cloud.google.com/speech-to-text/docs/encoding)
- [RealTime AI Agents Frameworks Comparison: LiveKit, Pipecat and TEN -- Medium](https://medium.com/@ggarciabernardo/realtime-ai-agents-frameworks-bb466ccb2a09)
- [Vapi vs Retell: Architecture Comparison -- Retell AI](https://www.retellai.com/comparisons/retell-vs-vapi)
- [Bland AI vs Retell vs Vapi vs Air -- Bland AI Blog](https://www.bland.ai/blogs/bland-ai-vs-retell-vs-vapi-vs-air)
