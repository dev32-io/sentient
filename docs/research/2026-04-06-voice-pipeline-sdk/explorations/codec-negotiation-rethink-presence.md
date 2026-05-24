# Codec Negotiation — Rethink: User Presence Gaps

## Task

Identify every moment during codec negotiation where the user could be left without feedback. Propose indicator states to fill those gaps.

## Timeline Analysis: User Action → System Response

### Phase 1: Initial Connection + Negotiation

```
User clicks "Start Voice"
  → SDK opens WebSocket                   [0-500ms typical, up to 3s on poor network]
  → SDK sends session.start               [immediate after WS open]
  → Gateway processes + responds           [1-50ms server-side]
  → SDK receives session.ready             [RTT dependent, 10-200ms]
  → SDK applies codec, enters "ready"      [<1ms]
  → SDK begins audio capture               [getUserMedia prompt + AudioContext init, 100-2000ms]
  → User sees "Listening..."              
```

**Silent gaps identified:**

| Gap | Duration | What user sees | Problem |
|-----|----------|---------------|---------|
| **G1**: WS connecting | 0-3000ms | Nothing | User clicked button, nothing happened yet |
| **G2**: Negotiation in flight | 10-200ms | Nothing (or still "Connecting...") | Usually fast enough to skip, but on slow networks can feel stuck |
| **G3**: Codec initialization | <5ms | Nothing | Negligible — no indicator needed |
| **G4**: getUserMedia permission prompt | 0-∞ | Browser permission dialog | OS-level, SDK can't control. But SDK should show "Waiting for microphone access..." |
| **G5**: AudioContext startup | 50-500ms | Nothing after permission granted | AudioWorklet loading, context resume. Can feel laggy |

### Phase 2: Negotiation Failure

```
User clicks "Start Voice"
  → WS opens
  → session.start sent
  → ... 5 seconds pass, no response ...     [NEGOTIATION_TIMEOUT]
  → State machine → error
  → ??? What does the user see?
```

**Silent gaps identified:**

| Gap | Duration | What user sees | Problem |
|-----|----------|---------------|---------|
| **G6**: Negotiation timeout waiting | 0-5000ms | "Connecting..." with no progress | User doesn't know if it's progressing or stuck. No distinction between "slow" and "broken" |
| **G7**: Error state with no recovery hint | indefinite | Error message only | User needs to know what to do: retry? refresh? check network? |

### Phase 3: Mid-Session Renegotiation

```
System decides to switch codec (e.g., bandwidth drop → switch PCM→Opus)
  → Audio streaming pauses                 [instant]
  → session.start sent with new caps       [instant]
  → Gateway responds                       [10-200ms]
  → New codec applied                      [<5ms]
  → Audio resumes                          
```

**Silent gaps identified:**

| Gap | Duration | What user sees | Problem |
|-----|----------|---------------|---------|
| **G8**: Audio gap during renegotiation | 10-3200ms (up to timeout) | Audio cuts out mid-conversation | User thinks connection dropped. No indicator that a codec switch is happening |
| **G9**: Renegotiation failure fallback | instant | Brief error flash, then resumes | Confusing — did something break? Is it still working? |

### Phase 4: Codec Error During Streaming

```
Audio is flowing normally
  → Decode error on incoming audio         [instant]
  → State → error, audio suspended
  → Auto-recovery attempted
  → ... or user must act
```

**Silent gaps identified:**

| Gap | Duration | What user sees | Problem |
|-----|----------|---------------|---------|
| **G10**: Audio corruption before error detected | 0-500ms | Garbled audio / noise | User hears garbage but UI shows "Speaking..." — confusing |
| **G11**: Error → recovery transition | 0-5000ms | Error message, then... what? | User doesn't know recovery is in progress |

### Phase 5: WS Disconnect During Any State

```
WS drops unexpectedly
  → All timers cancelled, codec released
  → State → disconnected
  → SDK may auto-reconnect
  → Full negotiation cycle restarts
```

**Silent gaps identified:**

| Gap | Duration | What user sees | Problem |
|-----|----------|---------------|---------|
| **G12**: Reconnection + re-negotiation | 500-10000ms | Nothing or stale state | The most dangerous gap — user may think system is still listening when it's not |

## Proposed Indicator States

The current state machine has 8 states but lacks user-facing presence signals. I propose adding `EMIT_INDICATOR` effects that map machine states to user-visible status messages.

### Indicator Map

| Machine State | Indicator Text | Visual | Priority |
|---------------|---------------|--------|----------|
| `disconnected` | — | No indicator (inactive) | — |
| `connected` | "Setting up audio..." | Spinner | LOW |
| `negotiating` | "Setting up audio..." | Spinner | LOW |
| `ready` | "Ready" (brief) → fades | Checkmark, then fade | LOW |
| `streaming` | (delegated to voice pipeline state) | — | — |
| `renegotiating` | "Optimizing audio..." | Subtle spinner | LOW |
| `error` (recoverable) | "Audio issue — retrying..." | Warning icon + spinner | MEDIUM |
| `error` (terminal) | "Audio setup failed" + retry button | Error icon | HIGH |
| `closed` | — | No indicator | — |

### New Effects to Add

```typescript
type PresenceIndicator =
  | { type: "SHOW_INDICATOR"; text: string; style: "spinner" | "success" | "warning" | "error" }
  | { type: "HIDE_INDICATOR" }
  | { type: "SHOW_RECOVERY_ACTION"; action: "retry" | "refresh" | "check-permissions" };
```

### Gap-by-Gap Solutions

**G1 (WS connecting)**: Not in codec state machine — handled by connection-level state machine. But codec negotiation should emit `SHOW_INDICATOR("Setting up audio...", "spinner")` on entering `connected`.

**G2 (Negotiation in flight)**: Already covered by `negotiating` → "Setting up audio..." indicator. The 5s timeout ensures it never hangs. Add a **progress sub-indicator** at 2s: "Still setting up..." to reassure user on slow networks.

```typescript
// New effect: escalation timer
{ type: "START_TIMER", name: "negotiation_slow", durationMs: 2_000 }
// When fired:
{ type: "SHOW_INDICATOR", text: "Still setting up audio...", style: "spinner" }
```

**G4 (getUserMedia)**: Outside codec state machine scope. The SDK voice client should show "Waiting for microphone access..." before entering the codec flow. This is a **pre-negotiation indicator** in the parent state machine.

**G5 (AudioContext startup)**: Add a sub-state or effect between `ready` and `streaming`. When AUDIO_START is dispatched but AudioWorklet isn't loaded yet, show "Preparing microphone..." briefly.

**G6 (Timeout waiting)**: The existing 5s timeout handles this. Enhance by showing progress at 2s mark (see G2).

**G7 (Error with no recovery hint)**: Differentiate error types in the EMIT_ERROR effect:

```typescript
// Enhanced error classification
type CodecErrorKind = "timeout" | "rejected" | "decode_failure" | "network";

// Error → recovery hint mapping
const RECOVERY_HINTS: Record<CodecErrorKind, { text: string; action: "retry" | "refresh" }> = {
  timeout: { text: "Connection is slow — tap to retry", action: "retry" },
  rejected: { text: "Audio format not supported", action: "refresh" },
  decode_failure: { text: "Audio error — reconnecting...", action: "retry" },
  network: { text: "Connection lost — reconnecting...", action: "retry" },
};
```

**G8 (Renegotiation audio gap)**: Show "Optimizing audio..." during renegotiation. If the gap is <200ms, the indicator may not even render (which is fine). For gaps >500ms, the indicator provides reassurance.

**G9 (Renegotiation failure fallback)**: When falling back to previous format, briefly show "Kept current audio settings" as a success indicator (not error), then auto-dismiss after 2s.

**G10 (Audio corruption)**: This is the hardest gap. The codec error is detected AFTER the user hears garbage. Mitigation: the AudioCodec decode function should detect invalid frames (e.g., PCM16 values outside expected range, implausible amplitude) and emit CODEC_ERROR before playing corrupted audio. This is a **codec validation** concern, not an indicator concern.

**G11 (Error → recovery)**: When auto-recovering, show "Audio issue — reconnecting..." with spinner. Track recovery attempt count. After 3 failed recoveries, escalate to terminal error with "refresh" action.

**G12 (WS disconnect during any state)**: The WS_CLOSE handler already transitions to `disconnected`. The parent state machine (voice client) should handle reconnection. During reconnection, codec state machine re-enters from `disconnected` → `connected` → `negotiating` → ... and the indicators follow naturally. Key requirement: the **parent must show "Reconnecting..." during the WS reconnect phase** before codec negotiation restarts.

## Integration with Parent State Machine

The codec negotiation state machine is a **sub-machine** of the SDK voice client state machine. Presence indicators should be layered:

```
Parent indicator (voice state):  "Listening..."  |  "Processing..."  |  "Speaking..."
Codec indicator (overlay):       "Setting up..." |  "Optimizing..."  |  (hidden when stable)
```

Rules:
1. Codec indicators show as **secondary/overlay** — never replace the primary voice state indicator
2. When codec is in `ready` or `streaming`, codec indicator is hidden — voice state indicator takes over
3. When codec is in `negotiating`, `renegotiating`, or `error`, codec indicator shows as overlay
4. Error indicators from codec take **priority** over voice state (error > everything)

## Key Insight

The codec negotiation is mostly invisible to the user — it should stay that way when working correctly. The presence gaps that matter most are:

1. **Initial setup (G1-G5)**: Combined into a single "Setting up audio..." phase. Users expect a brief setup period.
2. **Failure modes (G6-G7, G10-G11)**: These MUST surface clearly. The current state machine transitions to `error` but has no mechanism to differentiate error severity or suggest recovery.
3. **Mid-session disruptions (G8-G9, G12)**: These break immersion. The indicator "Optimizing audio..." keeps the user aware without alarming them.

The biggest risk is **G12 (WS disconnect)** — the user may continue speaking into a dead connection. This requires the parent state machine to immediately show "Reconnecting..." and potentially play a subtle audio cue (short tone) to alert the user.
