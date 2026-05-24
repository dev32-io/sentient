# Self-Hosted Voice Gateway — LLM-to-Audio Pipeline Research

## TLDR

Building a voice gateway that pipes STT → LLM → TTS with streaming overlap can achieve **<1 second** end-to-end latency (user speaks → user hears response). The key architectural decisions:

1. **STT**: Deepgram Nova-3 (cloud, <300ms) or faster-whisper large-v3-turbo (self-hosted, RTX 3060+)
2. **LLM**: Direct API to Anthropic/OpenAI for production (skip OpenRouter's 50-100ms overhead); self-hosted Llama 8B via vLLM for lowest latency (<100ms TTFT)
3. **TTS**: Cartesia Sonic-Turbo (cloud, <40ms TTFA enterprise) or Kokoro 82M (self-hosted, 96x real-time, best cost-performance)
4. **Transport**: WebSocket + Opus codec (24kHz, 24kbps, 20ms frames)
5. **Architecture**: Python asyncio, streaming pipeline with barge-in as first-class feature
6. **Framework**: Start with LiveKit Agents or Pipecat; go custom only if needed

**Critical insight**: Streaming overlap between stages cuts perceived latency by 50-70%. Don't wait for LLM to finish before starting TTS — send each sentence as it completes.

## Latency Budget (Optimized)

| Stage | Cloud | Self-Hosted |
|-------|-------|-------------|
| STT + endpointing | 300ms | 150ms |
| LLM TTFT + first sentence | 400ms | 150ms |
| Text preprocessing | 2ms | 2ms |
| TTS TTFA | 50ms (Cartesia) | 50ms (Kokoro) |
| Transport + buffer | 100ms | 75ms |
| **Total** | **~850ms** | **~425ms** |

## Cost at Scale (1K DAU, 5 min voice/day)

| Component | Cloud | Self-Hosted |
|-----------|-------|-------------|
| STT | $240/mo (Deepgram) | ~$150/mo (GPU) |
| LLM | $200-500/mo | ~$300/mo (GPU) |
| TTS | $2,400-6,700/mo | ~$150/mo (GPU) |
| **Total** | **$2,800-7,400/mo** | **~$600/mo** |

TTS is 60-70% of cloud costs — self-hosted TTS is the highest-ROI optimization.

## Research Findings

### [STT Providers & Engines](findings/stt-providers.md)
Deepgram Nova-3 is the fastest cloud STT (<300ms, $0.26/hr). For self-hosted, faster-whisper with large-v3-turbo achieves real-time on RTX 3060+ with INT8 quantization. Silero VAD is the best endpointing solution.

### [OpenRouter Streaming Integration](findings/openrouter-streaming.md)
OpenRouter adds 50-100ms overhead vs direct API. For voice, prefer direct API calls or self-hosted LLM. Best voice models: GPT-4o-mini, Claude Haiku, Gemini Flash. System prompt is critical — instruct LLM to output spoken-word format, not markdown.

### [TTS Preprocessing & Chunking](findings/tts-preprocessing.md)
Hybrid chunking strategy: first sentence ships immediately (minimize TTFA), then group 2-3 sentences for better prosody. Use streaming sentence boundary detection (PySBD or custom regex). Essential pipeline: markdown strip → number normalization → abbreviation expansion → pronunciation overrides.

### [Cloud TTS Providers](findings/cloud-tts-providers.md)
Cartesia: lowest latency (<40ms enterprise). ElevenLabs: best quality + cloning. Fish Audio: cheapest ($18/1M chars) + richest emotion control (50+ tags). Warning: marketing TTFA claims often 5-10x better than self-serve reality.

### [Self-Hosted TTS Engines](findings/self-hosted-tts.md)
Kokoro (82M params) is the standout: ELO 1,059 on Artificial Analysis (#1 open-weight), 96x real-time, runs on any GPU or even CPU. Chatterbox has voice cloning but quality concerns (86% CER in some tests). Piper for CPU-only deployments.

### [Audio Delivery & Transport](findings/audio-delivery.md)
WebSocket + Opus is the sweet spot: simple deployment, <5ms overhead, bidirectional, universal browser support. WebRTC (via LiveKit) only if you need <50ms transport or already use WebRTC infrastructure.

### [Gateway Architecture](findings/gateway-architecture.md)
Pipeline orchestrator with streaming overlap, pluggable STT/LLM/TTS backends, barge-in as first-class event. Python asyncio is adequate — the bottleneck is always the external services, not the gateway. Study LiveKit Agents (clean API, built-in turn detection) and Pipecat (maximum flexibility).

## Cross-Cutting Analysis

### [Connections](connections.md)
10 cross-topic patterns including: latency cascade effect, quality-latency-cost triangle, hybrid cloud/self-hosted routing, barge-in as architecture stress test, WebSocket as universal transport.

### [Contradictions](contradictions.md)
10 areas where sources disagree: OpenRouter overhead (25ms claimed vs 120ms measured per [Skywork benchmark](https://skywork.ai/blog/openrouter-review-2025-api-gateway-latency-pricing/)), Cartesia TTFA (40ms vs 199ms per [Podcastle](https://podcastle.ai/blog/tts-latency-vs-quality-benchmark/)), ElevenLabs TTFA (75ms vs 832ms), Chatterbox quality (marketing vs 86% CER), Python viability.

### [Gaps](gaps.md)
12 research gaps ranked by impact: real-world e2e latency measurements, concurrent user performance, echo cancellation for barge-in, multi-language support.

## Research Quality
All 7 topics scored in Phase 6 critique loop. Final scores: **39-43/50** across all topics (100+ cited sources total). Strongest dimensions: actionable clarity (8-9/10) and depth of insight (8-10/10). Weakest: confidence (7-8/10) due to reliance on vendor-reported benchmarks for some metrics.

## Quick Start Recommendation

**Fastest path to a working voice gateway**:
1. Use **LiveKit Agents** with their Python SDK
2. Configure: Deepgram STT + OpenAI GPT-4o-mini + Cartesia TTS
3. Deploy with Docker Compose
4. Expected latency: ~800ms-1.2s end-to-end
5. Iterate: swap providers, tune chunking, add barge-in refinements

**For maximum control**: Use Pipecat or build custom with the architecture patterns documented in [Gateway Architecture](findings/gateway-architecture.md).
