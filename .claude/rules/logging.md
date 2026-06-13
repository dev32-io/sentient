# Logging Rules

> When a rule is unclear, read `agents/docs/logging-details.md`.

- Every new file MUST import and use a tagged logger. No bare `console.log`, `console.error`, or `console.warn`.
- Logger tag MUST reflect the file's position in the hierarchy (e.g., `["sentient", "tts", "fish-audio"]`).
- Log every input and output at component boundaries: service calls, decorator units, WS messages, pipeline stages.
- Log every state change with previous state, new state, and trigger event.
- Log every boundary / classifier / fallback decision with the reason and the value(s) that triggered it.
- Log IDs (utteranceId, responseId, sessionId, cycleId) in every entry where available, for request tracing.
- Log buffer sizes, queue depths, byte counts, elapsed ms on data operations.
- DEBUG for high-volume tracing (every chunk, every decision). INFO for lifecycle (start/complete, connect/disconnect). WARN with a `reason` field for every fallback / degraded path.
- Truncate string previews to ≤120 chars. Never dump full buffers or raw tokens.
- Never log sensitive data directly. All log output passes through the log sanitizer — still avoid putting raw tokens or keys in messages.
- Mobile DEBUG is NOT ephemeral: SentientMobileVitals captures every `shared/mobile-sdk` log line at DEBUG+ into a ring that uploads to the gateway. NEVER log user/chat content (message text, search queries, raw WS frames, transcripts) at ANY level — log lengths/ids/types only. Any new content-bearing sink must be covered by `PrivacyGuardTest`.
- Logging is part of code-complete. If a bug report can't be traced end-to-end from the file's logs, the file is not done.
- Browser-side code (webui, web-sdk) uses `createLogger([tags])` from `@sentient/web-sdk`. Same shape as the gateway's tagged logger (debug/info/warn/error + structured properties). No bare `console.log` / `console.debug` / `console.warn` / `console.error` in shipped browser code. Tests may still use console directly.

## Log File Location

- **Local dev:** Logs write to `gateway/logs/` (relative to the gateway project root).
- **Docker/deploy:** The `gateway/logs/` directory is mounted as a volume from the host. Same path inside the container.
- **Timezone:** Log timestamps are UTC. Local time conversion is the reader's responsibility.
- The file logger uses daily rotation: `gateway/logs/YYYY-MM-DD.log`.
