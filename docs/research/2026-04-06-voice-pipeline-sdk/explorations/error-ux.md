# Error UX — Graceful "Pardon?" Experience

## Current Error Handling

### Error Types (`errors.ts:12-19`)
```typescript
const ERROR_TYPES = [
  "auth_failed",
  "session_limit",
  "token_expired",
  "protocol_error",
  "provider_error",
  "internal_error",
] as const;
```

### How Errors Surface Today
- **Gateway → Client**: `{ type: "error", code: string, message: string }` (`messages.ts:115-119`)
- **Client display**: `use-messages.ts:63-66` creates a chat message: `"Error: ${message.message}"` — raw technical error shown to user
- **Voice handler errors**: `voice-handlers.ts` sends `sendError(ws, "stt_error", ...)` — note `"stt_error"` is NOT in `ERROR_TYPES`, code field is unconstrained `z.string()`
- **WS close codes**: `errors.ts:3-8` — `AUTH_FAILED: 4001`, `SESSION_LIMIT: 4002`, `TOKEN_EXPIRED: 4003`, `PROTOCOL_ERROR: 4004`

### Problems
1. **Raw technical errors shown to users.** `"STT connect failed"`, `"LLM error"` — meaningless to end users.
2. **Error codes are inconsistent.** `ERROR_TYPES` defines 6 types but handlers send arbitrary strings like `"stt_error"`.
3. **No error categorization for UX.** All errors are treated the same — displayed as text message.
4. **No recovery flow.** Error → message displayed → user must figure out what to do.
5. **Silent failures exist.** `voice-session.ts:50` early audio buffer leak if `connectPromise` fails. `voice-handlers.ts:50` STT read error during abort is silently swallowed (correct for abort, but no user feedback).
6. **No "thinking" / "processing" indicators.** Between `audio.end` and first `response.text.delta`, user sees nothing.

## Proposed Error UX Model

### Error Categories (User-Facing)
```typescript
type UserErrorCategory =
  | "connection_lost"     // "Sorry, I lost the connection. Reconnecting..."
  | "didnt_catch"        // "I didn't catch that. Could you repeat?"
  | "thinking_timeout"   // "Hmm, I'm taking longer than usual..."
  | "service_unavailable" // "I'm having trouble right now. Try again in a moment."
  | "auth_required"      // "Please sign in again."
  | "try_again"          // "Something went wrong. Could you try again?"
```

### Mapping: Technical Error → User Category
```
auth_failed         → auth_required
token_expired       → auth_required
session_limit       → service_unavailable
provider_error (STT) → didnt_catch
provider_error (LLM) → thinking_timeout → try_again
provider_error (TTS) → try_again (text response still delivered)
internal_error      → try_again
protocol_error      → try_again
WS disconnect       → connection_lost (auto-reconnect)
STT mid-stream drop → didnt_catch
processing timeout  → thinking_timeout
```

### Recovery Flows
| Category | Auto-Recover? | User Action | State Transition |
|----------|--------------|-------------|------------------|
| connection_lost | Yes (reconnect) | Wait | → reconnecting → listening |
| didnt_catch | Yes (reset to listening) | Re-speak | → listening |
| thinking_timeout | Partial (retry once) | Wait or retry | → listening |
| service_unavailable | No | Wait and retry | → error |
| auth_required | No | Re-authenticate | → inactive |
| try_again | Yes (reset to listening) | Try again | → listening |

### State Machine Integration
Every error maps to a state transition (from `sdk-state-machine.md`):
- `connection_lost` → `reconnecting` state
- `didnt_catch` → `listening` state (after brief message)
- `thinking_timeout` → shows indicator in `processing` state, eventually → `error` or `listening`
- `service_unavailable` → `error` state
- `auth_required` → `inactive` state

### "Never Silent" Principle
Every pipeline state emits a user-visible signal:
```
listening       → "Listening..." (or visual indicator)
user-speaking   → audio waveform / "Recording..." indicator
processing      → "Thinking..." with spinner
assistant-speaking → audio playback + text streaming
reconnecting    → "Reconnecting..." with progress
error           → friendly error message + action button
```

The transition from `processing` to `assistant-speaking` must be bounded:
- 0-2s: no indicator (fast enough to skip)
- 2-5s: show "Thinking..."
- 5-15s: show "Still thinking..."
- 15-30s: show "Taking longer than usual..."
- 30s+: timeout → "Sorry, I'm having trouble. Could you try again?"

### Implementation Pattern
```typescript
// Error classifier: technical error → user-facing category
function classifyError(error: PipelineError): UserErrorCategory {
  if (error.source === "stt" && error.phase === "streaming") return "didnt_catch";
  if (error.source === "llm" && error.phase === "streaming") return "thinking_timeout";
  // ...
}

// User message generator: category → friendly message
function errorMessage(category: UserErrorCategory): string {
  const messages: Record<UserErrorCategory, string> = {
    connection_lost: "Sorry, I lost the connection. Reconnecting...",
    didnt_catch: "I didn't catch that. Could you repeat?",
    // ...
  };
  return messages[category];
}
```

## Deep Codebase Error Path Analysis

### Error Propagation Patterns Found

**1. Deferred Error Propagation** (`streaming-overlap.ts:26-54`)
The most sophisticated error pattern in the codebase. LLM errors are captured in a variable (line 26), the sentence/TTS loop continues draining, and the error is thrown *after* TTS finishes (line 53-54). This means the user gets partial audio output even when LLM fails mid-stream. For error UX this is excellent — the user hears what was generated before the error, then gets a graceful "I lost my train of thought" rather than abrupt silence.

**2. Result Type Pattern** (auth only)
`paseto.ts:verifyToken()` and `session-manager.ts:createSession()` return `Result<T>` — no throws. But provider code (`voice-session.ts:132`, `deepgram-provider.ts:161`) throws errors instead. Inconsistency: auth is Result-based, providers are throw-based. Error UX layer must handle both.

**3. Silent Error Swallowing** (5 locations)
- `ws-server.ts:240` — WS close cleanup: "nothing to do on close" (acceptable)
- `deepgram-provider.ts:207` — disconnect send failure (acceptable)
- `use-websocket.ts:112` — JSON parse failure: silent return (BAD — user never knows)
- `use-audio-capture.ts:44` — AudioContext close: `.catch(() => {})` (acceptable)
- `voice-handlers.ts:50` — readTranscriptOrNull returns null on abort (acceptable for abort, bad for real errors)

**4. Abort vs Error Distinction**
`voice-handlers.ts:50` checks `signal.aborted` before sending `stt_error`. This is critical for UX: abort (barge-in) should NOT surface an error. The existing code gets this right but only in one location. Every error handler in the pipeline must distinguish abort from failure.

**5. Ping/Pong Timeout Path** (`use-websocket.ts:81-83`)
Client closes with code 4000 on pong timeout. This triggers `onclose` which triggers reconnect with backoff. User sees connection status change but no explicit error message. Gap: should show "Connection unstable..." before full reconnect.

**6. Timeout Coverage**
- Deepgram connect: timeout with `Promise.race()` ✓
- Fish Audio connect: timeout with `Promise.race()` ✓
- LLM stream: NO timeout — `openrouter.ts:30-47` has no timeout/race ✗
- Processing state (client): NO timeout — waits forever for first response token ✗
- Auth handshake: has timeout in `use-websocket.ts:93-96` ✓

### Error Paths Not Handled

1. **LLM timeout**: If OpenRouter hangs, `stream()` blocks forever. No AbortSignal timeout on client side for processing state. User stares at nothing.
2. **TTS partial failure**: If TTS drops mid-sentence, audio stops but text may continue. User hears half a word then silence.
3. **Double error**: STT fails, then reconnect also fails. Current code shows two separate error messages.
4. **Network degradation**: Slow but not dead connection. Audio arrives with gaps but no timeout fires. User hears choppy audio with no explanation.

### Error Code Mismatch Detail

`errors.ts` schema validates `code: z.enum(ERROR_TYPES)` but `voice-handlers.ts` sends `"stt_error"` which is NOT in the enum. Since `ws-helpers.ts:sendError()` constructs the message directly (bypassing Zod validation), this mismatch is never caught. The protocol says one thing, the implementation does another.

## PoC Approach: Error Classifier + Recovery Flow

### What to Build
A standalone PoC that demonstrates:
1. **PipelineError type** — structured error with source, phase, severity, original error
2. **Error classifier** — pure function: `PipelineError → UserErrorCategory`
3. **Recovery strategy resolver** — pure function: `UserErrorCategory → RecoveryAction`
4. **User message generator** — pure function: `UserErrorCategory → friendly string`
5. **Processing timeout with staged indicators** — timer-based state progression
6. **Integration with state machine** — error events trigger appropriate transitions

### Why This PoC
The core question is: can we create a clean mapping layer between arbitrary technical errors (from 3+ providers, network, auth) and a small set of user-facing categories, where each category has a deterministic recovery path? The PoC validates that the classification is exhaustive (no error falls through) and the recovery flows are sensible.

### PoC Structure
```
poc/error-ux/
├── src/
│   ├── pipeline-error.ts      # Structured error type
│   ├── error-classifier.ts    # Technical → user-facing mapping
│   ├── recovery-resolver.ts   # Category → recovery action
│   ├── user-messages.ts       # Category → friendly message strings
│   ├── processing-timer.ts    # Staged "thinking" indicators
│   └── state-integration.ts   # Error → state machine transition
├── test/
│   ├── error-classifier.test.ts
│   ├── recovery-resolver.test.ts
│   └── processing-timer.test.ts
└── package.json
```

### Key Design Decisions
- **Classification is exhaustive**: every error source × phase combination maps to exactly one category. A `default: "try_again"` catch-all ensures no silent failures.
- **Recovery is deterministic**: given a category, the recovery action is always the same. No conditional logic based on retry count or timing.
- **Messages are i18n-ready**: category → message lookup, trivially swappable for localization.
- **Staged processing timer**: not a single timeout but a progression (2s → thinking, 5s → still thinking, 15s → taking longer, 30s → timeout error). Each stage emits an event the UI can render.

## Codebase Integration Points
- `shared/protocol/src/errors.ts` — expand `ERROR_TYPES` to include all provider errors, fix mismatch with actual usage
- `gateway/src/server/voice-handlers.ts` — use standardized error codes from enum, not arbitrary strings
- `gateway/src/server/ws-helpers.ts:sendError()` — validate error message against schema before sending
- `web/src/hooks/use-messages.ts:63-66` — replace raw error display with classified messages
- `web/src/hooks/use-websocket.ts:112` — surface JSON parse errors instead of silent swallow
- `web/src/types.ts` — add error category types
- New SDK module: `ErrorClassifier` — maps technical errors to user-facing categories
- New SDK module: `ProcessingTimer` — staged indicator progression with timeout
- State machine: every error category maps to a specific state transition + side effect (message + recovery action)
- Streaming overlap pattern: preserve deferred error propagation — it's the right approach for partial audio delivery before error surfacing
