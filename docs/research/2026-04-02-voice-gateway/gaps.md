# Research Gaps — What's Weak, What Needs More Work

## Critical Gaps

### 1. Real-World End-to-End Latency Measurements
**What's missing**: No source provides measured end-to-end latency (user speaks → user hears response) for a complete pipeline. All latency figures are per-stage, and real-world pipeline latency is worse than the sum due to scheduling overhead, serialization, and network variance.
**Impact**: Our latency budget estimates (660-1750ms) are theoretical. Actual measurements could be 20-50% higher.
**What would strengthen this**: Build a prototype, measure actual end-to-end latency with different provider combinations, publish results.

### 2. Concurrent User Performance
**What's missing**: How do self-hosted TTS models degrade under concurrent load? All benchmarks are single-request latency. What happens with 10, 50, 100 simultaneous TTS requests on a single GPU?
**Impact**: Can't accurately model self-hosted capacity planning.
**What would strengthen this**: Load testing Kokoro/CosyVoice2 with concurrent requests on RTX 4090, measuring latency percentiles (p50, p95, p99).

### 3. Echo Cancellation for Barge-In
**What's missing**: When TTS audio is playing through speakers and the user speaks, the microphone picks up TTS audio. How to separate user speech from echoed TTS? This is critical for barge-in but barely covered in voice agent framework documentation.
**Impact**: Barge-in may not work reliably without acoustic echo cancellation (AEC). Most frameworks assume the client handles AEC.
**What would strengthen this**: Research browser-based AEC (Web Audio API constraints), client-side echo cancellation libraries, and how LiveKit/WebRTC handle this.

### 4. Multi-Language Pipeline Testing
**What's missing**: Almost all benchmarks and examples are English-only. How do the recommended providers (Deepgram, Cartesia, Kokoro) perform on non-English languages? What changes are needed in the preprocessing pipeline for languages with different sentence boundary rules (Chinese, Japanese, Arabic)?
**Impact**: Gateway may not work well for non-English use cases without significant adaptation.
**What would strengthen this**: Testing each provider on 5-10 common languages, documenting quality gaps and preprocessing requirements.

## Moderate Gaps

### 5. Preprocessing Pipeline Latency
**What's missing**: How much time does the text preprocessing step (markdown stripping, number normalization, sentence detection) actually add? We assume it's negligible (<5ms) but haven't measured it with realistic LLM output.
**Impact**: Probably low, but could be higher with complex normalization (e.g., SSML generation).
**What would strengthen this**: Benchmark the preprocessing pipeline on 1000 real LLM outputs.

### 6. Long Conversation Memory Management
**What's missing**: Voice conversations can last 30+ minutes. How to manage context window? Simple approaches (sliding window, summarization) are described but not tested. What's the impact of context truncation on conversation quality?
**Impact**: Long conversations may degrade in quality or fail if context management isn't well-designed.
**What would strengthen this**: Test different context strategies (sliding window, periodic summarization, semantic compression) on 30-minute conversations.

### 7. Provider Migration and Portability
**What's missing**: If you build with Cartesia TTS and later want to switch to ElevenLabs, what breaks? Custom voices, API format differences, audio format differences. How portable are voice clones?
**Impact**: Vendor lock-in risk not well quantified.
**What would strengthen this**: Document specific migration requirements between each provider pair.

### 8. Security Considerations
**What's missing**: Audio data privacy, compliance (GDPR, HIPAA for medical), API key management for multiple providers, preventing voice cloning abuse, audio data retention policies.
**Impact**: May block enterprise adoption without clear security guidance.
**What would strengthen this**: Security review of the gateway architecture, compliance checklist.

### 9. Mobile Client Implementation
**What's missing**: Most examples focus on web browsers. Mobile (iOS/Android) has different audio APIs, background audio restrictions, and codec support. What are the specific implementation requirements for mobile clients?
**Impact**: Mobile users are a major use case for voice assistants.
**What would strengthen this**: Document iOS AVAudioEngine and Android AudioTrack/Oboe integration patterns.

## Minor Gaps

### 10. SSML Cross-Provider Compatibility
**What's missing**: Which SSML tags work across all major providers? Is there a portable subset? The findings note provider-specific support but don't identify a common denominator.
**What would strengthen this**: Test each SSML tag across Cartesia, ElevenLabs, Fish Audio, Azure, Google and document a compatibility matrix.

### 11. Cost Modeling Validation
**What's missing**: Our cost projections assume 5 min voice output/user/day. What are actual usage patterns in production voice applications? The estimate may be too high or too low.
**What would strengthen this**: Published usage data from production voice applications.

### 12. Error Recovery UX
**What's missing**: When things go wrong (TTS fails, LLM times out), what should the user experience be? Silence? A beep? "Let me try again"? No UX research on voice error states.
**What would strengthen this**: User testing of different error recovery strategies.

## Self-Critique Summary

**Strongest areas**: Cloud provider comparison (25+ cited sources with pricing/latency), architecture patterns (informed by Pipecat/LiveKit/Vocode analysis with framework-specific code), latency analysis (concrete per-stage numbers from Twilio ~1.1s mouth-to-ear, Cresta decomposition), STT benchmarks (HuggingFace Open ASR Leaderboard, Northflank 2026).

**Weakest areas**: Self-hosted concurrent performance (no load testing data), non-English coverage (English-centric research), echo cancellation (critical for barge-in but under-researched), PSTN/SIP integration depth.

**What a challenger would question**:
1. "Your latency budget is theoretical — have you actually built and measured it?"
2. "You recommend Cartesia for latency but the independent benchmark shows 199ms, not <40ms"
3. "How does barge-in actually work when the mic picks up speaker audio?"
4. "What about non-English languages — does any of this work for Chinese/Arabic/Hindi?"
5. "Your cost model assumes 5 min/user/day — where does that number come from?"
