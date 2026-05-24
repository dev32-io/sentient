# Sources & Bibliography

> Running list of references, URLs, and research notes. Surveyed 2026-04-03.

## Prior Research Rounds
- `/Users/kevinye/offline-research/2026-04-02-voice-gateway/` — STT providers, OpenRouter, TTS, audio delivery, gateway patterns
- `/Users/kevinye/offline-research/2026-04-03-voice-gateway-arch/` — Python-focused: pipeline arch, WebSocket protocol, classifier, security, memory, providers

## Runtimes

- [Node.js Release Schedule](https://nodejs.org/en/about/previous-releases) — v25.9.0 current, v22.22.1 LTS; starting Oct 2026 one major/year
- [Node.js Evolving Release Schedule](https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule) — Future release cadence changes
- [Bun GitHub Releases](https://github.com/oven-sh/bun/releases) — v1.3.10 latest (March 2026); ARM64 fixes included
- [Bun RPi 4 Issue #17460](https://github.com/oven-sh/bun/issues/17460) — Tracks RPi4 ARM64 breakage and fix history
- [Bun Linux ARM64 Issue #75](https://github.com/oven-sh/bun/issues/75) — Long-running ARM64 support tracking
- [Bun vs Node.js WebSocket Benchmark (Lemire)](https://lemire.me/blog/2023/11/25/a-simple-websocket-benchmark-in-javascript-node-js-versus-bun/) — Independent WS throughput comparison
- [Bun vs Node.js vs Deno Performance 2026](https://www.askantech.com/bun-vs-nodejs-vs-deno-performance-benchmarks-2026/) — 2.8x WS throughput, 52k vs 14k HTTP req/s
- [Bun vs Node.js: Time to Switch? (2026)](https://dev.to/alexcloudstar/bun-vs-nodejs-is-it-time-to-switch-in-2026-5821) — ~95% npm compat, native addon gaps
- [Node vs Bun vs Deno 2026: Honest Benchmarks](https://blog.devgenius.io/node-vs-bun-vs-deno-in-2026-the-brutally-honest-benchmarks-no-one-talks-about-aa5b74d83bbe) — 4.7k open issues, production readiness

## STT Providers

- [Deepgram Nova-3 Introduction](https://deepgram.com/learn/introducing-nova-3-speech-to-text-api) — 54% WER reduction, 5.26% WER on English
- [Deepgram Pricing](https://deepgram.com/pricing) — $0.0077/min streaming, $200 free credit, per-second billing
- [Deepgram Pricing Breakdown (BrassTranscripts)](https://brasstranscripts.com/blog/deepgram-pricing-per-minute-2025-real-time-vs-batch) — $0.46/hr streaming, idle WS free
- [Deepgram STT Benchmarks](https://deepgram.com/learn/speech-to-text-benchmarks) — 2703 files, 81.69 hrs, 9 domains tested
- [whisper.cpp GitHub](https://github.com/ggml-org/whisper.cpp) — v1.8.3 latest, ARM64 Docker, stream example
- [whisper.cpp v1.8.3 Performance (Phoronix)](https://www.phoronix.com/news/Whisper-cpp-1.8.3-12x-Perf) — 12x perf boost with integrated GPU
- [AssemblyAI Universal-Streaming](https://www.assemblyai.com/universal-streaming) — $0.15/hr, session-duration billing, voice-agent optimized
- [AssemblyAI Pricing](https://www.assemblyai.com/pricing) — Plan details and per-hour rates
- [AssemblyAI 99 Languages](https://www.assemblyai.com/blog/99-languages) — Universal-2 multilingual expansion
- [Deepgram Endpointing Docs](https://developers.deepgram.com/docs/endpointing) — speech_final, endpointing ms config
- [Deepgram Interim Results](https://developers.deepgram.com/docs/interim-results) — is_final vs interim streaming
- [Deepgram UtteranceEnd](https://developers.deepgram.com/docs/utterance-end) — Word-gap endpoint, min 1000ms
- [Deepgram SpeechStarted](https://developers.deepgram.com/docs/speech-started) — VAD onset detection event
- [Deepgram Live Streaming Audio](https://developers.deepgram.com/docs/live-streaming-audio) — WebSocket API flow
- [Deepgram End-of-Speech Detection](https://developers.deepgram.com/docs/understanding-end-of-speech-detection) — speech_final + UtteranceEnd patterns
- [Deepgram Measuring Streaming Latency](https://developers.deepgram.com/docs/measuring-streaming-latency) — 80ms min, 674ms avg measured
- [Deepgram Audio KeepAlive](https://developers.deepgram.com/docs/audio-keep-alive) — Idle WS free, keepalive pattern
- [Deepgram JS SDK GitHub](https://github.com/deepgram/deepgram-js-sdk) — v5, TypeScript, LiveTranscriptionEvents
- [Bun + Deepgram SDK Issue](https://github.com/orgs/deepgram/discussions/740) — Binary frames broken under Bun WS
- [Deepgram Multilingual Code-Switching](https://developers.deepgram.com/docs/multilingual-code-switching) — language=multi, per-word tags
- [Whisper vs Deepgram (Modal)](https://modal.com/blog/whisper-vs-deepgram) — Independent WER comparison
- [whisper.cpp Server (DeepWiki)](https://deepwiki.com/ggml-org/whisper.cpp/3.2-http-server) — HTTP API, OpenAI-compatible
- [whisper.cpp Quantization (DeepWiki)](https://deepwiki.com/ggml-org/whisper.cpp/5.2-quantization) — Q5_0/Q4_0 sizes and speedups
- [Whisper on RPi5 (Tkachenko, Medium)](https://gektor650.medium.com/audio-transcription-with-openai-whisper-on-raspberry-pi-5-3054c5f75b95) — Model size benchmarks
- [Whisper on RPi5 (GoTranscript)](https://gotranscript.com/public/enhance-raspberry-pi-5-with-whisper-for-live-transcription) — Live transcription setup
- [Edge STT Evaluation (ACM/IEEE 2025)](https://dl.acm.org/doi/10.1145/3769102.3774244) — Whisper models on RPi, thermal analysis
- [faster-whisper GitHub](https://github.com/SYSTRAN/faster-whisper) — CTranslate2, 4x faster, ARM64 OpenBLAS
- [faster-whisper PyPI](https://pypi.org/project/faster-whisper/) — Python package, int8 quantization

## VAD Libraries

- [avr-vad npm](https://github.com/agentvoiceresponse/avr-vad) — Silero v5 ONNX, Node.js, SPEECH_START/END events
- [Silero VAD GitHub](https://github.com/snakers4/silero-vad) — v5, 2MB ONNX, 189µs/chunk
- [ricky0123/vad GitHub](https://github.com/ricky0123/vad) — Browser Silero VAD; vad-node deprecated Oct 2024
- [node-vad GitHub](https://github.com/Snirpo/node-vad) — WebRTC VAD Node bindings, unmaintained
- [LiveKit Turn Detection](https://livekit.com/blog/turn-detection-voice-agents-vad-endpointing-model-based-detection) — VAD vs STT vs model-based endpointing
- [AssemblyAI Turn Detection](https://www.assemblyai.com/blog/turn-detection-endpointing-voice-agent) — Semantic endpointing, 160ms min silence
- [Picovoice VAD Benchmark](https://picovoice.ai/blog/best-voice-activity-detection-vad/) — CPU comparison across platforms
- [whisper.cpp Silero VAD Model (HF)](https://huggingface.co/ggml-org/whisper-vad) — GGML format for whisper.cpp --vad flag

## LLM (OpenRouter)

- [OpenRouter Pricing Page](https://openrouter.ai/pricing) — 300+ models, full pricing table
- [OpenRouter Claude Opus 4.6](https://openrouter.ai/anthropic/claude-opus-4.6) — $5/$25 per 1M tokens, 1M context
- [OpenRouter Streaming Docs](https://openrouter.ai/docs/api/reference/streaming) — SSE streaming setup, keep-alive comments
- [OpenRouter Tool Calling Docs](https://openrouter.ai/docs/guides/features/tool-calling) — Standardized tool calling, parallel_tool_calls
- [OpenRouter TypeScript SDK Streaming](https://openrouter.ai/docs/sdks/typescript/call-model/streaming) — getTextStream, getToolCallsStream
- [OpenRouter API Reference](https://openrouter.ai/docs/api/reference/overview) — OpenAI-compatible API
- [AI API Pricing Comparison 2026 (LemonData)](https://lemondata.cc/en/blog/pricing-comparison) — GPT-4.1, Claude Sonnet 4.6, Gemini 2.5 costs

## TTS Providers

- [Fish Audio Pricing](https://fish.audio/plan/) — Free 8k credits, Plus $11/mo, Pro $75/mo
- [Fish Audio Developer Pricing](https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits) — $15/M UTF-8 bytes, rate limits
- [Fish Audio Voice Cloning](https://fish.audio/blog/best-text-to-speech-api-voice-cloning/) — 10s reference audio, same endpoint
- [Cartesia Pricing](https://cartesia.ai/pricing) — Free 10k, Pro $5/100k, Startup $49/1.25M credits
- [Cartesia Sonic 3](https://cartesia.ai/sonic) — 40ms TTFA (Turbo), WS streaming, emotion control
- [Cartesia Sonic 3 Pricing (eesel)](https://www.eesel.ai/blog/cartesia-sonic-3-pricing) — 1 credit/char, 1.5 for Pro Voice Cloning
- [ElevenLabs Pricing](https://elevenlabs.io/pricing) — Free/Starter $5/Creator $22/Pro $99
- [Kokoro-82M on RPi (mikeesto)](https://mikeesto.com/posts/kokoro-82m-pi/) — ~80MB ONNX, below real-time on Pi4
- [Kokoro Local TTS (ariya.io)](https://ariya.io/2026/03/local-cpu-friendly-high-quality-tts-text-to-speech-with-kokoro) — CPU inference, multi-language
- [Kokoro-FastAPI GitHub](https://github.com/remsky/Kokoro-FastAPI) — Docker ARM/multi-arch, REST API wrapper

## Wake Word / Audio

- [Porcupine Wake Word SDK](https://picovoice.ai/docs/porcupine/) — v4.0.2, multi-platform, on-device
- [Porcupine Platform](https://picovoice.ai/platform/porcupine/) — Pricing tiers, custom wake word
- [Picovoice/porcupine GitHub](https://github.com/Picovoice/porcupine) — Source, benchmarks
- [@picovoice/porcupine-web npm](https://www.npmjs.com/package/@picovoice/porcupine-web) — WASM SDK
- [Wake Word Detection Guide 2026 (Picovoice)](https://picovoice.ai/blog/complete-guide-to-wake-word/) — Landscape overview, alternatives
- [dscripka/openWakeWord GitHub](https://github.com/dscripka/openWakeWord) — Open-source, custom training, HA integration
- [Custom Wake Word Tutorial (Picovoice)](https://picovoice.ai/blog/console-tutorial-custom-wake-word/) — Type-to-train via Console
- [AudioRecord API (Android)](https://developer.android.com/reference/android/media/AudioRecord) — Internal ring buffer API
- [TPCircularBuffer (A Tasty Pixel)](https://atastypixel.com/a-simple-fast-circular-buffer-implementation-for-audio-processing/) — Classic C circular buffer for iOS audio
- [TPCircularBuffer GitHub](https://github.com/michaeltyson/TPCircularBuffer) — VM-mapped lock-free ring buffer for iOS audio
- [Picovoice Free Tier](https://picovoice.ai/blog/introducing-picovoices-free-tier/) — Up to 3 active users/month free
- [Picovoice Wake Word Benchmark](https://github.com/Picovoice/wake-word-benchmark) — Comparison vs competitors
- [Porcupine FAQ](https://picovoice.ai/docs/faq/porcupine/) — Custom word accuracy, supported platforms
- [Snowboy (archived)](https://github.com/Kitt-AI/snowboy) — Shut down Dec 2020, fork at seasalt-ai/snowboy
- [Android FGS Types (Android 14)](https://developer.android.com/about/versions/14/changes/fgs-types-required) — foregroundServiceType requirements
- [Android FGS Guide (Lanisnik)](https://medium.com/@domen.lanisnik/guide-to-foreground-services-on-android-9d0127dc8f9a) — Microphone foreground service setup
- [Picovoice Voice UI on Mobile](https://picovoice.ai/blog/voice-ui-on-mobile-challenges-and-opportunities/) — Power/battery considerations

## Audio Codecs

- [Opus Codec](https://opus-codec.org/) — Official site; 6-510 kbit/s, royalty-free; v1.6 Dec 2025 with ML bandwidth extension
- [Opus Codec Explained (Wowza)](https://www.wowza.com/blog/opus-codec-the-audio-format-explained) — SILK/CELT modes, 26.5ms default delay
- [Best Audio Codec for Streaming 2026 (Ant Media)](https://antmedia.io/best-audio-codec/) — Opus recommended for WebRTC/ultra-low latency
- [Opus in Voice AI (Telnyx)](https://telnyx.com/resources/voice-ai-hd-codecs) — AI engines need wideband; Opus preserves quality
- [Cloudflare Realtime Voice AI](https://blog.cloudflare.com/cloudflare-realtime-voice-ai/) — WebRTC Opus→SFU→PCM relay pattern
- [WebSocket vs WebRTC Audio Pipeline](https://dev.to/nick_lackman/i-tested-our-websocket-audio-pipeline-with-webrtc-heres-why-i-switched-it-back-3g1j) — Real-world comparison, WS simpler for relay
- [opus-recorder GitHub](https://github.com/chris-rudmin/opus-recorder) — v8.0.5, **unmaintained**, recommends WebCodecs API
- [opus-encdec GitHub](https://github.com/mmig/opus-encdec) — Active fork, JS+WASM Ogg Opus encode/decode
- [opus-decoder npm](https://www.npmjs.com/package/opus-decoder) — v0.7.11, WASM streaming decoder
- [WebCodecs API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API) — Browser-native codec access, replacing WASM shims
- [MediaStream Recording API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/MediaStream_Recording_API/Using_the_MediaStream_Recording_API) — getUserMedia + MediaRecorder for browser capture

## Security

- [paseto-ts npm](https://www.npmjs.com/package/paseto-ts) — v2.0.5, pure TS, PASETO v4 encrypt/decrypt/sign/verify
- [auth70/paseto-ts GitHub](https://github.com/auth70/paseto-ts) — 100% test coverage, PASETO implementation guide
- [panva/paseto GitHub](https://github.com/panva/paseto) — **Archived**; may revive for v5/v6
- [@opliko/paseto JSR](https://jsr.io/@opliko/paseto/doc/v4) — Multi-runtime PASETO v4 (Workers, Bun, Deno)
- [OWASP LLM Prompt Injection Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) — Canonical defense checklist
- [OWASP LLM01:2025 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) — #1 in LLM Top 10 2025
- [tldrsec/prompt-injection-defenses GitHub](https://github.com/tldrsec/prompt-injection-defenses) — Comprehensive catalog of defenses
- [protectai/rebuff GitHub](https://github.com/protectai/rebuff) — Multi-layer injection detector with canary tokens
- [deadbits/vigil-llm GitHub](https://github.com/deadbits/vigil-llm) — YARA + transformer + vector DB scanners
- [DefensiveTokens Paper (OpenReview)](https://openreview.net/pdf?id=VAJQ8UblUo) — 0.24% attack success rate on 31K+ samples
- [protectai/rebuff — Archived](https://github.com/protectai/rebuff) — **Archived May 2025**; 4-layer defense (heuristic + LLM + vector DB + canary), TS SDK existed
- [Spotlighting Technique (tldrsec catalog)](https://github.com/tldrsec/prompt-injection-defenses) — Input transformation to signal provenance, reduces injection success from >50% to <2%
- [PASETO v4 XChaCha20-Poly1305 Performance](https://github.com/auth70/paseto-ts) — Pure software impl, no AES-NI needed, fast on ARM64

## WebSocket Libraries

- [ws npm](https://www.npmjs.com/package/ws) — v8.20.0, Autobahn compliance, permessage-deflate
- [websockets/ws GitHub](https://github.com/websockets/ws) — De facto Node.js WS standard
- [Bun WebSockets Docs](https://bun.com/docs/runtime/http/websockets) — Built-in, zero-dep, pub/sub, compression
- [uWebSockets.js GitHub](https://github.com/uNetworking/uWebSockets.js/) — C++ core, ~10x Socket.IO performance
- [sockjs/websocket-multiplex GitHub](https://github.com/sockjs/websocket-multiplex) — Thin multiplexing layer over WS

## Classifier & Tool Routing

- [ReAct Paper (arXiv)](https://arxiv.org/abs/2210.03629) — Original interleaved thought-action-observation traces
- [ReAct Prompting Guide](https://www.promptingguide.ai/techniques/react) — Practical prompt templates
- [What is a ReAct Agent? (IBM)](https://www.ibm.com/think/topics/react-agent) — Clear explainer of thought/action/observation loop
- [Hybrid LLM + Intent Classification (Medium)](https://medium.com/data-science-collective/intent-driven-natural-language-interface-a-hybrid-llm-intent-classification-approach-e1d96ad6f35d) — Regex-first fast path + LLM fallback architecture
- [Intent Classification 2026 (Label Your Data)](https://labelyourdata.com/articles/machine-learning/intent-classification) — All four approaches: rule-based, ML, transformer, LLM
- [98x Faster LLM Routing (arXiv)](https://arxiv.org/pdf/2603.12646) — Compress prompts to ~512 tokens, ~19ms classifier latency
- [vLLM Semantic Router (Red Hat)](https://www.redhat.com/en/blog/bringing-intelligent-efficient-routing-open-source-ai-vllm-semantic-router) — ModernBERT for routing, 47% latency reduction
- [LLM Structured Output Guide (Agenta)](https://agenta.ai/blog/the-guide-to-structured-outputs-and-function-calling-with-llms) — Zod for TS, constrained decoding, JSON Schema
- [Function Calling (OpenAI)](https://platform.openai.com/docs/guides/function-calling) — Tools via JSON Schema, strict mode
- [Function Calling Architecture (Martin Fowler)](https://martinfowler.com/articles/function-call-LLM.html) — Declaration, dispatch loop, error handling patterns; explicit routing (not dynamic invocation) for security; guardrail denylist patterns
- [OpenRouter Haiku 4.5 Pricing](https://openrouter.ai/anthropic/claude-haiku-4-5-20251001) — $0.80/$4.00 per 1M tokens — cheapest fast model for classification
- [OpenRouter Sonnet 4.6 Pricing](https://openrouter.ai/anthropic/claude-sonnet-4-6) — $3/$15 per 1M tokens — tool-capable model for ReAct loop

## Skill System Patterns

- [Claude Code Skills Docs](https://code.claude.com/docs/en/common-workflows) — SKILL.md with YAML frontmatter, auto-discovered
- [Agent Skills (Anthropic)](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) — Allowed-tools restrictions, distribution models
- [Claude Code Skills Guide (fp8.co)](https://fp8.co/articles/Claude-Code-Skills-Complete-Developer-Guide) — SKILL.md structure walkthrough
- [HA Conversation Integration](https://www.home-assistant.io/integrations/conversation/) — Intent recognition from text, MCP integration
- [HA Template Sentence Syntax](https://developers.home-assistant.io/docs/voice/intent-recognition/template-sentence-syntax/) — YAML intent definitions with slots/lists
- [HA Custom Sentences](https://www.home-assistant.io/voice_control/custom_sentences_yaml/) — Custom intents via YAML in config dir
- [OHF-Voice/intents GitHub](https://github.com/home-assistant/intents) — Canonical HA intent patterns source
- [OpenWorkflow GitHub](https://github.com/openworkflowdev/openworkflow) — TS durable workflow framework, Node+Bun
- [ts-edge GitHub](https://github.com/cgoinglove/ts-edge) — Lightweight type-safe TS workflow engine
- [chokidar GitHub](https://github.com/paulmillr/chokidar) — v5 ESM-only, Node 20+; most popular file watcher
- [Bun Watch/Hot Docs](https://bun.sh/docs/runtime/hot) — Built-in --hot and --watch flags
- [Skill Authoring Best Practices (Anthropic)](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) — Description-driven triggers, reference files, 500-line limit
- [SKILL.md Pattern (Bibek Poudel)](https://bibek-poudel.medium.com/the-skill-md-pattern-how-to-write-ai-agent-skills-that-actually-work-72a3169dd7ee) — Two-part description formula, frontmatter constraints
- [Deep Dive SKILL.md (A B Vijay Kumar)](https://abvijaykumar.medium.com/deep-dive-skill-md-part-1-2-09fc9a536996) — Detailed structure walkthrough
- [Claude Code Skills Architecture (MindStudio)](https://www.mindstudio.ai/blog/claude-code-skills-architecture-skill-md-reference-files) — Architecture overview, reference file patterns
- [Skill Collaboration Pattern (MindStudio)](https://www.mindstudio.ai/blog/claude-code-skill-collaboration-pattern) — Multi-skill orchestration
- [EmDash Plugin Sandboxing (LushBinary)](https://lushbinary.com/blog/emdash-plugin-development-typescript-capabilities-security-2026/) — V8 isolate sandboxing, capability manifests

## Persona & Memory

- [Markdown Memory Paradigm (Substack)](https://micheallanham.substack.com/p/the-markdown-memory-paradigm-in-ai) — File-based beats vector DBs for single-user agents
- [AI Agent Memory with Markdown (DEV)](https://dev.to/imaginex/ai-agent-memory-management-when-markdown-files-are-all-you-need-5ekk) — Manus three-file pattern (task_plan, notes, output)
- [memsearch GitHub (Zilliz)](https://github.com/zilliztech/memsearch) — Markdown-first memory library, MEMORY.md pattern
- [Agent Builder Memory (LangChain)](https://blog.langchain.com/how-we-built-agent-builders-memory-system/) — MD/JSON files in Postgres as filesystem
- [File vs DB for Agent Memory (Oracle)](https://blogs.oracle.com/developers/comparing-file-systems-and-databases-for-effective-ai-agent-memory-management) — File-based great for single-user, DB for multi-user
- [LLM Context Problem 2026 (LogRocket)](https://blog.logrocket.com/llm-context-problem/) — Token budgeting, rolling windows, summarization
- [Memory Blocks (Letta)](https://www.letta.com/blog/memory-blocks) — Persona blocks with char limits, tiered memory
- [Mem0 Research](https://mem0.ai/research) — Extraction cuts tokens 80-90%, 26% quality improvement
- [Mem0 Summarization Guide](https://mem0.ai/blog/llm-chat-history-summarization-guide-2025) — Progressive summarization patterns
- [js-tiktoken npm](https://www.npmjs.com/package/js-tiktoken) — Pure JS tiktoken port, edge-runtime compatible
- [tiktoken npm](https://www.npmjs.com/package/tiktoken) — WASM bindings for OpenAI BPE tokenizer
- [Claude Code Memory Docs](https://code.claude.com/docs/en/memory) — File-based MEMORY.md index + individual files with YAML frontmatter
- [Claude API Memory Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) — CRUD commands for file-based memory (view/create/str_replace/delete)
- [Mem0 Custom Update Prompt](https://docs.mem0.ai/open-source/features/custom-update-memory-prompt) — ADD/UPDATE/DELETE/NONE reconciliation pattern
- [Mem0 Paper (arXiv)](https://arxiv.org/html/2504.19413v1) — Two-phase extraction + reconciliation architecture
- [MemGPT Research](https://research.memgpt.ai/) — Virtual context management, memory paging between tiers
- [Context Length Management (Agenta)](https://agenta.ai/blog/top-6-techniques-to-manage-context-length-in-llms) — Rolling windows, summarization, token budgeting strategies
- [tiktoken Benchmarks (Saplin)](https://dev.to/maximsaplin/how-fast-is-js-tiktoken-3fmk) — js-tiktoken ~1006ms vs tiktoken WASM ~452ms on 60KB text

## Provider Integration (TypeScript)

- [Deepgram JS SDK v5 GitHub](https://github.com/deepgram/deepgram-js-sdk) — v5.0.0, TypeScript, LiveTranscriptionEvents
- [Deepgram Lower-Level WebSockets](https://developers.deepgram.com/docs/lower-level-websockets) — Raw WS protocol for Bun compatibility
- [Bun + Deepgram SDK Issue](https://github.com/orgs/deepgram/discussions/740) — Binary frames broken under Bun WS
- [Bun WebSocket Binary Frame Issue #3742](https://github.com/oven-sh/bun/issues/3742) — Continuation frame reassembly bug
- [Bun WebSocket Binary Frame Issue #21807](https://github.com/oven-sh/bun/issues/21807) — 564-708 byte payload mishandling
- [Bun WebSocket Blob Crash #26669](https://github.com/oven-sh/bun/issues/26669) — binaryType="blob" causes crashes
- [Bun WebSocket ping() #3202](https://github.com/oven-sh/bun/issues/3202) — ws.ping() not implemented
- [OpenRouter TypeScript SDK Docs](https://openrouter.ai/docs/sdks/typescript) — @openrouter/sdk v0.11.2
- [OpenRouter OpenAI SDK Guide](https://openrouter.ai/docs/guides/community/openai-sdk) — baseURL override pattern (recommended)
- [Fish Audio TypeScript SDK GitHub](https://github.com/fishaudio/fish-audio-typescript) — v0.1.0, fish-audio-sdk npm
- [Fish Audio WebSocket TTS Docs](https://docs.fish.audio/api-reference/endpoint/websocket/tts-live) — MessagePack protocol, Opus output
- [@msgpack/msgpack npm](https://www.npmjs.com/package/@msgpack/msgpack) — Zero-dep MessagePack encode/decode
- [cockatiel npm](https://www.npmjs.com/package/cockatiel) — v3.2.1, zero-dep circuit breaker/retry/timeout
- [cockatiel GitHub](https://github.com/connor4312/cockatiel) — Pure TS, inspired by .NET Polly
- [opossum GitHub](https://github.com/nodeshift/opossum) — v8.1.3, Node-oriented circuit breaker (not recommended for Bun)
- [yaml npm](https://www.npmjs.com/package/yaml) — v2.8.1, zero-dep, YAML 1.2, built-in TS types
- [Bun SSE Guide](https://bun.com/docs/guides/http/sse) — Server-Sent Events consumption/production
- [Bun v1.2.18 Blog](https://bun.com/blog/bun-v1.2.18) — permessage-deflate, ReadableStream improvements
- [Bun ReadableStream Batching #13923](https://github.com/oven-sh/bun/discussions/13923) — Chunk batching in Response body

## Client Development

### Android
- [WebSocket in Compose with OkHttp (Medium)](https://medium.com/@danimahardhika/handle-websocket-in-jetpack-compose-with-okhttp-and-sharedflow-b1ed7c9fd713) — ViewModel + Repository + WS Service with SharedFlow
- [Ktor + Compose WebSocket (Medium)](https://medium.com/@YodgorbekKomilo/real-time-communication-in-android-how-websocket-works-with-jetpack-compose-kotlin-flow-and-939fc282f907) — Ktor WS + Kotlin Flow + Compose

### iOS
- [Starscream GitHub](https://github.com/daltoniam/Starscream) — RFC 6455, compression, SPM, 90+ contributors
- [Swift WebSockets: Starscream vs URLSession (GetStream)](https://getstream.io/blog/swift-websockets-starscream-urlsession/) — Comparison, URLSession reliability concerns

### iOS — Deep Dive
- [AVAudioEngine (Apple Docs)](https://developer.apple.com/documentation/avfaudio/avaudioengine) — Input tap, format conversion, real-time audio
- [installTap(onBus:bufferSize:format:)](https://developer.apple.com/documentation/avfaudio/avaudionode/1387122-installtap) — Input node tap for audio capture
- [AVAudioSession Category (Apple Docs)](https://developer.apple.com/documentation/avfaudio/avaudiosession/category) — playAndRecord, voiceChat mode
- [AVAudioSession Interruption Handling](https://developer.apple.com/documentation/avfaudio/avaudiosession/1616596-interruptionnotification) — Phone calls, Siri interrupts
- [AVAudioSession Route Change](https://developer.apple.com/documentation/avfaudio/avaudiosession/1616493-routechangenotification) — Bluetooth, headphone events
- [AVAudioPlayerNode (Apple Docs)](https://developer.apple.com/documentation/avfaudio/avaudioplayernode) — Schedule buffer playback for TTS streaming
- [TPCircularBuffer GitHub](https://github.com/michaeltyson/TPCircularBuffer) — VM-mapped lock-free SPSC ring buffer for iOS audio
- [URLSessionWebSocketTask (Apple Docs)](https://developer.apple.com/documentation/foundation/urlsessionwebsockettask) — Built-in WebSocket, async/await (iOS 15+)
- [NWPathMonitor (Apple Docs)](https://developer.apple.com/documentation/network/nwpathmonitor) — Network change detection, WiFi/cellular transport
- [Porcupine iOS Quick Start](https://picovoice.ai/docs/quick-start/porcupine-ios/) — SPM integration, AVAudioEngine setup
- [iOS Background Modes (Apple Docs)](https://developer.apple.com/documentation/bundleresources/information_property_list/uibackgroundmodes) — audio mode for playback/VoIP, not passive listening
- [Guided Access (Apple Docs)](https://support.apple.com/guide/iphone/use-guided-access-iph7f453d2bf/ios) — Lock device to single app
- [TestFlight Internal Testing (Apple Docs)](https://developer.apple.com/testflight/) — 25 internal testers, no beta review, 90-day builds
- [@Observable Macro (Apple Docs)](https://developer.apple.com/documentation/observation/observable()) — iOS 17+, replaces ObservableObject
- [Swift Concurrency: Actors](https://docs.swift.org/swift-book/documentation/the-swift-programming-language/concurrency/#Actors) — Thread-safe state management
- [libopus (xiph.org)](https://opus-codec.org/downloads/) — C source for Swift interop, no bridging header needed with SPM

### Web
- [React vs Preact vs Solid.js 2026 (Index.dev)](https://www.index.dev/skill-vs-skill/frontend-react-vs-preact-vs-solidjs) — Bundle sizes, perf benchmarks
- [JS Framework Size Comparison GitHub](https://github.com/MarioVieilledent/js-framework-comparison) — Preact 13.7KB, Solid 10KB, Svelte 6.7KB, Vanilla 1.1KB
- [Preact vs React 2026 (AlphaBold)](https://www.alphabold.com/preact-vs-react/) — 3KB gzipped core, 10x smaller than React
- [Best React Alternatives 2026 (Unanswered.io)](https://unanswered.io/guide/best-alternatives-to-react) — Preact, Solid, Svelte comparison
- [State of Solid.js 2026 (Listiak)](https://listiak.dev/blog/the-state-of-solid-js-in-2026-signals-performance-and-growing-influence) — Signals, performance, ecosystem growth
- [Lit.js Web Components (Perficient)](https://blogs.perficient.com/2025/05/05/lit-js-building-fast-lightweight-and-scalable-web-components/) — 5KB, Shadow DOM, TS decorators
- [HTMX vs React Bundle Size (Strapi)](https://strapi.io/blog/htmx-lightweight-alternative-javascript-frameworks) — HTMX 14KB, framework comparison
- [opus-media-recorder GitHub](https://github.com/kbumsik/opus-media-recorder) — WASM MediaRecorder polyfill for Safari Opus support
- [WebCodecs API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API) — Native browser audio encode/decode
- [W3C Opus WebCodecs Registration](https://www.w3.org/TR/webcodecs-opus-codec-registration/) — May 2025 spec for Opus in WebCodecs
- [web-audio-buffer-queue GitHub](https://github.com/Johni0702/web-audio-buffer-queue) — AudioWorklet ring buffer for streaming playback
- [Preact Vite Preset](https://github.com/preactjs/preset-vite) — @preact/preset-vite for Vite integration

### Android — Deep Dive
- [AudioRecord API (Android)](https://developer.android.com/reference/android/media/AudioRecord) — Internal ring buffer, getMinBufferSize()
- [Android CDD Audio Signal Processing](https://source.android.com/docs/compatibility/android-cdd#5114_audio_signal_processing) — VOICE_RECOGNITION flat frequency response requirement
- [THREAD_PRIORITY_URGENT_AUDIO](https://developer.android.com/reference/android/os/Process#THREAD_PRIORITY_URGENT_AUDIO) — CFS priority for audio threads
- [Android 14 FGS Types Required](https://developer.android.com/about/versions/14/changes/fgs-types-required) — foregroundServiceType="microphone" manifest + runtime
- [Android 12 FGS Background Start Restrictions](https://developer.android.com/about/versions/12/foreground-services) — Cannot start from background without user interaction
- [Android 15 FGS Changes](https://developer.android.com/about/versions/15/behavior-changes-15#foreground-service-types) — dataSync time limits, microphone type unaffected
- [Android Foreground Service Guide](https://developer.android.com/guide/components/foreground-services#microphone) — Microphone type setup
- [Android Mic/Camera Indicators (12+)](https://developer.android.com/about/versions/12/behavior-changes-all#mic-camera-indicators) — Green dot, status bar chip
- [Don't Kill My App](https://dontkillmyapp.com/) — OEM-specific battery management that kills foreground services
- [Android Doze/Standby Exemptions](https://developer.android.com/training/monitoring-device-state/doze-standby#exemptions) — Wake lock needed, REQUEST_IGNORE_BATTERY_OPTIMIZATIONS not recommended
- [Android Power Details](https://developer.android.com/topic/performance/power/power-details) — Battery optimization best practices
- [OkHttp WebSocket](https://square.github.io/okhttp/features/websocket/) — Binary frames via ByteString
- [Ktor WebSocket Client](https://ktor.io/docs/client-websockets.html) — Native coroutine WS, Frame.Binary
- [Concentus Java (Opus)](https://github.com/lostromb/concentus.java) — Pure Java Opus encoder/decoder, no JNI
- [opus-android JNI](https://github.com/AoEiuV020/opus-android) — libopus JNI wrapper, prebuilt for arm64-v8a
- [Compose LazyColumn Keys](https://developer.android.com/develop/ui/compose/lists#item-keys) — Stable keys for efficient diffing
- [Compose Animation](https://developer.android.com/develop/ui/compose/animation/value-based) — rememberInfiniteTransition, animateFloatAsState
- [Material 3 Bottom Sheets](https://developer.android.com/develop/ui/compose/components/bottom-sheets) — ModalBottomSheet for tool confirmation
- [collectAsStateWithLifecycle](https://developer.android.com/reference/kotlin/androidx/lifecycle/compose/package-summary#collectAsStateWithLifecycle) — Lifecycle-aware StateFlow collection
- [Android ConnectivityManager](https://developer.android.com/training/monitoring-device-state/connectivity-status-type) — NetworkCallback for transport change detection
- [AWS Exponential Backoff & Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) — Full jitter recommended pattern
- [Discord Gateway Resume](https://discord.com/developers/docs/events/gateway#resuming) — Reference architecture for WebSocket session resumption

### Opus on Platforms
- [AudioEncoder configure() (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/AudioEncoder/configure) — WebCodecs API Opus encoder config
- [Opus 1.6 Release](https://opus-codec.org/) — Dec 2025, ML bandwidth extension, 96kHz Opus HD
