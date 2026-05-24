# Cloud TTS Providers — Findings

> **Sources**: [Cartesia Pricing](https://cartesia.ai/pricing), [Cartesia Sonic-3](https://cartesia.ai/sonic), [Cartesia vs ElevenLabs (Cartesia)](https://cartesia.ai/vs/cartesia-vs-elevenlabs), [Cartesia vs ElevenLabs (ElevenLabs)](https://elevenlabs.io/blog/elevenlabs-vs-cartesia), [Sonic 3 vs ElevenLabs (eesel)](https://www.eesel.ai/blog/cartesia-sonic-3-vs-elevenlabs), [Sonic 3 Pricing (eesel)](https://www.eesel.ai/blog/cartesia-sonic-3-pricing), [Streaming TTS Benchmark (Podcastle)](https://podcastle.ai/blog/tts-latency-vs-quality-benchmark/), [Picovoice TTS Latency Benchmark (GitHub)](https://github.com/Picovoice/tts-latency-benchmark), [ElevenLabs Models Docs](https://elevenlabs.io/docs/overview/models), [ElevenLabs API Pricing](https://elevenlabs.io/pricing/api), [Fish Audio Pricing](https://fish.audio/plan/), [Fish Audio TTS Docs](https://docs.fish.audio/developer-guide/core-features/text-to-speech), [Deepgram Aura-2](https://deepgram.com/learn/introducing-aura-2-enterprise-text-to-speech) — $30/1M chars, [Deepgram WebSocket TTS](https://deepgram.com/learn/aura-text-to-speech-adds-websocket-support-for-input-streaming), [MiniMax Speech 2.6 (Together AI)](https://www.together.ai/blog/minimax-speech-2-6) — $100/1M HD, [LMNT Pricing](https://www.lmnt.com/pricing), [Hume AI Pricing](https://www.hume.ai/pricing), [Azure TTS Pricing](https://azure.microsoft.com/en-us/pricing/details/speech/), [PlayHT Pricing](https://play.ht/pricing/), [Inworld TTS Benchmarks 2026](https://inworld.ai/resources/best-voice-ai-tts-apis-for-real-time-voice-agents-2026-benchmarks), [CodeSOTA Speech AI 2026](https://www.codesota.com/speech), [Artificial Analysis TTS Methodology](https://artificialanalysis.ai/text-to-speech/methodology), [Best TTS APIs 2026 (Speechmatics)](https://www.speechmatics.com/company/articles-and-news/best-tts-apis-in-2025-top-12-text-to-speech-services-for-developers), [Layercode TTS Guide](https://layercode.com/blog/tts-voice-ai-model-guide)

## Provider Deep Dives

### Cartesia
- **Models**: Sonic, Sonic-Turbo, Sonic-3
- **TTFA**: Sonic-Turbo: 40ms per [Inworld 2026 Benchmarks](https://inworld.ai/resources/best-voice-ai-tts-apis-for-real-time-voice-agents-2026-benchmarks) and [Cartesia docs](https://cartesia.ai/vs/cartesia-vs-elevenlabs); Sonic-3: ~90ms per [CodeSOTA 2026](https://www.codesota.com/speech). [Podcastle independent benchmark](https://podcastle.ai/blog/tts-latency-vs-quality-benchmark/) measured 199ms at self-serve tier — the discrepancy likely reflects tier differences and measurement methodology (p50 vs p90). **Plan for 90-200ms at self-serve; negotiate for <50ms at enterprise**
- **Pricing**: ~$0.038/1K characters. Roughly 73% cheaper than ElevenLabs. ~$38/1M characters
- **Streaming**: WebSocket API with raw PCM or Opus output. Byte-level streaming — audio starts before full synthesis
- **Voice Cloning**: Instant voice cloning from reference audio (seconds of audio needed)
- **Emotion/Style**: Speed parameter, voice style presets, limited fine-grained control
- **Languages**: 15+ languages
- **Output Formats**: PCM (raw), Opus, MP3
- **Concurrency**: Varies by plan, enterprise negotiable
- **SSML**: Partial — speed, pause support
- **Key Strengths**: Lowest TTFA in the market, excellent cost-performance ratio, purpose-built for real-time
- **Key Weaknesses**: Smaller voice library, fewer languages than competitors, less mature API

### ElevenLabs
- **Models**: Flash v2.5 (fastest), Turbo v2.5 (balanced), Multilingual v2 (highest quality)
- **TTFA**: Flash v2.5: "as low as 75ms" per [ElevenLabs docs](https://elevenlabs.io/blog/elevenlabs-vs-cartesia) (this is a best-case figure). [Podcastle benchmark](https://podcastle.ai/blog/tts-latency-vs-quality-benchmark/) measured 832ms at self-serve tier — an 11x discrepancy. The "as low as" qualifier does significant work. **Plan for 300-800ms at self-serve; Flash at enterprise tier may achieve ~100-200ms**
- **Pricing**: ~$0.05/1K characters at scale. Starter: $5/mo (30K chars); Creator: $22/mo (100K chars); Pro: $99/mo (500K chars); Scale: $330/mo (2M chars). Enterprise: custom. ~$50/1M characters at scale tier
- **Streaming**: WebSocket streaming API. Also HTTP streaming. Input streaming (send text as it arrives) supported
- **Voice Cloning**: Industry-leading. Instant clone from <30s audio. Professional clone from 30+ minutes for premium quality. Custom fine-tuning available
- **Emotion/Style**: Stability, similarity, style exaggeration sliders. Some SSML support (breaks). Models infer emotion well from text
- **Languages**: 70+ languages, 32 supported by Flash
- **Output Formats**: MP3, PCM, Opus, μ-law
- **Concurrency**: Varies by plan (Pro: 3 concurrent, Scale: higher)
- **SSML**: Partial — `<break>` tag supported, limited other tags
- **Key Strengths**: Best overall voice quality, strongest voice cloning, largest voice library (10K+ community voices), most mature API and ecosystem
- **Key Weaknesses**: Most expensive, TTFA higher than Cartesia, rate limits on lower tiers

### Fish Audio
- **Models**: fish-speech-1.5, FishAudio-S1
- **TTFA**: Sub-500ms (marketing claim). Not as fast as Cartesia/ElevenLabs Flash
- **Pricing**: $15/1M UTF-8 bytes (~$15/180K English words). Roughly $0.018/1K characters — cheapest option. Pay-as-you-go available
- **Streaming**: REST API with streaming support. Python SDK with async
- **Voice Cloning**: Reference audio-based cloning. 2M+ community voice library
- **Emotion/Style**: 50+ emotion tags — richest emotion control in the market. Tags: happy, sad, angry, calm, excited, whisper, shouting, etc.
- **Languages**: 30-70+ languages (claims vary)
- **Output Formats**: MP3, WAV, Opus
- **SSML**: Custom emotion tag system rather than standard SSML
- **Key Strengths**: Cheapest pricing, richest emotion control, large community voice library
- **Key Weaknesses**: Higher TTFA than competitors, less proven at scale, newer in market

### PlayHT
- **Models**: PlayHT 3.0
- **TTFA**: ~300-500ms typical
- **Pricing**: Creator: $31.20/mo; Pro: $49.50/mo. Per-character pricing on API
- **Streaming**: gRPC and WebSocket streaming APIs
- **Voice Cloning**: Instant cloning available
- **Emotion/Style**: Style presets, limited real-time control
- **Languages**: 140+ languages — broadest language support
- **Output Formats**: MP3, WAV, Opus, μ-law, FLAC
- **Key Strengths**: Most languages, good voice variety (600+ voices), gRPC streaming option
- **Key Weaknesses**: Higher latency, less competitive on quality vs ElevenLabs/Cartesia

### Deepgram Aura
- **TTFA**: ~250ms
- **Pricing**: $0.015/1K characters ($15/1M chars) — very competitive
- **Streaming**: WebSocket streaming
- **Voice Cloning**: Not available
- **Languages**: English primarily, expanding
- **Key Strengths**: Low cost, same platform as STT (single vendor), decent quality
- **Key Weaknesses**: Limited voices, no cloning, English-centric

### LMNT
- **Focus**: Ultra-low latency for real-time applications
- **TTFA**: Claims <100ms
- **Streaming**: WebSocket streaming
- **Key Strengths**: Built specifically for real-time voice agents
- **Status**: Smaller player, less documentation available

### Hume AI
- **Focus**: Emotionally expressive speech
- **Key Feature**: EVI (Empathic Voice Interface) — detects and responds to user emotion
- **Streaming**: WebSocket-based
- **Key Strengths**: Emotion detection + expression, unique in market
- **Use Case**: Applications where emotional tone matters (therapy, companionship, support)

### Azure Neural TTS
- **TTFA**: ~200-300ms
- **Pricing**: $16/1M characters (standard); $160/1M characters (custom neural)
- **Streaming**: Full SSML support, WebSocket and REST streaming
- **Languages**: 140+ languages, 400+ voices
- **Key Strengths**: Full SSML, enterprise-grade, broadest language/voice coverage
- **Key Weaknesses**: Robotic quality compared to newer providers, complex pricing

### Google Cloud TTS
- **TTFA**: ~200-400ms
- **Pricing**: Standard: $4/1M chars; WaveNet: $16/1M chars; Neural2/Studio: $16/1M chars. Free tier: 1M chars/month (standard)
- **Streaming**: gRPC streaming
- **Languages**: 50+ languages
- **Key Strengths**: Good free tier, WaveNet quality, tight GCP integration
- **Key Weaknesses**: Not as natural as ElevenLabs/Cartesia for conversational speech

## Head-to-Head Comparison Table

| Provider | Price/1M chars | TTFA (real) | Streaming | Voice Clone | Emotions | Languages | Quality |
|----------|---------------|-------------|-----------|-------------|----------|-----------|---------|
| Cartesia | ~$38 | 40-199ms | WebSocket | Yes (instant) | Limited | 15+ | A |
| ElevenLabs | ~$50 | 75-832ms | WebSocket | Best | Moderate | 70+ | A+ |
| Fish Audio | ~$18 | <500ms | REST stream | Yes | 50+ tags | 30+ | B+ |
| PlayHT | ~$40 | 300-500ms | gRPC/WS | Yes | Presets | 140+ | B+ |
| Deepgram Aura | ~$15 | ~250ms | WebSocket | No | No | English | B |
| LMNT | TBD | <100ms | WebSocket | TBD | TBD | TBD | B+ |
| Azure Neural | $16-160 | 200-300ms | WS/REST | Custom ($$$) | SSML | 140+ | B+ |
| Google Cloud | $4-16 | 200-400ms | gRPC | No | SSML | 50+ | B |

## Streaming API Comparison

### WebSocket-Based (Cartesia, ElevenLabs, Deepgram)
- Bidirectional: send text chunks, receive audio chunks
- Persistent connection — no per-request overhead
- Best for real-time voice: send text as LLM generates it
- Cartesia: raw PCM frames, lowest overhead
- ElevenLabs: input streaming — send partial text, get partial audio

### HTTP Chunked (Fish Audio)
- Simpler integration
- Each request is independent
- Higher per-request overhead
- Fine for sentence-level chunking, less ideal for word-level streaming

### gRPC (PlayHT, Google)
- Binary protocol, efficient
- More complex client setup
- Good for high-throughput server-to-server

## Cost Modeling

Assumptions: 5 min voice output/user/day ≈ 750 words ≈ 4,500 characters ≈ 0.0045M chars/user/day

| Provider | 100 DAU/mo | 1K DAU/mo | 10K DAU/mo |
|----------|-----------|-----------|------------|
| Cartesia | $513 | $5,130 | $51,300 |
| ElevenLabs | $675 | $6,750 | $67,500 |
| Fish Audio | $243 | $2,430 | $24,300 |
| Deepgram Aura | $203 | $2,025 | $20,250 |
| Google Cloud (WaveNet) | $216 | $2,160 | $21,600 |

*Calculations: DAU × 30 days × 0.0045M chars × price/1M chars*

## Recommendations

### Best for Lowest Latency
**Cartesia Sonic-Turbo** — <40ms TTFA (enterprise), purpose-built for real-time voice agents. Clear winner for latency-sensitive applications.

### Best for Quality
**ElevenLabs Multilingual v2 / Turbo v2.5** — consistently ranked highest in quality benchmarks and blind tests. Worth the premium for user-facing applications where voice quality is a differentiator.

### Best for Cost
**Fish Audio** at ~$18/1M chars or **Deepgram Aura** at ~$15/1M chars. Fish Audio offers better quality and more features. Google Cloud standard tier ($4/1M) is cheapest but quality is lower.

### Best for Voice Cloning
**ElevenLabs** — industry-leading instant and professional cloning. Most natural reproduction of voice characteristics.

### Best for Emotion Control
**Fish Audio** — 50+ emotion tags with fine-grained control. Hume AI for emotion detection + response.

### Gateway Default Recommendation
**Cartesia** as primary (best latency/cost ratio) with **ElevenLabs** as premium option and **Fish Audio** as budget option. Design the gateway to support all three via a pluggable TTS backend interface.
