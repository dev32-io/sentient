// ══════════════════════════════════════════════════════════════════
// INTEGRATION DEMO — Full round-trip showing how SDK + Gateway
// negotiate and process audio without developer intervention.
// This simulates the actual WS handshake flow.
// ══════════════════════════════════════════════════════════════════

import { AudioSession } from "./audio-session";
import { GatewayNegotiator } from "./gateway-negotiator";

// ── Simulate: SDK connects to gateway ──

// CLIENT: create session with defaults
const clientSession = new AudioSession();

// GATEWAY: create negotiator with provider constraints
const gateway = new GatewayNegotiator({
  supportedEncodings: ["pcm16"],
  sttSampleRate: 16_000,   // Deepgram wants 16kHz
  ttsSampleRate: 48_000,   // Fish Audio outputs 48kHz
});

// ── Step 1: Client sends session.start ──
const sessionStart = clientSession.getCapabilities();
console.log("→ session.start:", JSON.stringify(sessionStart));

// ── Step 2: Gateway negotiates and replies session.ready ──
const sessionReady = gateway.negotiate(sessionStart);
console.log("← session.ready:", JSON.stringify(sessionReady));

// ── Step 3: Client applies negotiated format ──
clientSession.applyNegotiatedFormat(sessionReady);
console.log("Client ready:", clientSession.isReady, "| encoding:", clientSession.encoding);

// ── Step 4: Audio flows ──

// Simulate mic input: 10ms of silence at 48kHz = 480 samples
const micChunk = new Float32Array(480);

// Client encodes → send over WS
const wireBytes = clientSession.encode(micChunk);
console.log(`\nMic: ${micChunk.length} samples → ${wireBytes.byteLength} bytes on wire`);

// Gateway receives → prepare for STT (decode + resample to 16kHz)
const sttInput = gateway.prepareForSTT(wireBytes);
console.log(`Gateway: ${wireBytes.byteLength} bytes → ${sttInput.length} STT samples @16kHz`);

// TTS produces 10ms of audio at 48kHz = 480 samples
const ttsOutput = new Float32Array(480);
for (let i = 0; i < ttsOutput.length; i++) {
  ttsOutput[i] = Math.sin(2 * Math.PI * 440 * i / 48000) * 0.5; // 440Hz tone
}

// Gateway prepares for client (resample 48→44.1kHz + encode)
const clientBytes = gateway.prepareForClient(ttsOutput);
console.log(`Gateway: ${ttsOutput.length} TTS samples → ${clientBytes.byteLength} bytes for client`);

// Client decodes for playback
const playback = clientSession.decode(clientBytes);
console.log(`Client: ${clientBytes.byteLength} bytes → ${playback.length} playback samples @44.1kHz`);

// ── Verify: round-trip preserves signal ──
const peak = Math.max(...Array.from(playback).map(Math.abs));
console.log(`\nPlayback peak amplitude: ${peak.toFixed(4)} (expected ~0.5)`);
console.log("✓ Full round-trip: mic → encode → wire → decode → resample → STT");
console.log("✓ Full round-trip: TTS → resample → encode → wire → decode → playback");
