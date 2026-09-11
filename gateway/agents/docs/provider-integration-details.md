# Provider Integration — Details

## LLM provider boundary

The native ReAct loop consumes `ProviderClient` from
[`../../src/provider/provider-client.ts`](../../src/provider/provider-client.ts):

```typescript
export interface ProviderClient {
  stream(req: ProviderRequest): AsyncGenerator<ProviderStreamChunk>;
}
```

A request carries model messages, the immutable tool definitions for that
session, and an `AbortSignal`. The stream yields text, complete tool calls, and
a terminal completion record. The OpenAI-compatible implementation is
[`../../src/provider/openai-provider.ts`](../../src/provider/openai-provider.ts).

Provider credentials and the active provider are resolved from the gateway
secrets store. `config.yaml#orchestrator.provider` supplies non-secret defaults
and limits such as model, base URL fallback, output cap, reasoning effort, and
request timeout. Do not add a second environment-only provider path.

The ReAct loop owns provider-call policy:

- re-read the append-only store before each iteration;
- pass the same mediated tool definitions throughout a turn;
- propagate cancellation;
- bound both request setup and mid-stream silence;
- append tool calls and results before another model iteration;
- force the final iteration to be content-only.

Provider output and exception text are untrusted. Validate tool arguments at
the broker boundary, and log only safe types, identifiers, counts, timing, and
mapped reasons—never prompts, deltas, tool payloads, or provider response
previews.

## STT adapter boundary

[`../../src/adapters/stt/stt-adapter-types.ts`](../../src/adapters/stt/stt-adapter-types.ts)
defines the gateway-facing STT contract. The current adapter is
[`../../src/adapters/stt/local-stt-adapter.ts`](../../src/adapters/stt/local-stt-adapter.ts)
and dials the native whisper-stt service at:

```text
ws://127.0.0.1:8768
```

The configured URL receives `language` and `audioFormat` query parameters. PCM
input is downsampled to 16 kHz before send; Opus input is forwarded unchanged.
The service owns VAD, semantic/manual turn handling, and transcription.
Connection setup is bounded by `stt.connect_timeout_ms`, and session
cancellation closes the socket/iterator.

## TTS provider boundary

[`../../src/providers/tts/tts-types.ts`](../../src/providers/tts/tts-types.ts)
defines the provider lifecycle. The current implementation is
[`../../src/providers/tts/local-tts-provider.ts`](../../src/providers/tts/local-tts-provider.ts)
and dials LocalTTSService at:

```text
ws://127.0.0.1:8770
```

One synthesis run opens a JSON+binary WebSocket, waits for `ready`, pushes text,
sends `end`, and consumes Opus audio. The caller must dispose the provider on
normal completion as well as cancellation because the service keeps reusable
connections open. The live contract is Opus at 48 kHz.

## Deployment boundary

The gateway, whisper-stt, and local-tts are native host processes. Docker is
used for managed MCP/infrastructure addons, not for the gateway or these audio
services. The gateway reaches addons through loopback or their configured
ingress policy; do not use Docker DNS or `host.docker.internal` in provider
configuration.
