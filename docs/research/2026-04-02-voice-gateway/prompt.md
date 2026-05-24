# Research Mission: Self-Hosted Voice Gateway — LLM-to-Audio Pipeline

You have full autonomy. Do not ask questions. Use your best judgement.

## Workspace Structure

```
/workspace/
├── progress.md              # live scoreboard — scores, deltas, cycle log
├── critique-loop.md         # Phase 6 loop protocol (read after Phase 5)
├── scoring-rubric.md        # scoring dimensions for subagents
├── topics/
│   ├── 01-topic-name.md     # sub-topics + questions (generated in Phase 1)
│   └── ...
├── findings/
│   ├── topic-name.md        # research output per topic
│   └── ...
├── poc/                     # prototypes, architectures, visual explorations
│   └── ...
├── sources.md               # running bibliography — URLs, titles, notes
├── contradictions.md        # where sources disagree
├── connections.md           # cross-topic patterns and insights
├── gaps.md                  # self-critique — what's weak, what needs more work
└── README.md                # final TLDR + navigation
```

## Phases

### Phase 1: Scope Expansion
Read the initial topics below. Think about what's missing.
For each topic, create a file in `topics/` with:
- The original bullet points
- Sub-topics you think are important but weren't listed
- Adjacent areas that would strengthen the research
- 3-5 specific questions to answer

Update progress.md to mark Phase 1 complete.

### Phase 2: Survey
Quick pass across all topics. For each:
- Skim available sources, log them in sources.md
- Note which areas are well-documented vs sparse
- Flag any early contradictions

Update progress.md with survey status per topic.

### Phase 3: Deep Dive
For each topic (read its spec from `topics/`, write output to `findings/`):
1. Research thoroughly — multiple sources, specific examples, actionable detail
2. Cite sources (reference entries in sources.md)
3. Mark topic complete in progress.md

### Phase 4: Synthesize
1. Write connections.md — patterns and insights across topics
2. Write contradictions.md — where sources disagree and why
3. Write gaps.md — what's weak, what would someone challenge, what needs more work

### Phase 5: Final Report
1. Write README.md — TLDR summary with links to each findings file
2. Update progress.md to mark Phase 5 complete

### Phase 6: Critique & Expand Loop

Do NOT proceed past Phase 5 without reading `critique-loop.md` in full. The loop protocol, scoring system, and subagent instructions are defined there. Skipping this file will produce incorrect results.

Read `critique-loop.md` now and follow it exactly.

## Initial Topics

### 1. STT Providers & Engines (`stt-providers.md`)
- Cloud STT: Deepgram, AssemblyAI, Google Cloud Speech, Azure Speech, Whisper API
- Self-hosted STT: Whisper, faster-whisper, Whisper.cpp, Distil-Whisper
- Streaming/real-time support — partial transcript delivery, VAD integration
- Latency benchmarks: time-to-first-transcript, end-to-end
- Accuracy comparison across accents, noise conditions, domain-specific vocab
- Pricing models: per-minute, per-character, free tiers, volume discounts
- GPU/CPU requirements for self-hosted options
- Language support breadth and quality

### 2. OpenRouter Streaming Integration (`openrouter-streaming.md`)
- OpenRouter streaming API — SSE format, token-level delivery
- Latency characteristics: time-to-first-token across different models
- Model compatibility matrix — which models stream well through OpenRouter
- Rate limits, pricing pass-through, reliability
- How to consume the stream and forward partial text to the TTS preprocessing layer
- Comparison with direct provider APIs (does the OpenRouter hop add meaningful latency?)
- Error handling and fallback strategies for stream interruptions

### 3. TTS Preprocessing & Chunking (`tts-preprocessing.md`)
- Sentence-level streaming: send each sentence to TTS as it completes — fastest first-audio, but potential prosody breaks at chunk boundaries
- Paragraph-level buffering: wait for natural breaks — better prosody, longer initial wait
- Hybrid/adaptive: first sentence ships fast, then switch to larger chunks for quality
- Markdown stripping — converting LLM output to clean spoken text
- Emotion/tone tag injection — mapping LLM context to SSML or provider-specific tags
- Sentence boundary detection — libraries, heuristics, edge cases
- Handling edge cases: code blocks, lists, URLs, special characters in LLM output
- Configurable chunking strategy — how to expose this as a gateway setting

### 4. Cloud TTS Providers (`cloud-tts-providers.md`)
- Fish Audio: pricing, FishAudio-S1 quality, sub-500ms latency, 50+ emotion tags, streaming API, voice cloning
- Cartesia: ~40ms TTFA, Sonic model, cheaper than ElevenLabs, streaming support
- ElevenLabs: Flash v2.5 (75ms), premium quality, pricing, emotion range, API maturity
- PlayHT: 600+ voices, 140+ languages, pricing, PlayHT 3.0 model
- Deepgram Aura, MiniMax, Azure, Google Cloud TTS as secondary
- Head-to-head comparison table: pricing per 1M chars, TTFA, quality ranking, streaming support, emotion control, voice cloning, language count
- API design differences — how each provider handles streaming

### 5. Self-Hosted TTS Engines (`self-hosted-tts.md`)
- Chatterbox / Chatterbox-Turbo: 350M params, sub-200ms inference, Resemble AI
- Kokoro: 82M params, lightweight, quality comparable to larger models
- Voxtral: open-source, beat ElevenLabs Flash v2.5 in blind tests
- CosyVoice2-0.5B: 150ms streaming latency
- Coqui TTS: 17 languages, voice cloning from 6s
- GPU requirements per model
- Quality vs cloud comparison
- Deployment: Docker images, serving frameworks
- Voice cloning capabilities per engine
- Latency under load

### 6. Audio Delivery & Transport (`audio-delivery.md`)
- WebSocket streaming — bidirectional, real-time, connection management
- Chunked HTTP — simpler, unidirectional, widely supported
- WebRTC — lowest latency, most complex
- Audio codecs: PCM, Opus, MP3, AAC — tradeoffs
- Buffering strategies on the client side
- How each TTS provider delivers audio
- Gateway output format standardization

### 7. Gateway Architecture Design (`gateway-architecture.md`)
- API shape: REST for text, WebSocket for audio streaming, separate STT endpoint
- Pluggable backend abstraction: interface for STT, LLM, TTS backends
- Pipeline orchestration: STT → LLM → preprocessing → TTS with streaming overlap
- Configuration system: chunking strategy, TTS backend, model selection, persona, audio format
- Session management: conversation history, multi-turn context
- Error handling: TTS fails mid-stream, LLM times out, STT returns garbage
- Health checks and observability: latency tracking per pipeline stage
- Tech stack considerations: Go, Rust, Python asyncio, Node.js
- Existing open-source projects (KokoDOS, local-talking-llm)
