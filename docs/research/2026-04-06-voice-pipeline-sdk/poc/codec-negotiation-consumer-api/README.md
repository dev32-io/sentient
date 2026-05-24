# PoC: Codec Negotiation Consumer API

## What This Proves

A developer can use codec negotiation with **zero internal knowledge**:

- **Client side (12 lines)**: Create `AudioSession`, encode mic audio, decode playback audio. No sample rates, no PCM math, no codec selection logic.
- **Gateway side (8 lines)**: Create `GatewayNegotiator`, negotiate on connect, call `prepareForSTT()` / `prepareForClient()`. No manual resampling.
- **Advanced (3 extra lines)**: Request Opus with PCM16 fallback — negotiation handles mismatch.

## Key Design Decisions

1. **AudioSession is the only client-facing class** — wraps capabilities, negotiation, and codec into one object.
2. **GatewayNegotiator owns all resampling** — client never resamples. Gateway converts between client rates and provider rates.
3. **Codec registry is internal** — `getCodec("pcm16")` resolves automatically. Developer never imports a codec class.
4. **Negotiation is a simple request/response** — `session.start` → `session.ready`. No multi-round handshake.
5. **Fallback is automatic** — if gateway doesn't support preferred encoding, it picks best mutual match.

## Files

| File | Purpose |
|------|---------|
| `codec-types.ts` | Shared types: `AudioCapabilities`, `NegotiatedFormat`, `AudioCodec`, `Resampler` |
| `codecs.ts` | PCM16Codec, OpusCodec (stub), LinearResampler, codec registry |
| `audio-session.ts` | SDK surface — developer creates this |
| `gateway-negotiator.ts` | Gateway surface — negotiates + resamples |
| `demo-consumer.ts` | **Consumer API demo** — <50 lines of developer code |
| `demo-integration.ts` | Full round-trip simulation: mic → STT, TTS → playback |

## Run

```bash
npx tsx demo-consumer.ts
npx tsx demo-integration.ts
```
