# Logging Rules — Details & Examples

## Tagged Logger Usage

Every file that does any logging must use the structured logger, never bare console methods.

### Good

```typescript
import { getLogger } from "../logging/logger.ts";

const logger = getLogger(["sentient", "tts", "fish-audio"]);

logger.debug("text-event-sent", { utteranceId, responseId, text, queueSize: queue.size() });
logger.info("ws-connected", { url: FISH_AUDIO_URL, latency: "balanced" });
logger.error("ws-error", { message: error.message, readyState: ws.readyState });
```

### Bad

```typescript
console.log("Sent text to Fish Audio:", text); // WRONG: no structure, no tag, no sanitizer
console.error(error); // WRONG: may leak sensitive data, no context
```

## Log at Component Boundaries

Every function that crosses a boundary (network call, decorator unit, WS message) logs its input and output.

### Good — Decorator unit logging

```typescript
const logger = getLogger(["sentient", "pipeline", "sanitizer"]);

async function* sanitizeTransform(input, signal) {
  for await (const chunk of input) {
    if (signal.aborted) return;
    const sanitized = sanitizeSpeech(chunk.speech);
    logger.debug("chunk-processed", {
      display: chunk.display,
      speechIn: chunk.speech,
      speechOut: sanitized,
    });
    yield { display: chunk.display, speech: sanitized };
  }
}
```

### Good — State change logging

```typescript
const logger = getLogger(["sentient", "session"]);

function setAssistantSpeaking(speaking: boolean): void {
  const prev = isAssistantSpeaking;
  isAssistantSpeaking = speaking;
  logger.debug("assistant-speaking-changed", { from: prev, to: speaking });
}
```

### Good — Service call logging

```typescript
const logger = getLogger(["sentient", "tts", "fish-audio"]);

socket.onopen = () => {
  logger.info("ws-opened", { url: FISH_AUDIO_URL });
  socket.send(buildFishAudioStartMessage(config));
  logger.debug("start-sent", { voiceId: config.voiceId, format: config.format });
  resolve();
};

socket.onmessage = (event) => {
  if (parsed.event === "audio") {
    queue.enqueue(chunk);
    logger.debug("audio-chunk-received", { bytes: parsed.audio.length, queueSize: queue.size() });
  } else if (parsed.event === "finish") {
    logger.debug("finish-received", { queueSize: queue.size() });
    queue.finish();
  }
};
```

## ID Tracing

Always include available IDs for cross-referencing log entries.

### Good

```typescript
logger.info("turn-start", { utteranceId, responseId, transcript, model: chatModel });
// ... later ...
logger.info("turn-end", { utteranceId, responseId, textLength: fullText.length, frameCount, durationMs });
```

### Bad

```typescript
logger.info("turn started"); // WRONG: no IDs, can't correlate with other entries
logger.info("done"); // WRONG: no context at all
```

## Debug vs Info

Use DEBUG for high-frequency data tracing. Use INFO for lifecycle events.

### DEBUG — every chunk, every token

```typescript
logger.debug("llm-token", { token, accumulatedLength: buffer.length });
logger.debug("audio-frame-yielded", { bytes: frame.data.length, queueDepth: queue.size() });
logger.debug("addToken", { token, bufferLength: buffer.length });
```

### INFO — lifecycle events

```typescript
logger.info("session-started", { sessionId, sttConnected: true, ttsConnected: true });
logger.info("turn-end", { responseId, durationMs: 1423, sentences: 5, audioFrames: 47 });
logger.info("client-disconnected", { sessionId, reason: "User disconnect" });
```

## Sensitive Data

The log sanitizer catches most sensitive data automatically. But avoid putting raw credentials in log messages when possible.

### Good

```typescript
logger.debug("auth-attempt", { sessionId, tokenPrefix: token.slice(0, 10) + "..." });
```

### Bad

```typescript
logger.debug("auth-attempt", { token }); // Sanitizer will catch it, but still avoid
```
