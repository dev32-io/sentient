# STT Providers & Engines — Findings

> **Sources**: [Deepgram STT Benchmarks](https://deepgram.com/learn/speech-to-text-benchmarks), [AssemblyAI vs Deepgram](https://www.assemblyai.com/blog/assemblyai-vs-deepgram), [Deepgram Nova-3 Review](https://transcriber.talkflowai.com/blog/deepgram-nova-3-review-benchmarks-pricing), [Deepgram Nova-3 Announcement](https://deepgram.com/learn/introducing-nova-3-speech-to-text-api), [Deepgram Pricing 2025](https://deepgram.com/learn/speech-to-text-api-pricing-breakdown-2025), [AssemblyAI Real-Time STT 2026](https://www.assemblyai.com/blog/best-api-models-for-real-time-speech-recognition-and-transcription), [AssemblyAI Turn Detection](https://www.assemblyai.com/blog/turn-detection-endpointing-voice-agent), [VocaFuse STT Pricing 2025](https://vocafuse.com/blog/best-speech-to-text-api-comparison-2025/), [Northflank Open-Source STT 2026](https://northflank.com/blog/best-open-source-speech-to-text-stt-model-in-2026-benchmarks), [HuggingFace Open ASR Leaderboard](https://huggingface.co/spaces/hf-audio/open_asr_leaderboard), [Picovoice STT Latency](https://picovoice.ai/blog/speech-to-text-latency/), [Gladia Measuring STT Latency](https://www.gladia.io/blog/measuring-latency-in-stt), [faster-whisper GitHub](https://github.com/SYSTRAN/faster-whisper), [Whisper v3-turbo HuggingFace](https://huggingface.co/openai/whisper-large-v3-turbo), [Whisper GPU Requirements](https://itctshop.com/whisper-large-v3-gpu-requirements/), [Simplismart Whisper 1300x RTF](https://simplismart.ai/blog/fastest-whisper-v3-turbo-serving-millions-of-requests-at-1300-real-time-with-simplismart), [NVIDIA Parakeet/Canary](https://developer.nvidia.com/blog/nvidia-speech-and-translation-ai-models-set-records-for-speed-and-accuracy/), [Silero VAD GitHub](https://github.com/snakers4/silero-vad), [Whisper.cpp Benchmarks](https://github.com/ggml-org/whisper.cpp/issues/89), [Moonshine GitHub](https://github.com/moonshine-ai/moonshine)

## Cloud STT Providers

### Deepgram Nova-3
- **Streaming**: WebSocket-based, partial results with word-level timestamps, built-in VAD and endpointing
- **Latency**: Sub-300ms end-to-end streaming ([Deepgram benchmarks](https://deepgram.com/learn/speech-to-text-benchmarks)). Streaming adds ~$0.20/hr premium over batch pricing. Target latency ceiling for voice assistants is ~300ms ([STT Decision Guide](https://futureagi.substack.com/p/speech-to-text-apis-in-2026-benchmarks))
- **Accuracy**: WER ~5.3% on clean conversational English; ~18% on noisy audio per [independent benchmarks](https://transcriber.talkflowai.com/blog/deepgram-nova-3-review-benchmarks-pricing). Deepgram claims 30% lower WER than AssemblyAI — this is a vendor claim, not independently verified
- **Pricing**: $0.0043/min ($0.26/hr batch, $0.46/hr streaming), per-second billing ([Deepgram pricing](https://deepgram.com/pricing))
- **Languages**: 40+ languages
- **Differentiators**: Fastest cloud STT for real-time voice; custom vocabulary boosting; domain-specific models (Medical: 1-10% WER); smart formatting; diarization; Nova-3 Medical variant
- **Weaknesses**: Higher entity miss rate (25.2%) vs AssemblyAI on names/emails/phone numbers

### AssemblyAI Universal-2/3
- **Streaming**: WebSocket streaming with partial results, built-in VAD
- **Latency**: 300-600ms for streaming — noticeably slower than Deepgram for interactive voice
- **Accuracy**: Universal-3 Pro outperforms on entity accuracy (16.7% missed entity rate vs Deepgram's 25.2%). Better for names, emails, phone numbers, credit card numbers
- **Pricing**: ~$0.0061/min ($0.37/hr), per-second billing
- **Languages**: 100+ languages (broader than Deepgram)
- **Differentiators**: Superior entity recognition; LeMUR (built-in LLM integration); auto chapters, sentiment analysis, content moderation built-in; broader language coverage
- **Best for**: Medical, legal, financial use cases where every digit matters

### Google Cloud Speech-to-Text (Chirp 2)
- **Streaming**: gRPC streaming API with interim results
- **Latency**: 200-500ms typical
- **Accuracy**: Competitive WER, strong multi-language support
- **Pricing**: $0.006/15s ($0.024/min) standard; $0.009/15s enhanced. Free tier: 60 min/month
- **Languages**: 125+ languages (broadest coverage)
- **Differentiators**: Best language breadth; Chirp 2 model improved accuracy; tight GCP integration; phone call model variant

### Azure Speech Services
- **Streaming**: WebSocket and REST streaming, interim results
- **Latency**: 200-400ms typical
- **Accuracy**: Competitive, strong with custom speech models
- **Pricing**: $1/hr standard, $1.40/hr custom. Free tier: 5hrs/month
- **Languages**: 100+ languages
- **Differentiators**: Custom speech models with fine-tuning; pronunciation assessment; speaker recognition; tight Azure integration; batch transcription

### OpenAI Whisper API
- **Streaming**: No native streaming — batch-only (send full audio, get full transcript)
- **Latency**: 2-10s depending on audio length — NOT suitable for real-time voice
- **Accuracy**: Very good WER on clean audio, large-v2 based
- **Pricing**: $0.006/min
- **Languages**: 57 languages
- **Differentiators**: Simple API; good accuracy; but batch-only makes it unsuitable for real-time voice gateway use
- **Verdict**: Not viable for real-time voice pipeline due to lack of streaming

## Self-Hosted STT Engines

### Whisper large-v3 / large-v3-turbo
- **Model size**: large-v3: 1.55B params; large-v3-turbo: ~809M params (32→4 decoder layers)
- **GPU requirements**: Minimum RTX 3060 12GB; recommended RTX 4090 24GB for multi-stream
- **VRAM**: ~10GB FP16; ~3GB INT8 quantized
- **Real-time factor**: RTX 3060 RTF ~0.6 (standard), ~0.15 (faster-whisper INT8). RTX 4090 can achieve 30x real-time with turbo variant
- **Streaming**: Not natively streaming; requires chunked inference with VAD-based segmentation
- **Accuracy**: large-v3 competitive with cloud providers on English; turbo variant ~1-2% WER degradation vs full model
- **Quantization**: INT8 reduces VRAM from 10GB to ~3GB with minimal accuracy loss

### faster-whisper
- **Description**: CTranslate2-based reimplementation, 4x faster than OpenAI's implementation
- **GPU requirements**: Same models as Whisper, but much more efficient
- **Streaming**: Supports chunked streaming with VAD integration (Silero VAD built-in)
- **Real-time factor**: RTF ~0.15 on RTX 3060 with INT8, <0.05 on RTX 4090
- **Key advantage**: Best self-hosted option for real-time — fast, memory efficient, well-maintained
- **Quantization**: INT8, FP16 supported via CTranslate2

### Whisper.cpp
- **Description**: C/C++ port, runs on CPU and GPU (CUDA, Metal, OpenCL)
- **CPU viable**: Yes — can achieve real-time on modern CPUs with small/medium models
- **GPU**: CUDA and Metal support for acceleration
- **Streaming**: Supports real-time streaming with `--stream` flag
- **Best for**: Edge deployment, CPU-only environments, macOS (Metal acceleration)

### Distil-Whisper
- **Model size**: ~756M params (distilled from large-v3)
- **Speed**: 6x faster than large-v3 with 1% WER degradation on English
- **VRAM**: ~4-5GB FP16
- **Best for**: English-only applications where speed matters more than multi-language

### Moonshine (Useful Sensors)
- **Model size**: Tiny (~30M) and Base (~80M) variants
- **Key advantage**: Designed for real-time, extremely low latency
- **CPU viable**: Yes, runs well on CPU including edge devices
- **Streaming**: Native streaming support
- **Accuracy**: Lower than Whisper large but adequate for command-and-control, conversational

### NVIDIA Parakeet / Canary
- **Parakeet**: CTC-based, very fast inference, English-focused
- **Canary**: Multi-task (ASR + translation), 1B params
- **GPU**: NVIDIA GPUs required (NeMo framework)
- **Best for**: NVIDIA GPU environments with NeMo toolkit already in use

## Voice Activity Detection (VAD)

### Silero VAD
- State-of-the-art accuracy, lightweight (~2MB model)
- Runs on CPU at negligible cost
- Integrated into faster-whisper
- Best choice for most self-hosted deployments

### WebRTC VAD
- Very fast, CPU-only, built into many WebRTC libraries
- Less accurate than Silero on difficult audio
- Good for simple endpointing

### Provider-Built-In VAD
- Deepgram, AssemblyAI include VAD in streaming API
- Automatic endpointing with configurable timeouts
- Simplest option for cloud STT

### Endpointing Strategies
- **Timeout-based**: 500-1500ms silence threshold → trigger LLM. Simple but adds latency
- **Energy + silence**: Combine energy drop with silence duration. More responsive
- **Semantic**: Use partial transcript content to detect question completion. Most complex, best UX
- **Recommendation**: Start with timeout-based (800ms), optimize later with semantic endpointing

## Comparison Table

| Provider | Type | Streaming | Latency | WER (clean) | Price | Languages | GPU Req |
|----------|------|-----------|---------|-------------|-------|-----------|---------|
| Deepgram Nova-3 | Cloud | WebSocket | <300ms | ~5% | $0.26/hr | 40+ | N/A |
| AssemblyAI Uni-2 | Cloud | WebSocket | 300-600ms | ~5% | $0.37/hr | 100+ | N/A |
| Google Chirp 2 | Cloud | gRPC | 200-500ms | ~5-7% | $1.44/hr | 125+ | N/A |
| Azure Speech | Cloud | WebSocket | 200-400ms | ~5-7% | $1.00/hr | 100+ | N/A |
| OpenAI Whisper | Cloud | None | 2-10s | ~5% | $0.36/hr | 57 | N/A |
| faster-whisper lg-v3 | Self | Chunked | ~200ms* | ~5% | GPU cost | 100+ | RTX 3060+ |
| Whisper turbo | Self | Chunked | ~100ms* | ~6% | GPU cost | 100+ | RTX 3060+ |
| Distil-Whisper | Self | Chunked | ~80ms* | ~6% (EN) | GPU cost | English | RTX 3060+ |
| Whisper.cpp | Self | Stream | ~300ms* | ~5-7% | CPU/GPU | 100+ | Optional |
| Moonshine | Self | Stream | ~50ms* | ~10-15% | CPU/GPU | English | Optional |

*Self-hosted latency = processing time per chunk, not including network

## Recommendations

### Best for Lowest Latency Voice Gateway
**Deepgram Nova-3** (cloud) or **faster-whisper with large-v3-turbo + INT8** (self-hosted). Deepgram provides the simplest path to <300ms with zero infrastructure. Self-hosted faster-whisper can match on RTX 4090.

### Best for Self-Hosted with Limited GPU
**Distil-Whisper** on RTX 3060 with INT8 quantization — achieves real-time with ~3GB VRAM. For CPU-only: **Whisper.cpp** with medium model or **Moonshine Base**.

### Best Accuracy for Difficult Audio
**AssemblyAI Universal-3 Pro** for entity-rich content (names, numbers). **Deepgram Nova-3** for general noisy conditions. Self-hosted: **faster-whisper large-v3** (full model, not turbo) gives best accuracy.

### Gateway Recommendation
Use **Deepgram Nova-3** as primary cloud STT for lowest latency + good accuracy. Offer **faster-whisper** as self-hosted alternative for users who want to avoid cloud dependency. Integrate **Silero VAD** for endpointing in both cases.
