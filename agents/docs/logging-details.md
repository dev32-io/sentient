# Logging — details

Use the repository's tagged structured logger (`getLog` in the gateway, `createLogger` in the web UI). Log lifecycle facts and sanitized metadata, not data payloads.

```typescript
const log = getLog(["sentient", "runtime", "turn"]);
log.info("turn.started", { sessionId, turnId, channel });
log.debug("audio.buffered", { sessionId, turnId, bytes, queueDepth });
log.warn("tool.denied", { sessionId, toolName, tier, reason });
```

Useful fields are stable IDs, event/type names, byte or character counts, durations, state transitions, provider/model names when non-secret, and bounded reason codes. Include enough identifiers to correlate a turn without exposing what the person said.

Never log prompts, message text, transcripts, tool arguments or results, raw frames, tokens, credentials, or audio. This applies to browser and mobile logs too: uploaded logs are not private. Do not rely on a sanitizer as permission to pass sensitive fields.

High-frequency token/audio/frame logging is prohibited, including at DEBUG. Prefer one lifecycle event and counters such as `textChars`, `audioBytes`, `frameCount`, or `durationMs`. Errors should record a safe error kind/reason; map arbitrary provider or exception text before logging if it can contain user data.
