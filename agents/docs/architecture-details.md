# Architecture Rules — Details & Examples

## Dependency Direction

Dependencies MUST flow inward. Outer layers know about inner layers, never reverse.

```
Infrastructure (providers, DB, HTTP)
  ↓ depends on
Application (use cases, orchestration)
  ↓ depends on
Domain (types, interfaces, business rules)
```

### Good Example — Gateway Provider

```typescript
// domain/providers.ts — interface (inner layer)
export interface STTProvider {
  transcribe(audio: AsyncIterable<Uint8Array>, signal: AbortSignal): AsyncGenerator<Transcript>;
}

// infrastructure/stt-service-client.ts — implementation (outer layer)
import type { STTProvider } from "../domain/providers.ts";

export function createSTTServiceClient(config: STTConfig): STTProvider {
  return { transcribe: async function* (audio, signal) { /* WS to STTService */ } };
}
```

### Bad Example — Domain importing infrastructure

```typescript
// domain/session.ts — WRONG: domain depends on infrastructure
import { createSTTServiceClient } from "../infrastructure/stt-service-client.ts"; // VIOLATION
```

## Feature-Based Organization

Group by what the code does, not what kind of file it is.

### Good

```
gateway/src/
  auth/
    verify-token.ts
    verify-token.test.ts
    session.ts
    session.test.ts
  pipeline/
    processor.ts
    processor.test.ts
    frame.ts
    frame.test.ts
```

### Bad

```
gateway/src/
  controllers/     # grouped by type — hard to navigate
  services/
  models/
  tests/           # tests separated from source — hard to find
```

## Decomposition

Split a file the moment its responsibilities diverge — let logical cohesion, not size, drive the boundary. A file doing more than one clear job wants splitting regardless of length; a long file with one tight responsibility does not.

Split strategies:
- Extract a helper function into its own file
- Split a type file into one-type-per-file
- Move test utilities into shared/testing/
