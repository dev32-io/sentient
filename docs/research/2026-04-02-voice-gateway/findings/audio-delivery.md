# Audio Delivery & Transport — Findings

> **Sources**: [Opus Recommended Settings (Xiph)](https://wiki.xiph.org/Opus_Recommended_Settings) — VoIP voice: 10-24kbps, 20ms default frame, [RFC 6716 Opus Codec](https://tools.ietf.org/html/rfc6716), [RFC 6455 WebSocket Protocol](https://tools.ietf.org/html/rfc6455), [LiveKit Architecture](https://docs.livekit.io/home/), [WebRTC Latency (VideoSDK)](https://www.videosdk.live/developer-hub/webrtc/webrtc-latency) — sub-150ms achievable, [WebRTC Powers Voice AI (GetStream)](https://getstream.io/blog/webrtc-ai-voice-video/), [TEN Framework WebSocket Voice AI](https://theten.ai/blog/building-real-time-voice-ai-with-websockets) — 20-40ms packet sweet spot, [Twilio Media Streams Tutorial](https://www.twilio.com/docs/voice/tutorials/consume-real-time-media-stream-using-websockets-python-and-flask), [Deepgram WebSocket vs REST TTS](https://deepgram.com/learn/websocket-vs-rest-text-to-speech), [WebRTC NetEQ Jitter Buffer (WebRTC Hacks)](https://webrtchacks.com/how-webrtcs-neteq-jitter-buffer-provides-smooth-audio/), [Improved Jitter Buffer Management (ACM)](https://dl.acm.org/doi/fullHtml/10.1145/3410449), [MDN AudioContext outputLatency](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/outputLatency), [Audio Output Latency (web.dev)](https://web.dev/articles/audio-output-latency), [Cresta Voice Agent Latency](https://cresta.com/blog/engineering-for-real-time-voice-agent-latency), [Sierra Low-Latency Voice](https://sierra.ai/blog/voice-latency), [Modal 1-Second Voice-to-Voice](https://modal.com/blog/low-latency-voice-bot), [Vapi SIP Trunking](https://docs.vapi.ai/advanced/sip/sip-trunk) — PSTN adds 200-500ms, [WebRTC-to-PSTN (OnSIP)](https://www.onsip.com/voip-resources/voip-fundamentals/webrtc-to-pstn-calling), [WebRTC in Kubernetes (WebRTC.ventures)](https://webrtc.ventures/2025/02/watch-webrtc-live-99-running-webrtc-media-servers-in-kubernetes-2/)

## Transport Protocols

### WebSocket Streaming (Recommended for Most Cases)

**How it works**: Persistent bidirectional connection. Gateway sends binary audio frames to client, client can send audio (for STT) or control messages back.

**Connection Lifecycle**:
1. Client opens WebSocket to `ws://gateway/v1/audio`
2. Negotiation: client sends config (codec, sample rate, session ID)
3. Streaming: gateway sends binary audio frames, client plays them
4. Keepalive: ping/pong every 30s to detect dead connections
5. Teardown: either side closes with close frame

**Latency Characteristics**:
- Connection setup: ~50-100ms (TCP + WebSocket handshake)
- Per-frame overhead: ~2-6 bytes (WebSocket framing)
- Latency: ~1-5ms over TCP on good networks
- Total additional latency vs raw TCP: negligible

**Reconnection Strategy**:
```
On disconnect:
  1. Buffer last 2s of unplayed audio
  2. Reconnect with exponential backoff (100ms, 200ms, 400ms...)
  3. Send session ID to resume
  4. Server resends from last acknowledged frame
  5. Client discards duplicates, continues playback
```

**Browser Support**: All modern browsers via WebSocket API. No plugins needed.

**Best For**: Voice gateways — bidirectional, low overhead, well-understood, wide support.

### WebRTC

**How it works**: Peer-to-peer (or via SFU) media transport with SRTP encryption. Audio travels over UDP with automatic congestion control.

**Two approaches for voice gateway**:
1. **Media tracks**: Gateway publishes an audio track, client subscribes. Standard WebRTC.
2. **DataChannel**: Binary data channel for arbitrary audio frames. More control, less automatic.

**Latency advantage**: 
- WebRTC: 20-50ms end-to-end (UDP, no head-of-line blocking)
- WebSocket over TCP: 30-100ms (TCP retransmissions can cause spikes)
- Advantage: ~10-30ms lower average, much better tail latency

**Complexity Cost**:
- ICE/STUN/TURN signaling: 200-2000ms connection setup
- NAT traversal: requires TURN server for ~10-15% of connections
- Codec negotiation: automatic but adds setup time
- More infrastructure: need STUN/TURN servers or use LiveKit/Daily

**Existing Infrastructure**:
- **LiveKit**: Open-source Go SFU, handles all WebRTC complexity. Best option if you want WebRTC
- **Daily.co**: Hosted WebRTC infrastructure, simple API
- **Janus**: Open-source WebRTC server, C-based, mature

**When WebRTC is Worth It**:
- High-quality bidirectional voice (like a phone call)
- Need <50ms latency consistently
- Already using LiveKit or similar infrastructure
- Building on existing WebRTC platform

**When WebSocket is Better**:
- Simpler deployment (no STUN/TURN)
- Primarily server→client audio (TTS playback)
- Don't need the absolute lowest latency
- Want to avoid WebRTC complexity

### Chunked HTTP Streaming

**How it works**: `Transfer-Encoding: chunked` response. Server sends audio data as HTTP chunks.

**Pros**: 
- Simplest to implement — standard HTTP
- Works through any proxy/CDN
- No persistent connection management

**Cons**:
- Unidirectional (server → client only)
- No backpressure signaling from client
- Higher overhead per request (HTTP headers)
- Connection per request (no reuse for multiple utterances)

**Best for**: Simple audio playback, non-interactive scenarios, single-response applications.

**Not suitable for**: Interactive voice with barge-in, bidirectional audio.

## Audio Codecs for Voice

### Opus (Recommended)

**Why Opus**: Designed specifically for interactive speech. The codec of choice for WebRTC, Discord, and most real-time voice applications.

**Optimal Settings for Voice Gateway**:
```
Sample rate: 24kHz (matches most TTS output)
Channels: Mono
Bitrate: 24-32kbps (excellent quality for voice)
Frame size: 20ms (good balance of latency and efficiency)
Application: OPUS_APPLICATION_VOIP (optimized for voice)
Mode: CBR (constant bitrate — predictable bandwidth)
Complexity: 5-7 (balance of quality and CPU)
```

**Frame Size Tradeoffs**:
| Frame Size | Latency | Efficiency | Use Case |
|-----------|---------|-----------|----------|
| 2.5ms | Lowest | Poor (high overhead) | Ultra-low latency (rarely needed) |
| 5ms | Very low | Fair | Interactive voice with <10ms requirement |
| 10ms | Low | Good | Real-time voice (good default for gateway) |
| 20ms | Medium | Best | Most voice applications (recommended) |
| 40-60ms | Higher | Excellent | Streaming music, non-interactive |

**Encode/Decode Latency**: ~0.1ms — negligible.

**Browser Support**: Native in all modern browsers (Chrome, Firefox, Safari, Edge). Decoded via WebAudio API or MediaSource Extensions.

**Bandwidth**: At 24kbps mono, a 1-minute audio clip is ~180KB. Very bandwidth-efficient.

### PCM (Raw Audio)

**Format**: 16-bit signed integers, little-endian, mono
**Sample rates**: 16kHz (telephone), 24kHz (HD voice), 44.1/48kHz (full quality)

**Bandwidth**: At 24kHz/16-bit: 384kbps = 48KB/s. ~8x more than Opus.

**When to use**:
- Between internal gateway components (STT output → LLM, TTS output → encoder)
- Local/LAN deployments where bandwidth is unlimited
- When you need zero encode/decode latency

**Not for**: Client delivery over internet — too much bandwidth.

### MP3

**Latency problem**: MP3 encoder adds 576-1152 sample delay (~26-52ms at 44.1kHz). Not ideal for real-time.
**Decoder startup**: MP3 decoder needs to find sync frame, adds startup latency.
**Best for**: Cached/recorded audio, non-real-time playback.

### AAC

**Latency**: Lower than MP3 but higher than Opus (~20-40ms).
**Browser support**: Universally supported.
**Best for**: iOS applications where Opus decoding might have issues (though modern iOS supports Opus).

### Codec Comparison

| Codec | Bitrate (voice) | Encode Latency | Quality | Browser | Best For |
|-------|----------------|----------------|---------|---------|----------|
| Opus | 16-32kbps | <1ms | Excellent | All modern | Real-time voice (default) |
| PCM 16-bit | 256-768kbps | 0ms | Perfect | Via WebAudio | Internal pipeline |
| MP3 | 32-64kbps | ~30-50ms | Good | Universal | Cached audio |
| AAC | 32-64kbps | ~20-40ms | Good | Universal | iOS compat |
| μ-law (G.711) | 64kbps | <1ms | Telephone | Via WebAudio | PSTN/telephony |

## Client-Side Audio

### Jitter Buffering for LLM-Generated Speech

LLM-generated TTS audio is **bursty**: chunks arrive in bursts (when sentences complete) with gaps (while LLM generates next sentence). This differs from live audio which has consistent packet rates.

**Adaptive Jitter Buffer Algorithm**:
```
target_buffer = 200ms  // Start with 200ms buffer
min_buffer = 50ms
max_buffer = 500ms
alpha = 0.1  // Smoothing factor

on_chunk_received(chunk):
    jitter = abs(actual_arrival - expected_arrival)
    avg_jitter = alpha * jitter + (1-alpha) * avg_jitter
    target_buffer = clamp(2 * avg_jitter, min_buffer, max_buffer)
    
    enqueue(chunk)
    if buffer_duration() > target_buffer:
        start_playback()
```

**Key insight**: For LLM TTS, use a **larger initial buffer** (200-300ms) than typical VoIP (20-50ms) because the first chunk is the critical path — subsequent chunks should arrive while the first chunk plays.

### Web Audio API Playback

```javascript
class AudioPlayer {
    constructor() {
        this.audioContext = new AudioContext({ sampleRate: 24000 });
        this.nextPlayTime = 0;
    }
    
    async playChunk(opusData) {
        const audioBuffer = await this.audioContext.decodeAudioData(opusData);
        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.audioContext.destination);
        
        const now = this.audioContext.currentTime;
        const playTime = Math.max(now, this.nextPlayTime);
        source.start(playTime);
        this.nextPlayTime = playTime + audioBuffer.duration;
    }
    
    stop() {
        // Cancel all scheduled sources
        this.nextPlayTime = 0;
    }
}
```

**Key considerations**:
- `AudioContext` must be created from user gesture (click/tap) due to autoplay policies
- Use `AudioWorklet` for more control over playback timing
- Mobile browsers may pause audio when app is backgrounded

### Gapless Playback Between Chunks
- Schedule each chunk's start time to be exactly when the previous chunk ends
- Use `AudioContext.currentTime` for precise scheduling
- Pre-decode next chunk while current chunk plays
- If gap is unavoidable, insert 50-100ms of silence (less jarring than a pop)

## Latency Budget

### End-to-End Target: <1000ms (good), <500ms (excellent)

| Stage | Time (Cloud) | Time (Self-Hosted) | Notes |
|-------|-------------|-------------------|-------|
| STT processing | 200-400ms | 100-200ms | Includes endpointing wait |
| Network: client→server | 20-50ms | 5-20ms | Depends on location |
| LLM TTFT | 200-500ms | 50-150ms | Model dependent |
| LLM first sentence | 200-500ms | 100-300ms | ~20 tokens at 30-100 tok/s |
| Text preprocessing | 1-5ms | 1-5ms | Negligible |
| TTS TTFA | 40-500ms | 50-200ms | Provider dependent |
| Audio encoding | <1ms | <1ms | Opus encoding is fast |
| Network: server→client | 20-50ms | 5-20ms | Depends on location |
| Client jitter buffer | 50-200ms | 50-200ms | Configurable |
| **Total** | **733-2200ms** | **362-1095ms** | |

### Optimization Priorities (highest impact first)
1. **LLM TTFT**: Use fastest model available (GPT-4o-mini, Haiku, or self-hosted 8B)
2. **TTS TTFA**: Use Cartesia Sonic-Turbo (<40ms) or Kokoro
3. **STT endpointing**: Reduce silence timeout from 1000ms to 500-700ms
4. **Streaming overlap**: Start TTS as first sentence completes, not after full LLM response
5. **Jitter buffer**: Tune for minimum viable buffer (100-150ms)

## Platform Comparisons

### LiveKit (WebRTC SFU)
- Go-based SFU handles all WebRTC complexity
- Agent joins room as participant, publishes audio track
- Built-in: STUN/TURN, room management, recording
- Latency: <50ms audio transport
- Open-source, self-hostable

### Twilio Media Streams
- WebSocket-based (not WebRTC) — simpler
- Sends μ-law 8kHz audio (telephone quality)
- Bidirectional: receive caller audio, send TTS audio
- For PSTN/phone integration specifically
- Pricing: per-minute call charges + media stream charges

### Daily.co
- Hosted WebRTC, simple API
- Supports server-side bots (like LiveKit Agents)
- Less customizable than LiveKit
- Good for: Teams that don't want to run WebRTC infrastructure

## Phone/PSTN Integration

### SIP Trunking
- Connect gateway to phone network via SIP
- Providers: Twilio, Telnyx, Vonage
- Audio format: μ-law G.711 8kHz (standard) or Opus (modern)
- Requires: SIP stack (FreeSWITCH, Asterisk, or cloud provider SDK)

### Twilio Media Streams API
```
Call arrives → Twilio → WebSocket to your gateway
                         ↓
                   Receive μ-law audio → STT
                   Send TTS audio back → μ-law
```
- Simplest path to phone integration
- 8kHz μ-law — lower quality than web-based voice
- Pricing: $0.0085/min (US) + media stream charge

### FreeSWITCH
- Open-source telephony platform
- Connects SIP trunks to your gateway via WebSocket or event socket
- Handles call control, recording, conferencing
- More complex but more flexible than Twilio

## Recommendations

### Best Transport for Web-Based Voice Gateway
**WebSocket** for most applications. Simpler deployment, adequate latency (<5ms overhead), bidirectional, wide browser support. Use WebRTC (via LiveKit) only if you need <50ms transport latency or are building on existing WebRTC infrastructure.

### Best Codec Settings for Voice
**Opus** at 24kHz, mono, 24kbps, 20ms frame size, CBR, VOIP application mode. This gives excellent voice quality at minimal bandwidth.

### Optimal Jitter Buffer
Start with **150ms target buffer**, adaptive range 50-300ms. Increase if users report choppy audio; decrease if latency complaints. For LLM TTS, the bursty nature means slightly larger buffers work better than aggressive low-latency settings.

### Gateway Audio Architecture
```
TTS Output (PCM 24kHz)
  → Opus Encoder (24kbps, 20ms frames)
  → WebSocket Binary Frames
  → Client Opus Decoder (Web Audio API)
  → AudioContext Playback with Scheduling

STT Input:
  Client Mic → Opus Encoder (browser)
  → WebSocket Binary Frames
  → Gateway Opus Decoder
  → PCM 16kHz → STT Engine
```
