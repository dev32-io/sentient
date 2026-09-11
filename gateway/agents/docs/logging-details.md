# Gateway Logging Details

This document applies the repository-wide
[logging rules](../../../agents/docs/logging-details.md) to gateway streams and
state machines.

## Privacy boundary

Use the tagged structured logger (`getLog`). Log lifecycle and control-plane
facts only. Never log:

- prompts, message text, transcripts, or streamed text deltas;
- content previews, even when truncated;
- tool arguments, tool results, permission argument values, or task previews;
- provider response bodies, arbitrary exception bodies, tokens, or secrets;
- raw JSON/binary frames or audio payloads.

A sanitizer is defense in depth, not permission to pass content into a log.
Browser and mobile logs follow the same rule because they may be uploaded.

## Stream logging

Do not log each token, audio chunk, frame, or generator yield, including at
DEBUG. High-frequency logs create volume, timing distortion, and a content
exposure surface.

Prefer one event at each meaningful lifecycle transition, with aggregate
counters on completion:

| Event | Level | Safe fields |
|---|---|---|
| Start/open | INFO or DEBUG | `sessionId`, `turnId`, stage/type, provider/model, configured limits |
| State transition | DEBUG | prior/next state, bounded reason code, queue depth |
| Soft failure/fallback | WARN | safe failure class, timeout/limit, retry/fallback decision |
| Abort/cancel | INFO or DEBUG | identifiers, cutoff kind, stage, aggregate dropped counts/bytes |
| Completion | INFO or DEBUG | status, duration, text character count, audio byte count, frame count, tool count |

For a long stream, maintain counters in memory and emit them once at a boundary.
A journal reaching its byte cap should log the transition into eviction plus
summary state, not one line for every evicted audio frame.

## Errors

External errors can contain user content. Map them to a stable safe category or
reason before logging. Log raw exception text only when the boundary guarantees
it cannot contain prompts, transcripts, tool payloads, URLs with credentials,
or response bodies. Otherwise retain the error for control flow and log its
class plus sanitized context.

Expected domain outcomes should use typed values. Catch and log failures at the
process or adapter boundary where identifiers, timeout configuration, and
cleanup outcome are known.

## Examples

```typescript
log.info("turn.started", { sessionId, turnId, trigger });
log.info("turn.completed", {
  sessionId,
  turnId,
  durationMs,
  textChars,
  toolCalls,
  audioBytes,
});
log.warn("provider.request.failed", {
  sessionId,
  turnId,
  provider,
  reason: "timeout",
  timeoutMs,
});
```

Do not add `preview`, `text`, `content`, `args`, `result`, `chunk`, or raw
`error` fields merely to make a post-mortem more convenient.
