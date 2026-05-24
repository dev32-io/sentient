# Self-Hosted TTS Engines — Findings

> **Sources**: [TTS Arena Leaderboard](https://tts-agi-tts-arena-v2.hf.space/leaderboard) — ELO rankings, [Artificial Analysis TTS](https://artificialanalysis.ai/text-to-speech), [BentoML Open-Source TTS 2026](https://bentoml.com/blog/exploring-the-world-of-open-source-text-to-speech-models), [Modal TTS Models](https://modal.com/blog/open-source-tts), [Inferless TTS Comparison](https://www.inferless.com/learn/comparing-different-text-to-speech---tts--models-part-2), [Kokoro-FastAPI Docker](https://github.com/remsky/Kokoro-FastAPI), [Kokoro TTS Review](https://reviewnexa.com/kokoro-tts-review/), [Chatterbox-Turbo HuggingFace](https://huggingface.co/ResembleAI/chatterbox-turbo), [Chatterbox GitHub](https://github.com/resemble-ai/chatterbox), [Voxtral TTS Announcement (Mistral)](https://mistral.ai/news/voxtral-tts) — 4B params, beats ElevenLabs Flash v2.5 in 68.4% human pref tests, [Voxtral vLLM Deployment (Red Hat)](https://developers.redhat.com/articles/2026/02/06/run-voxtral-mini-4b-realtime-vllm-red-hat-ai), [CosyVoice2-0.5B HuggingFace](https://huggingface.co/FunAudioLLM/CosyVoice2-0.5B), [Dia-1.6B HuggingFace](https://huggingface.co/nari-labs/Dia-1.6B), [Piper TTS GitHub](https://github.com/rhasspy/piper), [StyleTTS2 GitHub](https://github.com/yl4579/StyleTTS2), [MetaVoice Benchmark (Salad)](https://blog.salad.com/metavoice-benchmark), [ElevenLabs Alternatives (ocdevel)](https://ocdevel.com/blog/20250720-tts), [Trelis TTS Rankings](https://trelis.substack.com/p/top-text-to-speech-tts-models-in)

## Model Deep Dives

### Kokoro (82M params)
- **Parameters**: 82M — extremely lightweight
- **Quality**: ELO 1,059 on Artificial Analysis leaderboard (#9 overall, #1 among open-weight models). Quality comparable to models 10-20x larger
- **VRAM**: ~500MB FP16 — can coexist with other models on any modern GPU
- **GPU Requirements**: Runs on virtually any NVIDIA GPU. CPU inference viable with ONNX
- **Real-Time Factor**: 96x real-time on basic cloud GPU. Sub-0.3s processing for all text lengths
- **Streaming**: Supports streaming inference
- **Voice/Style Control**: Multiple speaker voices, style tokens for speed/tone
- **Voice Cloning**: Limited — preset voices, not general zero-shot cloning
- **Cost**: ~$0.70/1M chars (compute cost estimate)
- **Languages**: English primary, expanding to other languages
- **Deployment**: PyTorch, ONNX export, easily containerized
- **Verdict**: Best price-performance ratio in self-hosted TTS. Ideal for applications that need low-cost, fast inference with good quality English speech

### Chatterbox / Chatterbox-Turbo (Resemble AI)
- **Parameters**: ~350M
- **VRAM**: ~2-4GB FP16
- **GPU Requirements**: Minimum RTX 3060, recommended RTX 4090
- **Latency Claims**: Sub-200ms inference (marketing). Chatterbox-Turbo optimized for speed
- **Voice Cloning**: Key differentiator — 63.75% preference rate vs ElevenLabs in Resemble's testing. Clone from seconds of audio
- **Quality Issues**: Independent benchmark showed 86% CER (Character Error Rate) in some tests — severe quality problems with certain inputs. 4.0 MOS score. May have issues with longer text or edge cases
- **Streaming**: Supported
- **License**: Open-source (Apache 2.0)
- **Verdict**: Promising for voice cloning but reliability concerns. The high CER in benchmarks suggests it may not be production-ready for all inputs. Test thoroughly before deploying

### Voxtral (Mistral)
- **Background**: Open-source from Mistral, reportedly beat ElevenLabs Flash v2.5 in blind tests
- **Quality**: 4.1 MOS, 25% CER in independent testing
- **Critical Issue**: Premature termination — model frequently inserts end tokens before completing text. This is a significant reliability problem
- **Model Size**: Large (multi-billion parameter, as it's a multimodal model)
- **GPU Requirements**: High — requires substantial VRAM
- **Verdict**: Quality potential exists but premature termination bug makes it unreliable for production voice gateway use. Wait for fixes

### CosyVoice2-0.5B (Alibaba/FunAudioLLM)
- **Parameters**: 500M
- **VRAM**: ~3-4GB FP16
- **Streaming Latency**: 150ms claimed — one of the fastest streaming self-hosted options
- **Streaming**: Native streaming support — generates audio chunks before full text processing
- **Voice Cloning**: Zero-shot and few-shot cloning
- **Languages**: Chinese + English, expanding
- **Quality**: Good for Chinese, decent for English
- **License**: Apache 2.0
- **Verdict**: Excellent for Chinese language applications. English quality is adequate but not best-in-class. Native streaming is a strong plus

### Coqui TTS (XTTS v2)
- **Parameters**: ~400M
- **Languages**: 17 languages — broadest self-hosted multi-language support
- **Voice Cloning**: From 6 seconds of reference audio
- **Quality**: Good but not state-of-the-art compared to newer models
- **Project Status**: Coqui (the company) shut down. Model is community-maintained. Active forks exist but long-term maintenance uncertain
- **GPU Requirements**: ~4GB VRAM minimum
- **Streaming**: Supported but less optimized than newer models
- **Verdict**: Still viable for multi-language applications. Voice cloning from minimal audio is a strong feature. But community maintenance introduces risk for production use

### Dia (Nari Labs)
- **Key Feature**: Multi-speaker dialogue generation — can generate conversations between speakers
- **Parameters**: ~1.6B
- **Use Case**: Generating podcasts, dialogues, not primarily for real-time voice gateway
- **Streaming**: Limited
- **Verdict**: Interesting for content generation but not suited for real-time voice gateway

### Parler-TTS (Hugging Face)
- **Key Feature**: Text-described voice control — describe the voice you want in natural language ("a young woman speaking slowly with a warm tone")
- **Parameters**: ~880M
- **Quality**: Moderate — innovative concept but quality behind dedicated TTS models
- **Streaming**: Supported
- **Verdict**: Novel approach to voice control but quality not competitive for production use

### StyleTTS2
- **Key Feature**: Style transfer, highly natural speech
- **Parameters**: ~150M
- **Quality**: Excellent naturalness, competitive MOS scores
- **Streaming**: Limited streaming support
- **GPU Requirements**: Low VRAM (~1-2GB)
- **Verdict**: Good quality but limited streaming support hampers real-time use

### Piper
- **Key Feature**: CPU-friendly, ONNX-based, extremely fast on CPU
- **Parameters**: Various sizes (16M - 100M+)
- **CPU Viable**: Absolutely — designed for CPU deployment, runs on Raspberry Pi
- **Latency**: Very low on CPU (50-200ms depending on voice)
- **Quality**: Lower than cloud or larger GPU models — functional but robotic compared to neural models
- **Languages**: 30+ languages with community-contributed voices
- **Streaming**: Supported
- **Use Case**: Edge devices, embedded systems, CPU-only servers
- **Verdict**: Best option for CPU-only deployment. Quality acceptable for utility applications but not for premium voice experiences

### MetaVoice
- **Key Feature**: Zero-shot voice cloning, emotional speech
- **Parameters**: ~1.2B
- **Quality**: Competitive, good emotion expression
- **GPU Requirements**: ~6-8GB VRAM
- **Status**: Relatively new, less battle-tested
- **Verdict**: Promising but needs more community validation

## Serving Frameworks

### Triton Inference Server (NVIDIA)
- Enterprise-grade, supports dynamic batching
- Best for: High-throughput production deployments
- Complexity: High setup, NVIDIA ecosystem lock-in
- Batching: Excellent dynamic batching reduces per-request cost

### BentoML
- Python-first, easy model packaging
- Best for: Teams comfortable with Python, need quick deployment
- Includes: Auto-batching, async serving, Docker export

### Ray Serve
- Distributed serving, autoscaling
- Best for: Multi-model deployments, complex pipelines
- Integrates with Ray ecosystem

### FastAPI + Custom
- Simplest approach — wrap model in FastAPI endpoint
- Best for: Single-model deployment, prototypes, small scale
- Add uvicorn workers for concurrency
- Implementation pattern:
```python
from fastapi import FastAPI
from fastapi.responses import StreamingResponse

app = FastAPI()

@app.post("/synthesize")
async def synthesize(text: str, voice: str = "default"):
    async def generate_audio():
        async for chunk in tts_model.stream_synthesize(text, voice):
            yield chunk
    return StreamingResponse(generate_audio(), media_type="audio/opus")
```

### Recommendation
**FastAPI** for getting started and small-scale. **BentoML** for production packaging. **Triton** only if you need maximum throughput and are already in the NVIDIA ecosystem.

## GPU Requirements Comparison Table

| Model | Params | VRAM (FP16) | Min GPU | RTF@4090 | Streaming | Clone | Quality |
|-------|--------|-------------|---------|----------|-----------|-------|---------|
| Kokoro | 82M | ~500MB | Any / CPU | 96x RT | Yes | No | A- |
| Chatterbox | 350M | ~2-4GB | RTX 3060 | ~10x RT | Yes | Yes | B+ (variable) |
| CosyVoice2 | 500M | ~3-4GB | RTX 3060 | ~15x RT | Yes | Yes | B+ |
| XTTS v2 | 400M | ~4GB | RTX 3060 | ~5x RT | Limited | Yes | B |
| StyleTTS2 | 150M | ~1-2GB | Any GPU | ~20x RT | Limited | No | A- |
| Piper | 16-100M | ~200MB | CPU OK | RT+ on CPU | Yes | No | C+ |
| Voxtral | Multi-B | ~16GB+ | RTX 4090 | ~2x RT | No | No | B+ (buggy) |
| MetaVoice | 1.2B | ~6-8GB | RTX 3080 | ~3x RT | Limited | Yes | B+ |

*RTF = Real-Time Factor. Higher is better (10x RT = generates 10s of audio in 1s)*

## Quantization Impact

### FP16 → INT8
- **Speed improvement**: 1.5-2x faster inference
- **Quality impact**: Minimal — usually imperceptible for TTS
- **VRAM reduction**: ~50%
- **Recommendation**: Always use INT8 for production unless quality testing shows degradation

### INT8 → INT4
- **Speed improvement**: Additional 1.2-1.5x
- **Quality impact**: Noticeable for some models — test per model
- **VRAM reduction**: Additional ~50%
- **Recommendation**: Only for resource-constrained environments, test thoroughly

### TensorRT Acceleration
- Fastest inference option for NVIDIA GPUs
- 2-5x speedup over PyTorch
- Requires model conversion and NVIDIA GPU
- Worth it for production deployments with high traffic

### ONNX Runtime
- Cross-platform acceleration (CPU + GPU)
- 1.5-3x speedup over PyTorch on CPU
- Piper uses ONNX natively — already optimized
- Good option for CPU deployment of smaller models

## Quality vs Cloud

### Where Self-Hosted Matches Cloud
- **Kokoro**: Matches mid-tier cloud providers (Deepgram Aura, Google WaveNet) on English
- **StyleTTS2**: Naturalness competitive with ElevenLabs Turbo for certain voices

### Where Cloud Still Wins
- **Voice cloning quality**: ElevenLabs professional cloning > any self-hosted option
- **Emotion control**: Fish Audio's 50+ tags, ElevenLabs' stability controls
- **Multi-language**: Cloud providers cover 50-140+ languages; self-hosted rarely exceeds 17
- **Consistency**: Cloud providers more consistent across inputs; self-hosted can have edge cases (Chatterbox CER issues, Voxtral truncation)

### Hybrid Strategy (Recommended)
```
Request arrives:
  if language == "en" AND emotion == "neutral":
    → Self-hosted Kokoro (cheapest, fastest)
  elif needs_voice_cloning:
    → ElevenLabs (best cloning)
  elif needs_emotion_control:
    → Fish Audio (richest emotion tags)
  else:
    → Cartesia (best latency/quality for non-English)
```

## Deployment Patterns

### Docker Compose (Development/Small Scale)
```yaml
services:
  tts-kokoro:
    image: custom-kokoro-tts:latest
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    ports:
      - "8001:8001"
    environment:
      - MODEL_PATH=/models/kokoro-82m
      - MAX_BATCH_SIZE=8
```

### Production Checklist
1. Health check endpoint that tests actual inference (not just HTTP 200)
2. Prometheus metrics: inference_latency, queue_depth, gpu_utilization
3. Graceful shutdown: drain queue before stopping
4. Model warmup on startup (first inference is slow due to CUDA initialization)
5. GPU memory monitoring and OOM protection
