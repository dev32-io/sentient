// ══════════════════════════════════════════════════════════════════
// CONSUMER API DEMO — Developer uses codec negotiation in <50 lines
// Zero internal knowledge required. No sample rates, no PCM math.
// ══════════════════════════════════════════════════════════════════

import { AudioSession } from "./audio-session";

// ── CLIENT SIDE: 12 lines ──────────────────────────────────────

// 1. Create session (all defaults are sane — just works)
const audio = new AudioSession();

// 2. SDK transport sends capabilities on connect (developer never sees this)
const caps = audio.getCapabilities();
// → SDK serializes as session.start message, sends over WS

// 3. Gateway responds with session.ready (SDK calls this internally)
audio.applyNegotiatedFormat({ encoding: "pcm16", captureSampleRate: 48000, playbackSampleRate: 44100 });

// 4. Encode mic audio for sending
const micSamples = new Float32Array(512); // from AudioWorklet
const encoded = audio.encode(micSamples);
// → SDK sends encoded bytes over WS as binary frame

// 5. Decode gateway audio for playback
const fromGateway = new Uint8Array(1024); // from WS binary message
const playbackSamples = audio.decode(fromGateway);
// → SDK feeds playbackSamples to AudioWorklet

console.log("Client encoding:", audio.encoding);    // "pcm16"
console.log("Client ready:", audio.isReady);         // true
console.log("Encoded size:", encoded.byteLength);    // 1024 (512 samples * 2 bytes)
console.log("Decoded samples:", playbackSamples.length); // 512

// ── ADVANCED: Developer wants Opus (still <10 lines) ───────────

const opusAudio = new AudioSession({
  preferredEncoding: "opus",
  supportedEncodings: ["opus", "pcm16"],  // pcm16 fallback
});
const opusCaps = opusAudio.getCapabilities();
console.log("\nOpus client prefs:", opusCaps.preferredEncoding);    // "opus"
console.log("Opus fallbacks:", opusCaps.supportedEncodings);       // ["opus", "pcm16"]
// If gateway doesn't support Opus, it responds with pcm16 → SDK adapts, dev doesn't care

// ── GATEWAY SIDE: 8 lines ──────────────────────────────────────

import { GatewayNegotiator } from "./gateway-negotiator";

const negotiator = new GatewayNegotiator();  // defaults: pcm16, STT@16kHz, TTS@48kHz
const agreed = negotiator.negotiate(caps);   // returns session.ready payload
// → gateway sends agreed format back to client

// Audio flows through with zero developer effort:
const sttReady = negotiator.prepareForSTT(encoded);         // decode + resample 48→16kHz
console.log("\nSTT samples (16kHz):", sttReady.length);     // ~171 (512 * 16000/48000)

const ttsSamples = new Float32Array(480);                   // from TTS provider @48kHz
const clientReady = negotiator.prepareForClient(ttsSamples); // resample 48→44.1kHz + encode
console.log("Client-ready bytes:", clientReady.byteLength); // ~882 bytes

console.log("\n✓ Full negotiation + encode/decode/resample in <50 lines of consumer code");
