# Decorator-Pattern Details — Gateway

Gateway-specific applications of the decorator-pattern (root rule:
`.claude/rules/decorator-pattern.md`).

## Multi-Cycle TTS Boundaries (ACP Protocol)

Each Hermes ACP `session/update` carrying an assistant message is one
agent micro-turn (intermediate narration → tool calls → final answer).
The ACP event-translator (`hermes-adapter-client/event-translator.ts`)
converts the update to an `InternalEvent`; the AcpHermesClient adapter
maps that onto a `text.delta` HermesEvent with a trailing `\n`. The
gateway's utterance-aggregator uses `\n` as a flush boundary:

1. Hermes completes a cycle iteration, emits a `session/update` with the
   assistant text.
2. Gateway's translator emits `InternalEvent { assistant.message }`.
3. AcpHermesClient maps to `text.delta { delta: "<text>\n" }`.
4. Utterance-aggregator sees `\n`, flushes pending text to TTS.
5. TTS plays per-cycle (snappy), not waiting for the final answer.
6. Webui renders a paragraph break for the cycle.

`cycle.done` (mapped from the ACP `session/prompt` response) is the cycle
terminator. Without per-cycle boundaries, intermediate narration sits
buffered until the final answer arrives. The trailing `\n` is the
contract — don't strip it in the translator.
