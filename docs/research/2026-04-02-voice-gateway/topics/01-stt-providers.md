# STT Providers & Engines

## Original Scope
- Cloud STT: Deepgram, AssemblyAI, Google Cloud Speech, Azure Speech, Whisper API
- Self-hosted STT: Whisper, faster-whisper, Whisper.cpp, Distil-Whisper
- Streaming/real-time support — partial transcript delivery, VAD integration
- Latency benchmarks: time-to-first-transcript, end-to-end
- Accuracy comparison across accents, noise conditions, domain-specific vocab
- Pricing models: per-minute, per-character, free tiers, volume discounts
- GPU/CPU requirements for self-hosted options
- Language support breadth and quality

## Expanded Sub-Topics
- **Voice Activity Detection (VAD)**: Silero VAD, WebRTC VAD, provider-built-in VAD — how they interact with STT streaming
- **Endpointing strategies**: How to detect end-of-utterance for triggering LLM inference — timeout-based, semantic, energy-based
- **Word-level timestamps**: Which providers return them, usefulness for alignment and interruption handling
- **Speaker diarization**: Multi-speaker scenarios, which providers support inline diarization
- **Custom vocabulary / domain adaptation**: Medical, legal, technical jargon — provider support for boosting specific terms
- **Emerging self-hosted models**: Canary (NVIDIA), Parakeet, Universal-1 (AssemblyAI's model weights), Moonshine
- **Quantization and optimization**: INT8/INT4 whisper variants, ONNX runtime, TensorRT acceleration
- **Noise robustness**: How models handle background noise, echo cancellation prerequisites

## Adjacent Areas
- Audio preprocessing pipeline: noise gate, AGC, echo cancellation before STT
- Barge-in / interruption detection: how partial STT results enable user interruption of TTS playback
- Confidence scores and how to use them for retry/fallback logic

## Research Questions
1. What is the realistic end-to-end latency (mic capture to complete transcript) for each major cloud STT provider in streaming mode?
2. For self-hosted options, what is the minimum viable GPU to achieve real-time factor < 1.0 on streaming audio?
3. How do endpointing strategies differ across providers, and which give the developer most control?
4. What accuracy gap exists between the best self-hosted model (e.g., large-v3-turbo) and Deepgram Nova-3 on conversational English?
5. Which providers support WebSocket-based streaming with partial results and what are the API shape differences?
