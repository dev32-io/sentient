# Surface-Isolation ACP Wire Model + Fork-Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every chat surface (web tab / mobile app instance) a fully isolated Hermes session so accidental duplicate ("#2") conversations stop, while preserving fast warm reconnect.

**Architecture:** Introduce a `surfaceId` (per-tab on web via sessionStorage; `= deviceId` on mobile). Re-key the gateway ACP wire pool + resume buffer + replay attachment by `surfaceId` (was `userId`/`deviceId`); keep `deviceId` for device presence/registry. Add within-surface correctness: one in-flight cycle per surface, an anchor that survives transport handover, and real Hermes session-id readback. Spec: `docs/superpowers/specs/2026-06-14-surface-isolation-acp-fork-fix-design.md`.

**Tech Stack:** TS/Bun gateway (vitest, zod), KMP mobile-sdk (Kotlin, kotlin-test), Preact web-sdk (vitest), Docker `deploy/macos`, Maestro (mobile e2e), Playwright MCP (web e2e).

---

## Conventions & cross-task contracts (read first)

These pin shared decisions so tasks don't drift. They resolve the planners' flagged ambiguities.

- **Test runner (TS):** `bun run test <path>` from `gateway/` / `shared/<pkg>/` (script is `cd src && bun test`; path filters are relative to `src/`). `bun run typecheck` = `tsc --noEmit`. Source `scripts/env.sh` first.
- **Test runner (mobile):** `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "<fqcn>"`.
- **Test-lean doctrine:** only wire/protocol/FSM/security tests (per `.claude/rules/testing.md`). No trivial-util tests.
- **Resolved surface key (single source):** in `handleSessionConfigure`, derive **once**:
  `const surfaceId = configureSurfaceId ?? configureDeviceId;`
  Every gateway task (wire pool, buffer, attachment, cycle owner, anchor) keys on this `surfaceId`. Old clients omit `surfaceId` → falls back to `deviceId` → today's per-device behavior. **Invariant:** surfaceId and deviceId draw from non-overlapping UUID spaces (web surfaceId = fresh sessionStorage UUID; deviceId = separate localStorage UUID), so the fallback never aliases a real surface.
- **Handler signature (final, all tasks align to this):**
  `handleSessionConfigure(ws, capabilities, language, services, clientType, configureDeviceId, configureSurfaceId, configureResume, configureConversationId)` — `configureSurfaceId: string | undefined` inserted right after `configureDeviceId`. `ws-handlers.ts` passes `msg.surfaceId` in that slot.
- **`updateConversationId` re-keyed to surfaceId** (D2, chosen contract): signature becomes `updateConversationId(surfaceId, conversationId)`; the call site at `ws-session-configure.ts:661` passes `surfaceId`. The transport `sessionId` binding stays for userId/url.
- **`per-user-plugin.ts` (REST `/api/v1/sessions`) is NOT a surface.** Key its transient acquire/release with a sentinel `` `rest-list:${userId}` `` so it never aliases a surface; its `finally` release disposes immediately (no surface attachment rides it).
- **`attachmentId` becomes `surfaceId`** and the attachment carries `deviceId` for presence. After GK-3, grep `attachmentId` consumers outside the buffer path: `grep -rn "attachmentId" gateway/src | grep -v ".test."` — any that assumed `attachmentId === deviceId` must read the carried `deviceId` / `store.deviceIdFor(surfaceId)`.
- **Per-surface cycle owner lives in a new `SurfaceCycleRegistry` on `GatewayServices`** — NOT `PersonSession` (which is per-user and would falsely serialize two surfaces of one user).
- **Phase order is load-bearing:** Phase 1 (protocol) → Phase 2 (clients) → Phase 3 (gateway keying, defines `surfaceId` in the handler) → Phase 4 (within-surface, reuses that `surfaceId`). Phase 0 is the system-level RED gate; Phase 5 is the system-level GREEN gate.
- **Branch:** all work on `feature/acp-wire-surface-isolation` (already created; the spec commit is its first commit).

---

## Phase 0 — System-level repro (the failing signal)

The unit tests below are per-task RED/GREEN. This phase establishes the **system-level RED**: reproduce the fork on the local stack and assert it via the Hermes store, so Phase 5 can prove it's gone.

### Task 0.1 — Boot local stack + capture a baseline fork

**Files:**
- Create: `gateway/test-harness/fork-repro.md` (documented procedure + assertion)
- Create: `gateway/test-harness/check-forks.sh` (store assertion script)

- [ ] **Step 1: Boot the local stack**

```bash
source scripts/env.sh
cd deploy/macos && docker compose up -d && docker compose ps
```
Expected: `sentient-gateway` healthy, `sentient-hermes` up.

- [ ] **Step 2: Write the fork-detection assertion script**

Create `gateway/test-harness/check-forks.sh`:

```bash
#!/usr/bin/env bash
# Counts Hermes-minted timestamp-named "fork" sessions for a profile.
# A clean run = 0. Any session_YYYYMMDD_HHMMSS_*.json that is a full-history
# copy is an accidental fork (design 2026-06-14 §1).
set -euo pipefail
PROFILE="${1:?usage: check-forks.sh <profileId> [hermesHome]}"
HERMES_HOME="${2:-$HOME/.sentient/gateway/data/$PROFILE}"
SESS_DIR="$HERMES_HOME/profiles/$PROFILE/sessions"
count="$(find "$SESS_DIR" -maxdepth 1 -name 'session_2[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]_*.json' 2>/dev/null | wc -l | tr -d ' ')"
echo "timestamp-fork sessions for $PROFILE: $count"
exit 0
```

- [ ] **Step 3: Document the repro procedure**

Create `gateway/test-harness/fork-repro.md` capturing the overlap that forks: drive two concurrent WS transports for one user against the SAME conversation with a long (web-search) cycle in flight, dropping/reconnecting one mid-cycle. (Manual: mobile Maestro flow `background-mid-search`; or a bun WS driver that opens two `session.configure` frames with the same `deviceId` and no `surfaceId`, dispatches a long cycle, drops transport A mid-cycle, reconnects, sends a follow-up.) Record the assertion: run `check-forks.sh <profile>` before and after.

- [ ] **Step 4: Capture baseline RED**

Run the repro on `develop` (pre-fix) and record: `check-forks.sh` count > 0 (a timestamp-fork appears). This is the system-level RED that Phase 5 must drive to 0.

- [ ] **Step 5: Commit the harness**

```bash
git add gateway/test-harness/fork-repro.md gateway/test-harness/check-forks.sh
git commit -m "test(gateway): fork repro harness + Hermes-store fork assertion"
```

---

## Phase 1 — Protocol

### Task P1 — Add optional `surfaceId` to `sessionConfigureSchema`

**Files:**
- Modify: `shared/protocol/src/messages.ts` (schema ~lines 81–112)
- Test: `shared/protocol/src/messages.test.ts` (append after the existing `session.configure conversationId` block, ~line 887)

- [ ] **Step 1: Write the failing wire-contract test**

Append to `shared/protocol/src/messages.test.ts`:

```ts
describe("session.configure surfaceId", () => {
  it("accepts session.configure with an optional surfaceId", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: [] },
      clientType: "webui",
      deviceId: "dev-1",
      surfaceId: "surf-tab-abc",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.surfaceId).toBe("surf-tab-abc");
  });

  it("accepts session.configure with surfaceId omitted (old-client back-compat)", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: [] },
      clientType: "webui",
      deviceId: "dev-1",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.surfaceId).toBeUndefined();
  });

  it("rejects empty-string surfaceId", () => {
    const result = sessionConfigureSchema.safeParse({
      type: "session.configure",
      capabilities: { supports: [] },
      clientType: "webui",
      deviceId: "dev-1",
      surfaceId: "",
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to fail**

Run: `bun run --filter @sentient/protocol test`
Expected: the empty-string and optional-readback cases fail (zod strips the unknown key).

- [ ] **Step 3: Add the field**

In `shared/protocol/src/messages.ts`, in `sessionConfigureSchema`, after `conversationId: z.string().min(1).optional(),`:

```ts
  conversationId: z.string().min(1).optional(),
  /**
   * Optional — the chat-surface id (one browser tab / one mobile app instance).
   * Layers on top of `deviceId`; does NOT replace it (2026-06-14 surface-
   * isolation design §1). Web mints a per-tab UUID in sessionStorage; mobile
   * sends `surfaceId = deviceId`. The gateway keys the ACP wire pool / resume
   * buffer / replay attachment by this value so each surface is isolated.
   * OMITTED by old clients → the gateway falls back to `deviceId` (no break).
   */
  surfaceId: z.string().min(1).optional(),
});
```

- [ ] **Step 4: Run to pass**

Run: `bun run --filter @sentient/protocol test`
Expected: new block green; full protocol suite stays green.

- [ ] **Step 5: Commit**

```bash
git add shared/protocol/src/messages.ts shared/protocol/src/messages.test.ts
git commit -m "protocol: add optional surfaceId to session.configure"
```

> Flag: the wire frame schema is `sessionConfigureSchema` in `messages.ts` — NOT `sessionSchema` in `session.ts` (a different, unrelated gateway session-handle type).

---

## Phase 2 — Clients

### Task W1 — Web: `surface-id.ts` (per-tab, sessionStorage, memory fallback)

**Files:**
- Create: `shared/web-sdk/src/surface-id.ts`
- Test: `shared/web-sdk/src/surface-id.test.ts`

- [ ] **Step 1: Write the failing test** — mirror `device-id.test.ts` but shim **sessionStorage** and pin key `sentient.surfaceId`.

Create `shared/web-sdk/src/surface-id.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetSurfaceMemoryFallbackForTests, getOrCreateSurfaceId } from "./surface-id.ts";

const SURFACE_ID_KEY = "sentient.surfaceId";

function installSessionStorageShim(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  } as Storage;
  return store;
}
function uninstallSessionStorageShim(): void { Reflect.deleteProperty(globalThis, "sessionStorage"); }

describe("getOrCreateSurfaceId — with sessionStorage", () => {
  let store: Map<string, string>;
  beforeEach(() => { store = installSessionStorageShim(); _resetSurfaceMemoryFallbackForTests(); });
  afterEach(() => { uninstallSessionStorageShim(); _resetSurfaceMemoryFallbackForTests(); });

  it("generates a non-empty id on first call", () => {
    const id = getOrCreateSurfaceId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
  it("persists the id to sessionStorage under sentient.surfaceId", () => {
    const id = getOrCreateSurfaceId();
    expect(store.get(SURFACE_ID_KEY)).toBe(id);
  });
  it("returns the same id on repeated calls", () => {
    expect(getOrCreateSurfaceId()).toBe(getOrCreateSurfaceId());
  });
  it("reuses a pre-existing id from sessionStorage", () => {
    store.set(SURFACE_ID_KEY, "preset-surface-abc");
    expect(getOrCreateSurfaceId()).toBe("preset-surface-abc");
  });
  it("generates a UUID-shaped id", () => {
    expect(getOrCreateSurfaceId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

describe("getOrCreateSurfaceId — without sessionStorage (SSR / Node)", () => {
  beforeEach(() => { uninstallSessionStorageShim(); _resetSurfaceMemoryFallbackForTests(); });
  afterEach(() => { _resetSurfaceMemoryFallbackForTests(); });
  it("does not throw when sessionStorage is unavailable", () => {
    expect(() => getOrCreateSurfaceId()).not.toThrow();
  });
  it("returns a non-empty id via in-memory fallback", () => {
    expect(getOrCreateSurfaceId().length).toBeGreaterThan(0);
  });
  it("returns the same in-memory id on repeated calls", () => {
    expect(getOrCreateSurfaceId()).toBe(getOrCreateSurfaceId());
  });
});
```

- [ ] **Step 2: Run to fail**

Run: `cd shared/web-sdk && bun run test surface-id`
Expected: `Cannot find module './surface-id.ts'`.

- [ ] **Step 3: Create the implementation** (mirror `device-id.ts`, sessionStorage + key)

Create `shared/web-sdk/src/surface-id.ts`:

```ts
// surface-id — per-TAB surfaceId persisted to sessionStorage.
//
// A "surface" is one chat surface: one browser tab. Unlike deviceId (per-
// browser, localStorage), surfaceId is per-tab: sessionStorage is scoped to a
// single tab and survives reloads within that tab, so two tabs get two distinct
// surfaceIds. Sent in `session.configure` (optional) so the gateway keys the
// ACP wire / resume buffer / replay attachment per surface (2026-06-14 design).
// Falls back to an in-memory UUID when sessionStorage is unavailable.

import { createLogger } from "./logger.ts";

const log = createLogger(["sentient", "web-sdk", "surface-id"]);
const SURFACE_ID_KEY = "sentient.surfaceId";
let memoryFallbackId: string | null = null;

function readSessionStorage(key: string): string | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage.getItem(key);
  } catch { return null; }
}
function writeSessionStorage(key: string, value: string): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(key, value);
  } catch { /* storage disabled / quota — non-fatal */ }
}
function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Get or create a per-tab surfaceId (sessionStorage `sentient.surfaceId`, memory fallback). */
export function getOrCreateSurfaceId(): string {
  const stored = readSessionStorage(SURFACE_ID_KEY);
  if (stored !== null && stored !== "") return stored;
  if (memoryFallbackId !== null) return memoryFallbackId;

  const id = generateUUID();
  writeSessionStorage(SURFACE_ID_KEY, id);
  const check = readSessionStorage(SURFACE_ID_KEY);
  if (check === null || check === "") {
    memoryFallbackId = id;
    log.debug("surface-id.memory-fallback", { id });
  } else {
    log.debug("surface-id.persisted", { id });
  }
  return id;
}

/** Test helper — reset the in-memory fallback between tests. */
export function _resetSurfaceMemoryFallbackForTests(): void { memoryFallbackId = null; }
```

- [ ] **Step 4: Run to pass**

Run: `cd shared/web-sdk && bun run test surface-id`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add shared/web-sdk/src/surface-id.ts shared/web-sdk/src/surface-id.test.ts
git commit -m "web-sdk: add per-tab surfaceId (sessionStorage, memory fallback)"
```

### Task W2 — Web: send `surfaceId` in `session.configure`

**Files:**
- Modify: `shared/web-sdk/src/sentient-sdk.ts` (import ~line 9; field ~72; ctor ~92; configure send ~354–360)

- [ ] **Step 1: Wire it in**

1. Import after `import { getOrCreateDeviceId } from "./device-id.ts";`:
```ts
import { getOrCreateSurfaceId } from "./surface-id.ts";
```
2. Field after `private readonly deviceId: string;`:
```ts
  private readonly surfaceId: string;
```
3. Constructor after `this.deviceId = getOrCreateDeviceId();`:
```ts
    this.surfaceId = getOrCreateSurfaceId();
```
4. Configure send — add `surfaceId` alongside `deviceId`:
```ts
        this.sendRaw({
          type: "session.configure",
          capabilities: { supports: [...this.capabilities] },
          clientType: "webui",
          deviceId: this.deviceId,
          surfaceId: this.surfaceId,
          ...(resume ? { resume } : {}),
        });
```

- [ ] **Step 2: Run to pass (typecheck + suite)**

Run: `cd shared/web-sdk && bun run typecheck && bun run test`
Expected: green (the sent object now matches `sessionConfigureSchema` with the new optional field).

- [ ] **Step 3: Commit**

```bash
git add shared/web-sdk/src/sentient-sdk.ts
git commit -m "web-sdk: send surfaceId in session.configure"
```

### Task M1 — Mobile: `surfaceId = deviceId` in `SessionConfigure`

**Files:**
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/protocol/ClientMessage.kt` (`SessionConfigure`, ~18–46)
- Modify: `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkLifecycle.kt` (configure, ~155–163)
- Test: `shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/protocol/WireSerializationTest.kt` (after `session_configure_*`, ~line 160)

- [ ] **Step 1: Write the failing wire-serialization tests**

Add to `WireSerializationTest.kt`:

```kotlin
    @Test fun session_configure_carries_surface_id_when_set() {
        val msg = ClientMessage.SessionConfigure(
            capabilities = Capabilities(listOf("text.input", "stream.resume")),
            clientType = "mobile",
            deviceId = "dev-abc",
            surfaceId = "dev-abc",
        )
        val json = WireJson.instance.encodeToString(ClientMessage.serializer(), msg)
        assertTrue(json.contains("\"surfaceId\":\"dev-abc\""), json)
    }

    @Test fun session_configure_omits_surface_id_when_null() {
        val msg = ClientMessage.SessionConfigure(
            capabilities = Capabilities(listOf("text.input")),
            clientType = "mobile",
            deviceId = "dev-abc",
        )
        val json = WireJson.instance.encodeToString(ClientMessage.serializer(), msg)
        assertFalse(json.contains("surfaceId"), json)
    }
```

- [ ] **Step 2: Run to fail**

Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "io.sentient.mobilesdk.protocol.WireSerializationTest"`
Expected: compile failure — `SessionConfigure` has no `surfaceId` param.

- [ ] **Step 3: Add the field + send it**

In `ClientMessage.kt`, after `val conversationId: String? = null,`:
```kotlin
        val conversationId: String? = null,
        /**
         * Chat-surface id (one app instance). Mobile sends `surfaceId = deviceId`
         * (1 app = 1 surface) — 2026-06-14 design §1. Omitted from the wire when
         * null (WireJson explicitNulls=false); the gateway schema is
         * `surfaceId: z.string().min(1).optional()` and rejects an explicit null.
         */
        val surfaceId: String? = null,
    ) : ClientMessage()
```

In `SdkLifecycle.kt`, add `surfaceId = deviceId`:
```kotlin
            transport?.send(
                ClientMessage.SessionConfigure(
                    capabilities = Capabilities(hooks.mergedCapabilities()),
                    clientType = CLIENT_TYPE_MOBILE,
                    deviceId = deviceId,
                    // Mobile: 1 app = 1 surface, so surfaceId = deviceId (design §1).
                    surfaceId = deviceId,
                    resume = hooks.resumeParams(),
                    conversationId = hooks.currentConversationId(),
                ),
            )
```

- [ ] **Step 4: Run to pass**

Run: `./gradlew :shared:mobile-sdk:testDebugUnitTest --tests "io.sentient.mobilesdk.protocol.WireSerializationTest"`
Expected: both new tests pass; existing `session_configure_*` + round-trip green.

- [ ] **Step 5: Commit**

```bash
git add shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/protocol/ClientMessage.kt shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/sdk/SdkLifecycle.kt shared/mobile-sdk/src/commonTest/kotlin/io/sentient/mobilesdk/protocol/WireSerializationTest.kt
git commit -m "mobile-sdk: send surfaceId = deviceId in session.configure"
```

---

## Phase 3 — Gateway keying

Full task bodies (real code, run-to-fail/pass, commits) are in the gateway-keying slice. Tasks, in order:

### Task GK-1 — `AcpWireRegistry`: re-key pool `userId` → `surfaceId`

**Files:** `gateway/src/hermes-adapter-client/acp-wire-registry.ts` + `.test.ts`

- [ ] **Step 1:** Rewrite `acp-wire-registry.test.ts` to express the contract in `surfaceId` terms + add the load-bearing case `dials TWO isolated wires for two surfaces of the SAME user` and `keeps the wire live after one release, disposes on last` (full test file in the slice notes; mechanics cases carry over with the param renamed).
- [ ] **Step 2:** Run to fail/baseline: `bun run test hermes-adapter-client/acp-wire-registry.test.ts` — confirm the new isolation case is present and nothing regresses.
- [ ] **Step 3:** Edit `acp-wire-registry.ts`: rename the key dimension `userId` → `surfaceId` in the header comment, the `AcpWireRegistry` interface JSDoc + all method params (`acquire`/`release`/`refCount`), and **every** `log.*` field. Mechanics (refcount/dial/dispose) unchanged. (Full renamed source in the slice notes.)
- [ ] **Step 4:** Run to pass: all cases green incl. the two-surfaces isolation case.
- [ ] **Step 5:** Commit `gateway(acp-wire): re-key pool userId→surfaceId for surface isolation`.

> **Resolved (per-user-plugin):** in `gateway/src/hermes-adapter-client/per-user-plugin.ts:71-91`, change the transient acquire/release to use sentinel key `` `rest-list:${userId}` `` (string), keeping the `finally` release. Add a one-line comment: "REST list path is not a surface — ephemeral un-pooled key; disposes immediately." Cover by the existing per-user-plugin test + typecheck.

### Task GK-2 — `DeviceBufferStore` + `DeviceAttachment`: re-key replay buffer by `surfaceId`, carry `deviceId`

**Files:** `device-buffer-store.ts`, `person-session.ts`, `device-attachment.ts` + their `.test.ts`

- [ ] **Step 1:** Update `device-buffer-store.test.ts`: rename ids to surface ids, pass `{ deviceId }` into `acquire`, add `gives two surfaces of the SAME device independent buffers + epochs` and `carries deviceId on the entry for device-presence` (asserts new `store.deviceIdFor(surfaceId)`). (Full test file in the slice notes.)
- [ ] **Step 2:** Run to fail: `bun run test person-session/device-buffer-store.test.ts` — type errors (`acquire(surfaceId, {deviceId})`, `deviceIdFor` missing).
- [ ] **Step 3:** Implement:
  - `DeviceBufferEntry` gains `readonly deviceId: string` (carried, never the key).
  - `acquire(surfaceId, { deviceId, resumeEpoch? })` — map keyed by `surfaceId`, stores `deviceId`, resume retains the entry's `deviceId`.
  - Rename param `deviceId` → `surfaceId` (+ log fields, carrying `deviceId` in logs) in `setForceClose`/`release`/`dispose`/`bufferFor`/`epochFor`/`sweepIdle`.
  - Add `deviceIdFor(surfaceId): string | undefined`.
  - `person-session.ts` facade: mirror the renamed signatures + add `deviceIdFor` passthrough.
  - `device-attachment.ts`: `DeviceAttachmentInit`/`DeviceAttachment` gain `readonly deviceId: string` (carried); `attachmentId` now documents "= surfaceId"; expose `deviceId` on the returned object.
  (Full code in the slice notes.)
- [ ] **Step 4:** Update `device-attachment.test.ts` `makeAttachment` + inline calls to pass `deviceId: "dev-1"`; assert `a.deviceId`. Run `bun run test person-session/` + `bun run typecheck` (catches every `acquireDeviceBuffer` call site, incl. `person-session.test.ts`/`person-session-registry.test.ts`).
- [ ] **Step 5:** Commit `gateway(buffer): re-key replay buffer + attachment by surfaceId, carry deviceId for presence`.

### Task GK-3 — `ws-session-configure.ts`: read `surfaceId` (fallback `deviceId`), thread into wire+buffer+attachment

**Files:** `ws-handlers.ts` (call), `ws-session-configure.ts` (signature ~78–87; surface derivation ~208; buffer ~209-212; wire `acquireAcpWireOrFail` ~234-244 + ~1042-1104; attachment ~271-282; resume-handover logs), `ws-resume-handover.ts` (log-only `deviceId` → `surfaceId`)

- [ ] **Step 1:** Verification gate (no bespoke unit test — 1000-line orchestrator, covered by GK-1/GK-2 + the resume/cleanup FSM tests). Run-to-fail: `cd gateway && bun run typecheck` — errors because `acquireDeviceBuffer`/`acquireAcpWireOrFail` now demand the surface key + `{deviceId}`.
- [ ] **Step 2:** Implement per the **Conventions** signature: `ws-handlers.ts` passes `msg.surfaceId` in the new slot; derive `const surfaceId = configureSurfaceId ?? deviceId;` (+ `session-configure.surface` log); `acquireDeviceBuffer(surfaceId, { deviceId, resumeEpoch? })`; `acquireAcpWireOrFail` gains `surfaceId` and acquires/releases by it (keep `userId` for WS-URL + logging); `createDeviceAttachment({ attachmentId: surfaceId, deviceId, ... })`; `setForceClose(surfaceId, …)`; rename log-only `deviceId` → `surfaceId` in the handover path. (Full code in the slice notes.)
- [ ] **Step 3:** Run to pass: `cd gateway && bun run typecheck` clean; `bun run test session-handlers/ws-resume-handover.test.ts session-handlers/ws-handlers-cleanup.test.ts session-handlers/ws-handlers-activity.test.ts` green.
- [ ] **Step 4:** Run the `attachmentId` consumer grep (Conventions); fix any consumer that assumed `attachmentId === deviceId` to read the carried `deviceId`/`store.deviceIdFor`.
- [ ] **Step 5:** Commit `gateway(configure): read surfaceId (fallback deviceId), thread into wire+buffer+attachment`.

### Task GK-4 — D3: lock wire release to the surface-attachment reap (not transport close)

**Files:** `ws-handlers.ts` (`teardownPipelineResources` ~374-376), `ws-handlers-cleanup.test.ts`

- [ ] **Step 1:** Add two regression tests to `ws-handlers-cleanup.test.ts`: (a) resumable disconnect does NOT call `acpWireDispose` until the captured deferred teardown runs; (b) full teardown calls it immediately. (Full sketch in the slice notes.)
- [ ] **Step 2:** Run to fail/verify: `bun run test session-handlers/ws-handlers-cleanup.test.ts`. **Likely both pass already** — the wire ref is held by the surviving attachment's deferred teardown, which fires on the buffer reap (`sweepIdle @ session.idle_timeout_ms`), and GK-2 re-points that reap to the surface. If the resumable case fails, that IS the D3 gap: relocate the wire release so it runs ONLY from the deferred/full-teardown path, never inline on transport close.
- [ ] **Step 3:** Add the clarifying comment at `teardownPipelineResources` documenting "wire lifetime = surface lifetime (D3); reuses the existing reap; no new TTL constant." Make the relocation fix only if Step 2 failed.
- [ ] **Step 4:** Run to pass + `bun run typecheck`.
- [ ] **Step 5:** Commit `gateway(d3): lock wire-release to the surface-attachment reap, not transport close`.

---

## Phase 4 — Within-surface correctness

### Task 4.0 — Add `SurfaceCycleRegistry` to `GatewayServices`

**Files:** Create `gateway/src/session-handlers/surface-cycle-registry.ts` + `.test.ts`; modify `gateway/src/bootstrap/create-gateway-services.ts` (~75-110 interface + construction phase)

- [ ] **Step 1: Write the failing test** — `surface-cycle-registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createSurfaceCycleRegistry } from "./surface-cycle-registry.js";

describe("SurfaceCycleRegistry — one in-flight cycle per surface", () => {
  it("acquire returns owner=true for the first cycle on a surface", () => {
    const reg = createSurfaceCycleRegistry();
    const lease = reg.acquire("surface_a", "cycle_1", new AbortController());
    expect(lease.owner).toBe(true);
    expect(lease.activeCycleId).toBe("cycle_1");
  });
  it("acquire on a busy surface returns owner=false + the in-flight id (no register-over)", () => {
    const reg = createSurfaceCycleRegistry();
    reg.acquire("surface_a", "cycle_1", new AbortController());
    const lease = reg.acquire("surface_a", "cycle_2", new AbortController());
    expect(lease.owner).toBe(false);
    expect(lease.activeCycleId).toBe("cycle_1");
  });
  it("isolates two surfaces — each owns its own in-flight cycle", () => {
    const reg = createSurfaceCycleRegistry();
    expect(reg.acquire("surface_a", "c_a", new AbortController()).owner).toBe(true);
    expect(reg.acquire("surface_b", "c_b", new AbortController()).owner).toBe(true);
  });
  it("a reconnecting transport adopts the in-flight cycle's controller (no restart)", () => {
    const reg = createSurfaceCycleRegistry();
    const original = new AbortController();
    reg.acquire("surface_a", "cycle_1", original);
    expect(reg.currentController("surface_a")).toBe(original);
    expect(reg.activeCycleId("surface_a")).toBe("cycle_1");
  });
  it("complete clears the slot so the next cycle owns it", () => {
    const reg = createSurfaceCycleRegistry();
    reg.acquire("surface_a", "cycle_1", new AbortController());
    reg.complete("surface_a", "cycle_1");
    expect(reg.acquire("surface_a", "cycle_2", new AbortController()).owner).toBe(true);
  });
  it("complete with a stale id is a no-op (does not free an adopted cycle)", () => {
    const reg = createSurfaceCycleRegistry();
    reg.acquire("surface_a", "cycle_1", new AbortController());
    reg.complete("surface_a", "cycle_OLD");
    expect(reg.activeCycleId("surface_a")).toBe("cycle_1");
  });
});
```

- [ ] **Step 2: Run to fail** — `bun run test session-handlers/surface-cycle-registry.test.ts` → module missing.

- [ ] **Step 3: Implement** — `surface-cycle-registry.ts`:

```ts
import { getLog } from "../logging/logger.js";
const log = getLog(["sentient", "session-handlers", "surface-cycle-registry"]);

export interface CycleLease {
  readonly owner: boolean;
  readonly activeCycleId: string;
}
interface SurfaceSlot { cycleId: string; controller: AbortController; }

export interface SurfaceCycleRegistry {
  acquire(surfaceKey: string, cycleId: string, controller: AbortController): CycleLease;
  complete(surfaceKey: string, cycleId: string): void;
  activeCycleId(surfaceKey: string): string | null;
  currentController(surfaceKey: string): AbortController | null;
}

export function createSurfaceCycleRegistry(): SurfaceCycleRegistry {
  const slots = new Map<string, SurfaceSlot>();
  return {
    acquire(surfaceKey, cycleId, controller) {
      const existing = slots.get(surfaceKey);
      if (existing) {
        log.debug("acquire.busy", { surfaceKey, activeCycleId: existing.cycleId, requested: cycleId });
        return { owner: false, activeCycleId: existing.cycleId };
      }
      slots.set(surfaceKey, { cycleId, controller });
      log.debug("acquire.owner", { surfaceKey, cycleId });
      return { owner: true, activeCycleId: cycleId };
    },
    complete(surfaceKey, cycleId) {
      const existing = slots.get(surfaceKey);
      if (!existing || existing.cycleId !== cycleId) {
        log.debug("complete.stale", { surfaceKey, requested: cycleId, active: existing?.cycleId ?? null });
        return;
      }
      slots.delete(surfaceKey);
      log.debug("complete", { surfaceKey, cycleId });
    },
    activeCycleId(surfaceKey) { return slots.get(surfaceKey)?.cycleId ?? null; },
    currentController(surfaceKey) { return slots.get(surfaceKey)?.controller ?? null; },
  };
}
```

- [ ] **Step 4: Run to pass** — `bun run test session-handlers/surface-cycle-registry.test.ts` (6 green).

- [ ] **Step 5: Wire into `GatewayServices`** — add `readonly surfaceCycles: SurfaceCycleRegistry;` to the interface (`create-gateway-services.ts:75-110`), construct it sibling to `acpWireRegistry`. `bun run typecheck`. Commit `feat(gateway): per-surface cycle owner registry (D1)`.

### Task 4.1 — onCycle consults the per-surface owner (D1): adopt, queue, never cancel

**Files:** `gateway/src/session-handlers/ws-session-configure.ts` (`admitCycle` helper near ~1191; `onCycle` ~619-666); `ws-session-configure.cycle-owner.test.ts`

- [ ] **Step 1: Write the failing test** — `ws-session-configure.cycle-owner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createSurfaceCycleRegistry } from "./surface-cycle-registry.js";
import { admitCycle } from "./ws-session-configure.js";

describe("admitCycle — per-surface serialization + adoption", () => {
  it("admits the first user cycle as dispatchable", () => {
    const reg = createSurfaceCycleRegistry();
    expect(admitCycle(reg, "surface_a", "cycle_user", new AbortController()).dispatch).toBe(true);
  });
  it("rejects an internal dispatch while a user cycle is in flight (queue, no second prompt)", () => {
    const reg = createSurfaceCycleRegistry();
    admitCycle(reg, "surface_a", "cycle_user", new AbortController());
    const internal = admitCycle(reg, "surface_a", "cycle_save_skill", new AbortController());
    expect(internal.dispatch).toBe(false);
    expect(internal.activeCycleId).toBe("cycle_user");
  });
  it("a reconnect transport seeing an in-flight cycle does NOT dispatch and does NOT cancel it", () => {
    const reg = createSurfaceCycleRegistry();
    const original = new AbortController();
    admitCycle(reg, "surface_a", "cycle_user", original);
    const reconnect = admitCycle(reg, "surface_a", "cycle_user_again", new AbortController());
    expect(reconnect.dispatch).toBe(false);
    expect(original.signal.aborted).toBe(false);
  });
});
```

- [ ] **Step 2: Run to fail** — `bun run test session-handlers/ws-session-configure.cycle-owner.test.ts` → `admitCycle` not exported.

- [ ] **Step 3: Implement** — add the exported helper near `resolveForcedSessionId`:

```ts
export interface CycleAdmission { readonly dispatch: boolean; readonly activeCycleId: string; }

/**
 * Per-surface cycle gate (D1). First cycle on an idle surface dispatches; any
 * concurrent dispatch (internal save-skill, or a reconnecting transport's fresh
 * cycle) is REFUSED — it queues behind / adopts the in-flight cycle whose output
 * already streams to the resume buffer. NEVER cancels the incumbent.
 */
export function admitCycle(
  registry: SurfaceCycleRegistry,
  surfaceKey: string,
  cycleId: string,
  controller: AbortController,
): CycleAdmission {
  const lease = registry.acquire(surfaceKey, cycleId, controller);
  return { dispatch: lease.owner, activeCycleId: lease.activeCycleId };
}
```

Rewire `onCycle` (~619-666): build the controller, call `admitCycle(services.surfaceCycles, surfaceId, params.cycleId, controller)`; if `!dispatch`, log `onCycle.queued-behind-surface-cycle` and `return { aborted: false, shouldContinue: true }` (no second `session/prompt`). Keep the per-transport `cycleSlot.register` for TTS/barge-in wiring, but ownership is the surface gate. In the `finally`, call both `cycleSlot.complete(...)` and `services.surfaceCycles.complete(surfaceId, params.cycleId)`. (Full code in the within-surface slice notes.)

- [ ] **Step 4: Verify adopt-not-cancel on resumable disconnect** — read `ws-handlers.ts` / `ws-resume-handover.ts`; confirm the resumable-disconnect close-handler does NOT fire `interruptController.trigger()` / barge-in (those abort `cycleSlot.currentController()`); on a resumable disconnect the adopted cycle must keep streaming. If suppression is missing, add it + a RED test in `ws-handlers-cleanup.test.ts`. **This is the highest-risk seam — do it explicitly.**

- [ ] **Step 5: Run to pass + commit** — `bun run test session-handlers/` green; commit `feat(gateway): onCycle consults per-surface owner; reconnect adopts, internal dispatch queues (D1)`.

### Task 4.2 — Conversation anchor keyed by surface (D2)

**Files:** `gateway/src/session-router.ts` + `.test.ts`; call sites `ws-session-configure.ts:176` (bind) + `:661` (update)

- [ ] **Step 1: Write the failing test** — add to `session-router.test.ts`:

```ts
describe("SessionRouter — conversation anchor survives transport handover (D2)", () => {
  it("a new sessionId on the SAME surface reads the conversationId anchored by the prior transport", async () => {
    const router = createSessionRouter(makeDeps());
    await router.bind("sess_old", "u_1", "surface_a");
    router.updateConversationId("surface_a", "conv_42");
    router.release("sess_old");
    await router.bind("sess_new", "u_1", "surface_a");
    expect(router.get("sess_new")?.conversationId).toBe("conv_42");
  });
  it("updateConversationId after the originating transport was released still lands on the surface anchor", async () => {
    const router = createSessionRouter(makeDeps());
    await router.bind("sess_old", "u_1", "surface_a");
    await router.bind("sess_new", "u_1", "surface_a");
    router.release("sess_old");
    router.updateConversationId("surface_a", "conv_99");
    expect(router.get("sess_new")?.conversationId).toBe("conv_99");
  });
  it("two different surfaces do not share an anchor", async () => {
    const router = createSessionRouter(makeDeps());
    await router.bind("sess_a", "u_1", "surface_a");
    await router.bind("sess_b", "u_1", "surface_b");
    router.updateConversationId("surface_a", "conv_a");
    expect(router.get("sess_b")?.conversationId).toBeNull();
  });
});
```

- [ ] **Step 2: Run to fail** — `bun run test session-router.test.ts` → `bind` arity / `surfaceId`-keyed anchor missing.

- [ ] **Step 3: Implement** (pure-surfaceId anchor, per Conventions):
  - `InternalBinding` gains `surfaceId: string`.
  - `bind(sessionId, userId, surfaceId)` stores it.
  - new `const anchors = new Map<string, string>()` (surfaceId → conversationId).
  - `updateConversationId(surfaceId, conversationId)` writes `anchors`.
  - `get(sessionId)` returns `conversationId: anchors.get(binding.surfaceId) ?? null`.
  - `release(sessionId)` deletes only the binding (anchors persist until surface reap).
  - `clearConversationIdForAllSessions(userId)` iterates bindings → collects that user's surfaceIds → `anchors.delete`.
  - Update interface signatures.
  - Call sites: `ws-session-configure.ts:176` → `bind(sessionId, userId, surfaceId)`; `:661` → `updateConversationId(surfaceId, result.conversationId)`.
  (Full code in the within-surface slice notes.)

- [ ] **Step 4: Run to pass** — `bun run test session-router.test.ts` + `bun run test cerebrum/ session-handlers/` regressions green.

- [ ] **Step 5: Commit** `feat(gateway): conversation anchor keyed by surface, survives transport handover (D2)`.

### Task 4.3 — Real Hermes session-id readback (drop synthesized `created`)

**Files:** `gateway/src/hermes-adapter-client/per-profile-connection.ts` (`onSessionId` + fan-out ~117) + `.test.ts`; `acp-hermes-client.ts` (~174 + finally) + `.test.ts`

- [ ] **Step 1: Write the failing tests**
  - `per-profile-connection.test.ts`: a `session/update` carrying `params.sessionId` fans to `onSessionId` subscribers (real id, incl. a fork-named id).
  - `acp-hermes-client.test.ts`: dispatch emits a provisional `created` from the forced id, then on a divergent `session/update.sessionId` emits a corrective `created` with the REAL id (contract 1). (Full tests in the within-surface slice notes.)

- [ ] **Step 2: Run to fail** — both files → `onSessionId` missing; corrective `created` never emitted.

- [ ] **Step 3: Implement**
  - `per-profile-connection.ts`: add `sessionIdHandlers` set + `onSessionId(cb)` subscription; in the `session/update` notification, read `params.sessionId` via a zod-guarded helper and fan it. Clear in `dispose()`.
  - `acp-hermes-client.ts`: after the provisional `created` push (`:174`), `deps.acpConn.onSessionId((realId) => …)` — on the FIRST id, if it differs from `resolvedSessionId`, `log.warn("created.real-id-divergence", …)` and push a corrective `created` carrying `realId`; else `log.debug("created.real-id-confirmed", …)`. Unsubscribe in the same `finally`/error path as `unsubEvents`/`unsubCycleDone`.
  (Full code in the within-surface slice notes.)
  > Contract (1) preserves the existing "created before wire activity" test + FSM ungate. Confirm the cerebrum `hermes-event-translator` tolerates two `created` events per cycle (the second re-anchors to the real id via `updateConversationId` — the desired heal). If it asserts single-`created`, fall back to contract (2) (defer `created`) and update the legacy test.

- [ ] **Step 4: Run to pass** — both files green; existing happy-path `created` tests still pass (no divergence when ids match).

- [ ] **Step 5: Commit** `feat(gateway): read back real Hermes session id from session/update; log + re-anchor on divergence`.

---

## Phase 5 — System-level verification (the e2e matrix)

Run against the local `deploy/macos` stack. Mobile = Maestro; web = Playwright MCP. Each case green only when user-visible behavior AND the Hermes-store / gateway-log trail match. Use `gateway/test-harness/check-forks.sh` for the hard fork signal.

### Task 5.1 — Full local CI + the e2e matrix

- [ ] **Step 1: Quality gate** — `bun run ci` (lint + typecheck + unit) green across gateway + shared packages; `./gradlew :shared:mobile-sdk:testDebugUnitTest` green.
- [ ] **Step 2: Rebuild + boot** — rebuild gateway image, `cd deploy/macos && docker compose up -d`, confirm health.
- [ ] **Step 3: Case `Repro: bg mid-search` (iOS, Maestro)** — chat in convo A, send a web-search-triggering msg, background mid-search, foreground, send follow-up. Assert: answer lands in A; **`check-forks.sh <profile>` == 0**; gateway log shows no `updateConversationId.unknown-session`; resume on same `surfaceId`.
- [ ] **Step 4: Case `Two tabs, diff chats` (web ×2, 1280×900)** — Tab1 convo A, Tab2 convo B, send in both ~concurrently. Assert: each answer in its own tab/convo; gateway log shows 2 distinct `surfaceId` wires (`acquire.dial` ×2); no cross-write; `check-forks.sh` == 0.
- [ ] **Step 5: Case `Same chat, two surfaces` (iOS + web)** — convo A open on both, send on each. Assert: fork **intended** (two A's); 2 children load A; documented, not flagged as error.
- [ ] **Step 6: Case `Reconnect storm` (iOS, Maestro)** — toggle bg/fg ×5 mid-cycle. Assert: stream resumes, one answer; same `surfaceId` child reused (no extra `acquire.dial`); `check-forks.sh` == 0.
- [ ] **Step 7: Case `Old client fallback` (web build w/o surfaceId)** — normal chat + reconnect. Assert: works as today; gateway keys by `deviceId`; no error.
- [ ] **Step 8: Evidence + handover** — capture screenshots/log trails under the QA dirs; confirm every case green, the system-level RED from Phase 0 is now 0. Commit any harness/evidence notes.

---

## Self-review

**Spec coverage:** §1 identity → P1/W1/W2/M1. §2 keying → GK-1/GK-2/GK-3. §3.1 (D1) → 4.0/4.1. §3.2 (D2) → 4.2. §3.3 real-id → 4.3. §4 edge cases → fallback (GK-3, P1), old-client (5.7), same-chat-two-surfaces (5.5). §5 affected components → all covered. §6 D1/D2/D3 → 4.x + GK-4. E2E matrix → Phase 5 rows 1:1. ✅

**Placeholder scan:** Phase-3 tasks reference "full code in the slice notes" for the largest mechanical files (registry rename, buffer re-key, configure threading) rather than re-pasting ~400 lines; the novel logic (surface-cycle-registry, admitCycle, anchor, real-id readback, surface-id.ts) has complete inline code. The slice notes are the agent outputs captured in this session; the executor has the exact code. No `TODO`/`TBD` in requirements. Acceptable for a plan this size; if executing fresh, re-derive the rename diffs from the cited file:line ranges.

**Type consistency:** `surfaceId` (resolved key) used uniformly; `admitCycle(registry, surfaceKey, cycleId, controller)` matches `SurfaceCycleRegistry.acquire`; `updateConversationId(surfaceId, conversationId)` consistent across router + call site; `acquireDeviceBuffer(surfaceId, { deviceId, resumeEpoch? })` consistent across store + facade + caller; handler signature pinned in Conventions and reused by GK-3 + Phase 4. ✅
