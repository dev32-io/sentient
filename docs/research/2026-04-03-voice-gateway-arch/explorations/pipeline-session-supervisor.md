# Pipeline Sub-Decision: Session Supervisor

## Parent Decision Area
`pipeline-architecture` — this is a sub-decision extracted during decomposition.

## Decision Area
How to detect hung, failed, or degraded sessions and recover from them — including resource cleanup, user notification, and provider failover triggers. The session supervisor is the "watchdog" layer that ensures no session silently dies, leaks resources, or leaves users in limbo.

## Key Questions

1. **Hung session detection**: How to detect a session that's alive (WebSocket open) but stuck (no frames flowing)?
2. **Recovery strategy**: When a session is detected as unhealthy, what happens? Restart pipeline? Notify user? Kill and re-create?
3. **Resource cleanup**: When a session ends (graceful or crash), how to ensure all cloud API connections (Deepgram WebSocket, OpenRouter SSE, Fish Audio WebSocket) are closed?
4. **Provider degradation response**: When the backpressure monitor emits high-water-mark MetricsFrames, what does the supervisor do?
5. **Health checks**: How does the supervisor know a session is healthy vs degraded vs dead?
6. **Session lifecycle**: Who owns session creation, the session registry, and teardown?

---

## Session Lifecycle Context

A session exists from client WebSocket connect to disconnect. During its life:

```
Connect → Auth → Pipeline created → [Request/Response cycles] → Disconnect → Cleanup
```

**What can go wrong at each phase:**

| Phase | Failure Mode | Impact |
|-------|-------------|--------|
| Auth | Invalid token, expired token | Reject immediately — not a supervisor concern |
| Pipeline creation | Provider unreachable at session start | User hears nothing — must notify |
| Request/Response | STT timeout, LLM stall, TTS stall | User experiences silence mid-conversation |
| Request/Response | Unhandled exception in processor | Pipeline partially dead, session zombied |
| Request/Response | Cloud API rate limit | 429 errors, degraded responses |
| Disconnect | Client drops without close frame | Orphaned cloud connections, leaked tasks |
| Disconnect | Server-side crash | Same as above but for all sessions |

---

## Health Signal Sources

The supervisor doesn't need to poll or probe — it can observe signals already flowing through the pipeline:

### 1. Frame Flow Heartbeat
Each processor emits frames when active. If no frame has transited a processor for an abnormal period, the session may be stuck.

- **Normal**: During active request, frames flow continuously (~30-60/sec from LLM alone)
- **Normal idle**: Between requests, no frames flow — this is fine
- **Abnormal**: During an active request (user sent input), no frames emitted for >10 seconds = something is stuck

**Key insight**: The supervisor only needs to monitor during *active requests*. A session sitting idle between user turns needs no heartbeat.

### 2. High-Water Mark MetricsFrames (from Backpressure)
The backpressure design (Approach C from `pipeline-backpressure`) emits MetricsFrames when queue depth exceeds 20 items. The supervisor consumes these as provider degradation signals.

### 3. Provider Error Frames
When a cloud API call fails (timeout, 5xx, rate limit), the processor wraps the error in an ErrorFrame. The supervisor can aggregate these to detect systemic provider issues vs one-off failures.

### 4. Task Exceptions
`asyncio.Task` objects for each processor's `_run()` coroutine surface unhandled exceptions via `task.exception()` or a done callback. The supervisor monitors these for unexpected crashes.

---

## Approaches Evaluated

### A. Centralized Session Manager with Health Polling Loop

A single `SessionManager` class that owns all sessions and runs a periodic health-check loop.

**Architecture:**
```python
class SessionManager:
    def __init__(self):
        self._sessions: dict[str, Session] = {}
        self._health_task: asyncio.Task | None = None
    
    async def create_session(self, user_id: str, ws: WebSocket) -> Session:
        session = Session(user_id=user_id, ws=ws)
        pipeline = Pipeline([
            STTProcessor(), Classifier(), LLMProcessor(),
            SentenceAggregator(), TTSProcessor(), TransportProcessor(ws)
        ])
        session.pipeline = pipeline
        await pipeline.start()
        self._sessions[session.id] = session
        return session
    
    async def destroy_session(self, session_id: str):
        session = self._sessions.pop(session_id, None)
        if session:
            await session.pipeline.stop()       # Sends EndFrame, waits for drain
            await session.close_providers()      # Closes cloud API connections
            session.audit_log("session_ended")
    
    async def _health_loop(self):
        """Runs every 5 seconds, checks all active sessions."""
        while True:
            await asyncio.sleep(5.0)
            for session in list(self._sessions.values()):
                health = session.check_health()
                if health == Health.DEAD:
                    logger.error(f"Session {session.id}: dead — destroying")
                    await self.destroy_session(session.id)
                elif health == Health.DEGRADED:
                    logger.warning(f"Session {session.id}: degraded — notifying user")
                    await session.notify_user("I'm experiencing some delays.")
                elif health == Health.STUCK:
                    logger.warning(f"Session {session.id}: stuck — restarting pipeline")
                    await self._restart_pipeline(session)
```

**Session health check:**
```python
class Session:
    def check_health(self) -> Health:
        # Check 1: Are all processor tasks still running?
        for task in self.pipeline.processor_tasks:
            if task.done():
                if task.exception():
                    return Health.DEAD  # Processor crashed
                return Health.DEAD      # Processor exited unexpectedly
        
        # Check 2: Is the session stuck during an active request?
        if self.is_active_request:
            silence = time.monotonic() - self.last_frame_emitted
            if silence > 15.0:
                return Health.STUCK
            elif silence > 8.0:
                return Health.DEGRADED
        
        # Check 3: High-water mark alerts?
        if self.queue_alerts > 3:
            return Health.DEGRADED
        
        return Health.HEALTHY
```

**Pros:**
- Clear ownership — SessionManager is the single source of truth for session lifecycle
- Centralized health logic is easy to understand and debug
- Periodic loop catches slowly degrading sessions (not just acute failures)
- Clean resource lifecycle — `destroy_session()` is the one path for cleanup
- Session registry enables admin introspection (list active sessions, per-session stats)

**Cons:**
- Polling-based (5s interval) introduces detection latency — a crashed processor takes up to 5s to notice
- Health loop checks all sessions every tick, even idle ones (negligible CPU at 5 sessions, but inelegant)
- Pipeline restart is complex: must drain in-flight frames, close/reopen provider connections, resume from a clean state
- "Stuck" detection requires distinguishing "actively processing a request" from "idle between turns" — needs a request-state flag

### B. Event-Driven Supervisor with Task Callbacks

No polling loop. Each processor's asyncio.Task has a done-callback, and MetricsFrames propagate to a supervisor listener.

**Architecture:**
```python
class SessionSupervisor:
    """Reacts to events rather than polling."""
    
    def __init__(self, session: Session):
        self._session = session
        self._request_timer: asyncio.TimerHandle | None = None
    
    def attach_to_pipeline(self, pipeline: Pipeline):
        for proc in pipeline.processors:
            proc.task.add_done_callback(self._on_processor_done)
            proc.set_metrics_listener(self._on_metrics_frame)
    
    def _on_processor_done(self, task: asyncio.Task):
        """Fires immediately when a processor task exits."""
        if task.cancelled():
            return  # Expected during teardown
        exc = task.exception()
        if exc:
            logger.error(f"Processor crashed: {exc}")
            asyncio.create_task(self._handle_crash(task, exc))
        else:
            logger.warning(f"Processor exited unexpectedly without error")
            asyncio.create_task(self._handle_unexpected_exit(task))
    
    def _on_metrics_frame(self, frame: MetricsFrame):
        if frame.queue_depth >= 20:
            asyncio.create_task(self._handle_degradation(frame))
    
    def on_request_started(self):
        """Called when user input arrives. Starts a timeout timer."""
        if self._request_timer:
            self._request_timer.cancel()
        loop = asyncio.get_event_loop()
        self._request_timer = loop.call_later(15.0, self._on_request_timeout)
    
    def on_response_completed(self):
        """Called when TTS finishes. Cancels the timeout."""
        if self._request_timer:
            self._request_timer.cancel()
            self._request_timer = None
    
    def _on_request_timeout(self):
        logger.warning(f"Session {self._session.id}: request timeout")
        asyncio.create_task(self._notify_timeout())
```

**Pros:**
- **Zero-latency crash detection**: `add_done_callback` fires immediately when a task exits
- **No wasted work**: Only runs code when something actually happens
- **Timer-based request timeout**: `call_later(15.0)` is more precise than a 5s polling loop
- **Event-driven is idiomatic asyncio**: Callbacks and timers are the intended patterns
- **Per-session supervisor**: Each session has its own supervisor instance

**Cons:**
- Distributed logic — crash handling in callbacks, timeout in timer, degradation in metrics listener
- `add_done_callback` runs in the event loop context — must not block (hence `asyncio.create_task`)
- Timer-based timeout requires explicit `on_request_started` / `on_response_completed` hooks — must be wired correctly
- Slow degradation (gradually increasing latency) harder to detect without periodic observation
- No centralized session registry — need a separate component for "list all sessions"

### C. Hybrid: Session Manager + Per-Session Event Supervisor

Combines A's centralized session registry with B's event-driven monitoring. The SessionManager owns lifecycle and registry; each session has a lightweight EventSupervisor for real-time health.

**Architecture:**
```python
class SessionManager:
    """Owns session lifecycle and registry. No health polling."""
    
    def __init__(self):
        self._sessions: dict[str, Session] = {}
    
    async def create_session(self, user_id: str, ws: WebSocket) -> Session:
        session = Session(user_id=user_id, ws=ws)
        pipeline = build_pipeline(session)
        supervisor = EventSupervisor(session, on_dead=self._handle_dead_session)
        supervisor.attach(pipeline)
        session.pipeline = pipeline
        session.supervisor = supervisor
        await pipeline.start()
        self._sessions[session.id] = session
        return session
    
    async def destroy_session(self, session_id: str):
        session = self._sessions.pop(session_id, None)
        if not session:
            return
        try:
            await asyncio.wait_for(session.graceful_shutdown(), timeout=5.0)
        except asyncio.TimeoutError:
            logger.error(f"Session {session_id}: graceful shutdown timed out, forcing")
            await session.force_shutdown()
        finally:
            logger.info(f"Session {session_id}: destroyed")
    
    async def _handle_dead_session(self, session: Session, reason: str):
        logger.error(f"Session {session.id} dead: {reason}")
        await session.notify_user("Something went wrong. Please try again.")
        await self.destroy_session(session.id)
    
    def active_sessions(self) -> list[SessionInfo]:
        return [s.info() for s in self._sessions.values()]


class EventSupervisor:
    """Per-session event-driven health monitor."""
    
    def __init__(self, session: Session, on_dead: Callable):
        self._session = session
        self._on_dead = on_dead
        self._request_timer: asyncio.TimerHandle | None = None
        self._degradation_count = 0
    
    def attach(self, pipeline: Pipeline):
        for proc in pipeline.processors:
            proc.task.add_done_callback(self._on_task_done)
            proc.set_metrics_listener(self._on_metrics)
    
    def _on_task_done(self, task: asyncio.Task):
        if task.cancelled():
            return
        exc = task.exception()
        if exc:
            asyncio.create_task(self._on_dead(self._session, f"Processor crash: {exc}"))
    
    def _on_metrics(self, frame: MetricsFrame):
        self._degradation_count += 1
        if self._degradation_count >= 5:
            asyncio.create_task(
                self._session.notify_user("I'm having trouble right now. One moment...")
            )
    
    def on_request_started(self):
        if self._request_timer:
            self._request_timer.cancel()
        loop = asyncio.get_event_loop()
        self._request_timer = loop.call_later(15.0, self._handle_timeout)
    
    def on_response_completed(self):
        if self._request_timer:
            self._request_timer.cancel()
            self._request_timer = None
        self._degradation_count = 0  # Reset on successful response
    
    def _handle_timeout(self):
        asyncio.create_task(
            self._session.notify_user("I'm taking longer than expected. Still working...")
        )
        # Hard timeout — if no response in another 15s, kill the session
        loop = asyncio.get_event_loop()
        self._request_timer = loop.call_later(15.0, self._handle_hard_timeout)
    
    def _handle_hard_timeout(self):
        asyncio.create_task(self._on_dead(self._session, "Request hard timeout (30s)"))
```

**Pros:**
- **Best of both**: Centralized lifecycle (SessionManager) + real-time monitoring (EventSupervisor)
- **Zero-latency crash detection** via task callbacks
- **Clean session registry** for admin introspection
- **Two-tier timeout**: Soft at 15s (notify user) + hard at 30s (kill session)
- **Degradation counter with reset**: Tracks cumulative provider issues per request cycle; resets on success
- **Single cleanup path**: `destroy_session()` is always the final cleanup, with 5s graceful → forced fallback
- **Separation of concerns**: SessionManager handles lifecycle; EventSupervisor handles health signals

**Cons:**
- Two components instead of one — ~90 lines vs ~50-60
- EventSupervisor needs pipeline hooks (`on_request_started`, `on_response_completed`) wired correctly
- No periodic catch-all — if a failure mode doesn't trigger a callback or timer, it goes undetected. Mitigated by: task done-callbacks catch all processor crashes, and the request timer catches all request-level hangs.

---

## Resource Cleanup Deep-Dive

Regardless of approach, resource cleanup on session end must handle:

### Cloud API Connections
| Provider | Connection Type | Cleanup Action |
|----------|----------------|---------------|
| Deepgram STT | WebSocket (persistent per session) | `await ws.close()` — sends close frame |
| OpenRouter LLM | HTTP/SSE (per request) | Cancel `aiohttp.ClientResponse` — closes TCP |
| Fish Audio TTS | WebSocket (per request or persistent) | `await ws.close()` — sends close frame |

### asyncio Resources
| Resource | Cleanup Action |
|----------|---------------|
| Processor tasks (5-7 per pipeline) | `task.cancel()` + `await asyncio.gather(*tasks, return_exceptions=True)` |
| Per-processor queues | Drain remaining frames, release references |
| Request timeout timer | `timer_handle.cancel()` |
| Session conversation history | Release reference (GC handles it) |

### Cleanup Ordering
```
1. Cancel all processor tasks (stops new frame processing)
2. Close cloud API connections (releases network resources)
3. Drain queues (allows GC to collect frame objects)
4. Remove from session registry (prevents new frames from being routed)
5. Log session end (audit trail)
```

**Critical edge case: Crash during cleanup.** If `ws.close()` hangs (provider not responding to close frame), cleanup blocks forever. Mitigation: wrap all cleanup in `asyncio.wait_for(cleanup_sequence(), timeout=5.0)`. If cleanup itself times out, force-cancel everything and log.

---

## Idle Session Management

A session with no activity for an extended period wastes resources (open WebSocket, potentially open cloud connections).

**Policy:**
- **Idle timeout**: 10 minutes with no user input → send "Are you still there?"
- **Hard idle timeout**: 15 minutes → close session, send "Session ended due to inactivity."
- **Implementation**: Simple `call_later()` timer reset on each incoming user frame. Same pattern as request timeout — no polling needed.

---

## User Notification Strategies

When the supervisor detects a problem, how should the user know?

| Situation | Notification | Channel |
|-----------|-------------|---------|
| Request timeout (15s) | "I'm taking longer than expected..." | TTS (synthesized speech) or text fallback |
| Provider degradation | "I'm having some trouble right now." | TTS or text |
| Session killed (hard timeout) | "Something went wrong. Please try again." | Text frame (TTS may be broken) |
| Idle timeout warning | "Are you still there?" | TTS |
| Session ended (idle) | "Session ended due to inactivity." | Text frame |

**Key insight**: When TTS is the degraded component, user notification can't use TTS. The transport layer must support a text-only notification path that the client renders as on-screen text. This is already needed for non-audio interactions, so it's not additional work.

---

## Analysis & Recommendation

### Decision Matrix

| Factor | A. Centralized Polling | B. Event-Driven | C. Hybrid |
|--------|:-:|:-:|:-:|
| Crash detection latency | Up to 5s (poll interval) | Immediate (callback) | Immediate (callback) |
| Stuck request detection | ~5s granularity | Precise (timer-based) | Precise (two-tier timer) |
| Session registry | Built-in | Separate component needed | Built-in |
| Code complexity | ~60 lines | ~50 lines | ~90 lines |
| Wasted work (idle sessions) | Polls all sessions every 5s | Zero | Zero |
| Failure coverage | Broad (periodic scan) | Targeted (must wire hooks) | Targeted + cleanup safety net |
| User notification | On poll discovery | Immediate | Immediate + two-tier |
| Resource cleanup | Centralized | Distributed | Centralized |

### Recommendation: Approach C (Hybrid: SessionManager + EventSupervisor)

**Why C over A**: Polling at 5s intervals is fine for 5 sessions (negligible CPU), but it introduces unnecessary detection latency. A crashed processor task can be detected immediately via `add_done_callback` — waiting up to 5 seconds means 5 seconds of unexplained silence. The event-driven approach eliminates this for zero cost.

**Why C over B**: Pure event-driven supervision lacks a centralized session registry and cleanup path. The SessionManager provides clean session lifecycle ownership — one place to create, one place to destroy, one place to list. Without it, session cleanup logic gets scattered across callbacks, making it hard to guarantee every resource gets released.

**Why C is proportionate**: At 5 sessions max, ~90 lines of code handles:
1. Immediate crash detection (task callbacks)
2. Two-tier request timeout (15s soft, 30s hard)
3. Provider degradation tracking (MetricsFrame listener with per-request reset)
4. Idle session timeout (10 min warn, 15 min kill)
5. Guaranteed resource cleanup (5s graceful → forced fallback)
6. Session registry for admin introspection

No watchdog threads, no heartbeat protocols — just asyncio primitives (callbacks, timers, tasks) applied to a well-defined set of failure modes.

### Key Design Decisions

1. **SessionManager owns lifecycle**: Single point for create/destroy/list sessions. All cleanup flows through `destroy_session()`.
2. **EventSupervisor is per-session**: Each session has its own supervisor instance, attached to its pipeline's processor tasks. No cross-session supervisor logic.
3. **Task done-callbacks for crash detection**: `asyncio.Task.add_done_callback()` fires immediately on processor crash — zero detection latency.
4. **Two-tier request timeout**: 15s soft (notify user, keep trying) → 30s hard (kill session). Prevents both silent hangs and premature kills.
5. **Degradation counter with per-request reset**: Tracks cumulative MetricsFrame alerts. Resets to 0 on successful response. Notifies user after 5 cumulative alerts.
6. **Idle timeout via `call_later()`**: 10 min warn, 15 min kill. Timer resets on every incoming user frame.
7. **Graceful shutdown with 5s hard fallback**: `asyncio.wait_for(graceful_shutdown(), timeout=5.0)` prevents cleanup from hanging on unresponsive providers.
8. **Text-only notification fallback**: When TTS is broken, supervisor sends text frames for on-screen rendering.
9. **Cleanup ordering**: Cancel tasks → close connections → drain queues → remove from registry → log.
10. **No polling**: All monitoring is event-driven or timer-based. Zero periodic work for idle sessions.

### Open Questions

- Should the supervisor attempt pipeline restart (re-create processors, reconnect providers) before killing the session?
- Should session health status be exposed via a simple HTTP endpoint for a family dashboard?
- How does the supervisor interact with provider failover (from `provider-integration`)? Should the supervisor trigger a provider switch, or should the TTS processor handle that internally?
- Should destroyed sessions' conversation history be persisted to disk before cleanup, or is that handled by the memory update step earlier in the pipeline?
