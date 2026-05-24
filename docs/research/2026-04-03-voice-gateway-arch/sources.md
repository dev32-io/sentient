# Sources & Bibliography

*Running bibliography of references consulted during architecture exploration.*

## Prior Research
- `/Users/kevinye/offline-research/2026-04-02-voice-gateway/` — Extensive prior research covering STT providers, OpenRouter streaming, TTS preprocessing, cloud TTS providers, self-hosted TTS, audio delivery, and gateway architecture

---

## Pipeline Architecture

### Frameworks & Patterns
- [Pipecat Documentation — Pipeline & Frame Processing](https://docs.pipecat.ai/guides/learn/pipeline) — Frame-based architecture with SystemFrames/DataFrames/ControlFrames, priority queuing, async processors
- [Pipecat GitHub](https://github.com/pipecat-ai/pipecat) — Open-source Python framework for voice/multimodal AI; design influence for custom pipeline
- [Mastering Python Async Patterns 2026 (DEV)](https://dev.to/shehzan/mastering-python-async-patterns-a-complete-guide-to-asyncio-in-2026-10o6) — Worker pool, queue chaining, backpressure patterns
- [Audio Streaming over WebSocket with Asyncio (Medium)](https://medium.com/@python-javascript-php-html-css/python-based-effective-audio-streaming-over-websocket-using-asyncio-and-threading-a926ecf087c4) — Combining asyncio with threading for audio

### Streaming Overlap
- [stream2sentence (GitHub)](https://github.com/KoljaB/stream2sentence) — Sentence boundary detection for LLM→TTS streaming; fragment + full delimiters, word-forcing fallback
- [RealtimeTTS (GitHub)](https://github.com/KoljaB/RealtimeTTS) — Real-time TTS from LLM streams; integrates with stream2sentence
- [vLLM Async Streaming](https://docs.vllm.ai/en/latest/examples/offline_inference/async_llm_streaming/) — Queue-based decoupling for true pipelining
- [Google ADK — Beyond Request-Response](https://developers.googleblog.com/beyond-request-response-architecting-real-time-bidirectional-streaming-multi-agent-system/) — LiveRequestQueue for bidirectional streaming

### Concurrency & Memory
- [Asyncio on Raspberry Pi (Super Fast Python)](https://superfastpython.com/asyncio-raspberry-pi/) — Single-threaded event loop preferred for I/O-bound on RPi
- [Python Concurrency Showdown 2026 (Medium)](https://medium.com/@sizanmahmud08/python-concurrency-showdown-asyncio-vs-threading-vs-multiprocessing-which-should-you-choose-in-31205161899a) — Asyncio ~23MB baseline; per-coroutine overhead negligible
- [websockets Memory and Buffers (v16.0)](https://websockets.readthedocs.io/en/stable/topics/memory.html) — 64 KiB per connection default; reducible to 14 KiB; queue buffer sizing critical
- [Python Retell AI 2025 — Production Voice Agents](https://johal.in/python-retell-ai-voice-agents-low-latency-production-2025/) — Baseline ~50-80 MB Python voice agent; expect 150-300 MB with concurrent users on RPi5

### Cancellation / Barge-In
- [Python asyncio-task Documentation](https://docs.python.org/3/library/asyncio-task.html) — CancelledError propagation, TaskGroup semantics
- [PEP 789 — Preventing Task-Cancellation Bugs](https://peps.python.org/pep-0789/) — Structured concurrency for safer cancellation
- [AnyIO Cancellation](https://anyio.readthedocs.io/en/stable/cancellation.html) — Cancel scopes with tree-like propagation
- [LiveKit Agents Issue #3702](https://github.com/livekit/agents/issues/3702) — Tool call results lost on barge-in; need durable state tracking

---

## Client-Gateway Protocol

### Transport Patterns
- [Home Assistant WebSocket API](https://developers.home-assistant.io/docs/api/websocket/) — Primary protocol for real-time voice; stateful bidirectional
- [OVOS Technical Manual](https://openvoiceos.github.io/ovos-technical-manual/) — Message bus via WebSockets; JSON messages
- [Rhasspy Documentation](https://rhasspy.readthedocs.io/) — Hybrid: MQTT (Hermes) + HTTP API + WebSocket events
- [Deepgram WebSocket vs REST TTS](https://deepgram.com/learn/websocket-vs-rest-text-to-speech) — WebSocket saves 50-100ms per request; better for streaming
- [AG2 RealtimeAgent over WebSocket](https://docs.ag2.ai/0.8.7/docs/blog/2025/01/08/RealtimeAgent-over-websocket/) — WebSocket preferred for low-latency turn-taking

### Audio Codec (Opus)
- [Opus Codec Official](https://opus-codec.org/) — 6-510 kbps; voice optimal at 12-20 kbps; VoIP standard
- [RFC 6716 — Opus Definition](https://tools.ietf.org/html/rfc6716) — Official specification
- [MDN WebRTC Codecs Guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/WebRTC_codecs) — All modern browsers must support Opus
- [opus-media-recorder (npm)](https://www.npmjs.com/package/opus-media-recorder) — WebAssembly polyfill for cross-browser Opus recording

### Python WebSocket Servers
- [FastAPI WebSockets](https://fastapi.tiangolo.com/advanced/websockets/) — High-level, rapid prototyping, Uvicorn ASGI
- [aiohttp WebSockets (APIdog)](https://apidog.com/blog/aiohttp-and-websockets/) — Lower-level, more control, built on asyncio
- [websockets Library (Super Fast Python)](https://superfastpython.com/asyncio-websocket-clients/) — Pure WebSocket toolkit, correctness-focused

### Message Framing
- [RFC 6455 — WebSocket Protocol](https://www.rfc-editor.org/rfc/rfc6455) — Text frames (UTF-8), binary frames (raw bytes), control frames
- [OneUptime — Handle Binary Messages](https://oneuptime.com/blog/post/2026-01-24-websocket-binary-messages/view) — JSON control first, then binary audio; explicit frame type headers

### Reconnection
- [WebSocket.org Reconnection Guide](https://websocket.org/guides/reconnection/) — Session ID separation; exponential backoff 500ms→30s with jitter
- [Ably WebSocket Best Practices](https://ably.com/topic/websocket-architecture-best-practices) — Separate connection identity from session identity

---

## Tool Routing

### Classifier-First Patterns
- [RouteLLM — Intelligent Routing (Swfte AI)](https://www.swfte.com/blog/intelligent-llm-routing-multi-model-ai) — ML classifier for routing; 85% cost reduction, 95% quality
- [LangChain Router Pattern](https://docs.langchain.com/oss/python/langchain/multi-agent/router-knowledge-base) — Smaller LLM routes to specialized agents
- [LlamaIndex Orchestrator](https://developers.llamaindex.ai/python/framework/understanding/agent/multi_agent/) — Orchestrator agent chooses sub-agents as tools
- [LlamaIndex Router Modules](https://docs.llamaindex.ai/en/stable/module_guides/querying/router/) — Query + choices → LLM selects data source/strategy
- [Semantic Kernel Contextual Function Selection](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-contextual-function-selection) — Embeddings match conversation context to tool descriptions

### Cheap/Fast Models for Classification
- [Gemini 3.1 Flash-Lite](https://skywork.ai/blog/claude-haiku-4-5-vs-gpt4o-mini-vs-gemini-flash-vs-mistral-small-vs-llama-comparison/) — $0.25/$1.50 per MTok; fastest Gemini
- [DeepSeek V3](https://intuitionlabs.ai/articles/low-cost-llm-comparison) — $0.14/$0.28 per 1M tokens; cheapest option
- [Mistral Small 3.2-24B (OpenRouter)](https://openrouter.ai/mistralai/mistral-small-2603) — $0.10/$0.30 per 1M tokens; 128K context
- [OpenRouter Latency Guide](https://openrouter.ai/docs/guides/best-practices/latency-and-performance) — ~25ms overhead ideal, ~40ms typical

### Agent Loop Patterns
- [ReAct vs Plan-and-Execute (DEV)](https://dev.to/jamesli/react-vs-plan-and-execute-a-practical-comparison-of-llm-agent-patterns-4gh9) — ReAct: adaptive, exploratory; P&E: predictable, efficient
- [AI Agent Planning: ReAct vs P&E for Reliability](https://byaiteam.com/blog/2025/12/09/ai-agent-planning-react-vs-plan-and-execute-for-reliability/) — P&E preferred for home automation/calendar; ReAct for web search
- [Agentic Reasoning Patterns (ServicesGround)](https://servicesground.com/blog/agentic-reasoning-patterns/) — Hybrid: high-level planner + ReAct executor

### Tool Registration
- [LangChain @tool decorator](https://docs.langchain.com/oss/python/langchain/tools) — Docstring → description, type hints → schema
- [Pydantic AI @agent.tool](https://ai.pydantic.dev/tools/) — Auto JSON schema from type hints; Pydantic validates args
- [FastMCP @mcp.tool](https://gofastmcp.com/servers/tools) — Function name/docstring as tool name/description
- [ToolRegistry — Protocol-Agnostic Management](https://arxiv.org/html/2507.10593v1) — Unified interface for diverse tool sources

### OpenRouter Function Calling
- [OpenRouter Tool Calling Guide](https://openrouter.ai/docs/guides/features/tool-calling) — Standardized interface; filter models by `supported_parameters=tools`
- [OpenRouter Tool Calling Models Collection](https://openrouter.ai/collections/tool-calling-models) — Gemini 2.5 Flash, Claude Opus 4.6, Qwen3-Max, Grok 4.1 Fast
- [Response Healing (OpenRouter)](https://openrouter.ai/announcements/response-healing-reduce-json-defects-by-80percent) — Fixes malformed JSON; 97% → 99%+ validity

---

## Security Architecture

### Authentication (PASETO vs JWT)
- [Permify — JWT vs PASETO](https://permify.co/post/jwt-paseto/) — PASETO prevents algorithm confusion; no "none" vulnerability; versioned protocols
- [Okta — Introduction to PASETO](https://developer.okta.com/blog/2019/10/17/a-thorough-introduction-to-paseto) — Foundational guide to PASETO architecture
- [PySETO (PyPI)](https://pypi.org/project/paseto/) — Python library; supports v1-v4; XChaCha20 + BLAKE2b-MAC for local, EdDSA for public
- [PySETO Documentation](https://pyseto.readthedocs.io/) — Official API reference

### Prompt Injection Defense
- [OWASP LLM01:2025 — Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) — #1 on OWASP Top 10 for LLM Apps; layered defense recommended
- [Multi-Agent LLM Defense Pipeline (arXiv)](https://arxiv.org/html/2509.14285v4) — Coordinator + Guard; 100% mitigation on 55 injection attacks
- [Bypassing Prompt Injection Detection (arXiv)](https://arxiv.org/html/2504.11168v1) — Unicode/emoji smuggling bypasses guardrails at 72%+ ASR
- [Lakera Guard Documentation](https://docs.lakera.ai/docs/prompt-defense) — API-based detection; 100+ languages; daily adversarial updates
- [Microsoft Prompt Shields](https://learn.microsoft.com/en-us/azure/ai-services/content-safety/concepts/jailbreak-detection) — Detects user + document attacks; "Spotlighting" for external docs
- [NVIDIA NeMo Guardrails (GitHub)](https://github.com/NVIDIA-NeMo/Guardrails) — Open-source; jailbreak detection, input/output moderation
- [OpenAI — Hardening Atlas Against Prompt Injection](https://openai.com/index/hardening-atlas-against-prompt-injection/) — "May never be fully patched" — defense-in-depth essential

### Tool Impact Tiers / Human-in-the-Loop
- [Permit.io — Human-in-the-Loop for AI Agents](https://www.permit.io/blog/human-in-the-loop-for-ai-agents-best-practices-frameworks-use-cases-and-demo) — Policy-driven approval; authorization-as-a-service
- [Microsoft Magentic-UI (2025)](https://www.microsoft.com/en-us/research/wp-content/uploads/2025/07/magentic-ui-report.pdf) — ActionGuard judge determines approval requirements

### Audit Logging
- [Audit Logs for LLM Pipelines (Newline)](https://www.newline.co/@zaoyang/audit-logs-for-llm-pipelines-key-practices--a08f2c2d) — Structured: user prompts, responses, timestamps, metadata
- [Implement Audit Logging for LLM Interactions (Markaicode)](https://markaicode.com/implement-audit-logging-llm-interactions/) — Three-layered framework; debugging + compliance

### API Key Management
- [Zowe — Secure Credential Storage on Headless Linux](https://docs.zowe.org/stable/user-guide/cli-configure-scs-on-headless-linux-os/) — libsecret backend; requires gnome-keyring or KWallet
- [grawity/secretsd (GitHub)](https://github.com/grawity/secretsd) — Generic org.freedesktop.secrets daemon for headless systems
- [Keyring Documentation](https://keyring.readthedocs.io/) — Python keyring; env var fallback when OS keyring unavailable

### Remote Access
- [RaspberryTips — Tailscale vs WireGuard on RPi](https://raspberrytips.com/tailscale-vs-wireguard-vpn-raspberry-pi/) — Tailscale: mesh P2P, zero-config; WireGuard: full control, native speed
- [Tailscale — WireGuard Comparison](https://tailscale.com/compare/wireguard) — Managed solution with relay fallback
- [Pi DIY Lab — Tailscale on RPi](https://pidiylab.com/tailscale-raspberry-pi-secure-remote-access/) — One-command installation
- [Tailscale Pricing](https://tailscale.com/pricing) — Free: 3 users/100 devices; Personal Plus for 5+ users

### Layered Prompt Injection Defense
- [Microsoft Spotlighting](https://learn.microsoft.com/en-us/azure/ai-services/content-safety/concepts/jailbreak-detection) — Data marking transforms untrusted input to be structurally distinct from instructions
- [Canary Tokens for LLM Security](https://openai.com/index/hardening-atlas-against-prompt-injection/) — Hidden tokens in system prompt detect exfiltration attempts

### API Key Management (Headless Linux)
- [age encryption tool](https://age-encryption.org/) — Modern file encryption; XChaCha20-Poly1305; simple CLI
- [systemd-creds](https://www.freedesktop.org/software/systemd/man/systemd-creds.html) — TPM-bound credential encryption for systemd services
- [structlog documentation](https://www.structlog.org/) — Structured logging for Python; async-friendly via contextvars

---

## Per-User Memory

### Memory Patterns
- [ChatGPT Memory FAQ (OpenAI)](https://help.openai.com/en/articles/8590148-memory-faq) — Dual-mode: saved memories + implicit learning; rolled out to free users June 2025
- [Claude Memory Docs (Anthropic)](https://code.claude.com/docs/en/memory) — File-based Markdown CLAUDE.md; transparent, project-scoped
- [Letta (formerly MemGPT)](https://docs.letta.com/concepts/memgpt/) — OS-inspired memory hierarchies; function-call-based context management
- [Mem0 Platform](https://mem0.ai/) — Hybrid graph+vector+KV store; 66.9% LOCOMO accuracy vs OpenAI's 52.9%
- [Zep Memory Framework](https://www.graphlit.com/blog/survey-of-ai-agent-memory-frameworks) — Temporal knowledge graph; multi-layer episodic/semantic

### Update Strategies
- [ProMem — Proactive Memory (arXiv)](https://arxiv.org/html/2601.04463) — Feedback-loop extraction vs passive summarization; task-aware
- [Agentic Memory (AgeMem, arXiv)](https://arxiv.org/html/2601.01885v1) — LTM/STM as LLM tool actions; agent decides what/when to store
- [Mem0 Research](https://mem0.ai/research) — Memory formation: 80-90% token cost reduction vs chat history; 26% quality improvement

### Context Window Budgeting
- [Context Engineering (Weaviate)](https://weaviate.io/blog/context-engineering) — Dynamic allocation by query type
- [CMU Research (2025)](https://medium.com/@kuldeep.paul08/context-engineering-optimizing-llm-memory-for-production-ai-agents-6a7c9165a431) — 23% performance degradation at >85% context utilization
- [HiAgent (ACL 2025)](https://aclanthology.org/2025.acl-long.1575.pdf) — Hierarchical working memory; subgoals as compact chunks

### Summarization
- [Mem0 Rolling Summaries](https://mem0.ai/blog/llm-chat-history-summarization-guide-2025) — Latest exchange + rolling long-term summary; async refresh
- [MemGPT Adaptive Retention](https://informationmatters.org/2025/10/memgpt-engineering-semantic-memory-through-adaptive-retention-and-context-summarization/) — LLM decides importance via function calls
- [Multi-Layered Memory Architectures (arXiv)](https://arxiv.org/html/2603.29194) — Multiple time-scale layers most effective for long-term retention

### File Format
- [AI Agent Memory: When Markdown Is All You Need (DEV)](https://dev.to/imaginex/ai-agent-memory-management-when-markdown-files-are-all-you-need-5ekk) — File-based persistent knowledge; optimal for local agents
- [Best Nested Data Format Comparison (Improving Agents)](https://www.improvingagents.com/blog/best-nested-data-format/) — Markdown most token-efficient; XML 80% more tokens; JSON less efficient

### Privacy Isolation
- [Cross Session Leak (Giskard)](https://www.giskard.ai/knowledge/cross-session-leak-when-your-ai-assistant-becomes-a-data-breach) — Prevention must occur *around* LLM; strict per-user isolation at infra level
- [AgentLeak Benchmark (arXiv)](https://arxiv.org/abs/2602.11510) — Full-stack benchmark for multi-agent privacy leakage
- [Mem0 Actor-Aware Memories](https://mem0.ai/blog/state-of-ai-agent-memory-2026) — Tag memories with source actor; enables access control

### Token Efficiency & Format Benchmarks
- [Markdown is 15% More Token Efficient Than JSON (OpenAI Forum)](https://community.openai.com/t/markdown-is-15-more-token-efficient-than-json/841742) — Head-to-head: 11,612 vs 13,869 tokens for same data
- [TOON vs JSON (jduncan.io)](https://jduncan.io/blog/2025-11-11-toon-vs-json-agent-optimized-data/) — Token-Optimized Object Notation: 30-60% reduction but only 73.9% parse accuracy

### Memory Quality & Extraction
- [Mem0 prompts.py (GitHub)](https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py) — Three-prompt architecture: extraction, reconciliation, retrieval
- [Mem0 Custom Fact Extraction Docs](https://docs.mem0.ai/open-source/features/custom-fact-extraction-prompt) — Category-scoped extraction for quality control
- [How Three Prompts Created Mem0 (blog.lqhl.me)](https://blog.lqhl.me/mem0-how-three-prompts-created-a-viral-ai-memory-layer) — Deep analysis of Mem0's three-prompt pipeline
- [Mem0 Paper (arXiv)](https://arxiv.org/html/2504.19413v1) — Production-ready agent memory with scalable long-term storage
- [AI Memory Wars (guptadeepak.com)](https://guptadeepak.com/the-ai-memory-wars-why-one-system-crushed-the-competition-and-its-not-openai/) — Benchmark: Mem0 66.9% vs OpenAI 52.9% on LOCOMO
- [Simon Willison — Comparing Claude and ChatGPT Memory](https://simonwillison.net/2025/Sep/12/claude-memory/) — Claude: file-based transparent; ChatGPT: dual-mode implicit

### Context Window Research
- [Context Rot (Chroma Research)](https://www.trychroma.com/research/context-rot) — Non-linear degradation; 11/12 models below 50% at 32K tokens
- [Beyond the Context Window (arXiv 2603.04814)](https://arxiv.org/abs/2603.04814) — Fact-based memory cheaper than long-context after ~10 turns
- [LLM Context Management Guide (16x)](https://eval.16x.engineer/blog/llm-context-management-guide) — Keep utilization under 80%; last 10-15 exchanges verbatim

### Growth & Maintenance
- [Memory Architectures for Long-Term Agent Behavior (GoCodeo)](https://www.gocodeo.com/post/memory-architectures-for-long-term-ai-agent-behavior) — STM/LTM patterns for persistent agents
- [6 Best AI Agent Memory Frameworks 2026 (MLMastery)](https://machinelearningmastery.com/the-6-best-ai-agent-memory-frameworks-you-should-try-in-2026/) — Comparative framework survey

---

## Provider Integration

### Fish Audio TTS
- [Fish Audio WebSocket TTS API](https://docs.fish.audio/api-reference/endpoint/websocket/tts-live) — Bidirectional streaming, MessagePack, configurable latency mode
- [Fish Audio HTTP TTS API](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech) — Chunked HTTP streaming for complete text input
- [Fish Audio Pricing](https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits) — $15 per 1M UTF-8 bytes; ~$2-3/mo at 100 req/day; 5 concurrent (Starter tier)
- [Fish Audio Python SDK](https://github.com/fishaudio/fish-audio-python) — `fish-audio-sdk`; sync + async clients; WebSocket streaming support
- [Fish Speech (GitHub, Apache 2.0)](https://github.com/fishaudio/fish-speech) — Self-hostable fallback model

### Cartesia TTS
- [Cartesia Sonic 3 Docs](https://docs.cartesia.ai/build-with-cartesia/tts-models/latest) — State Space Model architecture; high naturalness; 42 languages
- [Cartesia WebSocket API](https://docs.cartesia.ai/api-reference/tts/websocket) — Context multiplexing on single connection; word-level timestamps; cancel per context
- [Cartesia Pricing](https://cartesia.ai/pricing) — Pro $4/mo (annual) with 100K credits = ~111 min audio; Sonic Turbo ~40ms TTFB
- [Cartesia Python SDK](https://pypi.org/project/cartesia/) — v3.0.2; async + WebSocket; httpx-based; Python 3.9+

### ElevenLabs TTS
- [ElevenLabs API Pricing](https://elevenlabs.io/pricing/api) — Starter $5/30k chars, Creator $22/100k chars; best quality, worst price-performance
- [ElevenLabs TTS Docs](https://elevenlabs.io/docs/overview/capabilities/text-to-speech) — Flash v2.5 (~75ms) and Multilingual v2 (4.14 MOS)

### Deepgram Nova-3 STT
- [Deepgram Live Streaming](https://developers.deepgram.com/docs/live-streaming-audio) — WebSocket streaming; idle connections not billed
- [Deepgram Interim Results](https://developers.deepgram.com/docs/interim-results) — Partial transcripts (`is_final: false`) for responsive agents
- [Deepgram Endpointing & VAD](https://developers.deepgram.com/docs/understand-endpointing-interim-results) — Configurable; `speech_final=true` for turn-taking
- [Deepgram Pricing](https://deepgram.com/pricing) — Nova-3: $0.0077/min PAYG; ~$4/mo at 100 req/day

### OpenRouter LLM
- [OpenRouter Streaming](https://openrouter.ai/docs/api/reference/streaming) — SSE via `stream: true`; OpenAI-compatible
- [OpenRouter Tool Calling](https://openrouter.ai/docs/guides/features/tool-calling) — Standardized across models; not all models support
- [OpenRouter Pricing](https://openrouter.ai/pricing) — Pass-through + 5.5% fee; Haiku 4.5: $1/$5; Flash Lite: $0.25/$1.50
- [OpenRouter FAQ](https://openrouter.ai/docs/faq) — Automatic provider failover built-in

### Python Interface Patterns
- [PEP 544 — Protocols](https://peps.python.org/pep-0544/) — Structural subtyping; duck typing + static checking; no inheritance required
- [Protocol vs ABC (Justin Ellis)](https://jellis18.github.io/post/2022-01-11-abc-vs-protocol/) — Protocol more idiomatic for pluggable providers
- [Real Python — Python Protocols](https://realpython.com/python-protocol/) — `@runtime_checkable` for isinstance(); supports async methods
- [mypy Protocols Documentation](https://mypy.readthedocs.io/en/stable/protocols.html) — Full structural subtyping checks; async method enforcement

### Provider Failover
- [pyresilience (PyPI)](https://pypi.org/project/pyresilience/) — Unified retry/circuit breaker/timeout/fallback via `@resilient()` decorator; async-native
- [aiobreaker (GitHub)](https://github.com/arlyon/aiobreaker) — Async-native circuit breaker for asyncio
- [Claude API Circuit Breaker (SitePoint)](https://www.sitepoint.com/claude-api-circuit-breaker-pattern/) — Practical guide for LLM API circuit breakers

### Cost Estimates (~100 req/day, short utterances)
| Component | Provider | Est. Monthly Cost |
|-----------|----------|------------------|
| STT | Deepgram Nova-3 | ~$4 |
| TTS | Fish Audio | ~$2-3 |
| TTS | Cartesia (Pro) | $5 (plan) |
| TTS | ElevenLabs | $22 (Creator plan) |
| LLM | OpenRouter (Haiku 4.5) | ~$1-3 |
| LLM | OpenRouter (Flash Lite) | <$1 |
