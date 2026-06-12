# Activity-based idle watchdog (single timer) + per-user session cap

**Status:** Design approved (2026-06-11)
**Branch:** `feature/idle-activity-watchdog` (off `develop` @ `661ed59`)
**Scope:** Gateway only.

---

## 1. Problem

A production prompt ("news for today pls") streamed ~12 tool calls then went quiet for ~20 s while Hermes synthesized the final answer. The gateway aborted the cycle at exactly 60 s with `request:timeout id=13 method="session/prompt"`, emitting `aborted "error in stream"`, `assistantChars=0`. The user saw a stuck `…` with no answer; the answer only appeared after switching conversations and back (REST `getMessages` reload).

### Root cause
`gateway/src/hermes-adapter-client/client.ts` puts a single flat `setTimeout(requestTimeoutMs)` on every ACP request. `session/prompt` is **one** JSON-RPC request whose response arrives only at full-cycle completion; the streamed `session/update` events flow through a **separate** notification path and do **not** reset that timer. So `request_timeout_ms: 60000` is a flat wall-clock cap on an entire agentic cycle, blind to streaming activity. A legitimately long cycle trips it.

Hermes keeps running after the gateway abandons its view (`dispatch.end aborted=false` — no cancel routed), finishes, and commits the answer to its session DB — which is why the REST reload surfaces it. Split-brain.

### The deeper issue: timer sprawl
The flat request timeout is one of several overlapping/own-notion-of-idle timers. Audit found four **dead** timers (read into a struct or a comment, never consumed) and a Bun transport idle that uses a byte-only notion of activity. Too many independent timers, each with its own definition of "idle," is what produced this class of bug.

---

## 2. Goals / Non-goals

**Goals**
- Replace the flat per-request cap with a single, activity-based idle definition: a cycle/session is idle only when **nothing** happens on **either** live boundary (client WS, both directions; Hermes ACP wire, both directions).
- Collapse overlapping timers into **one** application-level idle control. Net timer count goes down.
- Bound worst-case memory under session churn with a per-user session cap.
- Build the activity clock as a sharable gateway primitive.

**Non-goals**
- Client-side (mobile/web SDK) idle-disconnect changes — separate surface, separate change.
- Re-pointing Bun's transport idle internals (it is capped at 255 s and benign; see §6).
- Cross-device buffer fan-out (out of scope, unchanged).
- Audio frame coalescing in the replay buffer (deferred, unchanged).

---

## 3. Design principle

**Idle = silence on both boundaries.** The activity that resets the clock:

| Source | Meaning |
|---|---|
| `ws.in` | any meaningful frame received from the client (user text, audio, control) |
| `ws.out` | any frame sent to the client (SDK frames, TTS audio) |
| `acp.out` | a request sent to Hermes (`session/prompt`, etc.) |
| `acp.in` | a notification/response received from Hermes (`session/update`, etc.) |

Transport **ping/pong is excluded** — keepalive is not activity; a client that only pings still goes idle.

This bounds the **quietest gap**, not total runtime. A multi-hour task that emits any event within each idle window survives indefinitely; only a genuinely silent gap longer than the window trips it.

---

## 4. Grounding facts (Hermes / ACP)

Verified against Hermes docs + code (sources below) and the gateway code:

- **Cancel is clean.** ACP `cancel(session_id)` sets the cancel event, calls `agent.interrupt()`, and the pending prompt resolves `stop_reason='cancelled'`. The gateway's `cancelInflight()` maps exactly to this — a two-sided cancel, not a one-sided abandon.
- **Hermes persists answers.** ACP sessions persist to `~/.hermes/state.db` (SessionDB), restored across process restarts. Matches the observed REST-reload recovery.
- **Hermes has no server-side prompt timeout** — a prompt can hang **indefinitely** (issue #20250). The gateway therefore **must** own a backstop; this is not redundant.
- **Hermes does not short-idle the ACP wire.** No documented ACP idle timeout; sessions persist + restore. Infra hibernation (Modal/Daytona) "wakes on demand"; the gateway wire **self-heals** on a remote close (`acp-wire-socket.ts` re-opens + re-`initialize` on next send). So a long idle window will not leave dead ACP wirings.

Net: the activity-idle backstop is required (Hermes won't break a stuck turn), the cancel path is correct, and a stuck/dead wire shows up as **silence** — which the same idle clock catches.

---

## 5. Architecture

### 5.1 The activity clock lives on the per-device buffer
The clock attaches to `DeviceBufferEntry` (`gateway/src/person-session/device-buffer-store.ts`), **not** the live WS session. Reason: it must survive a brief disconnect so resumable reconnect still works and so an in-flight cycle keeps the clock warm across a backgrounded socket. The buffer is already keyed per-device and already the unit of retention.

```ts
// gateway/src/session/activity/activity-clock.ts  (new, sharable)
type ActivitySource = "ws.in" | "ws.out" | "acp.out" | "acp.in";
interface ActivityClock {
  touch(source: ActivitySource): void;   // last-activity = now
  idleMs(nowMs: number): number;          // ms since last touch
  lastActivityMs(): number;
}
createActivityClock(now = Date.now): ActivityClock   // pure, injectable clock
```

The clock is created with the buffer entry and starts warm (last = now at acquire).

### 5.2 Four taps
| Tap | Site | Note |
|---|---|---|
| `ws.in` | `gateway/src/session-handlers/ws-handlers.ts` message handler | skip ping/pong frames |
| `ws.out` | `device-buffer-store.ts` `liveSocket` sink (`sendText`/`sendBinary`) | single outbound chokepoint; covers SDK frames + TTS audio |
| `acp.out` | `acp-hermes-client.ts` `session/prompt` send (`onRequestSent`) | via injected per-dispatch callback |
| `acp.in` | `acp-hermes-client.ts` `onEvent` (each `session/update`) | via injected per-dispatch callback |

The ACP wire is shared per-user, so its notifications are not globally routed to one buffer. The `acp.*` taps are therefore a `touch(source)` callback **injected into the dispatch** at session-configure time, already bound to that cycle's device buffer — no `sessionId → deviceId` lookup inside the shared wire layer.

### 5.3 One predicate, one sweep
The existing per-user sweep (`person-session-registry.ts` `setInterval`) is the single home. Its eviction predicate changes from **detach-age** to **activity-idle**:

- Was: evict a device buffer when `detachedAtMs !== null && now - detachedAtMs ≥ retention_ttl_ms (30 min)`.
- Now: evict a device buffer when `clock.idleMs(now) ≥ idle_timeout_ms (15 min)`, regardless of attach state.

`detachedAtMs` is removed in favor of the clock. The sweep interval is derived from the idle timeout (`max(60_000, floor(idle_timeout_ms / 6))` ≈ 2.5 min resolution at 15 min).

Eviction runs the entry's teardown, which cancels any in-flight cycle (`signal → cancelInflight → stopReason=cancelled`), releases the ACP wire refcount, removes the session-manager entry, and disposes the buffer. Two cases by attach state:

- **Detached buffer** (Bun already reaped the socket, or a clean disconnect): runs the **existing deferred teardown** stashed on `release`. This is the common path — an idle live socket is reaped by Bun within 255 s, so by the 15 min mark the buffer is almost always already detached.
- **Still-attached buffer** (a ping-keepalive client that holds the socket open with no real frames — ping/pong excluded from the clock): the sweep must initiate a **live-session close** (close the WS, which runs the normal full teardown). A `forceClose` handler is registered per live session so the sweep can trigger it. This is the only path that didn't exist before.

### 5.4 What this subsumes (timers removed)
- **`request_timeout_ms` (flat 60 s cycle cap)** — deleted. A stuck cycle = no `acp.in` = silent buffer → swept at the idle window, which runs the deferred teardown (= the proper two-sided cancel). On abort, the pending JSON-RPC entry is cleaned explicitly (drop the inflight id) so no `pending` Map leak — replacing the old timer's cleanup role.
- **`retention_ttl_ms` (30 min detach retention)** — becomes `idle_timeout_ms` (15 min, activity-based). The buffer's lifetime is now measured from last activity instead of detach time.
- **`cycle-gap` WARN watchdog** (`hermes-event-translator.ts`) — folds in; the diagnostic reads the shared clock instead of its own `lastEventTs`. WARN-only, no behavior change.

### 5.5 What stays
- **Bun `ws_idle_timeout_ms` (255 s)** — pure transport socket-reap. Capped at 255 s by Bun; cannot be lengthened to 15 min. Benign: when it fires it produces a resumable disconnect, the buffer + clock survive, and the idle window continues on the buffer. It frees dead sockets faster than 15 min, which is good. It is transport-level, not an application idle control.
- **`replay_buffer_max_bytes` (16 MB)** — grow-into byte cap, unchanged.
- **`max_sessions` (100)** — global WS cap, unchanged.

---

## 6. Lifecycle walk-throughs

- **Active cycle (foreground or backgrounded mid-cycle):** every `session/update` → `acp.in` touch keeps the buffer clock warm → never swept. Cycle completes, frames journal to the buffer, deliver live or replay on reconnect.
- **Stuck cycle (Hermes hung, no events):** no `acp.in`, no `ws.*` → buffer goes idle → swept at 15 min (± sweep resolution) → deferred teardown → `cancelInflight` → Hermes `stop_reason=cancelled`. Client (if still attached) reconnects and sees the cancelled/partial result via REST.
- **Idle live connection (user walked away):** Bun reaps the socket at 255 s → resumable disconnect → buffer keeps counting from last activity → swept at 15 min → dispose.
- **Per-user cap hit:** 41st concurrent session for one user is rejected gracefully at WS accept.

---

## 7. Caps + memory analysis

### Facts
| Knob | Value | Scope |
|---|---|---|
| `max_sessions` | 100 | global WS cap (the only existing cap) |
| `replay_buffer_max_bytes` | 16 MB | per device; **grow-into**, not pre-allocated (push + evict-oldest) |
| `idle_timeout_ms` (new) | 15 min | per-device buffer activity-idle |
| `per_user_max_sessions` (new) | 40 | per-user WS cap |

The 16 MB cap only fills with **audio** (~50 Opus frames/s journaled). Mobile runs TTS off (`ttsEnabled=false`) → text frames only → KB, not MB. The cap bites only webui-with-TTS or the cube during long continuous audio.

### Per-session footprint
- Replay buffer (dominant): mobile/text ≈ KB–tens of KB; webui+audio grows toward 16 MB; worst = 16 MB.
- Everything else (STT adapter+socket, Conversation/Task mirrors, cerebrum, pipeline): realistic ~0.2–1 MB; worst ~5 MB (ConversationMirror FIFO cap 10 000 entries, also grow-into).
- **Realistic/session ≈ 0.3–1 MB. Worst/session ≈ ~21 MB.**

### Worst-case totals
| Scenario | Sessions | Per-session | Total |
|---|---|---|---|
| Family, realistic (mobile, TTS off) | ~18 | ~0.5 MB | ~9 MB |
| Family, heavy (all audio, full buffers) | ~18 | ~21 MB | ~380 MB |
| One user spamming new sessions | bounded by per-user 40 | ~21 MB | ~840 MB |
| Global ceiling pathological | 100 | ~21 MB | ~2.1 GB (needs 100 simultaneous full-audio streams) |

Per-user 40 is the load-bearing protection against a single user / reconnect-loop. Buffers now dispose at 15 min (faster than the old 30 min). Comfortable on an 8 GB Pi 5.

---

## 8. Config delta (`gateway/config.yaml`)

**New**
```yaml
session:
  per_user_max_sessions: 40   # max concurrent WS sessions for one user (1–100). Bounds memory under churn.
  idle_timeout_ms: 900000     # 15 min. Reap a device buffer + its session after this much silence
                              # across WS (in/out) AND ACP (in/out). Resets on any activity; ping/pong excluded.
```

**Keep**
```yaml
max_sessions: 100                       # global concurrent WS cap
session:
  ws_idle_timeout_ms: 255000            # Bun transport socket-reap (cap 255 s); triggers resumable disconnect
  replay_buffer_max_bytes: 16777216     # 16 MB per-device, grow-into
```

**Delete**
- `hermes.defaults.request_timeout_ms` (subsumed by idle watchdog; pending-entry cleaned on abort instead)
- `session.retention_ttl_ms` (→ `idle_timeout_ms`)
- `session_persist_ms` (dead — read into `sessionPersistMs`, never consumed)
- `session.inactivity_timeout_ms` + `session.inactivity_check_interval_ms` (dead — unwired)
- `hermes.resource_management.*` (dead in gateway — Hermes/supervisor concern)
- `hermes.defaults.idempotency_window_s` (dead — comment only)

---

## 9. Behavior changes to flag

1. Resume window 30 min → **15 min**: a backgrounded app past 15 min of idle loses its buffer → REST refetch on return (graceful, not a failure).
2. A genuinely silent >15 min cycle now aborts at 15 min (was a 60 s flat kill → far safer; only pathological silence trips it).
3. Ping/pong excluded from activity → a keepalive-only client still goes idle.

---

## 10. E2E matrix

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| Long/slow cycle survives | mobile 390×844 | idle | "news for today pls", stay foreground | full answer, no stuck `…` | tools→answer; **no** `request:timeout`; sweep sees buffer non-idle |
| Stuck cycle reaped | mobile | mock Hermes silent post-prompt | send, wait >15 min | reconnect → cancelled/partial via REST | sweep `idleMs≥900000` → deferred teardown → `cancel.send` stopReason=cancelled |
| Idle connection reaped | desktop 1280×900 | connected, walk away | no activity 15 min | silent disconnect; clean reconnect on return | Bun 255 s socket reap → buffer idle → swept at 15 min → dispose |
| Per-user cap | mobile | user at 40 sessions | open 41st | rejected gracefully (no crash) | per-user 40 reject at WS accept |
| Active cycle across background | mobile | sent prompt | background <15 min, return | answer present (replay) | `acp.in` keeps clock warm; buffer not swept; replay on resume |
| Ping-only client goes idle | desktop | connected, ping/pong only | no real frames 15 min | reaped like any idle conn | ping/pong not counted; swept at 15 min |

> Native mobile cases drive via Maestro + `adb`/`simctl`; the "stuck cycle" case uses a mocked-silent Hermes (do not burn paid services). Web cases via Playwright MCP against the local Docker stack.

---

## 11. Testing (defensive-only, per `.claude/rules/testing.md`)

Keep:
- **ActivityClock** — pure: `touch` advances, `idleMs` measures, ping/pong path excluded. Direct, no mocks.
- **Sweep predicate** — `idleMs(now) ≥ idle_timeout_ms` evicts; warm clock does not; eviction runs deferred teardown exactly once (idempotent).
- **Stuck-cycle abort** — wire-contract: idle fire routes `session/cancel`; pending JSON-RPC id is cleaned (no `pending` Map leak).
- **Per-user cap** — boundary: 40 ok, 41 rejected.

Do not test: the timer plumbing/DI, config loading, the Bun transport reap, or anything that surfaces in smoke.

---

## 12. Out of scope / future
- Client SDK idle-disconnect alignment (bump on inbound frames, not just taps).
- Adaptive idle thresholds (shorter when disconnected) — explicitly rejected for simplicity.
- Replay-buffer audio coalescing (object-count reduction).

---

## Sources
- Hermes Configuration — https://hermes-agent.nousresearch.com/docs/user-guide/configuration
- Hermes ACP Internals — https://hermes-agent.nousresearch.com/docs/developer-guide/acp-internals
- Hermes ACP feature — https://hermes-agent.nousresearch.com/docs/user-guide/features/acp
- Issue #20250 (in-flight prompt can hang indefinitely) — https://github.com/NousResearch/hermes-agent/issues/20250
