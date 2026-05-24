# Bun TypeScript — Details & Examples

## AsyncGenerator Pattern

All streaming operations (STT, LLM, TTS) use AsyncGenerator for composability.

```typescript
async function* streamLLMResponse(
  prompt: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const response = await openai.chat.completions.create({
    model: "anthropic/claude-haiku",
    messages: [{ role: "user", content: prompt }],
    stream: true,
  });

  for await (const chunk of response) {
    if (signal.aborted) return;
    const content = chunk.choices[0]?.delta?.content;
    if (content) yield content;
  }
}

// Consumer — always clean up
const generator = streamLLMResponse(prompt, controller.signal);
try {
  for await (const token of generator) {
    process(token);
  }
} finally {
  await generator.return(undefined); // mandatory cleanup
}
```

## AbortSignal Threading

Every async function that calls an external service MUST accept AbortSignal:

```typescript
export async function transcribe(
  audio: AsyncIterable<Uint8Array>,
  signal: AbortSignal,  // REQUIRED
): AsyncGenerator<Transcript> { /* ... */ }
```

## Zod Validation at Boundaries

```typescript
import { z } from "zod";

const configSchema = z.object({
  port: z.number().int().min(1).max(65535),
  host: z.string().min(1),
});

// Validate at boundary
const config = configSchema.parse(rawConfig); // throws ZodError
// or
const result = configSchema.safeParse(rawConfig); // returns { success, data/error }
```
