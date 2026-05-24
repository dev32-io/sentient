# Sources — Voice Gateway Research

## STT Providers
- [Deepgram Nova-3 Review: Benchmarks & Pricing](https://transcriber.talkflowai.com/blog/deepgram-nova-3-review-benchmarks-pricing) — Nova-3 latency <300ms, WER ~5.3%, pricing $0.0043/min
- [AssemblyAI vs Deepgram Comparison](https://www.assemblyai.com/blog/assemblyai-vs-deepgram) — Universal-2 entity accuracy better (16.7% vs 25.2% miss rate), latency 300-600ms streaming
- [Deepgram vs AssemblyAI 2026](https://transcriber.talkflowai.com/blog/deepgram-vs-assemblyai-2026-comparison) — Side-by-side pricing, features
- [Best STT APIs 2026](https://deepgram.com/learn/best-speech-to-text-apis-2026) — Multi-provider comparison
- [Best STT Models for Real-Time Agents](https://www.assemblyai.com/blog/best-api-models-for-real-time-speech-recognition-and-transcription) — Streaming STT landscape
- [Best Speech to Text Models 2025](https://nextlevel.ai/best-speech-to-text-models/) — Real-time agent comparison
- [faster-whisper GitHub](https://github.com/SYSTRAN/faster-whisper) — 4x faster than OpenAI implementation, CTranslate2 backend
- [Whisper large-v3-turbo HuggingFace](https://huggingface.co/openai/whisper-large-v3-turbo) — 32→4 decoder layers, faster inference
- [Whisper v3 Turbo Deployment](https://simplismart.ai/blog/deploy-whisper-v3-turbo-using-vox-box) — Sub-second latency deployment guide
- [Whisper GPU Requirements](https://itctshop.com/whisper-large-v3-gpu-requirements/) — RTX 3060 minimum, RTX 4090 recommended for multi-stream
- [Fastest Whisper v3 Turbo at 1300x Real-Time](https://simplismart.ai/blog/fastest-whisper-v3-turbo-serving-millions-of-requests-at-1300-real-time-with-simplismart) — Batch processing optimization

## OpenRouter / LLM Streaming
- [OpenRouter Latency & Performance Docs](https://openrouter.ai/docs/guides/best-practices/latency-and-performance) — Official latency guidance
- [OpenRouter Streaming Docs](https://openrouter.ai/docs/api/reference/streaming) — SSE streaming reference
- [OpenRouter Review: Latency & Pricing](https://skywork.ai/blog/openrouter-review-2025-api-gateway-latency-pricing/) — Claims ~25ms edge overhead, independent benchmarks show 50-150ms
- [OpenRouter vs Claude Direct API](https://www.remio.ai/post/openrouter-vs-claude-direct-api-pros-and-cons-for-scaling-ai-apps) — Pros/cons analysis
- [OpenRouter Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection) — Multi-provider routing logic

## Cloud TTS Providers
- [Cartesia vs ElevenLabs 2026](https://elevenlabs.io/blog/elevenlabs-vs-cartesia) — ElevenLabs perspective
- [Cartesia Sonic 3 vs ElevenLabs](https://www.eesel.ai/blog/cartesia-sonic-3-vs-elevenlabs) — Sonic TTFA 40-90ms, ~73% cheaper
- [Cartesia vs ElevenLabs](https://cartesia.ai/vs/cartesia-vs-elevenlabs) — Cartesia perspective, Sonic-Turbo <40ms TTFA
- [Streaming TTS Benchmark: Cartesia vs ElevenLabs](https://podcastle.ai/blog/tts-latency-vs-quality-benchmark/) — Head-to-head latency benchmark
- [Fish Audio TTS API Comparison](https://fish.audio/blog/text-to-speech-api-comparison-pricing-features) — $15/1M UTF-8 bytes, sub-500ms, 30+ languages
- [Fish Audio Pricing](https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits) — Detailed pricing tiers
- [Best TTS APIs 2026](https://www.speechmatics.com/company/articles-and-news/best-tts-apis-in-2025-top-12-text-to-speech-services-for-developers) — 12-provider comparison
- [ElevenLabs Alternatives 2026](https://deepgram.com/learn/text-to-speech-elevenlabs-alternatives-2026) — Market landscape
- [ElevenLabs vs Cartesia (Fish Audio)](https://fish.audio/vs/elevenlabs-versus-cartesia/) — Third-party comparison
- [Best TTS APIs for Voice Agents 2026](https://inworld.ai/resources/best-voice-ai-tts-apis-for-real-time-voice-agents-2026-benchmarks) — Real-time benchmarks

## Self-Hosted TTS
- [Best Open-Source TTS Models 2026 (BentoML)](https://bentoml.com/blog/exploring-the-world-of-open-source-text-to-speech-models) — Comprehensive model survey
- [Open-Source TTS Models (Modal)](https://modal.com/blog/open-source-tts) — Deployment-focused comparison
- [ElevenLabs Alternatives: Open-Source TTS](https://ocdevel.com/blog/20250720-tts) — Kokoro, Chatterbox, Voxtral comparison
- [Chatterbox vs Kokoro TTS 2026](https://slashdot.org/software/comparison/Chatterbox-Voice-Cloning-vs-Kokoro-TTS/) — Side-by-side comparison
- [Kokoro TTS Review 2026](https://reviewnexa.com/kokoro-tts-review/) — 82M params, quality analysis
- [12 Best Open-Source TTS Models](https://www.inferless.com/learn/comparing-different-text-to-speech---tts--models-part-2) — Latency, quality, voice cloning
- [Top TTS Models 2026 (Trelis)](https://trelis.substack.com/p/top-text-to-speech-tts-models-in) — Rankings and analysis

## Voice Agent Frameworks / Architecture
- [Best Voice Agent Stack: Selection Framework](https://hamming.ai/resources/best-voice-agent-stack) — Framework selection guide
- [Voice Agent Frameworks: LiveKit & Pipecat](https://www.arunbaby.com/ai-agents/0018-voice-agent-frameworks/) — Deep architecture comparison
- [RealTime AI Agents: LiveKit, Pipecat, TEN](https://medium.com/@ggarciabernardo/realtime-ai-agents-frameworks-bb466ccb2a09) — Three-way framework comparison
- [LiveKit vs Pipecat](https://www.f22labs.com/blogs/difference-between-livekit-vs-pipecat-voice-ai-platforms/) — Detailed platform comparison
- [Sequential Pipeline Architecture (LiveKit)](https://livekit.com/blog/sequential-pipeline-architecture-voice-agents) — LiveKit's pipeline design
- [Choosing a Voice AI Production Framework](https://webrtc.ventures/2026/03/choosing-a-voice-ai-agent-production-framework/) — Bedrock vs Vertex vs LiveKit vs Pipecat
- [6 Best Orchestration Tools for Voice Agents 2026](https://www.assemblyai.com/blog/orchestration-tools-ai-voice-agents) — Market overview
- [Top Voice AI Frameworks 2026](https://medium.com/@mahadise0011/top-voice-ai-agent-frameworks-in-2026-a-complete-guide-for-developers-4349d49dbd2b) — Complete developer guide

## Audio Delivery & Transport
- (To be expanded in deep dive — WebSocket, WebRTC, Opus codec documentation)
- [LiveKit WebRTC Infrastructure](https://livekit.com/) — Go-based SFU, WebRTC transport
- [Opus Codec](https://opus-codec.org/) — Interactive speech codec specifications

## TTS Preprocessing
- (To be expanded in deep dive — sentence boundary detection, text normalization)
