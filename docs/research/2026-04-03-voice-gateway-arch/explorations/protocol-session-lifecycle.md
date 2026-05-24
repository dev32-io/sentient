# Protocol Sub-Decision: Session Lifecycle

## Parent Decision Area
`client-gateway-protocol` — this is a sub-decision extracted during decomposition.

## Decision Area
How sessions are created, maintained, timed out, and cleaned up. Includes: session state machine, memory footprint of idle sessions, zombie session detection, and handling in-flight operations (like tool confirmations) when a connection drops.

## Key Questions

1. **Session state machine**: What states can a session be in, and what transitions are valid?
2. **Memory footprint**: How much RAM does an idle session consume? What about 5 idle sessions?
3. **Zombie detection**: How to detect and clean up sessions whose client silently disconnected?
4. **In-flight tool confirmation**: If the gateway asked "Send SMS to Mom?" and the client disconnects before answering, what happens?
5. **Session storage**: In-memory only (lost on restart) or persisted (survives gateway restarts)?
6. **Conversation history bounds**: How many turns before the history is truncated or summarized?

---

## Session State Machine

```
                    ┌──────────────┐
    WS Connect ───►│  CONNECTED   │ (unauthenticated, 5s timeout to auth)
                    └──────┬───────┘
                           │ session.start (valid token)
                    ┌──────▼───────┐
                    │    ACTIVE    │ (authenticated, pipeline available)
                    └──┬───┬───┬──┘
                       │   │   │
         audio/text ───┘   │   └─── WS close / timeout
         interaction       │        ┌──────────────┐
                           │   ┌───►│  SUSPENDED   │ (no WS, session in memory, 5min TTL)
                           │   │    └──────┬───┬───┘
                tool.confirm_request       │   │
                    ┌──────▼───────┐       │   │ TTL expires
                    │  CONFIRMING  │───────┘   │
                    └──────────────┘  (WS drop) │
                         │ tool.confirm         │
                         └──► ACTIVE            │
                                          ┌─────▼──────┐
                                          │  DESTROYED  │ (GC'd, history discarded)
                                          └────────────┘
```

### State Definitions

| State | WS Connected | Pipeline Active | Description |
|-------|:-----------:|:---------------:|-------------|
| CONNECTED | Yes | No | Fresh WebSocket, awaiting auth. 5-second timeout. |
| ACTIVE | Yes | Yes | Authenticated, ready for audio/text/control messages. |
| CONFIRMING | Yes | Paused | Waiting for user to approve/deny a tool action. Pipeline paused at tool step. |
| SUSPENDED | No | No | Client disconnected. Session preserved in memory for reconnection. 5-minute TTL. |
| DESTROYED | No | No | Session cleaned up. All resources freed. |

### Valid Transitions

| From | To | Trigger |
|------|----|---------|
| CONNECTED | ACTIVE | Valid `session.start` |
| CONNECTED | DESTROYED | Auth timeout (5s) or invalid token |
| ACTIVE | CONFIRMING | Gateway sends `tool.confirm_request` |
| ACTIVE | SUSPENDED | WebSocket closes (client disconnect or network drop) |
| ACTIVE | DESTROYED | Explicit `session.end` from client |
| CONFIRMING | ACTIVE | Client sends `tool.confirm` (approved or denied) |
| CONFIRMING | SUSPENDED | WebSocket closes while awaiting confirmation |
| SUSPENDED | ACTIVE | Client reconnects with `session.resume` |
| SUSPENDED | DESTROYED | TTL expires (5 minutes) |

---

## Memory Footprint Analysis

Based on PoC measurements (352 bytes per session object) plus real-world data:

| Component | Per Session | Notes |
|-----------|-----------|-------|
| Session object (id, user, state, timestamps) | ~400 bytes | Dataclass with a few fields |
| Conversation history (20 turns avg) | ~20 KB | ~1KB per turn (user message + assistant response) |
| Pipeline reference | ~200 bytes | Just a reference to the asyncio task + queues |
| Audio buffer (unused in SUSPENDED) | 0 bytes | Freed when pipeline stops |
| WebSocket reference | ~100 bytes in ACTIVE, 0 in SUSPENDED | Freed on disconnect |
| **Total (ACTIVE)** | **~21 KB** | |
| **Total (SUSPENDED)** | **~21 KB** | Same — history is the bulk |
| **5 sessions (all ACTIVE)** | **~105 KB** | Negligible on 8GB RPi5 |
| **5 sessions (worst case, 100 turns each)** | **~500 KB** | Still negligible |

**Verdict**: Session memory is a non-issue. Even with generous history limits, 5 users can't meaningfully dent 8GB.

---

## Zombie Session Detection & Cleanup

A zombie session is one where the client silently disconnected (no close frame) and the heartbeat mechanism hasn't detected it yet.

### Detection Layers

1. **Application heartbeat**: Client sends `ping` every 30s. If no ping for 60s → mark session SUSPENDED.
2. **WebSocket close event**: `aiohttp` fires `WSMsgType.CLOSE` or `WSMsgType.ERROR` on connection drop → immediate transition to SUSPENDED.
3. **Periodic sweep**: Every 60s, a background task checks all sessions:
   - SUSPENDED sessions past TTL → DESTROYED
   - CONNECTED sessions past auth timeout → DESTROYED

```python
async def session_reaper(session_manager: SessionManager):
    """Background task that cleans up expired sessions."""
    while True:
        await asyncio.sleep(60)
        now = time.monotonic()
        for session in session_manager.all():
            if session.state == State.SUSPENDED and now - session.suspended_at > SESSION_TTL:
                await session_manager.destroy(session)
            elif session.state == State.CONNECTED and now - session.connected_at > AUTH_TIMEOUT:
                await session.ws.close(code=4001, message=b"Auth timeout")
                await session_manager.destroy(session)
```

### Resource Cleanup on DESTROYED

When a session is destroyed:
1. Cancel any running pipeline task (`task.cancel()`)
2. Close WebSocket if still open
3. Flush any pending memory updates to `memory/<user>.md`
4. Remove from session manager's lookup tables
5. Log session end to audit log (duration, turns, tools used)

---

## In-Flight Tool Confirmation on Disconnect

This is the trickiest edge case: the gateway asked "Send SMS to Mom — confirm?" and the client disconnects before responding.

### Options

**Option 1: Auto-deny on disconnect (Recommended)**

If the client disconnects while CONFIRMING → the pending tool action is denied, the agent loop is cancelled, and the tool invocation is logged as "denied (disconnected)".

- **Rationale**: For a voice assistant, "silence" should never mean "yes". The security architecture requires explicit confirmation for high-impact tools. A disconnected user cannot confirm.
- **On reconnect**: The user sees the conversation history including the tool request. They can re-ask if they want.

**Option 2: Hold pending until reconnect**

The CONFIRMING state is preserved in SUSPENDED. If the client reconnects within TTL, the gateway re-sends `tool.confirm_request`.

- **Problem**: The tool action may be stale. "Send SMS to Mom: 'I'm leaving now'" loses meaning if sent 3 minutes later.
- **Problem**: The agent loop is frozen the entire time, holding LLM context in memory.

**Option 3: Auto-approve on disconnect**

Never. This violates the security architecture's core principle.

### Recommendation: Option 1 (Auto-deny)

Simple, safe, and correct. The tool confirmation flow becomes:

```
ACTIVE → tool.confirm_request sent → CONFIRMING
  ├─ Client responds → tool executes or is denied → ACTIVE
  ├─ Client disconnects → tool auto-denied → SUSPENDED
  │   └─ Client reconnects → sees history, can re-ask → ACTIVE
  └─ Confirmation timeout (30s) → tool auto-denied → ACTIVE
      └─ Gateway says "No response received, cancelling the action"
```

The 30-second confirmation timeout prevents the session from being stuck in CONFIRMING indefinitely even with a connected but unresponsive client.

---

## Session Storage: In-Memory Only

Sessions are in-memory only — lost on gateway restart. This is acceptable because:

1. **Conversation history is ephemeral** — losing it is annoying but not catastrophic
2. **Per-user memory files persist on disk** — the assistant still "knows" the user after restart
3. **Gateway restarts are rare** — RPi5 running a Python process; crashes and updates are the only restart triggers
4. **Persistence adds complexity** — Redis/SQLite for session storage is overkill for 5 users
5. **Restart recovery UX**: Client gets a WebSocket close, reconnects, gets `session.new` instead of `session.resumed`, starts a fresh conversation. Fine.

If gateway restart preserving conversation becomes important later, the simplest path is: serialize conversation history to a JSON file on graceful shutdown, reload on start.

---

## Conversation History Bounds

History grows linearly with turns. Unbounded history means unbounded memory and unbounded LLM context.

### Limits

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Max turns in session | 50 | A 50-turn voice conversation is already very long (~15-20 min) |
| Max history sent to LLM | 20 most recent turns | Fits comfortably in context window alongside persona + memory |
| History beyond 20 turns | Kept in session for reconnect but not sent to LLM | Could be summarized later |

When the 50-turn limit is reached: the session continues, but the oldest turns are dropped from the session object. The LLM's 20-turn window always has the most recent context.

This interacts with the per-user memory system — important facts from older turns should already be captured in `memory/<user>.md` before they're dropped from history.

---

## Summary of Decisions

1. **State machine**: 5 states (CONNECTED → ACTIVE → CONFIRMING → SUSPENDED → DESTROYED) with well-defined transitions
2. **Memory footprint**: ~21KB per active session — negligible at 5-user scale
3. **Zombie cleanup**: 3-layer detection (heartbeat, WS close, periodic sweep) + 60s reaper task
4. **Tool confirmation on disconnect**: Auto-deny (safe default) + 30s confirmation timeout
5. **Session storage**: In-memory only — adequate for family scale, disk persistence deferred
6. **History bounds**: 50 turns max in session, 20 most recent sent to LLM
