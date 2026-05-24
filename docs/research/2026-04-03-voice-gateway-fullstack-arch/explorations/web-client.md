# Web Client

## Decision Area
Minimal web chat interface with push-to-talk voice, streaming responses, and guest access. Framework choice, audio capture/playback, and browser auth strategy.

## Key Questions
- Framework: what's the lightest-weight option for a simple chat + PTT UI?
- Audio capture: MediaRecorder vs AudioWorklet for push-to-talk Opus encoding?
- TTS playback: how to stream audio chunks from gateway and play seamlessly?
- Opus in browser: native MediaRecorder, WASM polyfill, or WebCodecs API?
- Guest auth in browser: URL token, PIN entry, QR code, or device cookie?
- Build tooling: Vite for dev/build?
- How does the web client differ from mobile clients (no wake word, text-first)?

## Prior Research
- Client-gateway protocol exploration established: WebSocket-only, binary Opus frames + JSON text control, PASETO auth handshake
- Security exploration defined guest token flow: ephemeral PASETO, restricted to read-tier tools
- Wake-word exploration confirmed: no wake word for web — text chat + PTT only
- Provider integration exploration confirmed: Opus 24kbps, 20ms frames, mono, 16kHz

## Approaches

### Approach A: Preact + Vite (Lightweight React-like)
Preact (~3 KB gzipped) with Vite build tooling. React-compatible API enables use of React ecosystem via aliasing. Hooks-based state management for WebSocket and audio. Familiar mental model for most developers.

### Approach B: Solid.js + Vite (Fine-grained Reactivity)
Solid.js (~7 KB gzipped) with signal-based reactivity. Best model for streaming data (partial transcripts, token-by-token LLM output). No virtual DOM — direct DOM updates. Slightly steeper learning curve.

### Approach C: Vanilla TypeScript + Vite (Zero Framework)
No framework overhead. Direct DOM manipulation with TypeScript. Simplest dependency profile. Appropriate if UI stays very minimal (single page, few interactive elements). Risk of maintenance burden if UI grows.

---

## Findings

### Framework Analysis

#### Preact (Recommended)
- **Bundle**: ~3 KB gzipped core, ~4.5 KB with hooks
- **TypeScript**: First-class `.tsx` support, types ship with package
- **WebSocket**: Standard `useEffect` + `useRef` lifecycle management
- **Web Audio**: `useRef` for AudioContext, standard cleanup patterns
- **Build**: `@preact/preset-vite` — excellent DX, fast HMR
- **Ecosystem**: ~36K GitHub stars, React compat-aliasing for broader library access
- **Why it wins**: Smallest bundle with the most familiar API. For a minimal chat UI that won't grow into a complex SPA, the React-like ergonomics with 1/15th the bundle is ideal.

#### Solid.js (Strong Alternative)
- **Bundle**: ~7 KB gzipped
- **TypeScript**: Written in TS, excellent type support
- **Streaming advantage**: Signals are a natural fit for streaming data — reactive updates without re-renders. `createSignal` + `createEffect` for WebSocket message state.
- **Trade-off**: Different mental model from React. JSX looks similar but semantics differ (no re-renders, no dependency arrays). Smaller component ecosystem.
- **When to prefer**: If the UI grows to handle complex real-time state (multiple concurrent streams, tool execution progress, etc.).

#### Vanilla TypeScript (Viable for MVP)
- **Bundle**: 0 KB framework overhead
- **Trade-off**: Manual DOM updates, event delegation, state management. Fine for a chat list + input box, but gets messy with streaming partial updates, tool confirmation dialogs, etc.
- **When to prefer**: If the web client is truly disposable/minimal and won't evolve.

#### Rejected Options
- **Alpine.js + HTMX**: ~29 KB combined (largest), weak TypeScript support, HTML-over-the-wire paradigm conflicts with binary WebSocket audio streams and Web Audio API. Poor fit.
- **Lit (Web Components)**: ~5 KB, decent TS support, but Shadow DOM adds unnecessary complexity for a simple chat UI. No clear advantage over Preact for this use case.

### Audio Capture: Push-to-Talk

#### MediaRecorder (Recommended for PTT)
```
User presses PTT -> AudioContext.resume() -> getUserMedia() -> MediaRecorder.start(100ms)
-> ondataavailable -> WebM/Opus chunks -> WebSocket binary frames -> Gateway

User releases PTT -> MediaRecorder.stop() -> send audio.end control message
```

- **Native Opus encoding** in Chrome and Firefox — no WASM needed
- `ondataavailable` with `timeslice: 100` gives 100ms chunks for streaming
- Output is containerized (WebM/Opus), not raw Opus frames
- Gateway needs to demux WebM container or transcode for STT provider
- **Safari caveat**: Safari's MediaRecorder supports MP4/AAC, not Opus. Needs polyfill.

#### AudioWorklet + WASM Opus Encoder (Advanced Path)
```
getUserMedia() -> AudioWorkletNode -> PCM samples via MessagePort
-> WASM libopus encoder -> raw Opus frames -> WebSocket binary -> Gateway (direct relay to STT)
```

- Full control over frame size, bitrate, sample rate
- Produces raw Opus frames matching gateway protocol exactly (no container demuxing)
- Significantly more complex: AudioWorkletProcessor, MessagePort communication, WASM loading
- **When to upgrade**: If WebM demuxing on the gateway becomes a pain point, or if you want the web client to produce frames identical to mobile clients

#### Safari Compatibility: opus-media-recorder
- WASM-based MediaRecorder polyfill using libopus/libogg compiled to WASM
- Drop-in replacement for native MediaRecorder
- Enables Opus output on Safari
- `npm install opus-media-recorder` — ~300 KB WASM asset

#### Future: WebCodecs API
- `AudioEncoder`/`AudioDecoder` with Opus codec now in Chrome/Firefox (2025-2026)
- Safari `AudioDecoder` in Technology Preview — not yet shipped
- Native browser Opus encode/decode without WASM
- **Monitor but don't depend on yet** — Safari lagging

### TTS Audio Playback

#### Approach: PCM Streaming via AudioWorklet (Recommended)
```
Gateway decodes Opus from TTS provider -> sends PCM16 chunks over WebSocket binary frames
-> Client AudioWorkletProcessor with ring buffer -> continuous playback

On barge-in: clear ring buffer immediately, stop playback
```

- Gateway handles Opus-to-PCM conversion (it already has the decoded audio for relay)
- Client receives PCM16 chunks (Int16Array), converts to Float32 (`sample / 32768.0`)
- AudioWorkletProcessor maintains a circular buffer, outputs samples continuously
- **No gap artifacts** — continuous buffer prevents inter-chunk silence
- Clear buffer on barge-in for instant interruption
- Library option: `web-audio-buffer-queue` provides ready-made queue node

#### Alternative: Chunked decodeAudioData
- Send self-contained WebM/Opus segments, decode each with `decodeAudioData()`
- Schedule playback with `AudioBufferSourceNode.start(time)` using AudioContext clock
- Simpler implementation but can produce audible gaps at chunk boundaries
- Better for lower-bandwidth scenarios where server-side Opus-to-PCM conversion is undesirable

#### Alternative: WebCodecs AudioDecoder (Future)
- Receive raw Opus frames over WebSocket
- Decode with `AudioDecoder` to `AudioData` (PCM), feed to AudioWorklet ring buffer
- Most elegant long-term solution, pending Safari support

### Guest Auth in Browser

#### Primary: URL Token + Device Cookie
1. Admin generates invite link: `https://assistant.local/chat?token=<PASETO>`
2. Client sends token in WebSocket auth handshake
3. On successful auth, server issues session cookie + client stores device token in localStorage
4. Subsequent visits: auto-auth from stored credential
5. **Family members**: long-lived token, persistent device recognition
6. **Security**: Token visible in URL bar/history — acceptable for trusted LAN. Use one-time tokens if sharing concern.

#### Guest Access: PIN Entry
1. Admin dashboard shows a rotating 6-digit PIN (valid 5 minutes)
2. Guest visits `https://assistant.local` — sees PIN input screen
3. Guest enters PIN — server validates, issues ephemeral PASETO (role: guest, expires: 4h)
4. Guest session: no persistent memory, read-tier tools only, auto-expire
5. **Why PIN over QR**: Works on same device (no camera needed), simpler to implement, intuitive

#### Optional: QR Code
- Display QR on family hub/admin panel encoding a one-time URL with guest token
- Nice for walk-up access at gatherings
- Requires camera, doesn't work on same device — secondary option

### UI Architecture

#### Component Structure (Preact)
```
App
+-- AuthGate                    # Token/PIN entry, device check
|   +-- PinEntry                # Guest PIN form
|   +-- TokenRedirect           # URL token handler
+-- ChatView                    # Main chat interface
|   +-- MessageList             # Scrolling message container
|   |   +-- UserMessage         # User text/voice input display
|   |   +-- AssistantMessage    # Streaming text response
|   |   +-- ToolMessage         # Tool execution results
|   +-- InputBar                # Text input + send button
|   +-- PTTButton               # Push-to-talk toggle
|   |   +-- VoiceIndicator      # Recording/processing state
|   +-- ToolConfirmDialog       # Modal for confirm-tier tool approval
+-- ConnectionStatus            # WebSocket connection indicator
```

#### State Management
- **No state library needed** — Preact hooks sufficient for this scale
- `useWebSocket` hook: manages connection, reconnection, message dispatch
- `useAudio` hook: manages AudioContext, MediaRecorder, playback buffer
- `useMessages` hook: message list, streaming partial updates
- `useAuth` hook: token storage, auth state, guest/family detection

#### Streaming Text Display
- LLM responses arrive as `response.text.partial` messages
- Append tokens to current assistant message in real-time
- Use `requestAnimationFrame` for batched DOM updates (avoid per-token re-render)
- Auto-scroll message list, but pause if user scrolled up (reading history)

#### Responsive Design
- Single-column layout, mobile-friendly (works on phone browser too)
- No complex responsive breakpoints — chat UI is naturally mobile-first
- PTT button: large, thumb-friendly, bottom of screen
- CSS: minimal custom styles, CSS variables for theming

### Build & Deploy

#### Tooling
- **Vite** with `@preact/preset-vite` — fast dev server, optimized production build
- TypeScript strict mode
- Output: static files (HTML + JS + CSS) served by the gateway's HTTP endpoint
- **No separate web server** — gateway serves static assets alongside WebSocket

#### Production Bundle Estimate
- Preact + hooks: ~4.5 KB
- App code: ~15-25 KB (estimated for chat UI + audio handling)
- opus-media-recorder WASM (Safari only, lazy-loaded): ~300 KB
- **Total (non-Safari)**: ~20-30 KB gzipped
- **Total (Safari, first load)**: ~320-330 KB gzipped

#### Project Structure
```
web-client/
+-- index.html
+-- src/
|   +-- main.tsx
|   +-- App.tsx
|   +-- components/
|   |   +-- ChatView.tsx
|   |   +-- MessageList.tsx
|   |   +-- InputBar.tsx
|   |   +-- PTTButton.tsx
|   |   +-- AuthGate.tsx
|   +-- hooks/
|   |   +-- useWebSocket.ts
|   |   +-- useAudio.ts
|   |   +-- useMessages.ts
|   |   +-- useAuth.ts
|   +-- types.ts
+-- vite.config.ts
+-- tsconfig.json
+-- package.json
```

### Key Design Decisions

1. **No wake word**: Web client is text-first with PTT voice as secondary. Users type or hold a button to talk. This keeps the web client simple and avoids always-on mic complexity in browser.

2. **Gateway serves static files**: No separate web server. The gateway's HTTP endpoint (already needed for health/metrics) serves the built web client assets. Simplifies deployment — one process, one port.

3. **MediaRecorder first, AudioWorklet later**: Start with the simplest audio capture path. If WebM container demuxing on the gateway is problematic, upgrade to AudioWorklet + WASM Opus encoder.

4. **PCM streaming for TTS playback**: Gateway converts Opus-to-PCM and streams PCM16 to web client. Simpler client-side playback via AudioWorklet ring buffer. Trades bandwidth for simplicity (PCM16 at 16kHz = 32KB/s vs ~3KB/s for Opus — acceptable on LAN).

5. **PIN for guests, URL token for family**: Different auth paths for different trust levels. Family gets persistent device recognition. Guests get time-limited ephemeral sessions.

### Constraints & Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Safari Opus support | Safari can't natively record Opus with MediaRecorder | opus-media-recorder WASM polyfill; monitor WebCodecs adoption |
| AudioWorklet browser support | Older browsers lack AudioWorklet | Fallback to ScriptProcessorNode (deprecated but functional) |
| WebSocket disconnect during PTT | Audio lost mid-recording | Buffer locally, retry send on reconnect; show connection indicator |
| PCM streaming bandwidth | 32KB/s per active TTS stream on LAN | Acceptable for LAN; switch to Opus-in-browser decode if remote access needed |
| Guest PIN brute-force | Attacker guesses 6-digit PIN | Rate limit: 3 attempts per IP per 5 minutes; PIN rotation every 5 min |

## Summary

**Recommended approach**: Preact + Vite, MediaRecorder for PTT capture (with opus-media-recorder Safari polyfill), PCM streaming via AudioWorklet for TTS playback, URL token + PIN for auth. Total bundle ~20-30 KB gzipped. The web client is intentionally minimal — a thin interface to the gateway's intelligence layer, not a feature-rich SPA.
