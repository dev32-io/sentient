# Gateway Core — Node/Bun + TypeScript

## Decision Area
Runtime choice and gateway architecture for the voice gateway on RPi5.

## Key Questions
- Node.js vs Bun: performance on ARM64 (RPi5), ecosystem maturity, WebSocket support?
- Single process sufficient for passthrough orchestration with ~10 concurrent sessions?
- WebSocket server implementation: native (Bun) vs ws/uWebSockets.js (Node)?
- HTTP health/metrics endpoint alongside WebSocket?
- Memory footprint and startup time on constrained hardware?
- Streaming relay patterns: backpressure handling, cancel propagation?

## Prior Research
- Python iteration explored Pipecat/LiveKit patterns — adapt for TS
- Gateway is passthrough/orchestrator, not audio processor
- Bun ARM64: official aarch64 binaries since v0.1.5, RPi5 (Cortex-A76 ARMv8.2-A) fully supported with 64-bit OS. GitHub issues #75 and #17460 both closed — all reported problems were 32-bit OS on 64-bit hardware.

## Approaches

### Approach A: Bun Runtime (Native WebSocket)

**Description:** Use Bun as the sole runtime. Leverage built-in WebSocket server (uWebSockets underneath), native TypeScript execution (no build step), and built-in file watcher for skill hot-reload.

**Architecture:**
```
Bun.serve({
  fetch(req, server) → HTTP health endpoint + WS upgrade
  websocket: {
    open(ws) → session create, auth handshake
    message(ws, data) → binary: relay to STT/TTS; text: JSON control
    close(ws) → session cleanup
  }
})
```

**Pros:**
- **2.1x faster WebSocket throughput** — PoC measured 296,794 msg/s vs Node's 141,522 msg/s (10 clients, JSON echo)
- **2.25x faster binary relay** — 272,995 frames/s vs 121,609 frames/s (5 sessions, 320-byte Opus frames)
- **Lower base memory** — 32.7MB RSS at startup vs 45.0MB for Node.js (27% less)
- **Faster startup** — 9ms vs 15ms median cold start
- **Native TypeScript** — no tsc, no build step, no tsx. Just `bun run server.ts`
- **Built-in hot reload** — `bun --hot server.ts` for development; `Bun.serve` supports hot module reloading
- **Built-in file watcher** — useful for skill hot-reload without chokidar dependency
- **Single binary** — simpler deployment to RPi5, curl install
- **Built-in pub/sub** — `ws.subscribe(topic)` / `server.publish(topic, data)` useful for broadcast scenarios
- **Backpressure reporting** — `ws.send()` returns bytes buffered, `getBufferedAmount()` for flow control

**Cons:**
- **Ecosystem maturity** — ~95% npm compatibility, but native addon gaps (N-API bindings can fail)
- **~4.7K open issues** on GitHub — more rough edges than Node
- **No musl/Alpine ARM64** — must use glibc-based distro (Raspberry Pi OS, Ubuntu)
- **Less battle-tested on ARM64** — works but fewer production deployments than Node
- **JavaScriptCore quirks** — subtle behavioral differences from V8 in edge cases
- **API churn** — Bun APIs still evolving faster than Node; some breaking changes between minor versions

**Risk factors:**
- If a critical npm dependency uses native addons that don't work with Bun, must fall back to Node or find alternatives
- ARM64 stability under sustained load (24/7 home server) less proven than Node

### Approach B: Node.js Runtime (ws library)

**Description:** Use Node.js LTS with the `ws` library for WebSocket server. Standard, battle-tested stack. TypeScript via tsx or Node v22+ `--experimental-strip-types`.

**Architecture:**
```
const server = http.createServer(healthHandler);
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => { ... });
server.listen(PORT);
```

**Pros:**
- **Battle-tested** — Node.js LTS on ARM64 is the industry standard for RPi projects
- **100% npm compatibility** — every package works, including native addons
- **Proven 24/7 stability** — thousands of production deployments on Raspberry Pi
- **Mature debugging** — Chrome DevTools, `--inspect`, heap snapshots, all work on ARM64
- **Large community** — easier to find help, examples, and solutions for RPi-specific issues
- **LTS guarantees** — v22 LTS supported through April 2027, predictable update cycle

**Cons:**
- **Slower WebSocket** — 141K msg/s vs 297K msg/s (Bun) — still 2,830x above requirement (50 msg/s × 10 sessions)
- **Higher memory baseline** — 45MB RSS vs 33MB — but RPi5 has 8GB, so 12MB difference is negligible
- **Build step for TypeScript** — needs tsx, ts-node, or upgrade to Node v22+ for native TS strip
- **No built-in file watcher** — needs chokidar (or switch to Node v22 `fs.watch` improvements)
- **ws library boilerplate** — more setup code than Bun's declarative handler pattern
- **Slower startup** — 15ms vs 9ms — irrelevant for a long-running server

**Risk factors:**
- Node.js v20 LTS doesn't have native TypeScript — either need tsx dependency or upgrade to v22
- ws library is well-maintained but adds a dependency

### Approach C: Bun Primary with Node.js Fallback

**Description:** Develop and deploy with Bun. Write code to be compatible with both runtimes (avoid Bun-only APIs in critical paths). If a Bun ARM64 issue surfaces, switch to Node.js with minimal changes.

**Architecture:**
```typescript
// Abstraction layer
interface GatewayServer {
  start(port: number): Promise<void>;
  stop(): Promise<void>;
}

// Bun implementation (primary)
class BunGateway implements GatewayServer { ... }
// Node implementation (fallback)
class NodeGateway implements GatewayServer { ... }
```

**Pros:**
- Gets Bun performance benefits while hedging ARM64 risk
- Forces clean abstractions that benefit the codebase regardless
- Can A/B test both runtimes on the actual Pi hardware

**Cons:**
- **Premature abstraction** — maintaining two implementations for a problem that may not exist
- **Increased complexity** — more code to write, test, and maintain for a personal project
- **Bun-specific features lost** — can't use pub/sub, built-in file watcher, etc. if staying portable
- **Testing burden** — must validate behavior on both runtimes

**Risk factors:**
- Over-engineering for a family project. If Bun works (and PoCs suggest it does), the fallback is wasted effort.

## PoC Results

All benchmarks run on ARM64 (aarch64), Bun 1.3.11, Node.js v20.20.2.

### WebSocket JSON Echo (10 clients, 5 seconds)

| Metric | Node.js + ws | Bun native |
|--------|-------------|------------|
| Messages/sec | 141,522 | 296,794 |
| RSS at start | 45.0 MB | 32.7 MB |
| RSS with 10 clients | 47.2 MB | 36.0 MB |
| RSS final | 55.1 MB | 61.0 MB |

**Bun is 2.1x faster for JSON message throughput.** Both are >2,800x above the real-world requirement of ~500 msgs/s (50/session × 10 sessions). Memory is comparable under load.

### Binary Frame Relay (5 sessions, 320-byte Opus frames, 5 seconds)

| Metric | Node.js + ws | Bun native |
|--------|-------------|------------|
| Frames/sec total | 121,609 | 272,995 |
| Frames/sec/session | 24,322 | 54,599 |
| RSS | 55.0 MB | 66.2 MB |

**Real-time Opus needs ~50 frames/sec/session (20ms frames).** Both runtimes deliver >480x headroom. This confirms the gateway is not audio-processing-bound — it's a pure relay.

### Startup Time (5 runs, median)

| Runtime | Cold start |
|---------|-----------|
| Node.js | 15ms |
| Bun | 9ms |

Negligible for a long-running server.

### Session Management PoC (`poc/gateway-core/session-poc.ts`)

Validated:
- Session creation/destruction with 10-session cap
- AbortController-based cancel propagation (barge-in signals)
- Async operation cancellation via abort signal (simulated STT relay cancelled in ~100ms)
- Health endpoint shape with runtime info, memory stats, session counts
- Guest vs family role tracking
- All tests pass on Bun 1.3.11

## Analysis

### Do we need this performance?

**No.** The RPi5 gateway handles at most ~10 concurrent sessions. At peak, that's:
- ~500 audio frames/sec (50fps × 10 sessions) — both runtimes deliver 100K+
- ~100 JSON control messages/sec — both deliver 100K+
- The bottleneck will be STT/LLM/TTS latency, never WebSocket throughput

**The performance margin is so large that runtime choice should be driven by developer experience, ecosystem fit, and operational simplicity — not raw speed.**

### Single process: sufficient?

**Yes, definitively.** The gateway is a passthrough orchestrator. Its work is:
1. Accept WebSocket connections (I/O bound)
2. Relay binary audio to STT service (I/O bound)
3. Run classifier (regex: CPU-trivial; LLM: network-bound)
4. Execute skill/tool calls (mostly network-bound API calls)
5. Relay TTS audio back (I/O bound)

This is classic async I/O workload. A single event loop handles it easily. The PoC showed 10 concurrent sessions with no contention. Worker threads/clustering would add complexity for zero benefit.

### TypeScript experience

- **Bun:** Native TS execution, zero config, just works. Best DX.
- **Node.js v20:** Requires tsx or ts-node. Extra dependency, slightly slower startup.
- **Node.js v22+:** Has `--experimental-strip-types` but it's experimental. v22 LTS is available.

For a greenfield TypeScript project, Bun's native TS support is a significant DX advantage.

### Hot reload for development

- **Bun:** `bun --hot server.ts` — built-in, preserves state
- **Node.js:** `node --watch` (v18.11+) — restarts process, loses state. Or use nodemon.

Bun's hot reload is better for the skill system development loop (edit skill file → immediate effect).

### npm ecosystem compatibility

The gateway needs: WebSocket server (built-in for both), PASETO library, file system watcher, YAML parser, HTTP client for provider APIs. None of these require exotic native addons. The ~5% Bun incompatibility is mainly in: native C++ addons (node-gyp edge cases), some `vm` module uses, and niche Node-specific APIs.

**Relevant packages checked:**
- `paseto-ts` — pure TS, works in Bun
- `@opliko/paseto` — explicitly targets Bun
- `chokidar` — works in Bun (but Bun has built-in file watcher)
- `yaml` — pure JS, works everywhere
- `ws` — Node-only (not needed for Bun)

## Recommendation

**Approach A: Bun Runtime** is the strongest choice for this project.

**Rationale:**
1. **Both runtimes have >100x performance headroom** — performance is not the deciding factor
2. **Bun's DX wins matter more**: native TypeScript, built-in file watcher (skill hot-reload), built-in WebSocket server, simpler deployment (single binary)
3. **Lower operational complexity**: fewer dependencies (no ws, no tsx, no chokidar), single binary install on RPi5
4. **ARM64 support is solid**: 64-bit RPi OS + Bun aarch64 binary. Issues were all 32-bit OS misconfigurations.
5. **The ecosystem gap doesn't matter here**: all needed packages are pure TS/JS — no native addon dependencies
6. **Approach C (hybrid) is over-engineering**: maintaining two implementations for a solved problem wastes effort on a personal project

**If Bun breaks on RPi5 ARM64 in production**: migration to Node.js + ws is straightforward (the business logic is TypeScript either way). The risk is low and the migration cost is bounded.

## Gateway Architecture Sketch (Bun)

```typescript
// server.ts — entry point
const sessions = new SessionManager(MAX_SESSIONS);

const server = Bun.serve({
  port: config.port,
  
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return healthResponse(sessions);
    if (url.pathname === "/metrics") return metricsResponse(sessions);
    if (server.upgrade(req, { data: { ip: req.headers.get("x-real-ip") } })) return;
    return new Response("Not found", { status: 404 });
  },
  
  websocket: {
    open(ws) {
      // Auth handshake starts — 5s timeout for PASETO token
    },
    message(ws, data) {
      if (typeof data === "string") {
        // JSON control message (text.input, barge_in, tool.confirm, etc.)
        handleControlMessage(ws, JSON.parse(data));
      } else {
        // Binary audio frame — relay to STT service
        relayToSTT(ws, data);
      }
    },
    close(ws) {
      sessions.destroy(ws.data.sessionId);
    },
    perMessageDeflate: false, // No compression for audio binary frames
    maxPayloadLength: 64 * 1024, // 64KB max (Opus frames are tiny)
    idleTimeout: 120, // 2min idle timeout
  },
});
```

## Process Model

```
┌──────────────────────────────────────────┐
│  Bun Single Process (RPi5)               │
│                                          │
│  Event Loop                              │
│  ├── WebSocket Server (built-in)         │
│  │   ├── Binary frame relay (STT/TTS)   │
│  │   └── JSON control messages           │
│  ├── HTTP Server (health/metrics)        │
│  ├── Session Manager (Map, ≤10)          │
│  ├── Skill File Watcher (built-in)       │
│  ├── Provider Connections (outbound WS)  │
│  │   ├── Deepgram STT (per-session WS)  │
│  │   ├── OpenRouter LLM (SSE/fetch)     │
│  │   └── Fish Audio TTS (per-session WS) │
│  └── AbortController (cancel propagation)│
│                                          │
│  Memory budget: ~100-150MB RSS total     │
│  (base 33MB + sessions + provider conns) │
└──────────────────────────────────────────┘
```

## Open Questions
- Bun's `--hot` reload: does it preserve WebSocket connections across code changes? (Important for dev experience but not production)
- Bun's file watcher API surface — does it provide sufficient granularity for skill file change detection?
- Graceful shutdown: how does `server.stop()` handle in-flight WebSocket messages? Need to test drain behavior.
- Bun's fetch() for outbound HTTP to OpenRouter SSE streaming — any gotchas with ARM64?
