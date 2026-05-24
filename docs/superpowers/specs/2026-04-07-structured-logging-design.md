# Structured Logging System

## Context

The gateway uses ad-hoc `console.*` calls with no structure, no persistent files, no log levels, and no way to trace a request through the pipeline. Debugging requires guessing. This adds a proper structured logging system with persistent files, per-unit tags, millisecond timestamps, and environment-aware log levels.

## Design

### Library: LogTape

`@logtape/logtape` + `@logtape/file`. Zero dependencies, native Bun support, built-in daily file rotation, ~2x faster than Pino. Good fit for resource-constrained Pi.

### Log Entry Format

Every line: millisecond ISO timestamp, level, tag (source), event name, structured key-value context.

```
2026-04-07T20:34:12.847Z DEBUG [tts:fish-audio] text-event-sent | utteranceId=utt-1712 responseId=resp-4821 text="Once upon a time." queueSize=0
2026-04-07T20:34:12.903Z DEBUG [tts:fish-audio] audio-chunk-received | utteranceId=utt-1712 encoding=opus bytes=960 queueSize=1
2026-04-07T20:34:13.001Z INFO  [pipeline:sanitizer] chunk-processed | display="**Hello**" speech="Hello"
2026-04-07T20:34:13.102Z DEBUG [session] state-change | from=listening to=user-speaking trigger=SPEECH_START
```

Format: `{iso-ms} {LEVEL padded} [{tag}] {event} | {key=value pairs}`

### Logger Hierarchy (Tags)

```
sentient                        — root
  ├── session                   — continuous-session lifecycle, state changes
  ├── pipeline                  — voice-turn orchestration
  │   ├── pipeline:sanitizer    — TTS text sanitizer input/output
  │   ├── pipeline:aggregator   — sentence boundaries, flush events
  │   └── pipeline:overlap      — terminal stage text/audio events
  ├── stt                       — Deepgram STT
  │   └── stt:transcript        — every transcript event with confidence
  ├── tts                       — TTS processor
  │   └── tts:fish-audio        — Fish Audio WS lifecycle, text/audio/finish events
  ├── llm                       — OpenRouter LLM streaming
  ├── ws                        — WebSocket server, client connections
  │   └── ws:handler            — message dispatch, turn lifecycle
  └── auth                      — PASETO auth, session management
```

Each unit: `getLogger(["sentient", "tts", "fish-audio"])` → tag in output: `[tts:fish-audio]`.

### Log Levels by Environment

| Level | Dev (LOG_LEVEL=debug, default) | Prod/Docker (LOG_LEVEL=info) |
|-------|-------------------------------|------------------------------|
| DEBUG | Every buffer size, every chunk, every state change, full text content | OFF |
| INFO | Same as prod | SDK in/out, turn lifecycle, service connect/disconnect, response summaries |
| WARN | Same as prod | Degraded service, high latency, threshold breaches |
| ERROR | Same as prod | Service failures, unhandled errors, connection drops |

Controlled by `LOG_LEVEL` env var (`debug`, `info`, `warn`, `error`). When unset: defaults to `debug` (logs everything). Docker sets `LOG_LEVEL=info` in the Dockerfile `ENV` directive.

### File Output

- **Dev:** `gateway/logs/{date}.log` (e.g., `2026-04-07.log`) + console (colored). Daily rotation, old files preserved.
- **Docker:** stdout only by default. Mount `gateway/logs/` to `/var/log/sentient/` for file persistence.
- `gateway/logs/` added to `.gitignore`.

LogTape's `@logtape/file` handles daily rotation — new file per day.

### Log Sanitizer

**File:** `gateway/src/logging/log-sanitizer.ts`

A sink wrapper that intercepts every log entry before it reaches console or file sinks. Two layers:

1. **Key-based scrubbing** on structured properties: any key matching `token`, `apiKey`, `api_key`, `secret`, `password`, `authorization`, `pin` → value replaced with `[REDACTED]`
2. **Pattern-based scrubbing** on the serialized message string: PASETO tokens (`v4.local.\S+`), Bearer tokens (`Bearer \S+`), long hex/base64 strings that look like keys

Both layers — belt and suspenders. Wraps the actual sinks so it's impossible to bypass.

```
// Before sanitizer:
DEBUG [auth] token-verified | token=v4.local.abc123...xyz sessionId=sess-42

// After sanitizer:
DEBUG [auth] token-verified | token=[REDACTED] sessionId=sess-42
```

### What Gets Logged — Debug Build

**Session:** every state change (from/to/trigger), connect/disconnect, barge-in events with transcript, echo cooldown start/end, early audio buffer flush count

**Pipeline (voice-turn):** turn start (utteranceId, responseId, transcript), each PipelineOutput event (text display content, audio frame bytes), turn end (total text length, frame count, duration ms)

**Sanitizer:** input chunk (display + speech), output chunk (display + sanitized speech), stripped character count

**Sentence aggregator:** addToken with current buffer length, sentence boundary detected with sentence text, flush with remaining buffer content

**TTS terminal stage (overlap):** sentence sent to TTS with text, audio frame yielded (bytes, queue depth), text event yielded, endTurn called, total frames/duration

**Fish Audio provider:** WS open (url), start sent, text event sent (text content, queue depth), audio chunk received (bytes, encoding, queue depth), stop sent, finish received, WS close, timing (ms from connect to first audio)

**STT (Deepgram):** WS open/close, every transcript event (text, confidence, isFinal, speechFinal), keepalive sent

**LLM (OpenRouter):** stream start (model, message count), token received (accumulated length), stream end (total tokens, duration ms)

**WS handler:** client connect (ip, session), disconnect (reason), JSON message in/out (type, responseId), binary frame (bytes), turn start/end (timing)

**Auth:** verify attempt (sessionId), success/failure, token refresh

### What Gets Logged — Prod Build (INFO)

**Session:** state changes (summary), connect/disconnect, barge-in  
**Pipeline:** turn start/end with timing and token/frame counts  
**TTS:** connection lifecycle, per-turn summary (sentences sent, chunks received, total duration)  
**STT:** connection lifecycle, final transcripts only  
**LLM:** stream start/end with model and duration  
**WS:** client connect/disconnect, errors  
**Auth:** verify success/failure  
**Errors/warnings:** always, all levels  

### Files

| File | Action | Description |
|------|--------|-------------|
| `gateway/src/logging/logger.ts` | NEW | LogTape setup: configure sinks (console + file), log level from env, daily rotation |
| `gateway/src/logging/format.ts` | NEW | Custom formatter: `{iso-ms} {LEVEL} [{tag}] {event} \| {kv pairs}` |
| `gateway/src/logging/log-sanitizer.ts` | NEW | Sink wrapper: key-based + pattern-based sensitive data scrubbing |
| `gateway/src/logging/logger.test.ts` | NEW | Formatter tests, sanitizer tests |
| `gateway/src/index.ts` | MODIFY | Initialize logger at startup, replace console.* calls |
| `gateway/src/pipeline/continuous-session.ts` | MODIFY | Add session state change logging |
| `gateway/src/pipeline/voice-turn.ts` | MODIFY | Add turn lifecycle logging |
| `gateway/src/pipeline/processors/streaming-overlap.ts` | MODIFY | Add terminal stage event logging |
| `gateway/src/pipeline/processors/tts-text-sanitizer.ts` | MODIFY | Add sanitizer input/output logging |
| `gateway/src/pipeline/processors/sentence-aggregator.ts` | MODIFY | Add boundary/flush logging |
| `gateway/src/providers/tts/fish-audio-provider.ts` | MODIFY | Add WS lifecycle + audio event logging |
| `gateway/src/providers/stt/deepgram-provider.ts` | MODIFY | Add transcript + connection logging |
| `gateway/src/providers/openrouter.ts` | MODIFY | Add stream lifecycle logging |
| `gateway/src/server/ws-server.ts` | MODIFY | Add connection logging |
| `gateway/src/server/continuous-voice-handler.ts` | MODIFY | Add message dispatch logging |
| `gateway/.gitignore` | MODIFY | Add `logs/` |
| `deploy/Dockerfile` (or equivalent) | MODIFY | Set LOG_LEVEL=info default, document volume mount for /var/log/sentient/ |

### Testing

- **Formatter:** unit tests verifying output format (timestamp precision, level padding, tag joining, kv serialization)
- **Sanitizer:** unit tests with API keys, PASETO tokens, Bearer headers, PINs — verify all redacted. Test that safe values pass through unchanged.
- **Integration:** verify logger initializes, writes to file, rotates daily (mock date)
- **Existing tests:** logger calls in source files should not break existing tests (logger is a side effect, not a dependency that tests mock)
