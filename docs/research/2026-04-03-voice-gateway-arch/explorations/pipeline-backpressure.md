# Pipeline Sub-Decision: Backpressure

## Parent Decision Area
`pipeline-architecture` — this is a sub-decision extracted during decomposition.

## Decision Area
How per-processor async queues handle overflow, slow consumers, and resource exhaustion. Without backpressure, a fast LLM streaming into a slow TTS could cause unbounded queue growth, OOM on the 8GB Pi, or degraded latency for other sessions.

## Key Questions

1. **Queue bounds**: Should per-processor queues have max size? What happens when full — drop frames, block the producer, or signal backpressure upstream?
2. **Slow consumer**: If TTS is slower than LLM output, text frames pile up in the SentenceAggregator/TTS queue. How to handle?
3. **Memory budget per queue**: What's the max memory a single session's queues can consume before it becomes a problem for other sessions?
4. **Cross-session fairness**: Can one session's queue growth starve another session's processing?
5. **Metrics/observability**: How to detect queue buildup before it becomes a problem?

---

## Analysis Context: Does Backpressure Actually Matter Here?

Before diving into approaches, it's critical to quantify whether backpressure is a real risk or a theoretical concern for this system.

### Production Rate vs Consumption Rate

| Stage Pair | Producer Rate | Consumer Rate | Bottleneck? |
|-----------|--------------|---------------|-------------|
| Transport → STT | ~50 audio chunks/sec (20ms Opus frames) | Deepgram processes in real-time via WebSocket | No — Deepgram matches input rate |
| STT → Classifier | 1 transcription per utterance (~every 2-5s) | Classifier: single LLM call, 200-400ms | No — huge gap between utterances |
| Classifier → LLM | 1 request per utterance | LLM streams at ~30-60 tokens/sec | No — single request-response |
| LLM → SentenceAggregator | ~30-60 tokens/sec (~15-30 bytes/sec) | Aggregator is pure CPU, <0.1ms/token | No — aggregator is infinitely faster |
| SentenceAggregator → TTS | ~1 sentence every 1-3s | TTS synthesis: 200-800ms/sentence | **Maybe** — if TTS degrades |
| TTS → Transport | Audio chunks as synthesized | WebSocket send: <1ms/chunk | No — network send is instant |

**The only plausible backpressure scenario**: TTS provider degradation. If Fish Audio (or any TTS provider) latency spikes from 500ms to 5+ seconds per sentence, the SentenceAggregator will buffer completed sentences faster than TTS can consume them.

### Worst-Case Queue Growth Calculation

Assume TTS is completely stalled (0 consumption) and LLM is generating a long response:

- LLM generates ~60 tokens/sec × average 4 bytes/token = ~240 bytes/sec of text
- A typical long response is ~200 words (~1000 bytes) over ~15 seconds
- SentenceAggregator emits ~5-8 sentences, each ~20-150 bytes

**Max queue depth for one session**: ~8 sentences × ~150 bytes = **~1.2 KB of text frames**

Even with 5 sessions all experiencing TTS stalls simultaneously: 5 × 1.2 KB = **~6 KB total**.

**This is negligible.** Even if we multiply by 10x for frame overhead, metadata, and queue data structures, we're talking about ~60 KB — irrelevant on an 8GB system.

### The Real Risk Isn't Memory — It's Latency

Queue buildup doesn't threaten memory. The actual risks are:

1. **Stale audio**: If TTS is stalled, sentences queue up. When TTS resumes, it plays back a backlog of sentences that are now stale (the user has been waiting in silence). Playing 8 buffered sentences in sequence after a 10-second stall creates a jarring "fast-forward" experience.

2. **Undetected provider failure**: Without monitoring, a completely dead TTS provider results in permanent silence — the user says something, gets no audio response, has no idea what's wrong.

3. **Cross-session resource contention**: Not queue memory, but TCP connections. If TTS is degraded, all 5 sessions may have stalled HTTP/WebSocket connections tying up file descriptors and connection pool slots.

---

## Approaches Evaluated

### A. Bounded Queues with Producer Block

`asyncio.Queue(maxsize=N)` per processor. Producer `await queue.put()` blocks when the queue is full, creating natural backpressure that propagates upstream.

**Configuration:**
```python
class FrameProcessor:
    def __init__(self, queue_size: int = 10):
        self._input_queue = asyncio.PriorityQueue(maxsize=queue_size)
```

**Behavior when TTS stalls:**
1. TTS queue fills to `maxsize`
2. SentenceAggregator blocks on `queue.put()` — cannot emit next sentence
3. Since aggregator is blocked, it stops consuming LLM tokens (but LLM tokens are in its own queue, which also fills)
4. LLM streaming SSE buffer fills → eventually TCP backpressure to OpenRouter (or SSE events pile up in aiohttp's buffer)
5. Net effect: the entire pipeline freezes for this session

**Pros:**
- Zero custom code — `asyncio.Queue(maxsize=N)` is built-in
- Prevents unbounded growth (though growth was never a real memory risk)
- Producer block is a clear signal that "something downstream is slow"

**Cons:**
- **Blocking propagates catastrophically**: The block chain reaches all the way back to the STT/Transport stage. If the transport can't drain incoming audio, the WebSocket buffer grows, and eventually the client connection stalls or drops.
- **Violates pipeline independence**: The whole point of per-processor queues is that each stage runs independently. Blocking couples them tightly.
- **Barge-in interaction**: If the pipeline is blocked because TTS is stalled, can an InterruptionFrame still propagate? Yes — SystemFrames use priority queuing — but the processor's `process_frame` coroutine might be blocked on `queue.put()` for the downstream stage, not on `queue.get()` for its own input. This creates a deadlock-like scenario where the interrupt can't be processed because the coroutine is stuck putting a frame downstream.
- **Doesn't solve the real problem**: The user is already experiencing silence. Blocking the pipeline just ensures they ALSO can't interrupt (barge-in) cleanly.

**Verdict**: Harmful for this architecture. Blocking breaks barge-in and creates cascading stalls.

### B. Bounded Queues with Drop-Oldest Policy

Custom queue wrapper that, when full, drops the oldest `DataFrame` to make room. `SystemFrame`s are never dropped and always admitted (possibly exceeding the bound temporarily).

**Implementation sketch:**
```python
class BackpressureQueue:
    def __init__(self, maxsize: int = 10):
        self._queue: deque = deque(maxlen=maxsize)
        self._event = asyncio.Event()
    
    async def put(self, frame: Frame):
        if isinstance(frame, SystemFrame):
            self._queue.append(frame)  # Always admit, even over capacity
        else:
            if len(self._queue) >= self._maxsize:
                # Drop oldest non-system frame
                self._drop_oldest_data_frame()
            self._queue.append(frame)
        self._event.set()
    
    def _drop_oldest_data_frame(self):
        for i, frame in enumerate(self._queue):
            if isinstance(frame, DataFrame) and not isinstance(frame, UninterruptibleFrame):
                del self._queue[i]
                return
```

**Behavior when TTS stalls:**
1. TTS queue fills to `maxsize`
2. New sentences from aggregator cause oldest queued sentences to be dropped
3. When TTS resumes, it plays only the most recent sentences
4. User hears a gap but gets the freshest content

**Pros:**
- Producer never blocks — pipeline stays responsive, barge-in always works
- Drops stale content, keeping the most recent sentences (arguably better UX than playing back a stale queue)
- SystemFrames (including InterruptionFrame) always get through

**Cons:**
- **Custom queue implementation**: ~30-40 lines of code, needs testing for correctness (thread safety not needed since we're single-threaded asyncio, but edge cases around priority and drop ordering)
- **Dropped frames are lost speech**: If sentences 2-4 of a 6-sentence response are dropped, the user hears sentence 1, then jumps to sentences 5-6. This could be confusing.
- **UninterruptibleFrame complicates drop logic**: Tool results marked as UninterruptibleFrame cannot be dropped, which means the queue could still grow if it's full of undroppable frames (unlikely but theoretically possible).
- **Observability needed**: Dropped frames should be logged — silent data loss is a debugging nightmare.

**Verdict**: Workable, but the added complexity solves a problem that the analysis shows is negligible (max ~1.2 KB per session). The drop logic is solving for a queue depth of ~8 items that occupies ~1.2 KB of memory.

### C. Unbounded Queues with High-Water Mark Monitoring

Unbounded `asyncio.PriorityQueue()` (the current design). Add a high-water mark check that logs warnings and optionally triggers corrective action.

**Implementation sketch:**
```python
class FrameProcessor:
    HIGH_WATER_MARK = 20  # ~20 sentences queued = something is very wrong
    CRITICAL_MARK = 50    # Abandon hope, drain and reset
    
    async def _run(self):
        while True:
            frame = await self._input_queue.get()
            depth = self._input_queue.qsize()
            
            if depth >= self.CRITICAL_MARK:
                logger.error(f"{self.name}: queue depth {depth} — draining stale frames")
                await self._drain_stale_frames()
                # Optionally: emit a MetricsFrame upstream for session supervisor
            elif depth >= self.HIGH_WATER_MARK:
                logger.warning(f"{self.name}: queue depth {depth} — possible provider degradation")
            
            await self.process_frame(frame, FrameDirection.DOWNSTREAM)
    
    async def _drain_stale_frames(self):
        """Drop all DataFrames, preserve SystemFrames and UninterruptibleFrames."""
        preserved = []
        while not self._input_queue.empty():
            frame = self._input_queue.get_nowait()
            if isinstance(frame, (SystemFrame, UninterruptibleFrame)):
                preserved.append(frame)
        for frame in preserved:
            self._input_queue.put_nowait(frame)
```

**Behavior when TTS stalls:**
1. Sentences accumulate in TTS queue — memory impact negligible (~1.2 KB)
2. At depth 20: warning logged → operator/metrics can trigger alerts
3. At depth 50: stale DataFrames are drained, preserving SystemFrames
4. When TTS resumes: plays whatever sentences remain (most recent + any undroppable)

**Pros:**
- **Simplest implementation**: Uses standard `asyncio.PriorityQueue`, no custom queue class needed
- **Never blocks**: Producer always succeeds → pipeline stays responsive → barge-in always works
- **Proportionate to the risk**: The analysis shows max queue depth is ~8 items / ~1.2 KB per session. Adding bounded queues for this is over-engineering.
- **Observability-first**: The real value isn't preventing queue growth (which is harmless) — it's *detecting* provider degradation early so the session supervisor (future sub-decision) can take action (failover, notify user, etc.)
- **Critical-mark drain is a safety net**: If something truly pathological happens (e.g., TTS provider returns 200 OK but never sends audio), the drain prevents infinite growth over very long sessions
- **Compatible with all pipeline features**: Barge-in (InterruptionFrame is SystemFrame), UninterruptibleFrame (preserved during drain), session scoping (each session has independent queues and thresholds)

**Cons:**
- **No true backpressure**: Upstream producers have no idea downstream is stalled until the critical mark triggers a drain
- **Stale audio on TTS recovery**: If TTS was stalled for 10 seconds and then recovers, it will play back all 8+ buffered sentences in sequence. This is a UX issue regardless of approach — but approach B at least drops stale sentences.
- **Relies on session supervisor for real remediation**: Monitoring detects the problem but doesn't fix it. The session supervisor (to be explored separately) must handle failover, timeout, or user notification.

**Mitigation for stale audio**: Add a `max_age` check in the TTS processor — if a text frame has been queued for >5 seconds, skip it and log. This is a ~5-line addition:

```python
async def process_frame(self, frame: Frame, direction: FrameDirection):
    if isinstance(frame, TextFrame):
        age = time.monotonic() - frame.timestamp
        if age > 5.0:
            logger.info(f"Skipping stale text frame (age={age:.1f}s): {frame.text[:50]}...")
            return  # Don't synthesize stale text
    await self._synthesize(frame)
```

---

## Cross-Session Fairness

With 5 concurrent sessions sharing one asyncio event loop, can one session's queue buildup starve others?

**Answer: No, not from queues.** The asyncio event loop processes tasks cooperatively. Each processor's `_run()` coroutine does `await self._input_queue.get()` which yields to the event loop. A deep queue doesn't consume more CPU — it just has more items waiting. The event loop round-robins between all active coroutines fairly.

**The real fairness risk is TCP connections**, not queues. If one session's TTS provider call is stalled with an open TCP connection, it doesn't block other sessions' connections (asyncio handles them independently). But if the provider is globally degraded, ALL sessions stall simultaneously. This is a provider-level failover problem, not a backpressure problem — addressed in `provider-integration`.

---

## Analysis & Recommendation

### Decision Matrix

| Factor | A. Bounded + Block | B. Bounded + Drop | C. Unbounded + Monitor |
|--------|:-:|:-:|:-:|
| Implementation complexity | Zero (built-in) | Medium (~40 lines) | Low (~15 lines) |
| Memory protection needed? | No (max ~6KB across 5 sessions) | No | No |
| Barge-in compatibility | **Broken** (deadlock risk) | Good | Good |
| Producer blocking | Yes (cascading) | No | No |
| Stale audio handling | Worst (full backlog on recovery) | Best (drops old) | Good (with max_age check) |
| Observability | None | Needs logging | Built-in (high-water alerts) |
| Pipeline independence | Destroyed | Preserved | Preserved |
| Future extensibility | Low | Medium | High (supervisor integration) |

### Recommendation: Approach C (Unbounded Queues with High-Water Mark Monitoring)

**Why C over A**: Approach A is actively harmful. Blocking propagation breaks barge-in (the most important pipeline feature) and couples all stages tightly. It solves a memory problem that doesn't exist while creating a deadlock problem that's real.

**Why C over B**: Approach B adds ~40 lines of custom queue code with drop logic, priority preservation, and UninterruptibleFrame handling to manage a queue that will realistically never exceed ~8 items totaling ~1.2 KB. The complexity isn't justified by the risk. The `max_age` check in C achieves the same "skip stale content" benefit with ~5 lines of code in the TTS processor, without needing a custom queue implementation.

**Why C is the right level of engineering**:
1. The quantitative analysis shows backpressure is not a memory risk for this system
2. The real risk is UX degradation from provider stalls — and the right fix is provider failover + user notification (session supervisor), not queue management
3. High-water mark monitoring provides the observability needed for the session supervisor to detect and respond to degradation
4. The `max_age` check on text frames prevents stale audio playback with minimal code
5. The approach is trivially testable: inject frames, check queue depth, verify drain behavior

### Key Design Decisions

1. **Unbounded `asyncio.PriorityQueue`** per processor — standard library, no custom queue
2. **High-water mark at 20 items**: Log warning, emit MetricsFrame for session supervisor
3. **Critical mark at 50 items**: Drain all DataFrames, preserve SystemFrames and UninterruptibleFrames
4. **`max_age` check in TTS processor**: Skip text frames older than 5 seconds — prevents stale audio playback
5. **Frame timestamps**: Every DataFrame carries a `timestamp` (set at creation via `time.monotonic()`) for age-based staleness detection
6. **No cross-session fairness mechanism needed**: asyncio's cooperative scheduling provides natural fairness; queue depth doesn't affect CPU scheduling
7. **Provider-level degradation**: Handled by provider failover (separate decision area), not by per-queue backpressure

### Open Questions

- Should the high-water mark thresholds (20/50) be configurable or hardcoded? Given the analysis shows they'll rarely be hit, hardcoded constants seem appropriate.
- Should the `max_age` stale-frame check also apply to AudioEncodedFrames (outgoing audio that's been queued too long)?
- How does the session supervisor (future sub-decision) consume the MetricsFrame emitted at high-water mark? Direct queue inspection, or should the MetricsFrame propagate upstream to a supervisor listener?
