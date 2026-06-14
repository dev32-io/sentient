# Slice-Code Appendix — Phase 3 (Gateway Keying) full code

Companion to `2026-06-14-surface-isolation-acp-fork-fix.md`. Holds the full implementation code the plan's Phase-3 tasks abbreviate (GK-1/GK-2/GK-3 are largely mechanical `userId`/`deviceId` → `surfaceId` renames over known files). Phase 1/2/4 novel code is inline in the plan itself.

---

## GK-1 — `acp-wire-registry.ts` (full renamed source)

Header comment (replaces lines ~4-27):

```ts
// ---------------------------------------------------------------------------
// AcpWireRegistry — one pooled ACP wire per SURFACE (chat tab / app instance),
// ref-counted across that surface's transport reconnects.
//
// WHY: each chat surface must be a fully isolated Hermes session. The Hermes
// overlay (`acp_ws_server.py`) spawns a fresh Hermes child PER ACP connection,
// so dialing one wire per surface gives each surface its own child — concurrent
// cycles on different surfaces can never cross-wire (the fork root cause). A
// surface's reconnect dials the SAME surfaceId → the warm child is reused (fast
// reconnect), not respawned. Keying by surfaceId (not userId) is what makes N
// tabs of one user N isolated sessions instead of one shared, fork-prone wire.
//
// CONTRACT:
//   - First `acquire(surfaceId)` dials. Concurrent acquires for the same
//     surfaceId await the single in-flight dial promise (no double-dial race).
//   - A subsequent `acquire` for a surfaceId with a LIVE wire reuses it and
//     bumps the refCount — no new overlay connection.
//   - `release(surfaceId)` decrements the refCount; the underlying wire is
//     disposed ONLY when the count reaches zero. The surface-attachment
//     lifecycle (not the transport) owns when that last release fires (D3).
//   - A failed dial removes the entry so a later acquire can retry cleanly.
// ---------------------------------------------------------------------------
```

Interface + body (replaces lines ~41-134):

```ts
export interface AcpWireRegistry {
  acquire(surfaceId: string, dial: AcpWireDialFn): Promise<AcpPerProfileConnection>;
  release(surfaceId: string): void;
  refCount(surfaceId: string): number;
}

export function createAcpWireRegistry(): AcpWireRegistry {
  const pool = new Map<string, PoolEntry>();

  async function acquire(surfaceId: string, dial: AcpWireDialFn): Promise<AcpPerProfileConnection> {
    const existing = pool.get(surfaceId);
    if (existing) {
      existing.refCount += 1;
      log.info("acquire.reuse", { surfaceId, refCount: existing.refCount });
      const handle = await existing.dialPromise;
      return handle.acpConn;
    }
    log.info("acquire.dial", { surfaceId });
    const dialPromise = dial();
    const entry: PoolEntry = { dialPromise, handle: null, refCount: 1 };
    pool.set(surfaceId, entry);
    try {
      const handle = await dialPromise;
      entry.handle = handle;
      log.info("acquire.dial-ok", { surfaceId, refCount: entry.refCount });
      return handle.acpConn;
    } catch (err: unknown) {
      if (pool.get(surfaceId) === entry) pool.delete(surfaceId);
      log.warn("acquire.dial-failed", { surfaceId, reason: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  function release(surfaceId: string): void {
    const entry = pool.get(surfaceId);
    if (!entry) {
      log.debug("release.noop", { surfaceId, reason: "no-pooled-wire" });
      return;
    }
    entry.refCount -= 1;
    log.info("release", { surfaceId, refCount: entry.refCount });
    if (entry.refCount > 0) return;
    pool.delete(surfaceId);
    if (entry.handle !== null) {
      log.info("release.dispose", { surfaceId });
      entry.handle.dispose();
      return;
    }
    log.info("release.dispose-pending-dial", { surfaceId });
    entry.dialPromise.then((handle) => handle.dispose()).catch(() => { /* failed dial — nothing to dispose */ });
  }

  function refCount(surfaceId: string): number {
    return pool.get(surfaceId)?.refCount ?? 0;
  }

  return { acquire, release, refCount };
}
```

New test cases to add to `acp-wire-registry.test.ts` (the existing mechanics cases carry over with the param renamed `userId`→`surfaceId`):

```ts
it("dials a separate wire per distinct surfaceId", async () => {
  const reg = createAcpWireRegistry();
  const d = immediateDial();
  const a = await reg.acquire("surface-1", d.dial);
  const b = await reg.acquire("surface-2", d.dial);
  expect(d.calls()).toBe(2);
  expect(a).not.toBe(b);
});

it("dials TWO isolated wires for two surfaces of the SAME user (no cross-surface fork)", async () => {
  const reg = createAcpWireRegistry();
  const d = immediateDial();
  const tabA = await reg.acquire("alice-tab-A", d.dial);
  const tabB = await reg.acquire("alice-tab-B", d.dial);
  expect(d.calls()).toBe(2);
  expect(tabA).not.toBe(tabB);
  reg.release("alice-tab-A");
  expect(reg.refCount("alice-tab-A")).toBe(0);
  expect(reg.refCount("alice-tab-B")).toBe(1); // tab B's in-flight cycle survives
});
```

`per-user-plugin.ts:71-91` sentinel (REST list is not a surface):

```ts
// REST /api/v1/sessions is NOT a surface — ephemeral un-pooled key so it never
// aliases a real surface; finally-release at refCount→0 disposes immediately.
const wireKey = `rest-list:${userId}`;
const acpConn = await acpWireRegistry.acquire(wireKey, dial);
try { /* ...list... */ } finally { acpWireRegistry.release(wireKey); }
```

---

## GK-2 — `device-buffer-store.ts` + facade + attachment (full)

`DeviceBufferEntry` gains carried `deviceId`:

```ts
export interface DeviceBufferEntry {
  /** Physical device this surface belongs to. CARRIED for device-presence
   *  (Steward attached-devices, idle-archive); NEVER the map key (keyed by surfaceId). */
  readonly deviceId: string;
  readonly buffer: SessionReplayBuffer;
  readonly epoch: number;
  detachedAtMs: number | null;
  readonly liveSocket: DeviceSocketRef;
  deferredTeardown: (() => void) | null;
  readonly clock: ActivityClock;
  forceClose: (() => void) | null;
}
```

`acquire(surfaceId, { deviceId, resumeEpoch? })`:

```ts
acquire(surfaceId: string, opts: { deviceId: string; resumeEpoch?: number }): AcquireDeviceBufferResult {
  const existing = this._buffers.get(surfaceId);
  if (existing !== undefined && opts.resumeEpoch === existing.epoch) {
    existing.detachedAtMs = null;
    const priorDeferredTeardown = existing.deferredTeardown;
    if (priorDeferredTeardown !== null) {
      log.debug("acquire.handover-deferred-teardown", { surfaceId, epoch: existing.epoch });
      existing.deferredTeardown = null;
    }
    log.debug("acquire.resumed", { surfaceId, deviceId: existing.deviceId, epoch: existing.epoch });
    return { buffer: existing.buffer, epoch: existing.epoch, resumed: true, priorDeferredTeardown, liveSocket: existing.liveSocket, clock: existing.clock };
  }
  this._epochCounter += 1;
  const epoch = this._epochCounter;
  const buffer = createSessionReplayBuffer({ maxBytes: this._maxBytes });
  const entry: DeviceBufferEntry = {
    deviceId: opts.deviceId, buffer, epoch, detachedAtMs: null,
    liveSocket: { current: null }, deferredTeardown: null, clock: createActivityClock(), forceClose: null,
  };
  this._buffers.set(surfaceId, entry);
  log.debug("acquire.fresh", { surfaceId, deviceId: opts.deviceId, epoch, prevEpoch: existing?.epoch ?? null });
  return { buffer, epoch, resumed: false, priorDeferredTeardown: null, liveSocket: entry.liveSocket, clock: entry.clock };
}
```

Rename param `deviceId`→`surfaceId` (+ log fields, carrying `deviceId`) in `setForceClose`/`release`/`dispose`/`bufferFor`/`epochFor`/`sweepIdle`. Add reader:

```ts
/** Read the carried deviceId for a surface (undefined if absent). */
deviceIdFor(surfaceId: string): string | undefined {
  return this._buffers.get(surfaceId)?.deviceId;
}
```

`person-session.ts` facade mirrors the renamed signatures + `deviceIdFor` passthrough (see plan GK-2 Step 3).

`device-attachment.ts`: `DeviceAttachmentInit`/`DeviceAttachment` gain `readonly deviceId: string` (carried); `attachmentId` documents "= surfaceId"; the returned object adds `deviceId: init.deviceId`.

New buffer-store test cases:

```ts
it("gives two surfaces of the SAME device independent buffers + epochs", () => {
  const store = makeStore();
  const tabA = store.acquire("surf-A", { deviceId: "browser-1" });
  const tabB = store.acquire("surf-B", { deviceId: "browser-1" });
  expect(tabA.buffer).not.toBe(tabB.buffer);
  expect(tabA.epoch).not.toBe(tabB.epoch);
});
it("carries deviceId on the entry for device-presence", () => {
  const store = makeStore();
  store.acquire("surf-A", { deviceId: "dev-A" });
  expect(store.deviceIdFor("surf-A")).toBe("dev-A");
});
```

---

## GK-3 — `ws-session-configure.ts` threading (full)

`ws-handlers.ts` passes `msg.surfaceId` in the new slot:

```ts
await handleSessionConfigure(
  ws, msg.capabilities.supports, msg.language, services, msg.clientType,
  msg.deviceId, msg.surfaceId, msg.resume, msg.conversationId,
);
```

`handleSessionConfigure` derives the surface key + acquires the buffer by it:

```ts
const deviceId = configureDeviceId;
// Surface key — the unit of session isolation. Old clients omit surfaceId →
// fall back to deviceId (today's per-device behavior, spec §4).
const surfaceId = configureSurfaceId ?? deviceId;
log.info("session-configure.surface", { sessionId, surfaceId, deviceId, surfaceFromConfigure: configureSurfaceId !== undefined });
const acquired = personSession.acquireDeviceBuffer(surfaceId, {
  deviceId,
  ...(resumeParams ? { resumeEpoch: resumeParams.epoch } : {}),
});
```

Wire acquire keyed by surface (`acquireAcpWireOrFail` gains `surfaceId`; keep `userId` for WS-URL + logging):

```ts
const acpConn = await acquireAcpWireOrFail({
  sessionId, userId: initialBinding.userId, surfaceId,
  registry: services.acpWireRegistry, wsUrl: resolvedWsUrl, token: initialBinding.apiKey,
  acpWire: services.hermes?.acp_wire, setDispose: (fn) => { ws.data.acpWireDispose = fn; },
});
```

Inside `acquireAcpWireOrFail`: `await input.registry.acquire(input.surfaceId, dial)` and `input.registry.release(input.surfaceId)` in the dispose closure; logs carry both `userId` + `surfaceId`.

Attachment uses surfaceId as the id, carries deviceId:

```ts
const attachment = createDeviceAttachment<ClientData>({
  attachmentId: surfaceId, deviceId, ws, sessionId,
  profile: personSession.profile, buffer: deviceBuffer, epoch: deviceEpoch,
  liveSocket: deviceLiveSocket, clock: acquired.clock,
});
personSession.attach(attachment);
personSession.setForceClose(surfaceId, () => ws.close(WS_NORMAL_CLOSURE, "idle-timeout"));
```

Rename log-only `deviceId`→`surfaceId` in `handleResumeOrFresh` call + handover logs (`ws-resume-handover.ts` — confirm log-only first).

> `cleanupSession`/`ws-handlers.ts` need no key change: they address the buffer via `attachment.attachmentId`, now the surfaceId. Consumers that assumed `attachmentId === deviceId` (grep!) must read `attachment.deviceId` / `store.deviceIdFor(surfaceId)`.
