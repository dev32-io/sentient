# Self-Hosted TTS Engines

## Original Scope
- Chatterbox / Chatterbox-Turbo: 350M params, sub-200ms inference, Resemble AI
- Kokoro: 82M params, lightweight, quality comparable to larger models
- Voxtral: open-source, beat ElevenLabs Flash v2.5 in blind tests
- CosyVoice2-0.5B: 150ms streaming latency
- Coqui TTS: 17 languages, voice cloning from 6s
- GPU requirements per model
- Quality vs cloud comparison
- Deployment: Docker images, serving frameworks
- Voice cloning capabilities per engine
- Latency under load

## Expanded Sub-Topics
- **Serving frameworks**: Triton Inference Server, BentoML, Ray Serve, custom FastAPI — pros/cons for TTS serving
- **Batching strategies**: Dynamic batching for concurrent requests, impact on latency vs throughput
- **Model quantization**: FP16, INT8, INT4 — quality degradation vs speed gains per model
- **Streaming inference**: Which models support true streaming output (generating audio before full text is processed)
- **Multi-GPU scaling**: Sharding vs replication, load balancing across GPUs
- **VRAM requirements**: Detailed per-model VRAM usage, can multiple models coexist on one GPU?
- **CPU-only inference**: Which models are viable on CPU (Kokoro, Piper), latency expectations
- **Voice quality benchmarking**: MOS comparisons, TTS Arena rankings, naturalness vs intelligibility
- **Fine-tuning**: Which models support fine-tuning on custom voice data, data requirements
- **Emerging models**: Dia (Nari Labs), MetaVoice, Parler-TTS, StyleTTS2

## Adjacent Areas
- Audio post-processing: Normalization, silence trimming, format conversion after synthesis
- Hybrid cloud/self-hosted: Using self-hosted for baseline, cloud for premium voices
- Monitoring: Tracking inference latency, VRAM usage, error rates in production

## Research Questions
1. Which self-hosted TTS model offers the best quality-to-resource ratio for real-time voice applications?
2. What is the realistic latency profile (TTFA, full synthesis time) for each model on an RTX 4090 vs A100?
3. Can any self-hosted model match ElevenLabs or Cartesia quality for English conversational speech?
4. What is the most production-ready serving setup for self-hosted TTS (Docker + serving framework)?
5. How does quality degrade with quantization, and which models are most resilient to it?
