# Architecture Expansion: Voice Gateway — Secure Family AI Assistant (TypeScript)

You have full autonomy. Do not ask questions. Use your best judgement.

## Project Intent

A secure, extensible voice gateway for a family of up to 10 users (5 family + guests), running on a Raspberry Pi 5 (8GB RAM, 500GB SSD) on a local network. The gateway is a **lightweight orchestration layer** written in **TypeScript** (Node.js or Bun runtime — explore both). It receives audio/text from native clients (web, Android, iOS), relays audio to STT services (local or cloud — explore both), and routes the resulting text through a classifier-first intelligence pipeline: prompt classification, tool dispatch, a composable skill system, and LLM response generation with TTS. The gateway does minimal audio processing — it is a passthrough that forwards audio streams to STT and TTS services. The architectural complexity lives in the **intelligence layer**: a classifier determines intent, a tool routing loop handles actions, a hot-reloadable skill system (markdown-defined workflows with controlled tool access) enables extensibility, and per-user memory files let the assistant learn over time. A single `persona.md` defines the assistant's personality. Security is a core architectural pillar — not bolted on. All tools and skills are first-party authored. No third-party marketplace. The skill system must be composable (skills can call other skills) but sandboxed — every tool call is authorized, impact-tiered, and audited. Guest mode provides ephemeral sessions with no persistent memory and restricted tool access. Clients are strict native: Android (Kotlin + Jetpack Compose), iOS (Swift/SwiftUI), and a minimal web chat interface. Mobile clients handle on-device wake word detection using platform-native SDKs with continuous recording and circular audio buffering — the user speaks naturally and pre-trigger audio is already captured, so there is no perceived detection delay. The web client is minimal (text chat + push-to-talk voice toggle, no wake word).

This is your anchor. Re-read this before every expansion decision. Every exploration must serve this intent.

## Constraints

- **Hardware**: Raspberry Pi 5, 8GB RAM, 500GB SSD — no GPU, no heavy local inference
- **Scale**: 5 family users + up to 5 guests (party/guest mode) = max ~10 concurrent sessions
- **Budget**: Personal/home project — cost-conscious, not enterprise
- **Gateway language**: TypeScript only. Node.js or Bun runtime (explore both).
- **Gateway role**: Lightweight orchestration/passthrough. Minimal audio processing. Relay audio to STT/TTS services.
- **STT**: Explore local (Whisper.cpp on Pi), cloud (Deepgram Nova-3), and hybrid approaches
- **LLM**: OpenRouter (model flexibility, pay-per-use)
- **TTS**: Fish Audio (starting pick, pluggable interface)
- **All tools first-party**: No third-party skill/plugin marketplace. Every tool is self-authored or explicitly vetted.
- **Clients are native**: Android (Kotlin + Jetpack Compose), iOS (Swift/SwiftUI), Web (minimal chat UI)
- **Mobile wake word**: On-device SDK (e.g., Picovoice Porcupine), continuous recording with circular buffer, pre-trigger audio capture
- **Web client**: Minimal — text chat interface with push-to-talk voice toggle. No wake word detection.
- **No desktop client**: Desktop access via web only
- **Skill system**: Hot-reloadable from a gateway directory. Skills are markdown-defined workflows with tool calls. Skills can compose (call other skills). All first-party, sandboxed.
- **Guest mode**: Ephemeral sessions — no persistent memory writes, restricted tool access, no memory pollution
- **Persona**: Single `persona.md` file on disk, injected as system prompt into every LLM call
- **Per-user memory**: `memory/<user>.md` files on disk, loaded at auth, updated post-interaction

These are hard boundaries. Do not explore approaches that violate them.

## Architecture Sketch

```
+-----------------------------------------------------------------+
|                         CLIENTS (native)                         |
|                                                                  |
|  Android (Kotlin+Compose)  |  iOS (Swift/SwiftUI)  |  Web (min) |
|  - Porcupine wake word     |  - Porcupine wake word|  - Text chat|
|  - Continuous recording    |  - AVAudioEngine      |  - PTT voice|
|  - Circular audio buffer   |  - Circular buffer    |  - No wake  |
|  - Pre-trigger capture     |  - Pre-trigger capture|    word     |
+-----------------------------+------------------------+-----------+
                              | WebSocket (audio stream + JSON control)
                              v
+-----------------------------------------------------------------+
|              VOICE GATEWAY (RPi5, TypeScript)                    |
|                                                                  |
|  +----------+                                                    |
|  |   Auth   |  PASETO v4.local (family + guest tokens)           |
|  +----+-----+                                                    |
|       v                                                          |
|  +----------+   +----------------------------------------------+ |
|  |  Audio   |-->|  STT Service (passthrough relay)              | |
|  |  Relay   |   |  Local (Whisper.cpp) / Cloud (Deepgram) /    | |
|  |          |   |  Hybrid                                      | |
|  +----------+   +-------------------+--------------------------+ |
|                                     v                            |
|  +----------------------------------------------+                |
|  |  INTELLIGENCE LAYER                          |                |
|  |                                              |                |
|  |  Classifier -----> Direct LLM response       |                |
|  |      |              (no tools needed, ~70%)  |                |
|  |      v                                       |                |
|  |  Tool Router --> ReAct Loop (max 5 iter)     |                |
|  |      |              |                        |                |
|  |      v              v                        |                |
|  |  Skill Engine (hot-reload, composable)       |                |
|  |      |                                       |                |
|  |      v                                       |                |
|  |  Context Assembly                            |                |
|  |  persona.md + memory/<user>.md + history     |                |
|  +-------------------+--------------------------+                |
|                      v                                           |
|  +----------+   +---------+   +-----------+                      |
|  |  Text    |-->|  TTS    |-->| Transport |---> Client           |
|  |  Preproc |   | Service |   | (stream)  |                      |
|  +----------+   +---------+   +-----------+                      |
|                                                                  |
|  +----------------------------------------------+                |
|  |  Security Layer (cross-cutting)              |                |
|  |  - Auth at edge (family + guest tokens)      |                |
|  |  - Prompt injection guard on STT output      |                |
|  |  - Tool/skill impact tiers (auto/confirm)    |                |
|  |  - Skill sandboxing (first-party only)       |                |
|  |  - Audit log (who, what, when)               |                |
|  |  - Guest mode (ephemeral, restricted)        |                |
|  +----------------------------------------------+                |
+-----------------------------------------------------------------+
```

**Pipeline flow**: Client -> Auth -> Audio Relay -> STT Service -> Classifier -> [Direct LLM | Tool Router -> Skill Engine -> ReAct Loop] -> Context Assembly -> LLM -> Text Preproc -> TTS Service -> Audio stream back to client

**Gateway is a passthrough for audio**: It relays audio streams to STT/TTS services. No codec work, no frame processing. The Pi's job is orchestration, not audio processing.

**Intelligence layer is the core complexity**: Classification, tool routing, skill execution, memory management, persona injection, context budgeting — this is where the architecture matters.

**Streaming overlap is critical**: TTS starts on the first complete sentence while LLM is still generating. This cuts perceived latency by 50-70%.

**Cancel propagation**: Barge-in (user interrupts) must propagate cancel signals through STT relay, LLM generation, tool execution, TTS relay, and transport.

This is the starting skeleton. Your job is to expand, validate, and refine — not replace. Explore alternatives for each decision area, but the overall shape should remain recognizable.

## Workspace Structure

```
/workspace/
├── prompt.md                # this file (read-only reference)
├── progress.md              # scoreboard + task queue — your instruction sheet
├── expansion-loop.md        # how to handle Score tasks
├── scoring-rubric.md        # scoring dimensions for subagents
├── architecture.md          # LIVING DOCUMENT — update at every Synthesize step
├── explorations/            # research + analysis per decision area
│   ├── decision-area.md
│   └── ...
├── poc/                     # working prototypes (execute as: su -c "..." poc)
│   ├── component-name/
│   └── ...
├── risks.md                 # cross-cutting risks + mitigations
├── sources.md               # running bibliography — URLs, titles, notes
└── connections.md           # cross-component dependencies + interactions
```

## How This Works

1. Read `progress.md` and find the next unchecked item in the Task Queue
2. Do that ONE item
3. Check it off in progress.md
4. Output `TASK DONE`
5. Stop — you will be re-invoked automatically

When the task queue is empty, output `<promise>TASK DONE</promise>` instead.

## PoC Execution — CRITICAL

**ALL PoC code MUST be written and executed via `sudo -u poc`.** The `/workspace/poc/` directory is owned by the `poc` user — you cannot write to it directly. Any attempt to write or run code there without `sudo -u poc` will fail with Permission denied. This is intentional security enforcement, not a bug.

**Writing files:**
```bash
sudo -u poc mkdir -p /workspace/poc/<name>
sudo -u poc bash -c "cat > /workspace/poc/<name>/index.js << 'POCEOF'
// your code here
POCEOF"
```

**Running code:**
```bash
sudo -u poc bash -c "cd /workspace/poc/<name> && node index.js"
sudo -u poc bash -c "cd /workspace/poc/<name> && bun run index.ts"
sudo -u poc bash -c "cd /workspace/poc/<name> && python3 main.py"
```

**Installing dependencies:**
```bash
sudo -u poc bash -c "cd /workspace/poc/<name> && npm install <package>"
```

You CAN read PoC results directly (e.g., `cat /workspace/poc/<name>/output.txt`) — only writing and executing requires `sudo -u poc`.

PoCs should be minimal — just enough to validate feasibility. Limited scope: prove the concept works, measure key metrics, then move on. Do not build production code.

## Synthesize Step

When you reach a `Synthesize: update architecture.md` task:

1. Read all explorations, scores, and PoC results so far
2. Re-read the Project Intent section above to stay anchored
3. Update `architecture.md` with the current state of each decision area:
   - Use mermaid diagrams for component interactions, data flows, and sequence diagrams
   - Present 2-3 approaches per area with detailed pros/cons
   - Include score breakdowns per approach
   - Reference supporting PoCs with relative paths (e.g., `poc/bun-gateway/`)
   - Mark each area's status: exploring / scored / concluded
4. Update `risks.md` with any cross-cutting risks discovered
5. Update `connections.md` with cross-component dependencies

## Prior Research

Extensive research was conducted in two prior rounds:

1. **`/Users/kevinye/offline-research/2026-04-02-voice-gateway/`** — STT providers (Deepgram, AssemblyAI, Whisper, faster-whisper), OpenRouter streaming, TTS preprocessing, cloud TTS providers (Fish Audio, Cartesia, ElevenLabs), self-hosted TTS, audio delivery, and gateway architecture patterns (Pipecat, LiveKit). Reference for detailed provider comparisons, latency benchmarks, and cost analysis.

2. **`/Users/kevinye/offline-research/2026-04-03-voice-gateway-arch/`** (Python-focused iteration) — explored pipeline architecture (asyncio, frame-based), client-gateway protocol (WebSocket-only with Opus), classifier-first tool routing (hybrid regex + LLM, ReAct loop), security architecture (PASETO, 6-layer prompt injection defense, impact tiers), per-user memory (sectioned markdown, tiered storage), and provider integration (Protocol interfaces, config-ordered failover). The architectural patterns and provider conclusions carry forward — adapt for TypeScript, not re-research from scratch.

Do not re-research what's already covered. Build on these findings.

## Initial Decision Areas

### 1. Gateway Core — Node/Bun + TypeScript (`gateway-core`)
- Runtime choice: Node.js vs Bun — performance on RPi5, ecosystem maturity, WebSocket support
- Gateway is a lightweight passthrough/orchestrator — minimal audio processing
- WebSocket server for client connections (audio relay + JSON control messages)
- Session management for up to 10 concurrent sessions (family + guests)
- Streaming relay: forward audio to STT, stream TTS audio back to clients
- HTTP health/metrics endpoint alongside WebSocket
- Process model on RPi5: single process sufficient given passthrough role?

### 2. STT: Local vs Cloud vs Hybrid (`stt-strategy`)
- **Cloud (Deepgram Nova-3)**: Best accuracy, lowest Pi load, requires internet, ~$6/mo
- **Local (Whisper.cpp on Pi)**: Works offline, ~1-2GB RAM, CPU-bound on Pi (no GPU), lower accuracy for streaming
- **Hybrid**: Local for fast interim/offline, cloud for final accuracy
- Explore all three approaches — latency, accuracy, cost, offline capability, RPi5 resource impact
- How does local STT affect the "passthrough" gateway design? Does it become heavier?
- VAD and endpointing strategy per approach
- Reference prior STT research in `2026-04-02-voice-gateway/findings/stt-providers.md`

### 3. Classifier & Tool Routing (`classifier-tool-routing`)
- Prompt trigger classification after STT: determine intent (conversation, tool call, skill invocation)
- Hybrid classifier: local regex fast-path for obvious cases + LLM fallback for ambiguous
- Tool detection loop with LLM (ReAct pattern, max 5 iterations)
- Tool registry: declaration format, auto-discovery from directory, impact tier per tool
- How classifier interacts with skill system (skill triggers vs tool triggers)
- Latency budget: classifier <5ms (local) or <400ms (LLM fallback)
- Reference prior tool-routing research in the previous iteration's explorations

### 4. Skill System Architecture (`skill-system`)
- Markdown-defined workflows with tool calls — similar to Claude Code / OpenClaw skills but ALL first-party
- **Hot-reloadable**: file watcher on a gateway directory, add/edit a skill file and it's live immediately
- **Composable**: skills can call other skills (skill A invokes skill B as a step)
- Skill definition format: what does a skill markdown file look like? Triggers, steps, tool references, parameters
- Skill execution engine: how the gateway interprets and runs a skill workflow
- Skill sandboxing: each skill can only access tools it declares, no ambient authority
- Skill versioning and validation: malformed skills fail gracefully, don't crash the gateway
- How skills interact with the classifier (skill triggers) and tool router
- Cycle detection for composable skills (A calls B calls A)
- This is the most novel area — explore design space thoroughly

### 5. Persona & Memory System (`persona-memory`)
- `persona.md` injected as system prompt — single personality for all users
- Per-user `memory/<user>.md` files — sectioned markdown, tiered storage (core profile / active context / archive)
- **Guest memory**: ephemeral, in-memory only, discarded at session end — no file writes
- Memory update strategy: end-of-session extraction + explicit "remember this" trigger
- Context budgeting: persona + memory + history must fit in context window (<=80%)
- Memory quality: extraction prompt, reconciliation (ADD/UPDATE/DELETE), dedup
- Cross-user privacy: strict session isolation, path-validated memory loading
- Persona > Memory > History priority hierarchy
- Reference prior memory research in previous iteration's explorations

### 6. Security Architecture + Guest Mode (`security-guest-mode`)
- **Auth**: PASETO v4.local tokens — family members get persistent tokens, guests get ephemeral tokens
- **Guest mode**: ephemeral session, no persistent memory writes, restricted tool access (read-only tier only), auto-expire tokens
- **Prompt injection defense**: layered (sanitization, heuristic pre-filter, delimiter framing, privilege reduction, canary tokens, output filtering)
- **Tool/skill impact tiers**: read (auto) / write (auto) / confirm (user approval) / admin (adult only). Guests restricted to read tier.
- **Skill sandboxing**: skills declare their tool dependencies, can only access declared tools, no ambient authority
- **Role system**: adult / child / guest roles in token claims — different tool/skill access per role
- **Audit logging**: every tool/skill invocation logged (who, what, when, result)
- **API key management**: encrypted config, decrypted to memory at startup
- **Network**: LAN primary, Tailscale optional for remote access
- Security is a CORE PILLAR — explore thoroughly, not as an afterthought

### 7. On-Device Wake Word & Audio Buffering (`wake-word-audio-buffering`)
- Picovoice Porcupine as primary candidate — native SDKs for Android, iOS, Web (WASM)
- Custom wake word training vs built-in keywords
- **Continuous recording with circular buffer**: mic is always recording into a rolling buffer (e.g., last 2-3 seconds)
- **Pre-trigger audio capture**: when wake word is detected, the buffer already contains the audio before and during the trigger — user doesn't perceive any detection delay
- Buffer design: ring buffer size, sample rate, memory footprint on mobile
- How pre-trigger audio is transmitted to gateway (prepend to stream? separate message?)
- Alternatives to Porcupine: Snowboy successors, platform-native (Android voice interaction, Siri Shortcuts)
- Power and battery impact of always-on mic on mobile

### 8. Android Client — Kotlin + Jetpack Compose (`android-client`)
- Strict native: Kotlin + Jetpack Compose, latest best practices
- Audio capture: `AudioRecord` API with circular buffer, Kotlin coroutines
- Wake word: Porcupine Android SDK integration with foreground service
- Background recording: foreground service with persistent notification (Android requirement)
- WebSocket client: OkHttp or Ktor for WebSocket to gateway
- Opus encoding for audio streaming (or raw PCM if gateway handles codec?)
- UI: Compose-based — conversation view, voice activity indicator, tool confirmation dialogs
- Battery optimization: how to keep always-on mic without draining battery
- Android 14+ permission model for microphone, foreground service types
- Reconnection and session resumption on network changes

### 9. iOS Client — Swift/SwiftUI (`ios-client`)
- Strict native: Swift + SwiftUI, latest best practices
- Audio capture: `AVAudioEngine` with tap-based processing, circular buffer
- Wake word: Porcupine iOS SDK (SPM/CocoaPods), integration with audio pipeline
- Background audio: requires Audio background mode capability. Apple restrictions on always-on mic — explore what's actually possible
- The orange dot (mic indicator) is always visible — UX consideration, not a blocker for personal use
- WebSocket client: URLSessionWebSocketTask or Starscream
- UI: SwiftUI — conversation view, voice indicator, tool confirmation
- App Store vs TestFlight vs personal distribution — affects what background capabilities are allowed
- iOS audio interruptions: phone calls, Siri — graceful handling
- Privacy: microphone permission prompt, background audio justification string

### 10. Client-Gateway Protocol (`client-gateway-protocol`)
- WebSocket-only: single connection carries audio stream + JSON control messages
- Binary frames for audio, text frames for JSON control
- Auth handshake: first message is PASETO token (family or guest), 5-second timeout
- Guest onboarding: how does a guest get a token? QR code? PIN? Host approval?
- Message types: session.start, audio.start/end, text.input, barge_in, tool.confirm, transcript, response.text, etc.
- Mobile reconnection: session ID + exponential backoff with jitter, server session survives briefly
- Cellular network resilience: handle WiFi<->cellular handoffs gracefully
- Audio codec: Opus recommended, but explore if raw PCM passthrough is simpler given gateway is a relay

### 11. Provider Integration — TypeScript (`provider-integration-ts`)
- TypeScript interfaces (replaces Python Protocol classes) for STT, LLM, TTS contracts
- Streaming patterns in Node/Bun: async iterators, ReadableStream, EventEmitter — which pattern for provider streaming?
- Fish Audio TTS: WebSocket streaming, Opus output, emotion tags
- Deepgram STT: WebSocket streaming, partial transcripts, speech_final events
- OpenRouter LLM: SSE streaming, function calling, model selection
- Provider failover: config-ordered with circuit breaker pattern
- Configuration: YAML for structure, env vars for secrets
- npm ecosystem: what TypeScript libraries exist for each provider?
- Reference prior provider research in `2026-04-02-voice-gateway/`

### 12. Web Client (`web-client`)
- **Minimal scope**: text chat interface similar to ChatGPT/Claude web UI
- Push-to-talk voice toggle button (hold or click to record, release to send)
- No wake word detection — this is a convenience/fallback interface
- WebSocket connection to gateway for real-time streaming responses
- Audio: Web Audio API + MediaRecorder for PTT capture, audio playback for TTS responses
- UI: simple, clean — message list, input box, PTT button, typing indicator
- Guest access via web: how does guest auth work in browser? (link with embedded token? PIN entry?)
- Framework: explore minimal options (vanilla TS, Preact, Solid) — avoid heavy frameworks for a simple UI
