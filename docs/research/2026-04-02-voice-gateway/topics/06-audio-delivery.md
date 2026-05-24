# Audio Delivery & Transport

## Original Scope
- WebSocket streaming — bidirectional, real-time, connection management
- Chunked HTTP — simpler, unidirectional, widely supported
- WebRTC — lowest latency, most complex
- Audio codecs: PCM, Opus, MP3, AAC — tradeoffs
- Buffering strategies on the client side
- How each TTS provider delivers audio
- Gateway output format standardization

## Expanded Sub-Topics
- **Jitter buffering**: Adaptive jitter buffer algorithms for smooth playback despite network variance
- **Opus codec deep dive**: Bitrate selection, frame sizes (2.5ms–60ms), CBR vs VBR for voice
- **Audio format negotiation**: How the client and gateway agree on codec, sample rate, channel count
- **Reconnection and resumption**: Handling dropped WebSocket connections mid-audio without audible gaps
- **Backpressure signaling**: How the client signals it's falling behind, and how the gateway responds
- **Latency measurement**: End-to-end latency instrumentation from text-ready to audio-heard
- **Cross-platform client considerations**: Browser Web Audio API, mobile native audio, Electron/desktop
- **Audio synchronization**: Keeping audio chunks in order, handling out-of-order delivery
- **Bandwidth estimation**: Adapting audio quality to network conditions

## Adjacent Areas
- Client SDK design: What a gateway client library should look like
- Phone/PSTN integration: SIP, Twilio Media Streams, FreeSWITCH for telephony use cases
- Compression vs latency: The tradeoff between smaller payloads and codec encode/decode time

## Research Questions
1. What is the optimal transport protocol for a voice gateway serving web clients (WebSocket vs WebRTC)?
2. What Opus encoding settings minimize latency while maintaining acceptable voice quality?
3. How should the client-side jitter buffer be designed for LLM-generated speech (bursty, variable-rate)?
4. What is the end-to-end latency budget breakdown from LLM token to audible speech?
5. How do existing voice platforms (LiveKit, Daily, Twilio) handle audio transport, and what can we learn?
