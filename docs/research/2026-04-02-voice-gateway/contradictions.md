# Contradictions — Where Sources Disagree

## 1. OpenRouter Latency Overhead
- **OpenRouter claims**: ~25ms at edge, ~40ms typical ([OpenRouter Latency Guide](https://openrouter.ai/docs/guides/best-practices/latency-and-performance))
- **Independent benchmark (Skywork)**: 742ms TTFT via OpenRouter vs 622ms direct to Vertex AI = **~120ms overhead** ([Skywork Review](https://skywork.ai/blog/openrouter-review-2025-api-gateway-latency-pricing/))
- **Resolution**: The 25-40ms figure represents proxy overhead only; real-world includes route selection, provider fallback logic, and geographic routing. For voice applications, plan for **100-120ms overhead**.

## 2. Cartesia TTFA Discrepancy
- **Cartesia marketing**: Sonic-Turbo <40ms TTFA
- **Cartesia Sonic-3 marketing**: 40-90ms TTFA
- **Independent benchmark (Podcastle)**: 199ms at self-serve tier
- **Resolution**: The <40ms figure likely applies to enterprise tier with dedicated infrastructure and optimized routing. Self-serve tier has shared infrastructure and higher latency. **Plan for 100-200ms at self-serve, negotiate for <50ms at enterprise tier.** The discrepancy highlights that TTS latency claims should always be verified at your actual tier.

## 3. ElevenLabs TTFA Claims
- **ElevenLabs Flash v2.5 marketing**: "as low as 75ms"
- **Independent benchmark (Podcastle)**: 832ms at self-serve tier
- **Resolution**: Similar to Cartesia — the 75ms claim is for optimal conditions. Self-serve tier shows dramatically higher latency. The "as low as" qualifier does significant work. **Plan for 300-800ms at self-serve.** This makes ElevenLabs less competitive on latency despite marketing claims.

## 4. Chatterbox Quality Assessment
- **Resemble AI claims**: 63.75% preference rate vs ElevenLabs
- **Independent benchmark**: 86% CER (Character Error Rate), 4.0 MOS
- **Resolution**: The 86% CER suggests Chatterbox has severe intelligibility issues on certain inputs, possibly long text or edge cases. The preference rate may have been measured on cherry-picked short samples. **Treat Chatterbox as experimental** — test extensively on your specific use case before committing.

## 5. Voxtral Quality
- **Marketing**: "Beat ElevenLabs Flash v2.5 in blind tests"
- **Independent benchmark**: 25% CER, 4.1 MOS, premature termination issues
- **Resolution**: The blind test likely used short, carefully selected samples. On general text, premature termination (model stops generating before text is complete) is a critical reliability issue. **Not production-ready** for voice gateway use despite quality potential.

## 6. Deepgram vs AssemblyAI "Best Accuracy"
- **Deepgram claims**: 30% lower WER than AssemblyAI
- **AssemblyAI claims**: Better entity accuracy (16.7% vs 25.2% miss rate)
- **Resolution**: Both are right about different things. Deepgram wins on overall WER (general transcription accuracy). AssemblyAI wins on entity recognition (names, numbers, emails). **Choose based on your use case**: general conversation → Deepgram; data-heavy content → AssemblyAI.

## 7. WebSocket vs WebRTC for Voice
- **WebRTC advocates**: "WebRTC is always better for real-time audio" (10-30ms advantage)
- **Practical experience**: WebSocket adds <5ms overhead, WebRTC adds 200-2000ms connection setup
- **Resolution**: WebRTC has lower steady-state latency but much higher connection setup time. For voice gateways where sessions last minutes, the setup cost is amortized. For short interactions, WebSocket is more practical. **Use WebSocket unless you need <50ms transport latency or are already on LiveKit/WebRTC infrastructure.**

## 8. Python vs Go/Rust for Voice Gateway
- **Performance advocates**: "Python is too slow for real-time audio processing"
- **Framework authors**: Pipecat (Python), LiveKit Agent SDK (Python) both work in production
- **Resolution**: Python's asyncio handles I/O-bound streaming well. The bottleneck is never the gateway's language — it's the external services (STT, LLM, TTS). Python is fine for orchestration. Only consider Go/Rust if you're doing heavy audio processing (echo cancellation, custom VAD) in the gateway itself.

## 9. Kokoro Quality Rankings
- **Artificial Analysis**: ELO 1,059 (#9 overall, #1 open-weight)
- **Informal comparisons**: "Comparable to ElevenLabs quality"
- **Reality**: Quality varies significantly by voice and text type. English conversational speech: competitive. Non-English, emotional speech, edge cases: cloud providers still ahead.
- **Resolution**: Kokoro is excellent value but not a universal cloud replacement. **Best for English neutral speech; supplement with cloud for everything else.**

## 10. Fish Audio Language Count
- **Some sources**: 30+ languages
- **Other sources**: 70+ languages
- **Resolution**: Likely depends on the model version and what counts as "supported." Some languages may be experimental or have significantly lower quality. **Verify quality per language** rather than trusting the count.
