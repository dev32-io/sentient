# Logging Rules

> When a rule is unclear, read `agents/docs/logging-details.md`.

- Every new file MUST import and use a tagged logger. No bare `console.log`, `console.error`, or `console.warn`.
- Logger tag MUST reflect the file's position in the hierarchy (e.g., `["sentient", "tts", "local-tts"]`).
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

- **One path in every shape:** `~/.sentient/gateway/logs/` (override with `LOG_DIR`). Logs are mutable STATE, so they live under the user-owned state root, never in the code tree. Dev and prod agree; the launchd plist sets `LOG_DIR` explicitly anyway.
- Never default a writable path to a RELATIVE one. launchd sets no `WorkingDirectory` and a compiled binary's `import.meta.dir` is the virtual bunfs root, so both `"logs"` and `join(import.meta.dir, "..", "..")` resolve against `/` and crash-loop on EROFS. Anchor on `resolveSentientHome()`.
- **Timezone: LOCAL, not UTC** — `logging/format.ts` builds every timestamp from `getFullYear`/`getHours`/… , so both the line prefix and the daily rotation boundary follow the host's local clock. Grepping "today's log" with `date -u +%F` picks the wrong file for the hours either side of midnight.
- The file logger uses daily rotation: `~/.sentient/gateway/logs/YYYY-MM-DD.log`.
