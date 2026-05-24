# Pipeline Architecture on RPi5

## Decision Area
How to structure the voice processing pipeline on a Raspberry Pi 5 (8GB RAM, 4-core Cortex-A76 @ 2.4GHz) serving up to 5 concurrent family users. All inference is cloud-based — the Pi handles orchestration, audio codec, and streaming coordination.

## Key Questions
1. **Frame-based streaming design**: Frame types (audio, text, control, system), downstream/upstream flow, Pipecat-inspired but custom
2. **Streaming overlap**: TTS must start before LLM finishes — sentence boundary detection enables pipelined execution
3. **Barge-in / cancel propagation**: First-class interrupt event that cancels all in-flight work for a session
4. **Concurrency model**: How 5 simultaneous users share CPU and RAM
5. **Memory budget**: What does 5 concurrent sessions cost in RAM?
6. **Process model**: Single process vs worker-per-session vs hybrid

---

## Workload Profile

This is critical context: the Pi does **almost no compute**. The workload is ~95% I/O-bound (waiting on cloud APIs):

| Operation | Where | Time | CPU on Pi |
|-----------|-------|------|-----------|
| STT (Deepgram) | Cloud | 200-500ms | ~0 (WebSocket I/O) |
| Classifier (cheap LLM) | Cloud | 200-400ms | ~0 (HTTP/SSE I/O) |
| LLM response (OpenRouter) | Cloud | 500-3000ms | ~0 (SSE I/O) |
| TTS (Fish Audio) | Cloud | 200-800ms | ~0 (WebSocket I/O) |
| Opus decode (incoming audio) | Local | <1ms/chunk | Minimal |
| Opus encode (outgoing audio) | Local | <1ms/chunk | Minimal |
| Sentence boundary detection | Local | <0.1ms | Negligible |
| JSON parsing, frame routing | Local | <0.1ms | Negligible |

**Implication**: The GIL is irrelevant. Python's asyncio is ideal because the bottleneck is network I/O latency, not CPU throughput. The only CPU work (Opus codec) takes <1ms per 20ms audio chunk and releases the GIL in the C extension.

---

## Frame-Based Pipeline Design (Pipecat-Inspired)

### Frame Type Hierarchy

Adopting Pipecat's proven three-tier frame hierarchy:

```
Frame (base)
├── SystemFrame          # High-priority, processed immediately, NOT cancelled by interrupts
│   ├── StartFrame       # Session initialization
│   ├── CancelFrame      # Kill all in-flight work for this session
│   ├── InterruptionFrame # Barge-in signal (propagates both directions)
│   └── MetricsFrame     # Latency/timing data for observability
│
├── DataFrame            # Ordered data, CANCELLED by interruptions
│   ├── AudioRawFrame    # PCM audio chunk (decoded)
│   ├── AudioEncodedFrame # Opus-encoded audio chunk
│   ├── TextFrame        # Text chunk (STT output, LLM token, TTS input)
│   ├── TranscriptionFrame # Complete STT result (is_final=true)
│   └── LLMResponseFrame # Complete or partial LLM response
│
└── ControlFrame         # Ordered control signals, CANCELLED by interruptions
    ├── EndFrame         # Session teardown
    ├── LLMFullResponseStartFrame
    ├── LLMFullResponseEndFrame
    ├── TTSStartedFrame
    └── TTSStoppedFrame
```

**Key design choice**: `UninterruptibleFrame` mixin for frames that must survive barge-in (e.g., tool call results that should be preserved even if the user interrupts TTS playback).

### Pipeline Processor Architecture

Each processor is an async task with its own input queue:

```python
class FrameProcessor:
    """Base class for all pipeline stages."""
    
    def __init__(self):
        self._input_queue = asyncio.PriorityQueue()  # SystemFrames get priority 1, others priority 2
        self._next: FrameProcessor | None = None
        self._prev: FrameProcessor | None = None
        self._task: asyncio.Task | None = None
    
    async def process_frame(self, frame: Frame, direction: FrameDirection):
        """Override in subclasses. Call super() first for system frame handling."""
        if isinstance(frame, InterruptionFrame):
            await self._handle_interruption()
    
    async def push_frame(self, frame: Frame, direction: FrameDirection = DOWNSTREAM):
        """Send frame to next/prev processor."""
        target = self._next if direction == DOWNSTREAM else self._prev
        if target:
            await target.queue_frame(frame)
```

**Per-processor queues provide natural pipeline parallelism**: While TTS is synthesizing sentence N, the LLM is generating sentence N+1, and STT may be processing the next utterance. No explicit concurrency wiring needed — the queue architecture delivers overlap for free.

### Pipeline Linking

Processors form a doubly-linked list, enabling bidirectional frame flow:

```
[STT] ──next──> [Classifier] ──next──> [LLM] ──next──> [SentenceAggregator] ──next──> [TTS] ──next──> [Transport]
       <──prev──             <──prev──       <──prev──                        <──prev──      <──prev──
```

Upstream flow enables error propagation and interrupt signals to reach all stages.

---

## Streaming Overlap

The critical latency optimization: TTS begins synthesis on the first complete sentence while the LLM is still generating.

### Sentence Boundary Detection

Using a `SentenceAggregator` processor between LLM and TTS:

```
LLM streams tokens: "The weather" → " today is" → " sunny." → " Tomorrow" → " will be" → " cloudy."
                                                       ↓                                        ↓
SentenceAggregator emits: ─────────────────── "The weather today is sunny." ── "Tomorrow will be cloudy."
                                                       ↓                                        ↓
TTS starts synthesizing: ──────────────────── [synthesis begins]            [synthesis begins]
```

**Detection strategy** (inspired by stream2sentence):
- Primary: Punctuation delimiters (`.`, `!`, `?`, `:`, `;`)
- Secondary: After N words without punctuation, force a break at the next natural pause (comma, conjunction)
- Minimum chunk size: ~3 words (avoid synthesizing fragments like "Yes.")
- Fragment handling: Buffer very short fragments and combine with the next sentence

**Latency savings**: For a typical 3-sentence response, first audio reaches the user after ~sentence 1 synthesis time instead of waiting for the full LLM response. This cuts perceived latency by **50-70%**.

---

## Barge-In / Cancel Propagation

When a user starts speaking while the assistant is responding, the system must immediately:
1. Stop TTS playback
2. Cancel in-flight TTS synthesis
3. Cancel in-flight LLM generation
4. Cancel any in-flight tool calls (if applicable)
5. Start processing the new user utterance

### Propagation Mechanism

```
User starts speaking
       ↓
[Transport] detects audio input during TTS playback
       ↓
Broadcasts InterruptionFrame BOTH upstream and downstream
       ↓
Each processor receives InterruptionFrame (SystemFrame = priority queue):
  1. Cancels its current processing task
  2. Drains its process queue (except UninterruptibleFrames)
  3. Creates a fresh processing task
  4. Ready for new frames
```

**Critical edge case**: Tool call results during barge-in. If the LLM called a tool and the result hasn't been incorporated yet, we must NOT discard it. Solution: mark tool result frames as `UninterruptibleFrame` so they survive queue drain. The next LLM call can include them.

**Session scoping**: Each session has its own pipeline instance. InterruptionFrame only propagates within the interrupted session — other sessions are unaffected.

---

## Approaches Evaluated

### A. Single-Process Asyncio Pipeline

One Python process, one event loop, all sessions as concurrent coroutines sharing the process.

**Architecture:**
```
[Main Process]
  └── asyncio event loop
       ├── Session 1 pipeline (coroutines + queues)
       ├── Session 2 pipeline (coroutines + queues)
       ├── ...
       └── Session 5 pipeline (coroutines + queues)
```

**Memory budget:**

| Component | Memory |
|-----------|--------|
| Python 3.12 + asyncio baseline | ~15 MB |
| Shared libraries (aiohttp, websockets, opus bindings) | ~5-8 MB |
| Per-session (WebSocket + audio buffers + history + tasks) | ~0.5-1 MB x 5 |
| GC overhead / fragmentation (~20%) | ~5 MB |
| **Total for 5 sessions** | **~30-35 MB** |

**Pros:**
- Simplest implementation — standard asyncio patterns, well-understood
- Lowest memory footprint (~30-35 MB total for 5 sessions)
- Easy shared state (session registry, config, provider clients can be shared)
- Single process to monitor, restart, and log
- asyncio's cooperative multitasking is perfect for I/O-bound workloads

**Cons:**
- Zero failure isolation — unhandled exception in one session's coroutine can corrupt shared state
- Single core utilization (event loop is single-threaded) — but irrelevant for this I/O-bound workload
- Opus encode/decode runs on the event loop thread (though at <1ms, this is negligible blocking)

**Risk assessment**: The failure isolation concern is mitigable with structured exception handling (`try/except` in every session pipeline, `asyncio.TaskGroup` for cleanup). Python asyncio exceptions in one task don't crash others — they're contained to the task unless shared mutable state is corrupted.

### B. Worker-Per-Session (Subprocess)

Main process accepts connections and spawns a worker subprocess per active session.

**Architecture:**
```
[Main Process] ── accepts WebSocket connections, manages lifecycle
  ├── [Worker 1] ── full pipeline for Session 1
  ├── [Worker 2] ── full pipeline for Session 2
  └── ...
```

**Memory budget:**

| Component | Memory |
|-----------|--------|
| Main process | ~25 MB |
| Per worker (Python interpreter + libraries + pipeline) | ~20-25 MB x 5 |
| **Total for 5 sessions** | **~125-150 MB** |

Note: Copy-on-write (fork) helps initially but diverges quickly as each worker loads its own session state.

**Pros:**
- Full crash isolation — one worker dies, others unaffected
- True multi-core utilization (one worker per core)
- Clean security boundary between sessions
- Can restart individual workers without affecting others

**Cons:**
- 4-5x more RAM than single-process (~125-150 MB vs ~30-35 MB)
- IPC complexity — need pipes or Unix sockets between main process and workers
- No shared provider clients — each worker opens its own Deepgram/OpenRouter/Fish Audio connections (wastes API connection limits)
- Process spawn overhead (~100-200ms per new session)
- Overkill for 5 users on a mostly I/O-bound workload
- More complex deployment, logging, health monitoring

**Risk assessment**: The RAM overhead is acceptable on 8GB but wasteful. The real problem is complexity: IPC for forwarding WebSocket frames to workers, duplicated API connections, and process lifecycle management. This is enterprise-grade isolation for a 5-user family project.

### C. Hybrid: Single Process + ThreadPoolExecutor for CPU Work

Asyncio main loop handles all I/O. CPU-bound work (Opus encode/decode) is offloaded to a thread pool.

**Architecture:**
```
[Main Process]
  └── asyncio event loop
       ├── Session pipelines (coroutines + queues)
       └── ThreadPoolExecutor(max_workers=4)
            ├── Opus encode tasks
            └── Opus decode tasks
```

**Memory budget:**

| Component | Memory |
|-----------|--------|
| Python 3.12 + asyncio baseline | ~15 MB |
| Shared libraries | ~5-8 MB |
| ThreadPoolExecutor (4 threads, 8MB virtual stack each — ~1MB resident) | ~4 MB |
| Per-session state | ~0.5-1 MB x 5 |
| GC overhead | ~5 MB |
| **Total for 5 sessions** | **~35-45 MB** |

**Pros:**
- Same low memory as single-process + ~5 MB for thread pool
- Opus codec runs in parallel on separate cores (GIL released in C extension)
- `loop.run_in_executor()` is a one-line offload pattern — minimal complexity
- Future-proof: if CPU work grows, threads are already available
- Can swap `ThreadPoolExecutor` → `ProcessPoolExecutor` with a one-line change if true isolation is ever needed

**Cons:**
- Slight complexity increase over pure asyncio (thread safety for shared buffers)
- Thread crash can theoretically affect the process (though exceptions are captured in Futures)
- The benefit is marginal — Opus at <1ms barely blocks the event loop anyway

**Risk assessment**: This is the "engineer's insurance policy." The actual benefit over pure asyncio is minimal for this workload, but the cost is also minimal (~5 MB RAM, ~10 lines of code). It provides headroom if audio processing becomes more complex later.

---

## Analysis & Recommendation

### Decision Matrix

| Factor | A. Pure Asyncio | B. Worker/Session | C. Hybrid |
|--------|:-:|:-:|:-:|
| RAM (5 sessions) | ~30-35 MB | ~125-150 MB | ~35-45 MB |
| Implementation complexity | Low | High | Low-Medium |
| Failure isolation | Low (mitigable) | High | Medium |
| Multi-core usage | 1 core | 4 cores | 1 core + threads |
| Shared provider clients | Yes | No | Yes |
| Matches workload profile | Excellent | Overkill | Excellent |
| Ops complexity | Low | Medium | Low |

### Recommendation: Approach C (Hybrid), with Approach A as fallback

**Primary: Hybrid (C)** — It costs almost nothing over pure asyncio but provides thread pool headroom for CPU work and future extensibility. The implementation is straightforward:

```python
executor = ThreadPoolExecutor(max_workers=4)

# In audio processor:
pcm_data = await loop.run_in_executor(executor, opus_decode, encoded_chunk)
```

**Why not A?** It would work fine today. The thread pool in C is insurance, not necessity. If implementation simplicity is paramount, A is the right choice — you can add the thread pool later with minimal refactoring.

**Why not B?** It wastes 80-100 MB of RAM solving a problem (crash isolation) that doesn't exist at this scale. Five family users don't need process-level isolation. The IPC complexity and duplicated API connections add real costs with negligible benefits.

### Key Architecture Decisions

1. **Frame hierarchy**: Three tiers (System/Data/Control) with priority queuing — adopted from Pipecat
2. **Per-processor async queues**: Natural pipeline parallelism without explicit concurrency wiring
3. **Sentence boundary detection**: SentenceAggregator between LLM and TTS for streaming overlap
4. **Barge-in**: InterruptionFrame as SystemFrame propagates through priority queue to all stages
5. **UninterruptibleFrame mixin**: Tool results survive barge-in
6. **Session-scoped pipelines**: Each session gets its own pipeline instance; interrupts don't cross sessions
7. **Shared provider clients**: Single Deepgram/OpenRouter/Fish Audio connection pool shared across sessions

### Open Questions for Scoring
- Should the sentence aggregator be configurable (min chunk size, timeout before force-break)?
- How should pipeline metrics be collected? (Per-stage latency, queue depths)
- Should there be a pipeline "supervisor" that restarts failed sessions?

---

## Score — Round 1

- Feasibility & Validation: 5/10
- Maintainability & Testability: 5/10
- Risk & Trade-offs: 6/10
- Effort & Complexity: 8/10
- Alignment: 8/10
- **Total: 32/50**

### Friction Log
- [Feasibility]: Memory budget figures (0.5-1 MB/session) are asserted without measurement — likely too low once conversation history, persona.md, and user memory are in-process
- [Feasibility]: No PoC at all. Streaming overlap (50-70% latency cut), barge-in propagation, and sentence boundary detection are described but unexercised
- [Feasibility]: Sentence boundary detection doesn't address hard cases (abbreviations, ellipsis, quoted speech) — false breaks cause TTS stitching artifacts
- [Maintainability]: No test strategy documented — testing barge-in queue drain, UninterruptibleFrame survival, sentence edge cases is non-trivial but unaddressed
- [Maintainability]: PriorityQueue item format underspecified — asyncio.PriorityQueue needs comparable tuples, convention not shown
- [Maintainability]: No observability beyond MetricsFrame stub — debugging stuck queues or failed barge-in will be very hard
- [Risk]: Shared provider client corruption not analyzed — if one session corrupts connection pool, all fail
- [Risk]: Long-running tool calls during barge-in — can't cancel in-flight HTTP, client experiences silence
- [Risk]: No discussion of Pi reboot mid-session — all sessions lost (acceptable but should be called out)
- [Effort]: Approach C recommended despite analysis showing A is sufficient — slight gold-plating

### What's Missing
- No PoC code at all
- Memory numbers unverified
- No test strategy
- No session supervisor / watchdog for hung sessions
- Sentence aggregator timeout/N-word threshold unquantified
- Shared provider client thread safety unaddressed
- No backpressure mechanism for per-processor queues

### Sub-Decisions (from Decompose step)
- `pipeline-sentence-aggregator` — boundary detection rules, edge cases, configurability
- `pipeline-backpressure` — queue overflow, slow consumer handling, cross-session fairness
- `pipeline-test-strategy` — testing barge-in, UninterruptibleFrame, streaming overlap, sentence edge cases
- `pipeline-session-supervisor` — hung session detection, recovery, resource cleanup

### What's Strong
- Workload characterization (95% I/O-bound) is excellent and directly shapes decisions
- Three-way comparison (A/B/C) is well-structured with clear memory/complexity tradeoffs
- UninterruptibleFrame mixin for tool results is a sharp design insight
- Session-scoped pipelines with shared provider clients is proportionate to scale
- Strong alignment to project constraints — stays within asyncio + Python, rejects enterprise overkill
