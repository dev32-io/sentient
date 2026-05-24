# Codec Negotiation — Alternative Approach: Profile-Based Capability Selection

## Approach Name: `capability-profiles`

## Core Idea

Instead of per-field negotiation (encoding, capture rate, playback rate as independent parameters), define **pre-baked audio profiles** that bundle all format decisions into named presets. The SDK auto-detects the best profile for its environment; the gateway accepts or downgrades to a supported alternative. Developers never see individual codec parameters — they see profile names like `"voice-standard"` or `"voice-low-bandwidth"`.

This contrasts with the first approach (`negotiation-protocol-layered`) which negotiates each field independently via `session.start` with `supportedEncodings`, `captureSampleRate`, `playbackSampleRate` as separate negotiable parameters.

## Why a Different Approach?

The per-field negotiation approach has combinatorial complexity: 2 encodings × N capture rates × M playback rates = many possible configurations, most of which are untested or nonsensical (e.g., Opus capture @ 8kHz → PCM16 playback @ 96kHz). Profile-based selection constrains the configuration space to tested, known-good combinations.

This aligns with the SDK design principle: "SDK = magic black box." Developers don't need to understand sample rates or encodings — they just get a working profile.

## Design

### Audio Profiles

```typescript
// shared/protocol/src/audio-profiles.ts
interface AudioProfile {
  name: string;
  capture: { encoding: "pcm16" | "opus"; sampleRate: number };
  playback: { encoding: "pcm16" | "opus"; sampleRate: number };
  maxBandwidthKbps: number;  // combined up + down
}

const PROFILES: Record<string, AudioProfile> = {
  "voice-standard": {
    name: "voice-standard",
    capture: { encoding: "pcm16", sampleRate: 48000 },
    playback: { encoding: "pcm16", sampleRate: 48000 },
    maxBandwidthKbps: 1536,  // ~192 KB/s bidirectional PCM16 mono
  },
  "voice-low-bandwidth": {
    name: "voice-low-bandwidth",
    capture: { encoding: "opus", sampleRate: 48000 },
    playback: { encoding: "opus", sampleRate: 48000 },
    maxBandwidthKbps: 64,    // ~8 KB/s bidirectional Opus @ 24kbps
  },
  "voice-compatible": {
    name: "voice-compatible",
    capture: { encoding: "pcm16", sampleRate: 16000 },
    playback: { encoding: "pcm16", sampleRate: 24000 },
    maxBandwidthKbps: 640,   // lower rates = less bandwidth
  },
};
```

### Session Handshake

```typescript
// Client → Gateway
{ type: "session.start", profiles: ["voice-standard", "voice-low-bandwidth"] }

// Gateway → Client
{ type: "session.ready", profile: "voice-standard" }
// or
{ type: "session.ready", profile: "voice-compatible", reason: "opus-not-supported" }
```

The gateway picks the first client-offered profile it supports, or falls back to `"voice-compatible"` (always supported). No field-level negotiation — just a priority-ordered list of profile names.

### SDK Auto-Detection

```typescript
// SDK internal — developer never sees this
function detectBestProfiles(): string[] {
  const profiles: string[] = [];
  
  // Check Opus support
  if (typeof AudioEncoder !== "undefined") {
    profiles.push("voice-low-bandwidth");
  }
  
  // Standard PCM always works
  profiles.push("voice-standard");
  
  // Compatible fallback always last
  profiles.push("voice-compatible");
  
  return profiles;
}
```

### Gateway Profile Resolution

```typescript
function resolveProfile(clientProfiles: string[]): { profile: AudioProfile; reason?: string } {
  const gatewaySupported = new Set(["voice-standard", "voice-compatible"]);
  // Opus support added when WASM encoder available:
  // gatewaySupported.add("voice-low-bandwidth");

  for (const name of clientProfiles) {
    if (gatewaySupported.has(name)) {
      return { profile: PROFILES[name] };
    }
  }
  // Ultimate fallback
  return { profile: PROFILES["voice-compatible"], reason: "no-matching-profile" };
}
```

### Gateway Audio Middleware (same as first approach)

Once a profile is selected, the gateway configures its audio middleware:

```typescript
function configureMiddleware(profile: AudioProfile, sttConfig: STTConfig, ttsConfig: TTSConfig) {
  return {
    inbound: createResampler(profile.capture.sampleRate, sttConfig.sampleRate),
    outbound: createResampler(ttsConfig.sampleRate, profile.playback.sampleRate),
    inboundCodec: getCodec(profile.capture.encoding),
    outboundCodec: getCodec(profile.playback.encoding),
  };
}
```

### Developer Experience

```typescript
// Developer code — profile selection is automatic
const voice = createVoiceClient({
  url: "wss://gateway.example.com/voice",
  // Optionally force a profile:
  // profile: "voice-low-bandwidth",
});

voice.on("ready", (info) => {
  console.log(`Using profile: ${info.profile}`);  // "voice-standard"
});

voice.connect();
voice.startListening();
```

Zero codec knowledge required. The SDK handles profile detection, negotiation, and all codec operations internally.

## Comparison with First Approach (negotiation-protocol-layered)

| Dimension | Per-Field Negotiation | Profile-Based Selection |
|-----------|----------------------|------------------------|
| **Configuration space** | Combinatorial (2×N×M) | Constrained (3-5 profiles) |
| **Testability** | Must test many combinations | Test each profile once |
| **Developer surface** | Fields: encoding, captureRate, playbackRate | Just a profile name |
| **Flexibility** | Maximum — any combo possible | Limited to defined profiles |
| **New codec support** | Add to enum, test all combos | Add new profile, test it |
| **Runtime adaptation** | Change individual fields | Switch entire profile |
| **Protocol complexity** | ~6 negotiable fields | 1 field (profile list) |
| **Backward compat** | Defaults match current behavior | "voice-compatible" profile matches current |

## Strengths of Profile-Based Approach

1. **Eliminates untested combinations.** Every profile is a tested, known-good configuration. No "PCM16 capture @ 8kHz with Opus playback @ 96kHz" surprises.

2. **Simpler protocol.** One list field in `session.start`, one string field in `session.ready`. No per-field negotiation logic.

3. **SDK simplicity.** Developer sees profile names, not codec internals. Aligns perfectly with "SDK = magic black box."

4. **Easier runtime adaptation.** If bandwidth drops, SDK can request profile switch: `{ type: "session.renegotiate", profiles: ["voice-low-bandwidth"] }`. Atomic swap, not piecemeal field changes.

5. **Gateway testing.** Test matrix is `O(profiles)` not `O(encodings × rates × rates)`.

## Weaknesses

1. **Less flexible.** If a client needs 44.1kHz playback specifically (e.g., matching an existing AudioContext), it can't negotiate that — must use the closest profile.

2. **Profile proliferation risk.** Edge cases may demand many profiles, approaching per-field complexity. Mitigated by keeping profiles minimal (3-5) and adding only when real demand exists.

3. **Sample rate mismatch within profiles.** The current system uses 48kHz capture / 44.1kHz playback. No single profile matches both. Either:
   - `voice-standard` uses 48kHz for both (client must create playback AudioContext at 48kHz — browser resamples internally)
   - Add `voice-standard-44` variant — starts profile proliferation

4. **Provider coupling.** Profiles must account for what providers actually support. If Deepgram needs 16kHz and Fish Audio outputs 48kHz, the gateway still needs per-provider resampling regardless of profile. The profile only governs the client↔gateway boundary.

## How It Fixes the Current Bugs

| Bug | Fix via Profile |
|-----|-----------------|
| STT rate mismatch (48kHz→16kHz) | Gateway middleware resamples based on profile's capture rate → STT's required rate. Same fix as first approach. |
| TTS encoding mismatch (Opus-as-PCM16) | Profile specifies playback encoding. Gateway middleware transcodes TTS output to match. |
| Playback pitch shift (48kHz→44.1kHz) | Profile standardizes playback rate (e.g., 48kHz). Client creates AudioContext at profile's rate. |
| No negotiation (dead session.start) | Profile handshake replaces dead session.start with working protocol. |

## Edge Cases

### AudioContext Rate Mismatch
Web Audio's AudioContext has an immutable sample rate. If the profile says 48kHz playback but the browser's default AudioContext is 44.1kHz, the SDK must create a new AudioContext at 48kHz. Most browsers support this. Safari may default to device rate — SDK detects and adjusts profile preference.

### Mid-Session Profile Switch
If bandwidth degrades, the SDK could send `session.renegotiate`. The gateway responds with new profile, flushes current audio, and both sides switch atomically. This is cleaner than changing individual codec parameters mid-stream.

### Custom Profiles
For advanced use cases, allow custom profile definitions:
```typescript
createVoiceClient({
  customProfile: {
    name: "my-custom",
    capture: { encoding: "pcm16", sampleRate: 44100 },
    playback: { encoding: "pcm16", sampleRate: 44100 },
  }
});
```
Gateway validates custom profiles against its capabilities and accepts or rejects.

## Implementation Sketch

1. **Define profiles** in `shared/protocol/src/audio-profiles.ts` (~40 LOC)
2. **Update session.start schema** to accept `profiles: string[]` (~5 LOC)
3. **Add session.ready schema** with `profile: string` (~5 LOC)
4. **SDK profile detection** — auto-detect best profiles based on browser capabilities (~30 LOC)
5. **Gateway profile resolver** — pick first supported profile from client list (~20 LOC)
6. **Gateway audio middleware** — configure resampler/transcoder based on resolved profile (~50 LOC, same as first approach)
7. **Backward compat** — if no `session.start` received, assume `voice-compatible` profile

Total: ~150 LOC, vs ~165 LOC for the per-field approach. Similar size, simpler protocol, constrained configuration space.

## Cross-Topic Dependencies

- **sdk-gateway-contract**: Profile handshake is the session lifecycle's first exchange
- **gateway-pipeline**: Audio middleware stage is identical regardless of approach — profile just determines its configuration
- **testing-strategy**: Profile-based testing is simpler — test each profile as a unit, not each field combination
- **client-vad**: VAD needs consistent frame sizes — profile's capture rate determines VAD frame size
- **error-ux**: Profile negotiation failure → "audio format not supported, using default" (same as first approach)
- **sdk-state-machine**: Profile resolution is a sub-state of the `connecting` state

## Verdict

Profile-based selection is **simpler at the protocol layer** and **more constrained at the configuration layer**, trading flexibility for testability. It's the better choice if the number of real-world codec combinations stays small (3-5), which is likely for a voice assistant focused on web + RPi5. If the project later needs fine-grained per-field control (e.g., diverse mobile clients with specific rate requirements), profiles can be extended with per-field overrides without breaking the protocol.

The gateway audio middleware is identical in both approaches — the difference is purely in how the client and gateway agree on what format to use.
