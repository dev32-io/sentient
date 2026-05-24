# Provider Integration — Details & Examples

## Protocol Interface Pattern

Define provider contracts as TypeScript interfaces (structural typing):

```typescript
// domain/stt-provider.ts
export interface STTProvider {
  connect(config: STTConfig, signal: AbortSignal): Promise<void>;
  transcribe(audio: AsyncIterable<Uint8Array>, signal: AbortSignal): AsyncGenerator<TranscriptEvent>;
  disconnect(): Promise<void>;
}
```

Implementations satisfy the interface structurally — no `implements` keyword needed:

```typescript
// infrastructure/deepgram.ts
export function createDeepgramProvider(apiKey: string): STTProvider {
  return {
    async connect(config, signal) { /* ... */ },
    async *transcribe(audio, signal) { /* ... */ },
    async disconnect() { /* ... */ },
  };
}
```

## Circuit Breaker

```typescript
import { CircuitBreakerPolicy, ConsecutiveBreaker } from "cockatiel";

const breaker = new CircuitBreakerPolicy(
  new ConsecutiveBreaker(5),  // open after 5 consecutive failures
  { halfOpenAfter: 30_000 },  // probe after 30 seconds
);

const result = await breaker.execute(() => provider.transcribe(audio, signal));
```

## Config with Env Resolution

```yaml
# config.yaml
stt:
  url: ${STT_SERVICE_URL}
  model: whisper-large-v3
  endpointing_ms: 300
```

The config loader resolves `${VAR}` from environment at load time.
