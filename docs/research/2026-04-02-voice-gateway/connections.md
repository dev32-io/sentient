# Cross-Topic Connections & Patterns

## 1. The Latency Cascade Effect
Every millisecond saved in one pipeline stage compounds across the full chain. The end-to-end latency is the **sum** of all stages, so optimizing the slowest stage has the highest ROI.

**Pattern**: STT endpointing (200-400ms) + LLM TTFT (200-500ms) + first sentence generation (~300ms) + TTS TTFA (40-500ms) + transport (~50ms) = 790-1750ms total.

**Insight**: The two biggest levers are:
1. **LLM TTFT** — choosing GPT-4o-mini/Haiku/self-hosted 8B can save 200-400ms over larger models
2. **TTS TTFA** — Cartesia (<40ms) vs ElevenLabs (~832ms at self-serve) is a 10x difference

The gateway architecture must enable **streaming overlap** so that TTS starts on the first sentence while LLM is still generating. This single architectural decision can cut perceived latency by 50-70%.

## 2. The Quality-Latency-Cost Triangle
Every provider choice involves this tradeoff:

```
                Quality
               /       \
              /         \
          Latency ── Cost
```

- **ElevenLabs**: Best quality, highest cost, moderate latency
- **Cartesia**: Good quality, lowest latency, moderate cost
- **Kokoro (self-hosted)**: Good quality, low latency, lowest cost (GPU amortized)
- **Fish Audio**: Moderate quality, moderate latency, lowest per-char cost

**Gateway implication**: The pluggable TTS backend isn't just nice-to-have — it's essential for letting users navigate this triangle based on their priorities.

## 3. Self-Hosted vs Cloud Decision Framework
A consistent pattern emerges across STT and TTS:

| Factor | Self-Hosted Wins | Cloud Wins |
|--------|-----------------|------------|
| Latency | Yes (no network hop) | Sometimes (optimized infra) |
| Cost at scale | Yes (amortized GPU) | No (per-unit pricing) |
| Quality | Catching up (Kokoro) | Still ahead (ElevenLabs) |
| Multi-language | Limited (1-17 lang) | Yes (50-140+ lang) |
| Voice cloning | Limited | Yes (ElevenLabs) |
| Ops burden | High | Low |
| Data privacy | Yes (data stays local) | Depends on provider |

**Insight**: The optimal architecture supports **hybrid routing** — self-hosted for baseline English and cloud for premium features (cloning, emotion, languages). This is exactly what the pluggable backend pattern enables.

## 4. Barge-In Is the Architecture's Stress Test
Barge-in (user interruption) touches every component:
- **STT**: Must detect speech while TTS is playing (echo cancellation matters)
- **LLM**: Must cancel in-flight generation (needs cancellation token/signal)
- **Preprocessing**: Must reset buffer state
- **TTS**: Must cancel pending synthesis requests
- **Transport**: Must signal client to stop playback
- **Session**: Must record what was actually spoken vs cancelled

**Pattern**: Systems that handle barge-in well (LiveKit Agents) treat it as a first-class event that propagates through the entire pipeline. Systems that add it as an afterthought (many custom implementations) have edge cases and audio glitches.

**Architectural implication**: Every pipeline stage needs a `cancel()` method. The pipeline orchestrator needs an event bus for cross-stage communication.

## 5. Sentence Boundary Detection Is the Hidden Bottleneck
The preprocessing layer sits at the critical junction between LLM streaming and TTS:
- Too aggressive splitting → prosody breaks, unnatural speech
- Too conservative buffering → high latency to first audio
- Poor edge case handling → TTS speaks URLs, code blocks, markdown

**Connection to LLM**: The system prompt can eliminate most preprocessing work by instructing the model to output TTS-friendly text. This is cheaper (prompt engineering) than fixing output after the fact (text normalization pipeline).

**Connection to TTS**: Different providers handle small chunks differently. Cartesia handles single words well; ElevenLabs needs sentence-level chunks for good prosody. The chunking strategy should be provider-aware.

## 6. WebSocket as Universal Transport
WebSocket appears at every boundary in the architecture:
- **Client ↔ Gateway**: Audio streaming (WebSocket with binary Opus frames)
- **Gateway ↔ Deepgram**: STT streaming (WebSocket)
- **Gateway ↔ Cartesia/ElevenLabs**: TTS streaming (WebSocket)
- **Gateway ↔ LLM**: SSE/HTTP streaming (not WebSocket, but similar pattern)

**Pattern**: The gateway is fundamentally a **WebSocket proxy** that transforms between audio and text streams. This suggests the core abstraction should be stream-to-stream transformation, not request-response.

## 7. Opus Codec as the Unifying Audio Format
Opus emerges as the clear winner across all use cases:
- Browser clients: native Opus decoding
- WebRTC: default codec
- LiveKit: Opus transport
- TTS providers: many output Opus natively (Cartesia, ElevenLabs)
- STT: can accept Opus input (Deepgram)

**Gateway design**: Use Opus everywhere. Only transcode to PCM at pipeline boundaries where models require raw audio (self-hosted STT/TTS). This minimizes encode/decode overhead and bandwidth.

## 8. The Framework vs Custom Build Spectrum
| Approach | Time to MVP | Flexibility | Maintenance | Performance Control |
|----------|------------|-------------|-------------|-------------------|
| LiveKit Agents | 1-2 days | Low-Medium | Low (maintained) | Low |
| Pipecat | 3-5 days | High | Medium | Medium |
| Custom Gateway | 2-4 weeks | Maximum | High | Maximum |

**Insight**: For most projects, start with LiveKit Agents or Pipecat. Build custom only if you need:
- Specific transport not supported (custom SIP, proprietary protocol)
- Performance requirements beyond Python's capability
- Business logic deeply intertwined with audio pipeline
- Provider-specific optimizations that frameworks don't expose

## 9. Cost Scaling Follows a Power Law
At scale, the cost hierarchy shifts:
- **Small scale (<100 DAU)**: Cloud everything — operational simplicity wins
- **Medium scale (100-1K DAU)**: Cloud STT/LLM, consider self-hosted TTS (biggest cost component)
- **Large scale (1K-10K DAU)**: Self-hosted TTS mandatory ($20-67K/mo cloud vs ~$2K/mo GPU), consider self-hosted STT
- **Very large scale (10K+ DAU)**: Self-hosted everything, custom optimizations

**TTS is the cost driver**: At 5 min voice/user/day, TTS costs dominate (60-70% of total provider costs). This makes TTS self-hosting the first priority for cost optimization.

## 10. Observability Patterns Are Consistent Across Stages
Every pipeline stage needs the same three metrics:
1. **Latency**: How long this stage took (TTFT for LLM, TTFA for TTS, processing time for STT)
2. **Error rate**: How often this stage fails
3. **Queue depth**: How much work is waiting (backpressure indicator)

OpenTelemetry spans should wrap each stage, with the full turn as the parent span. This enables both per-stage optimization and end-to-end latency tracking.
