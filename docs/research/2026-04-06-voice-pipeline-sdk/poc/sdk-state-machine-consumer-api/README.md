# PoC: SDK State Machine — Consumer API

## What This Proves

A developer can integrate voice into their app in **<50 lines** with zero knowledge of:
- WebSocket protocol details
- Audio codecs or sample rates
- STT/TTS/LLM provider internals
- State machine transition tables

## Files

| File | Purpose |
|------|---------|
| `state-machine.ts` | SDK internals: pure `transition()` function + `VoiceClient` wrapper |
| `consumer-example.ts` | Vanilla JS integration — 35 lines of actual code |
| `consumer-preact.tsx` | Preact/React hook — 32 lines with `useVoice()` hook |
| `consumer-api.test.ts` | 20 tests validating the consumer experience (57 assertions) |

## Key Design Decisions

1. **Single `VoiceStatus` object** — developers read one thing: `{ state, label, canSpeak, isActive, transcript, error }`. No need to understand state machine internals.

2. **`onStatusChange` callback** — one subscription drives the entire UI. Framework-agnostic.

3. **`send()` for events, convenience methods for common actions** — `voice.connect()` is sugar over `voice.send({ type: "CONNECT" })`. Power users send raw events; casual users use methods.

4. **`canSpeak` boolean** — hides the complexity of "when is the user allowed to talk?" (listening + assistant-speaking for barge-in). Developer just checks one boolean.

5. **`onEffect` for platform wiring** — the SDK runtime calls this to let the host app wire WebSocket, audio, etc. In tests, it's a recorder. In production, it's the real transport layer.

## Run Tests

```bash
npx tsx consumer-api.test.ts
```

## Transferability Assessment

- The `VoiceClient` class maps directly to what would ship in `shared/sdk/`
- The `useVoice()` hook replaces the current 4 separate hooks in `web/src/hooks/`
- The pure `transition()` function is immediately testable without any browser/audio/WS dependencies
- Effect executor pattern means the same state machine works on web, mobile, and in tests
