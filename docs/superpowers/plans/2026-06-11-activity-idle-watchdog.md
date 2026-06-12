# Activity-based Idle Watchdog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat 60 s ACP `request_timeout_ms` (which kills long agentic cycles) with a single activity-based idle watchdog, and add a per-user session cap to bound memory.

**Architecture:** An `ActivityClock` lives on each per-device replay-buffer entry, touched at four boundaries (client WS in/out, Hermes ACP in/out; ping/pong excluded). The existing per-user sweep becomes the one idle predicate (`idleMs ≥ idle_timeout_ms`), subsuming `request_timeout_ms`, `retention_ttl_ms`, and the `cycle-gap` watchdog. Four dead timers are deleted. A per-user session cap (40) bounds churn.

**Tech Stack:** Bun + TypeScript (strict), Vitest, zod config schemas (`@sentient/config`).

**Spec:** `docs/superpowers/specs/2026-06-11-activity-idle-watchdog-design.md`

**Branch:** `feature/idle-activity-watchdog` (off `develop` @ `661ed59`).

---

## File Structure

**New**
- `gateway/src/session/activity/activity-clock.ts` — the `ActivityClock` primitive (pure).
- `gateway/src/session/activity/activity-clock.test.ts` — unit tests.

**Modified**
- `shared/config/src/schema.ts` — session schema: add `per_user_max_sessions`, `idle_timeout_ms`; remove `inactivity_timeout_ms`, `inactivity_check_interval_ms`, `retention_ttl_ms`.
- `shared/config/src/schemas/hermes-config.ts` — remove `request_timeout_ms` default + `resource_management`.
- `gateway/config.yaml` — apply value changes + delete dead keys.
- `gateway/src/config/startup-config.ts` — drop `sessionPersistMs`.
- `gateway/src/config/operator-config-migrator.ts` — migrate host config (inject new keys, drop dead).
- `gateway/src/person-session/device-buffer-store.ts` — add `clock` + `forceClose` to the entry; idle-based eviction.
- `gateway/src/person-session/device-attachment.ts` — touch `ws.out` in the send closures.
- `gateway/src/person-session/person-session.ts` — thread the clock; `sweepIdle` signature.
- `gateway/src/person-session/person-session-registry.ts` — sweep predicate → activity-idle.
- `gateway/src/hermes-adapter-client/acp-hermes-client.ts` — `onActivity` dep → touch `acp.in`/`acp.out`.
- `gateway/src/hermes-adapter-client/client.ts` — remove the flat request timeout.
- `gateway/src/hermes-adapter-client/per-profile-connection.ts` — clean the pending JSON-RPC id on abort.
- `gateway/src/session-handlers/ws-handlers.ts` — touch `ws.in`; carry `activityClock` on `ClientData`.
- `gateway/src/session-handlers/ws-session-configure.ts` — create/thread the clock + `onActivity` + register `forceClose`.
- `gateway/src/auth/session-manager.ts` — per-user session cap.

---

## Slice 0: Config additions (idle_timeout_ms, per_user_max_sessions)

Add the two NEW config knobs first so later slices can read them. Keep `retention_ttl_ms` for now (the sweep still uses it until Slice 5). Build stays green.

### Task 0.1: Add new session config fields to the schema

**Files:**
- Modify: `shared/config/src/schema.ts:17-32`
- Test: `shared/config/src/schema.test.ts` (if present) or `gateway/src/config/gateway-config.test.ts`

- [ ] **Step 1: Add the fields to `sessionConfigSchema`**

In `shared/config/src/schema.ts`, inside `sessionConfigSchema` (after `replay_buffer_max_bytes`), add:

```ts
  // Per-user concurrent WS session cap. Bounds memory under churn (one user /
  // reconnect-loop). Range 1–100.
  per_user_max_sessions: z.number().int().min(1).max(100),
  // Single activity-based idle window. A device buffer + its session are reaped
  // after this much silence across BOTH boundaries (client WS in/out + Hermes
  // ACP in/out). Resets on any activity; ping/pong excluded. Replaces
  // retention_ttl_ms and the flat request_timeout. Range: 60000–86400000.
  idle_timeout_ms: z.number().int().min(60_000).max(86_400_000),
```

- [ ] **Step 2: Add the values to `gateway/config.yaml`**

Under the `session:` block (near `retention_ttl_ms`, line ~84), add:

```yaml
    per_user_max_sessions: 40           # max concurrent WS sessions for ONE user (1–100). Bounds memory under churn.
    idle_timeout_ms: 900000             # 15 min. Reap a device buffer + its session after this much silence across
                                        # WS (in/out) AND Hermes ACP (in/out). Resets on any activity; ping/pong excluded.
```

- [ ] **Step 3: Migrate operator (host) config**

Read `gateway/src/config/operator-config-migrator.ts` to learn the existing migration mechanism (`migrateOperatorConfigYamlSync`). Add a migration that injects `session.per_user_max_sessions: 40` and `session.idle_timeout_ms: 900000` into a host `config.yaml` that lacks them (idempotent — skip when present). This is REQUIRED: the host `~/.sentient/gateway/config.yaml` will not have the new keys, and they are non-defaulted schema fields, so boot would otherwise fail.

- [ ] **Step 4: Typecheck**

Run: `source scripts/env.sh && bun run typecheck`
Expected: PASS (the `session` block flows through `StartupConfig.session` verbatim — no startup-config change needed for these two).

- [ ] **Step 5: Commit**

```bash
git add shared/config/src/schema.ts gateway/config.yaml gateway/src/config/operator-config-migrator.ts
git commit -m "feat(config): add per_user_max_sessions + idle_timeout_ms (slice 0)"
```

---

## Slice 1: ActivityClock primitive

### Task 1.1: Write the ActivityClock

**Files:**
- Create: `gateway/src/session/activity/activity-clock.ts`
- Test: `gateway/src/session/activity/activity-clock.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// gateway/src/session/activity/activity-clock.test.ts
import { describe, expect, it } from "vitest";
import { type ActivitySource, createActivityClock } from "./activity-clock.js";

describe("ActivityClock", () => {
  it("starts warm at construction time", () => {
    let t = 1_000;
    const clock = createActivityClock(() => t);
    t = 1_500;
    expect(clock.idleMs(t)).toBe(500);
  });

  it("resets idle on any touch", () => {
    let t = 1_000;
    const clock = createActivityClock(() => t);
    t = 5_000;
    clock.touch("acp.in");
    t = 5_200;
    expect(clock.idleMs(t)).toBe(200);
    expect(clock.lastActivityMs()).toBe(5_000);
  });

  it("treats all four sources identically", () => {
    let t = 0;
    const clock = createActivityClock(() => t);
    const sources: ActivitySource[] = ["ws.in", "ws.out", "acp.out", "acp.in"];
    for (const s of sources) {
      t += 100;
      clock.touch(s);
      expect(clock.idleMs(t)).toBe(0);
    }
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `source scripts/env.sh && bun run --filter @sentient/gateway test activity-clock`
Expected: FAIL — cannot resolve `./activity-clock.js`.

- [ ] **Step 3: Implement**

```ts
// gateway/src/session/activity/activity-clock.ts
import { getLog } from "../../logging/logger.js";

const log = getLog(["sentient", "session", "activity-clock"]);

/**
 * The two live boundaries of a session, both directions. "Idle" = no touch
 * from any of these for the idle window. Transport ping/pong is NOT a source —
 * keepalive is not activity (see ws-handlers + the spec).
 */
export type ActivitySource = "ws.in" | "ws.out" | "acp.out" | "acp.in";

/**
 * Single source of truth for "when did anything last happen" on a device's
 * session. Lives on the per-device buffer entry so it survives a brief
 * disconnect (resumable reconnect) and stays warm across a backgrounded socket
 * while an in-flight cycle is still streaming ACP events.
 */
export interface ActivityClock {
  touch(source: ActivitySource): void;
  /** ms since the last touch (or construction). */
  idleMs(nowMs: number): number;
  /** raw last-activity timestamp. */
  lastActivityMs(): number;
}

export function createActivityClock(now: () => number = Date.now): ActivityClock {
  let last = now();
  return {
    touch(source: ActivitySource): void {
      last = now();
      log.debug("touch", { source });
    },
    idleMs(nowMs: number): number {
      return nowMs - last;
    },
    lastActivityMs(): number {
      return last;
    },
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `source scripts/env.sh && bun run --filter @sentient/gateway test activity-clock`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add gateway/src/session/activity/
git commit -m "feat(gateway): ActivityClock primitive (slice 1)"
```

---

## Slice 2: Clock on the device buffer + ws.out tap

### Task 2.1: Add the clock (and forceClose) to the buffer entry

**Files:**
- Modify: `gateway/src/person-session/device-buffer-store.ts`
- Test: `gateway/src/person-session/device-buffer-store.test.ts`

- [ ] **Step 1: Extend the types**

In `device-buffer-store.ts`, import the clock and add fields to `DeviceBufferEntry` and `AcquireDeviceBufferResult`:

```ts
import { type ActivityClock, createActivityClock } from "../session/activity/activity-clock.js";
```

Add to `DeviceBufferEntry` (after `liveSocket`):

```ts
  /** Activity clock — single idle source of truth for this device's session.
   *  Reused across reconnects (same entry), like liveSocket. */
  readonly clock: ActivityClock;
  /** Closes the CURRENT live WS for this device, running the normal full
   *  teardown. Registered at session-configure. null while detached. Used by
   *  the idle sweep to reap a still-attached but silent (ping-keepalive)
   *  session. Cleared on detach. */
  forceClose: (() => void) | null;
```

Add to `AcquireDeviceBufferResult` (after `liveSocket`):

```ts
  /** The device's activity clock, reused across reconnects. */
  readonly clock: ActivityClock;
```

- [ ] **Step 2: Create the clock on fresh acquire, reuse on resume**

In `acquire()`, the resume branch already returns `existing.*` — add `clock: existing.clock`. The fresh branch builds a new entry — add `clock: createActivityClock()` and `forceClose: null`, and return `clock: entry.clock`. Concretely:

Resume-branch return (add the field):
```ts
      return {
        buffer: existing.buffer,
        epoch: existing.epoch,
        resumed: true,
        priorDeferredTeardown,
        liveSocket: existing.liveSocket,
        clock: existing.clock,
      };
```

Fresh entry + return:
```ts
    const entry: DeviceBufferEntry = {
      buffer,
      epoch,
      detachedAtMs: null,
      liveSocket: { current: null },
      deferredTeardown: null,
      clock: createActivityClock(),
      forceClose: null,
    };
    this._buffers.set(deviceId, entry);
    log.debug("acquire.fresh", { deviceId, epoch, prevEpoch: existing?.epoch ?? null });
    return { buffer, epoch, resumed: false, priorDeferredTeardown: null, liveSocket: entry.liveSocket, clock: entry.clock };
```

- [ ] **Step 3: Update the existing test fixtures**

`device-buffer-store.test.ts` asserts on `acquire()` results. Add `expect(result.clock).toBeDefined()` to a fresh + a resumed case, and assert the SAME instance is returned on resume:

```ts
  it("reuses the same activity clock across a resumed acquire", () => {
    const store = new DeviceBufferStore(1024);
    const first = store.acquire("dev-1");
    const resumed = store.acquire("dev-1", { resumeEpoch: first.epoch });
    expect(resumed.resumed).toBe(true);
    expect(resumed.clock).toBe(first.clock);
  });
```

- [ ] **Step 4: Typecheck + test**

Run: `source scripts/env.sh && bun run --filter @sentient/gateway test device-buffer-store && bun run typecheck`
Expected: PASS. (Other callers of `acquire()` still compile — they read named fields.)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/person-session/device-buffer-store.ts gateway/src/person-session/device-buffer-store.test.ts
git commit -m "feat(gateway): activity clock + forceClose on device buffer entry (slice 2.1)"
```

### Task 2.2: Touch ws.out in the attachment send path

**Files:**
- Modify: `gateway/src/person-session/device-attachment.ts`
- Test: `gateway/src/person-session/device-attachment.test.ts`

- [ ] **Step 1: Add `clock` to `DeviceAttachmentInit`**

```ts
import type { ActivityClock } from "../session/activity/activity-clock.js";
```
Add to `DeviceAttachmentInit<TData>`:
```ts
  /** The device's activity clock (from the buffer entry). Touched "ws.out" on
   *  every outbound frame so the idle sweep sees server→client traffic. */
  readonly clock: ActivityClock;
```

- [ ] **Step 2: Touch in the sequencer send closures**

The single outbound chokepoint is the sequencer's `sendText`/`sendBinary` (currently lines 128-129). Touch there:

```ts
  const sequencer = createFrameSequencer({
    epoch: init.epoch,
    buffer: init.buffer,
    sendText: (s) => {
      init.clock.touch("ws.out");
      init.liveSocket.current?.sendText(s);
    },
    sendBinary: (b) => {
      init.clock.touch("ws.out");
      init.liveSocket.current?.sendBinary(b);
    },
  });
```

> Touch unconditionally (before the `current?.` no-op guard): a frame produced while the socket is momentarily null is still session activity (it journals to the buffer and will replay), so it should keep the clock warm.

- [ ] **Step 3: Update the test**

`device-attachment.test.ts` constructs attachments. Add a fake clock to the init and assert `ws.out` is touched on send:

```ts
  it("touches ws.out on every outbound frame", () => {
    const touches: string[] = [];
    const clock = { touch: (s: string) => touches.push(s), idleMs: () => 0, lastActivityMs: () => 0 };
    const att = createDeviceAttachment({ /* ...existing init fields... */, clock } as never);
    att.goLive();
    att.send({ type: "x" });
    expect(touches).toContain("ws.out");
  });
```
Update every existing `createDeviceAttachment(...)` call in this test to include `clock` (use a no-op clock helper).

- [ ] **Step 4: Typecheck + test**

Run: `source scripts/env.sh && bun run --filter @sentient/gateway test device-attachment && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/person-session/device-attachment.ts gateway/src/person-session/device-attachment.test.ts
git commit -m "feat(gateway): touch ws.out on outbound frames (slice 2.2)"
```

---

## Slice 3: ACP taps (acp.in / acp.out)

### Task 3.1: Add `onActivity` to the ACP client and touch both directions

**Files:**
- Modify: `gateway/src/hermes-adapter-client/acp-hermes-client.ts`
- Test: `gateway/src/hermes-adapter-client/acp-hermes-client.test.ts` (or the nearest existing dispatch test)

- [ ] **Step 1: Extend deps**

```ts
import type { ActivitySource } from "../session/activity/activity-clock.js";

export interface AcpHermesClientDeps {
  readonly acpConn: AcpPerProfileConnection;
  /** Bound to this session's device activity clock. Touched on every ACP
   *  event in (session/update) and the prompt send out. Optional so existing
   *  tests/构造 without a clock still compile. */
  readonly onActivity?: (source: ActivitySource) => void;
}
```

- [ ] **Step 2: Touch acp.in on every event**

In `dispatch()`, the `onEvent` subscription (currently line 89-93) translates each `session/update`. Add the touch:

```ts
      const unsubEvents = deps.acpConn.onEvent((evt) => {
        deps.onActivity?.("acp.in");
        const translated = internalToHermesEvents(evt);
        if (translated.length === 0) return;
        queue.push(translated, false);
      });
```

- [ ] **Step 3: Touch acp.out on the prompt send**

Just before `deps.acpConn.sendUserMessage(promptArgs)` (currently line 181):

```ts
      deps.onActivity?.("acp.out");
      const sendPromise = deps.acpConn.sendUserMessage(promptArgs);
```

- [ ] **Step 4: Test — wire contract**

```ts
  it("touches acp.out on prompt send and acp.in on each update", async () => {
    const sources: string[] = [];
    // fake acpConn that emits one session/update then resolves the prompt
    const client = createAcpHermesClient({ acpConn: fakeConn, onActivity: (s) => sources.push(s) });
    const gen = client.dispatch(turnInput, new AbortController().signal, "interactive");
    for await (const _ of gen) { /* drain */ }
    expect(sources).toContain("acp.out");
    expect(sources).toContain("acp.in");
  });
```
Reuse the existing fake `AcpPerProfileConnection` from the neighbouring test file; if none exists, model one that fires the `onEvent` callback once and resolves `sendUserMessage`.

- [ ] **Step 5: Typecheck + test + commit**

Run: `source scripts/env.sh && bun run --filter @sentient/gateway test acp-hermes-client && bun run typecheck`
```bash
git add gateway/src/hermes-adapter-client/acp-hermes-client.ts gateway/src/hermes-adapter-client/acp-hermes-client.test.ts
git commit -m "feat(gateway): touch acp.in/acp.out on the ACP wire (slice 3)"
```

> The `onActivity` callback is bound to the device clock at assembly time in Slice 7 (`ws-session-configure.ts`), where `createAcpHermesClient` is constructed.

---

## Slice 4: ws.in tap

### Task 4.1: Carry the clock on ClientData and touch inbound

**Files:**
- Modify: `gateway/src/session-handlers/ws-handlers.ts`
- Modify: `gateway/src/session-handlers/ws-helpers.ts` (the `ClientData` interface)
- Test: `gateway/src/session-handlers/ws-handlers*.test.ts`

- [ ] **Step 1: Add `activityClock` to ClientData**

In the `ClientData` interface (`ws-helpers.ts` — grep `interface ClientData`), add:
```ts
  activityClock: import("../session/activity/activity-clock.js").ActivityClock | null;
```
Initialise to `null` wherever `ws.data` is seeded (the WS `open` handler / data factory).

- [ ] **Step 2: Touch ws.in in `handleWebSocketMessage`**

In `ws-handlers.ts` `handleWebSocketMessage` (line 43): touch on binary audio and on every non-ping JSON message. Add to the binary branch (line 52):
```ts
  if (typeof message !== "string") {
    if (ws.data.audioAdapter && ws.data.isStreaming) {
      ws.data.activityClock?.touch("ws.in");
      ws.data.audioAdapter.sendAudioFrame(message);
    }
    return;
  }
```
And in the `switch (msg.type)`, the `ping` case stays untouched (no clock touch). For every other admitted message, touch once right after the `clientMessageSchema` parse succeeds but BEFORE the switch, guarded to skip ping:
```ts
  const msg = msgResult.data;
  if (msg.type !== "ping") {
    ws.data.activityClock?.touch("ws.in");
    log.debug("message-received", { type: msg.type });
  }
```
(This replaces the existing `if (msg.type !== "ping") log.debug(...)` block.)

- [ ] **Step 3: Test**

Add a focused test: feed a `text.input` frame → clock touched; feed a `ping` → clock NOT touched. Use a fake clock on `ws.data`.

- [ ] **Step 4: Typecheck + test + commit**

Run: `source scripts/env.sh && bun run --filter @sentient/gateway test ws-handlers && bun run typecheck`
```bash
git add gateway/src/session-handlers/ws-handlers.ts gateway/src/session-handlers/ws-helpers.ts
git commit -m "feat(gateway): touch ws.in on inbound frames, ping/pong excluded (slice 4)"
```

---

## Slice 5: Sweep → activity-idle predicate (behavioral core)

This is the load-bearing change: the buffer sweep stops keying on `detachedAtMs ≥ retention_ttl_ms` and starts keying on `clock.idleMs(now) ≥ idle_timeout_ms`, for BOTH attached and detached entries. Detached → run the stashed deferred teardown; attached-but-idle → `forceClose`.

### Task 5.1: Idle-based eviction in DeviceBufferStore

**Files:**
- Modify: `gateway/src/person-session/device-buffer-store.ts`
- Test: `gateway/src/person-session/device-buffer-store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
  it("evicts a detached buffer once it is idle past the window, running deferred teardown", () => {
    let now = 0;
    const store = new DeviceBufferStore(1024);
    const acq = store.acquire("dev-1");
    const td = vi.fn();
    store.release("dev-1", td);          // detached; clock last touched ~now
    now = 900_000;                        // 15 min later, no touches
    const evicted = store.sweepIdle(now, 900_000);
    expect(evicted).toBe(1);
    expect(td).toHaveBeenCalledTimes(1);
  });

  it("evicts a still-attached but idle buffer via forceClose (ping-keepalive case)", () => {
    let now = 0;
    const store = new DeviceBufferStore(1024);
    const acq = store.acquire("dev-1");
    const fc = vi.fn();
    // simulate session-configure registering forceClose on the entry:
    store.setForceClose("dev-1", fc);
    now = 900_000;
    const evicted = store.sweepIdle(now, 900_000);
    expect(fc).toHaveBeenCalledTimes(1);
    expect(evicted).toBe(0);   // forceClose drives the normal teardown; entry not removed here
  });

  it("keeps a buffer whose clock was recently touched", () => {
    let now = 0;
    const store = new DeviceBufferStore(1024);
    const acq = store.acquire("dev-1");
    acq.clock.touch("acp.in");   // shares the entry's clock
    now = 899_000;               // under the window
    expect(store.sweepIdle(now, 900_000)).toBe(0);
  });
```

- [ ] **Step 2: Implement `sweepIdle` + `setForceClose`, replacing `sweepExpired`**

Replace `sweepExpired(nowMs, ttlMs)` with `sweepIdle(nowMs, idleTimeoutMs)`. New predicate uses the entry's clock and branches on attach state. Add a `setForceClose` setter (called from session-configure).

```ts
  /** Register the live-WS close hook for a device (session-configure). */
  setForceClose(deviceId: string, forceClose: (() => void) | null): void {
    const entry = this._buffers.get(deviceId);
    if (entry !== undefined) entry.forceClose = forceClose;
  }

  /**
   * Reap device buffers that have been idle (no activity-clock touch) for
   * >= idleTimeoutMs. Detached entries → remove + run deferred teardown.
   * Still-attached entries → invoke forceClose (the normal full teardown
   * via WS close); the entry is removed on the resulting detach/dispose.
   * Returns the number of entries REMOVED here (attached forceClose excluded).
   */
  sweepIdle(nowMs: number, idleTimeoutMs: number): number {
    let removed = 0;
    for (const [deviceId, entry] of this._buffers) {
      if (entry.clock.idleMs(nowMs) < idleTimeoutMs) continue;
      const attached = entry.detachedAtMs === null;
      if (attached) {
        log.info("sweepIdle.force-close", { deviceId, epoch: entry.epoch, idleMs: entry.clock.idleMs(nowMs) });
        try {
          entry.forceClose?.();
        } catch (err: unknown) {
          log.warn("sweepIdle.force-close-failed", { deviceId, error: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }
      this._buffers.delete(deviceId);
      removed += 1;
      log.info("sweepIdle.evicted", { deviceId, epoch: entry.epoch, idleMs: entry.clock.idleMs(nowMs) });
      if (entry.deferredTeardown !== null) {
        try {
          entry.deferredTeardown();
        } catch (err: unknown) {
          log.warn("sweepIdle.deferred-teardown-failed", { deviceId, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    return removed;
  }
```

> Keep `shouldEvictDeviceBuffer` and `detachedAtMs` for now — `detachedAtMs` is still the attached-vs-detached signal. The OLD `sweepExpired` is deleted; fix its one caller in Task 5.2.

- [ ] **Step 3: Run tests, verify pass**

Run: `source scripts/env.sh && bun run --filter @sentient/gateway test device-buffer-store`
Expected: PASS (the three new tests; old `sweepExpired` tests are rewritten to `sweepIdle`).

- [ ] **Step 4: Commit**

```bash
git add gateway/src/person-session/device-buffer-store.ts gateway/src/person-session/device-buffer-store.test.ts
git commit -m "feat(gateway): idle-based buffer eviction (sweepIdle) (slice 5.1)"
```

### Task 5.2: Wire the registry sweep to idle_timeout_ms

**Files:**
- Modify: `gateway/src/person-session/person-session.ts` (delegate method)
- Modify: `gateway/src/person-session/person-session-registry.ts`
- Test: `gateway/src/person-session/person-session-registry.test.ts`

- [ ] **Step 1: Replace the delegate on PersonSession**

In `person-session.ts`, replace `sweepExpired(nowMs, ttlMs)` with:
```ts
  /** Reap idle device buffers (>= idleTimeoutMs of no activity). Returns count removed. */
  sweepIdle(nowMs: number, idleTimeoutMs: number): number {
    return this._deviceBuffers.sweepIdle(nowMs, idleTimeoutMs);
  }

  /** Register the live-WS close hook for a device (session-configure). */
  setForceClose(deviceId: string, forceClose: (() => void) | null): void {
    this._deviceBuffers.setForceClose(deviceId, forceClose);
  }
```

- [ ] **Step 2: Swap the dep + predicate in the registry**

In `person-session-registry.ts`:
- Rename dep `retentionTtlMs` → `idleTimeoutMs` in `PersonSessionRegistryDeps` (and its doc: "sourced from config.session.idle_timeout_ms").
- In `createPersonSessionRegistry`, `const idleTimeoutMs = deps.idleTimeoutMs;` and `const sweepIntervalMs = Math.max(60_000, Math.floor(idleTimeoutMs / 6));`.
- In `sweep(nowMs)`: replace `session.sweepExpired(nowMs, retentionTtlMs)` with `session.sweepIdle(nowMs, idleTimeoutMs)`. Replace the `canRemove` block: a PersonSession is removed when it has **no retained buffers** (all swept) — drop the `idleSinceMs`/`attachmentCount` gate, since idle is now the buffer clock's job:

```ts
    for (const [userId, session] of sessions) {
      sessionsChecked += 1;
      buffersEvicted += session.sweepIdle(nowMs, idleTimeoutMs);
      if (!session.hasRetainedBuffers()) {
        sessions.delete(userId);
        sessionsRemoved += 1;
        log.info("sweep.session-removed", { userId, ageMs: session.ageMs });
      }
    }
```

- [ ] **Step 3: Thread the renamed dep from bootstrap**

In `gateway/src/bootstrap/phase-routes.ts:63`, change `retentionTtlMs: cfg.session.retention_ttl_ms` → `idleTimeoutMs: cfg.session.idle_timeout_ms`. (Grep for any other construction site of the registry and update identically.)

- [ ] **Step 4: Update registry tests**

Rewrite `person-session-registry.test.ts` cases that drove `retentionTtlMs`/`sweepExpired` to use `idleTimeoutMs` + `sweepIdle`, touching the buffer clock to keep a session alive and advancing `now` past the window to evict.

- [ ] **Step 5: Typecheck + test + commit**

Run: `source scripts/env.sh && bun run --filter @sentient/gateway test person-session && bun run typecheck`
```bash
git add gateway/src/person-session/person-session.ts gateway/src/person-session/person-session-registry.ts gateway/src/bootstrap/phase-routes.ts gateway/src/person-session/person-session-registry.test.ts
git commit -m "feat(gateway): registry sweep keys on activity idle_timeout_ms (slice 5.2)"
```

---

## Slice 6: Remove the flat request timeout + clean pending on abort

### Task 6.1: Drop the per-request setTimeout

**Files:**
- Modify: `gateway/src/hermes-adapter-client/client.ts:108-143`
- Test: `gateway/src/hermes-adapter-client/client.test.ts`

- [ ] **Step 1: Remove the timer from `request()`**

In `client.ts`, the `request()` Promise currently arms `setTimeout(timeoutMs)` that rejects + `pending.delete(id)`. Remove the timer block (lines ~120-129) and the `timer` field from `PendingRequest` (line 44). Keep the `pending.set(id, {...})` and the send-failure cleanup. The cycle backstop is now the idle sweep (Slice 5); a stuck/dead wire shows up as silence and is reaped there.

Result (the body of the returned Promise):
```ts
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
      send({ jsonrpc: JSONRPC_VERSION, id, method, params: params ?? {} }).catch((err: unknown) => {
        const entry = pending.get(id);
        if (entry && pending.delete(id)) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("request:send-failed", { id, method, reason: message });
          reject(err instanceof Error ? err : new Error(message));
        }
      });
    });
```

- [ ] **Step 2: Add `cancelPending(id)` so abort can clean the entry**

Add to the client's returned interface (and the `AcpClient` type):
```ts
  /** Reject + drop a pending request by id (used on cycle abort so a never-
   *  answered session/prompt does not leak a pending Map entry). No-op if
   *  unknown. */
  cancelPending(id: JsonRpcId, reason: string): void;
```
Implementation:
```ts
  const cancelPending = (id: JsonRpcId, reason: string): void => {
    const entry = pending.get(id);
    if (entry && pending.delete(id)) {
      log.warn("request:cancelled", { id, method: entry.method, reason });
      entry.reject(new Error(reason));
    }
  };
```
Drop `cfg.requestTimeoutMs` from the client config type (it is now unused).

- [ ] **Step 3: Test**

```ts
  it("does not time out a long-running request", async () => {
    // request never resolves; advance fake timers far; assert still pending
    // (no rejection). Then cancelPending rejects it.
  });
  it("cancelPending rejects and removes the entry", () => { /* ... */ });
```
Remove the old "request:timeout rejects after timeoutMs" test.

- [ ] **Step 4: Commit**

```bash
git add gateway/src/hermes-adapter-client/client.ts gateway/src/hermes-adapter-client/client.test.ts
git commit -m "refactor(gateway): drop flat ACP request timeout; add cancelPending (slice 6.1)"
```

### Task 6.2: Clean the inflight pending id on abort

**Files:**
- Modify: `gateway/src/hermes-adapter-client/per-profile-connection.ts:233-260` (`cancelInflight`)
- Test: `gateway/src/hermes-adapter-client/per-profile-connection.test.ts`

- [ ] **Step 1: After routing session/cancel, drop the pending id**

In `cancelInflight()`, after sending the ACP cancel, call `client.cancelPending(inflight.id, "cycle aborted")` so the awaited `session/prompt` promise settles even when Hermes never answers (dead/hung wire). Verify against the real `cancelInflight` body and keep its existing logging.

- [ ] **Step 2: Test — abort settles the prompt + drops pending**

Assert: with a never-answering fake wire, `cancelInflight()` causes the `sendUserMessage` promise to reject and leaves no pending entry.

- [ ] **Step 3: Commit**

```bash
git add gateway/src/hermes-adapter-client/per-profile-connection.ts gateway/src/hermes-adapter-client/per-profile-connection.test.ts
git commit -m "fix(gateway): clean pending session/prompt id on cycle abort (slice 6.2)"
```

---

## Slice 7: Wire the clock end-to-end + per-user cap

### Task 7.1: Thread the clock + onActivity + forceClose in session-configure

**Files:**
- Modify: `gateway/src/session-handlers/ws-session-configure.ts`
- Test: covered by Slice 9 smoke (this is assembly glue; no new unit test)

- [ ] **Step 1: Capture the clock from the acquire result**

Where `acquireDeviceBuffer(...)` is called and the `DeviceAttachment` is built, the result now carries `clock`. Set it on `ws.data.activityClock = acq.clock` and pass `clock: acq.clock` into `createDeviceAttachment({...})`.

- [ ] **Step 2: Bind `onActivity` on the ACP client**

Where `createAcpHermesClient({ acpConn })` is constructed (grep within `ws-session-configure.ts`), add `onActivity: (source) => acq.clock.touch(source)`.

- [ ] **Step 3: Register forceClose**

After the attachment is live, register the live-WS close hook so the idle sweep can reap a still-attached silent session:
```ts
personSession.setForceClose(deviceId, () => ws.close(1000, "idle-timeout"));
```
And clear it on teardown/detach: `personSession.setForceClose(deviceId, null)` in the disconnect path (alongside the existing `releaseSocket()` call in `ws-handlers.ts`).

- [ ] **Step 4: Typecheck + build**

Run: `source scripts/env.sh && bun run typecheck`
Expected: PASS — every tap now resolves a real clock instance.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/session-handlers/ws-session-configure.ts gateway/src/session-handlers/ws-handlers.ts
git commit -m "feat(gateway): bind activity clock across WS + ACP + forceClose (slice 7.1)"
```

### Task 7.2: Per-user session cap

**Files:**
- Modify: `gateway/src/auth/session-manager.ts`
- Modify: the post-auth bind site (grep `bind` in `gateway/src/session-router.ts` / `ws-session-configure.ts` where `userId` is known)
- Test: `gateway/src/auth/session-manager.test.ts`

- [ ] **Step 1: Track sessions per user + enforce the cap**

`createSession()` currently uses a fixed anonymous identity. The real `userId` is resolved at auth (`ws-auth-gate`) and bound later. Add a per-user counter keyed by the bound `userId`, enforced when the session binds to a user:

```ts
export interface SessionManagerOptions {
  maxSessions?: number;
  perUserMaxSessions?: number;
}
```
Add a `Map<string, number>` of userId → live count, a `bindUser(sessionId, userId): Result<void>` that rejects when `count >= perUserMaxSessions`, and decrement in `removeSession`. (If binding already happens elsewhere, expose `canBindUser(userId): boolean` + `noteBound/noteUnbound` and call them at the bind/teardown sites.)

- [ ] **Step 2: Source the cap from config**

`createSessionManager({ maxSessions: cfg.maxSessions, perUserMaxSessions: cfg.session.per_user_max_sessions })` at the construction site (`bootstrap/phase-routes.ts`).

- [ ] **Step 3: Test boundaries**

```ts
  it("admits up to perUserMaxSessions for one user, rejects the next", () => {
    const mgr = createSessionManager({ perUserMaxSessions: 2 });
    // bind 2 ok, 3rd rejected; after removeSession, a new bind ok again
  });
```

- [ ] **Step 4: Reject path at the WS layer**

At the bind site, on rejection send a graceful protocol error + close (do not crash). Mirror the existing global `max_sessions` rejection shape.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/auth/session-manager.ts gateway/src/auth/session-manager.test.ts gateway/src/bootstrap/phase-routes.ts
git commit -m "feat(gateway): per-user concurrent session cap (slice 7.2)"
```

---

## Slice 8: Delete dead timers + fold cycle-gap

Now that nothing reads the old knobs, remove them. Build must stay green.

### Task 8.1: Delete dead config keys

**Files:**
- Modify: `shared/config/src/schema.ts`, `shared/config/src/schemas/hermes-config.ts`
- Modify: `gateway/config.yaml`
- Modify: `gateway/src/config/startup-config.ts`
- Modify: `gateway/src/config/operator-config-migrator.ts`

- [ ] **Step 1: Remove from the schema**

In `sessionConfigSchema`: delete `inactivity_timeout_ms`, `inactivity_check_interval_ms`, `retention_ttl_ms`.
In `hermes-config.ts`: delete `request_timeout_ms` (the `defaults` block) and the `resource_management` object. Grep `request_timeout_ms` / `requestTimeoutMs` / `idempotency_window_s` across `gateway/src` + `shared` and delete every now-unused reference (e.g. `per-user-plugin.ts`, `server.ts:286`, `ws-session-configure.ts:237`, `wire-bootstrap` `requestTimeoutMs`).
Remove top-level `session_persist_ms` from the root config schema, and `idempotency_window_s`.

- [ ] **Step 2: Remove from `gateway/config.yaml`**

Delete the lines: `session_persist_ms`, `session.inactivity_timeout_ms`, `session.inactivity_check_interval_ms`, `session.retention_ttl_ms`, `hermes.defaults.request_timeout_ms`, `hermes.defaults.idempotency_window_s`, the whole `hermes.resource_management` block.

- [ ] **Step 3: Remove from startup-config**

Delete `sessionPersistMs: number` from `StartupConfig` and `sessionPersistMs: cfg.session_persist_ms` from `loadStartupConfig`.

- [ ] **Step 4: Migrator — strip dead keys**

Extend `operator-config-migrator.ts` to delete the dead keys from a host config (idempotent), so existing `~/.sentient/gateway/config.yaml` files validate against the trimmed schema.

- [ ] **Step 5: Typecheck + full test**

Run: `source scripts/env.sh && bun run typecheck && bun run --filter @sentient/gateway test`
Expected: PASS. Fix any dangling reference the compiler flags.

- [ ] **Step 6: Commit**

```bash
git add shared/config gateway/config.yaml gateway/src/config
git commit -m "chore(config): delete 4 dead timers + request_timeout + retention (slice 8.1)"
```

### Task 8.2: Fold cycle-gap WARN onto the shared clock (diagnostic only)

**Files:**
- Modify: `gateway/src/cerebrum/hermes-event-translator.ts:74-92`

- [ ] **Step 1: Reuse the clock for the diagnostic**

The per-cycle `setInterval` WARN currently tracks its own `lastEventTs`. Leave it WARN-only (no abort — the sweep owns abort now), but have it read `idleMs` from the session's activity clock instead of a private `lastEventTs`, so there is one source of truth. If threading the clock here is awkward, leave the existing diagnostic as-is and note it: it is WARN-only and harmless. (Pick one; do not add a second control timer.)

- [ ] **Step 2: Typecheck + commit**

```bash
git add gateway/src/cerebrum/hermes-event-translator.ts
git commit -m "refactor(gateway): cycle-gap diagnostic reads the shared clock (slice 8.2)"
```

---

## Slice 9: Local stack smoke (e2e)

Drive the spec's e2e matrix against the local Docker stack (`deploy/macos/`). Web → Playwright MCP; native → Maestro. Never burn paid services — the "stuck cycle" case uses a mocked-silent Hermes.

### Task 9.1: Build + boot the local stack

- [ ] **Step 1:** Build the gateway image via `deploy/macos/` and `docker compose up -d`; confirm container health (`docker ps`, `docker logs sentient-gateway` shows `config-loaded` with the new keys, no schema error).
- [ ] **Step 2:** Tail logs: `docker logs -f sentient-gateway`.

### Task 9.2: Run the matrix

- [ ] **Case: long/slow cycle survives** — mobile viewport, send "news for today pls", stay foregrounded. Expect full answer, no stuck `…`. Log trail: tools→answer, **no** `request:timeout`, sweep never reaps the live buffer.
- [ ] **Case: stuck cycle reaped** — point at a mocked-silent Hermes; send a prompt; advance/observe past the idle window (use a short `idle_timeout_ms` override in a test config to avoid a 15-min wait). Expect `sweepIdle ... → cancel.send` stopReason=cancelled; client recovers via REST on reconnect.
- [ ] **Case: idle connection reaped** — desktop viewport, connect, walk away. Expect Bun 255 s socket reap → buffer idle → swept; clean reconnect on return.
- [ ] **Case: per-user cap** — open sessions to the configured cap, then one more. Expect graceful rejection, no crash.
- [ ] **Case: active cycle across background** — mobile, send a prompt, background <window, return. Expect answer present via replay; `acp.in` kept the clock warm.
- [ ] **Case: ping-only client goes idle** — keepalive pings only, no real frames; expect `forceClose` at the idle window.

- [ ] **Step 3: Capture evidence** under the QA dir (screenshots + the `docker logs` trail). A case is green only when user-visible behavior AND the log trail match.

### Task 9.3: Pre-handover gate

- [ ] Run `source scripts/env.sh && bun run ci` (lint + typecheck + test) — all green.
- [ ] All matrix cases green, evidence captured.
- [ ] Build deployable artifact.

---

## Self-Review

**Spec coverage:**
- §3 four taps → Slices 2.2 (ws.out), 3 (acp.in/out), 4 (ws.in). ✓
- §5.1 clock on per-device buffer → Slice 2.1. ✓
- §5.3 one sweep predicate (attached vs detached teardown) → Slice 5. ✓
- §5.4 subsume request_timeout + retention + cycle-gap → Slices 5, 6, 8.2. ✓
- §7 per-user cap 40 → Slice 7.2; config values → Slice 0. ✓
- §8 config delta (add + delete) → Slices 0 (add) and 8.1 (delete). ✓
- §11 testing (clock, sweep predicate, abort/cancel, cap) → Slices 1, 5.1, 6, 7.2. ✓
- §10 e2e matrix → Slice 9. ✓
- §9 behavior changes (resume 30→15, ping-only idle) → encoded in `idle_timeout_ms` (Slice 0) + ws.in exclusion (Slice 4) + forceClose (Slice 5/7). ✓

**Type consistency:** `sweepExpired` → `sweepIdle` renamed consistently across device-buffer-store (5.1), person-session (5.2), registry (5.2). `retentionTtlMs` dep → `idleTimeoutMs` everywhere it is constructed (5.2 step 3). `clock` field name identical across entry / acquire-result / attachment-init. `onActivity`/`ActivitySource` identical across acp client (3) and binding site (7.1). `forceClose`/`setForceClose` identical across store (5.1) and person-session/configure (5.2, 7.1).

**Placeholder scan:** Integration steps cite exact files + anchors and show the code to add; the executor reads the cited region to place it. New/pure modules (ActivityClock, sweepIdle) have complete code. No "TBD"/"handle edge cases". One deliberate either/or in 8.2 (fold vs leave the WARN diagnostic) — both are spelled out; pick one.

**Note on ordering:** Each slice compiles and tests pass on its own (config ADD before consumers in Slice 0; config DELETE after consumers removed in Slice 8). Frequent commits per task.
