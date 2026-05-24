# Protocol Sub-Decision: Multi-Device Handling

## Parent Decision Area
`client-gateway-protocol` — this is a sub-decision extracted during decomposition.

## Decision Area
What happens when the same user connects from multiple devices simultaneously (e.g., phone and laptop). The current session model assumes one WebSocket connection per user — a second connection from the same user creates an undefined state.

## Key Questions

1. **Is multi-device even needed?** Family of 5 — will anyone realistically use two devices simultaneously?
2. **Session collision**: If Kevin connects from laptop, then connects from phone, what happens to the laptop session?
3. **Shared context**: If both devices are active, do they share conversation history?
4. **Audio routing**: If both devices are listening, who gets the TTS response?
5. **Barge-in across devices**: If the phone sends barge-in while the laptop is receiving audio, what happens?

---

## Usage Scenarios

For a family voice assistant on LAN:

| Scenario | Likelihood | Multi-device? |
|----------|-----------|---------------|
| Kevin uses laptop in office, walks to kitchen and uses phone | High | Sequential (not simultaneous) |
| Kevin has laptop open AND phone in hand, talking to both | Very low | Simultaneous |
| Kevin's laptop is idle, he starts on phone | High | First device is inactive |
| Two family members each on their own device | Common | Different users, not multi-device |

**Key insight**: The dominant pattern is **device switching** (sequential), not **simultaneous multi-device**. The user stops using one device and starts on another.

---

## Approaches

### A. Last-Connection-Wins (Recommended)

When a user authenticates on a new connection, the previous connection for that user is gracefully disconnected.

```python
async def handle_session_start(session, data):
    user = await authenticate(data["token"])
    
    # Check for existing session for this user
    existing = session_manager.get_by_user(user.id)
    if existing:
        # Notify old connection and close it
        await existing.ws.send_json({
            "type": "session.displaced",
            "message": "Connected from another device"
        })
        await existing.ws.close(code=4002, message=b"Displaced by new connection")
        # Preserve conversation history from old session
        session.history = existing.history
        session_manager.remove(existing)
    
    session.bind_user(user)
    session_manager.register(session)
```

**Pros:**
- **Matches the dominant use case** — device switching "just works" (history carries over)
- **Zero ambiguity** — exactly one active session per user at any time
- **No audio routing complexity** — one device, one pipeline, one audio stream
- **Client UX is clear** — old client shows "connected elsewhere" message, like WhatsApp Web
- **No zombie sessions** — switching devices automatically cleans up the old session

**Cons:**
- **Accidental displacement** — if a family member accidentally opens the app on a second device, the first session is killed. Mitigated: the displacement message tells the user what happened.
- **No simultaneous use** — can't have phone playing music while laptop does a query. Not a real scenario for a voice assistant.

### B. Multiple Concurrent Sessions Per User

Each connection gets its own independent session. Same user can have multiple active sessions.

```python
# session_manager stores list of sessions per user
sessions_by_user: dict[str, list[Session]] = {}
```

**Pros:**
- Maximum flexibility — any device, any time
- No displacement disruption

**Cons:**
- **Conversation context diverges** — laptop session and phone session have different histories. Confusing: "What did I just ask?" depends on which device you're on.
- **Audio routing is unsolvable** — if Kevin asks on the phone and the laptop is also connected, does the laptop hear the answer? If yes, that's jarring. If no, the laptop session is stale.
- **Memory file conflicts** — both sessions try to update `memory/kevin.md` after interaction. Last-write-wins? Merge? Both are complex.
- **Resource doubling** — two concurrent sessions = two pipeline instances, two STT streams, etc. For 5 users max this is still fine on RPi5, but it's needless complexity.
- **No real user demand** — nobody uses two voice assistants simultaneously.

### C. Primary-Device with Read-Only Observers

One active session (can send audio/text), other connections are read-only observers that see the transcript.

```python
# One active session, N observer connections
active_session: Session
observers: list[WebSocketResponse]  # receive transcript only
```

**Pros:**
- Supports "watch on tablet while talking on phone" scenario
- Clear distinction between active and passive connections

**Cons:**
- **Over-engineered for the use case** — who watches a voice assistant transcript on a second device?
- **Complexity**: must manage active/observer roles, handle promotion (observer becomes active when active disconnects)
- **Not requested, not needed** — this is a family assistant, not a conferencing system

---

## Analysis & Recommendation

### Recommendation: Approach A (Last-Connection-Wins)

The decision is straightforward:

1. **The use case doesn't exist**: No one talks to a voice assistant from two devices simultaneously
2. **Device switching is the real need**: And last-connection-wins handles it perfectly, including conversation history transfer
3. **Single-session-per-user eliminates entire categories of complexity**: No audio routing, no context divergence, no memory file conflicts
4. **Clear UX**: Displaced client shows a message — familiar pattern from WhatsApp/Telegram/Spotify

### Implementation Details

- **Session displacement message**: `{"type": "session.displaced", "message": "Connected from another device"}` — client shows a non-alarming notification
- **Close code**: `4002` (application-defined) for displacement — client can distinguish from network errors
- **History transfer**: Copy conversation history list from old session to new session before destroying old session
- **Grace period**: None needed — displacement is instant. The old client can reconnect if the user returns to it (which triggers displacement of the *new* session, which is fine)
- **Audit log**: Log displacement events (who, when, old device, new device) for the security architecture

### Edge Case: Rapid Switching

If a user rapidly switches between devices (buggy client reconnecting in a loop), the displacement mechanism becomes a ping-pong. Mitigation: rate-limit new connections per user to max 1 per second. If a second connection arrives within 1 second of a displacement, reject it with `4003` (rate limited) and let the existing session stay.
