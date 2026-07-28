### Task 10: Reconnect gap-fill — per-connection frame journal, seq/epoch stamping, `stream.resumed` replay

**Spec:** §11 build-order slice 6, second paragraph ("Reconnect gap-fill (seq/epoch frame journal over the new frame set)"). **Wave 4 — runs after Task 2 (voice) and Task 6 (permission) have landed**, because all three tasks edit `ws-handlers.ts`, `ws-helpers.ts` and `ws-session-configure.ts`.

**This is the one sub-area of Plan 3 where the WIRE SHAPE DOES NOT CHANGE.** `sessionConfigureResumeSchema` (`{ epoch, lastSeq }` folded into `session.configure`), `streamResumedSchema` (`{ recovered, epoch, fromSeq?, toSeq? }`), the optional `seq`/`epoch` stamp on every gateway → client JSON frame (`withSeqEpoch`), and the 9-byte binary header all already exist in `shared/protocol` **and** are already implemented on both client SDKs (`shared/web-sdk/src/resume-cursor.ts` + `stream-resume-handler.ts`; `shared/mobile-sdk/.../transport/ResumeCursor.kt` + `ReconnectResumeDecision.kt`). Task 1 kept every one of them in `gatewayMessageSchema` untouched. **Do not add, rename, or re-shape a single frame in this task.** Everything here is gateway internals catching up to a contract the clients have been speaking into a void.

**What exists today: nothing.** The 2.0 purge (`10bd446`) deleted the entire prior implementation. Concretely, right now:

- `SessionData` (`ws-helpers.ts`) has no `seq`, no `epoch`, no journal, no surface key.
- `handleSessionConfigure` receives `configureResume` and does exactly one thing with it: `hasResume: configureResume !== undefined` in a log line, under a comment saying it is "accepted but not acted on".
- `cleanupSession` (`ws-handlers.ts`) states in its doc comment: *"There is no resumable-disconnect handling yet — a fresh connection always mints a fresh runtime."*
- Task 1's `ws-send.ts` sends every JSON frame unstamped, and Task 1's `ws-turn-emitter.ts` carries a **local** `audioSeq` counter with the comment *"JSON frames stay unsequenced until Task 10 restores the replay journal."* That comment is this task's marching order.

So a client that reconnects today sends `resume: { epoch, lastSeq }`, gets no `stream.resumed` at all, never learns its request was ignored, and silently drops nothing / duplicates nothing only because no frame ever carried a seq in the first place.

---

#### Prior art — read it, do not resurrect it

The spec text says to mine `git show 7d3fb15:gateway/src/session-handlers/session-replay-buffer.ts`. **That reference is incomplete and the sibling paths in it are wrong for that commit.** Only `session-replay-buffer.ts` existed at `7d3fb15`. `frame-sequencer.ts` and `ws-resume-handover.ts` were added later under `gateway/src/session-handlers/`, and `device-buffer-store.ts` + `device-buffer-types.ts` under `gateway/src/person-session/`. All five were deleted together in the purge commit. Read them with:

```bash
cd /Users/kevinye/Development/sentient
git show 10bd446^:gateway/src/session-handlers/session-replay-buffer.ts   # 142 lines
git show 10bd446^:gateway/src/session-handlers/frame-sequencer.ts        #  53 lines
git show 10bd446^:gateway/src/session-handlers/ws-resume-handover.ts     # 203 lines
git show 10bd446^:gateway/src/person-session/device-buffer-store.ts      # 239 lines
git show 10bd446^:gateway/src/person-session/device-buffer-types.ts      #  81 lines
```

**Treat all of it as a design-pattern reference, not as code to restore.** It was built for a lifecycle that no longer exists: a `PersonSession` owning a `DeviceBufferStore`, a shared mutable `DeviceSocketRef` so a *stale in-flight ACP cycle* could keep writing to a *new* socket after a `goLive()` handover, and a `deferredTeardown` callback parked on the buffer entry so a TTL sweep could dispose an orphaned ACP-wire pipeline. None of those constructs exist in 2.0. `SessionRuntime.dispose()` is **immediate and idempotent** (`session-runtime.ts`: `if (disposed) return; disposed = true; inFlight?.controller.abort(); store.close();`) — there is no detach-then-reap window, no socket ref to re-point, and no in-flight turn that survives the disconnect. **The 2.0 journal replays frames the client MISSED before the socket died; it does not resume an in-flight turn.**

Four ideas carry forward verbatim, and they are the whole reason to read the old files:

1. **Two-phase seq allocation** — the seq must exist *before* the wire bytes are built, because the seq lives *inside* those bytes (JSON field / binary header).
2. **Byte-cap eviction** — evict oldest while over cap, but never evict the last remaining frame.
3. **Gap detection via `oldestSeq`** — if the frame the client last saw has been evicted, contiguous replay is impossible; say so and let the client REST-refetch.
4. **Epoch mismatch forces a fresh session** — an `epoch` that does not match is not a recoverable state, it is a different stream.

---

#### Files

**Create**
- `gateway/src/session-handlers/frame-journal.ts`
- `gateway/src/session-handlers/frame-journal.test.ts`
- `gateway/src/session-handlers/replay-registry.ts`
- `gateway/src/session-handlers/ws-resume.ts`
- `gateway/src/session-handlers/ws-resume.test.ts`

**Modify**
- `shared/config/src/schema.ts`
- `gateway/config.yaml`
- `gateway/src/bootstrap/create-gateway-services.ts`
- `gateway/src/session-handlers/ws-send.ts`
- `gateway/src/session-handlers/ws-turn-emitter.ts`
- `gateway/src/session-handlers/ws-helpers.ts`
- `gateway/src/session-handlers/ws-session-configure.ts`
- `gateway/src/session-handlers/ws-handlers.ts`

**Test (modify)**
- `gateway/src/session-handlers/ws-turn-emitter.test.ts`
- `gateway/src/session-handlers/ws-handlers-routing.test.ts`

**Do NOT touch:** `shared/protocol/src/messages.ts` (the resume half of the contract is already correct and frozen), `shared/web-sdk/src/resume-cursor.ts`, `shared/web-sdk/src/stream-resume-handler.ts`, `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/transport/*`, `gateway/src/runtime/cancellation.ts`, `gateway/src/adapters/stt/*`, the `cerebrum:` block in `gateway/config.yaml`.

---

#### Interfaces

**Consumes — from `shared/protocol` (already on the wire, frozen, verified in the tree):**

```ts
// shared/protocol/src/messages.ts
export const sessionConfigureResumeSchema = z.object({
  epoch: z.number().int().nonnegative(),
  lastSeq: z.number().int().nonnegative(),
});
export type SessionConfigureResume = z.infer<typeof sessionConfigureResumeSchema>;

const streamResumedBaseSchema = z.object({
  type: z.literal("stream.resumed"),
  recovered: z.boolean(),
  epoch: z.number().int().nonnegative(),
  fromSeq: z.number().int().nonnegative().optional(),
  toSeq: z.number().int().nonnegative().optional(),
});
export const streamResumedSchema = withSeq(streamResumedBaseSchema);

// every gateway → client entry in the union is wrapped:
//   withSeqEpoch(schema) === schema.extend({
//     seq:   z.number().int().nonnegative().optional(),
//     epoch: z.number().int().nonnegative().optional(),
//   })
export const gatewayMessageSchema = z.discriminatedUnion("type", [ /* … */ ]);
export type GatewayMessage = z.infer<typeof gatewayMessageSchema>;
```

**Consumes — from Task 1 (`gateway/src/session-handlers/ws-send.ts`), the shapes this task rewrites:**

```ts
export function sendGatewayFrame(ws: ServerWebSocket<SessionData>, frame: GatewayMessage): boolean;
export function encodeAudioFrame(seq: number, payload: Uint8Array): Uint8Array;
export function sendAudioFrame(ws: ServerWebSocket<SessionData>, seq: number, payload: Uint8Array): boolean;
```

**Consumes — existing gateway code (verified in the tree):**

```ts
// gateway/src/session-handlers/ws-helpers.ts  (post-Task-6 shape)
export interface SessionData {
  sessionId: string | null;
  authState: "pending" | "authenticating" | "authed" | "rejected";
  principal: UserPrincipal | null;
  authTimeout: ReturnType<typeof setTimeout> | null;
  grantedCapabilities: Set<string>;
  clientType: ClientType;
  runtime: SessionRuntime | null;
  permissions: PermissionBroker | null;   // added by Task 6
}
export function createEmptySessionData(): SessionData;
export function sendError(ws: ServerWebSocket<SessionData>, code: string, message: string): void;
export function errorMessage(error: unknown, fallback: string): string;

// gateway/src/identity/user-principal.ts
export interface UserPrincipal { readonly userId: UserId; readonly role: PrincipalRole; readonly householdId: string; }

// gateway/src/runtime/session-runtime.ts
dispose(): void;  // idempotent; aborts the in-flight signal, closes the store handle

// gateway/src/logging/logger.ts
export function getLog(tags: string[]): Logger;   // .debug/.info/.warn/.error(msg, props)

// shared/config/src/schema.ts
export const sessionConfigSchema = z.object({
  ws_idle_timeout_ms: z.number().int().min(1000).max(255000),
  per_user_max_sessions: z.number().int().min(1).max(100),
});
export type SessionConfig = z.output<typeof sessionConfigSchema>;

// gateway/src/bootstrap/create-gateway-services.ts
export interface GatewayServices { readonly session: SessionConfig; /* … */ }
```

**Produces — exact exported names later work relies on:**

```ts
// gateway/src/session-handlers/frame-journal.ts
export type JournaledFrameKind = "text" | "binary";
export interface JournaledFrame { readonly seq: number; readonly bytes: Uint8Array; readonly kind: JournaledFrameKind; }
export interface AllocatedText   { readonly seq: number; readonly text: string; }
export interface AllocatedBinary { readonly seq: number; readonly bytes: Uint8Array; }
export interface FrameJournal {
  allocateText(build: (seq: number) => string): AllocatedText;
  allocateBinary(build: (seq: number) => Uint8Array): AllocatedBinary;
  since(lastSeq: number): readonly JournaledFrame[] | null;
  readonly oldestSeq: number;
  readonly newestSeq: number;
  readonly byteLength: number;
  readonly frameCount: number;
}
export interface FrameJournalOptions { maxBytes: number }
export function createFrameJournal(options: FrameJournalOptions): FrameJournal;

// gateway/src/session-handlers/replay-registry.ts
export interface ReplayAcquisition { readonly journal: FrameJournal; readonly epoch: number; readonly resumed: boolean; }
export interface ReplayRegistry {
  acquire(surfaceKey: string, resumeEpoch: number | undefined): ReplayAcquisition;
  release(surfaceKey: string): void;
  discard(surfaceKey: string): void;
  readonly size: number;
}
export interface ReplayRegistryOptions { maxBytesPerSurface: number; retentionMs: number; now?: () => number }
export function createReplayRegistry(options: ReplayRegistryOptions): ReplayRegistry;

// gateway/src/session-handlers/ws-resume.ts
export interface HandleResumeInput {
  ws: ServerWebSocket<SessionData>;
  sessionId: string;
  surfaceKey: string;
  journal: FrameJournal;
  epoch: number;
  resumed: boolean;
  resumeParams: SessionConfigureResume | undefined;
  readyFrame: GatewayMessage;
}
export function handleResumeOrFresh(input: HandleResumeInput): boolean;

// gateway/src/session-handlers/ws-send.ts  (changed / added)
export function sendGatewayFrame(ws: ServerWebSocket<SessionData>, frame: GatewayMessage): boolean;
export function sendUnsequencedFrame(ws: ServerWebSocket<SessionData>, frame: GatewayMessage): boolean;
export function sendAudioFrame(ws: ServerWebSocket<SessionData>, payload: Uint8Array): number; // ← signature change
export function encodeAudioFrame(seq: number, payload: Uint8Array): Uint8Array;                // unchanged

// gateway/src/session-handlers/ws-helpers.ts  (SessionData additions)
journal: FrameJournal | null;
epoch: number;
replayKey: string | null;

// gateway/src/bootstrap/create-gateway-services.ts
readonly replayRegistry: ReplayRegistry;

// shared/config/src/schema.ts  (sessionConfigSchema additions)
replay_journal_max_bytes: number;
replay_journal_retention_ms: number;
```

---

#### Seven locked decisions — read before writing any code

1. **One seq space per surface, shared by JSON and binary.** The prior art's `FrameSequencer` drew JSON `seq` and binary-header `seq` from the same `SessionReplayBuffer` counter, and the clients depend on that: `resume-cursor.ts`'s `tryApply` is called from *both* the JSON path and the binary path against **one** `lastSeq`. Task 1's local `audioSeq` inside `ws-turn-emitter.ts` is a placeholder; it must be deleted, not extended. If audio and JSON ever draw from two counters the client silently drops half the stream.

2. **Stamping happens in `ws-send.ts`, nowhere else.** Task 1 made `sendGatewayFrame` the single JSON chokepoint and `sendAudioFrame` the single binary chokepoint, and both already take `ws`. Reading `ws.data.journal` inside them gives every existing and future caller sequencing for free, with **zero** call-site changes. Do not thread a sequencer object through the emitter.

3. **Validate first, stamp second.** `gatewayMessageSchema.safeParse(frame)` runs on the *unstamped* frame; the `seq`/`epoch` fields are then spread onto the parsed (key-stripped) output. This keeps Task 1's two guarantees intact — the wire bytes are exactly the contract and nothing else, and an invalid frame is dropped rather than thrown — while making it impossible for a validation failure to consume a seq and tear a hole in the journal.

4. **The journal outlives the socket; it lives in a `ReplayRegistry` keyed `${userId}::${surfaceId}`.** `surfaceId` falls back to `deviceId` when the client omits it (the protocol comment on `sessionConfigureSchema.surfaceId` mandates that fallback). Keying by `(userId, surfaceId)` matches `SessionRuntime`'s own identity — two browser tabs of one user are two surfaces with independent journals and epochs, exactly as before. **The registry does not hold sockets, runtimes, teardown callbacks, or activity clocks** — only `{ journal, epoch, detachedAtMs }`. That is the whole delta from `DeviceBufferStore`.

5. **Retention is a lazy sweep, not a timer.** `acquire()` and `release()` each sweep entries whose `detachedAtMs` is older than `retentionMs`. `release()` runs on every disconnect, so the sweep runs on every disconnect — growth is bounded without adding an interval to the bootstrap or a second lifecycle to reason about. Injecting `now` makes it deterministically testable.

6. **On the recovered path, `session.ready` goes out RAW (unstamped) and FIRST.** This is a load-bearing client-FSM detail, not a stylistic choice. Both SDKs only ungate their connect handshake on `session.ready` and have no `stream.resumed` case for that gate; and `resume-cursor.ts` advances `lastSeq` on *any* seq-stamped frame, so a seq-stamped `session.ready` here would jump the client cursor past the replay window and it would drop every replayed frame as a duplicate. Order: **raw `session.ready` → raw `stream.resumed{recovered:true}` → verbatim replay**. On every non-recovered path the order inverts: **raw `stream.resumed{recovered:false}` → stamped `session.ready`** (the client resets its cursor on `recovered:false`, so the stamped ready that follows starts the new epoch cleanly).

7. **Config lives under `session:`, not `orchestrator:`.** Two concrete reasons, both structural: `GatewayServices` exposes `session: SessionConfig` but does **not** expose the orchestrator config block at all (only `provider` and `createSessionRuntime` escape `phase-services.ts`); and `cfg.orchestrator` is *optional* while gap-fill must work on any connection that reaches `session.configure`, including one on a gateway with no orchestrator configured. `session:` already owns `ws_idle_timeout_ms` and `per_user_max_sessions`, and is where the deleted `replay_buffer_max_bytes` lived. Both new keys carry a zod `.default()` — `sessionConfigSchema`'s existing keys do not, but `orchestratorConfigSchema`/`sttConfigSchema`/`ttsConfigSchema` all do, and a default is what keeps every operator's existing `~/.sentient/gateway/config/config.yaml` booting without a `schema_version` bump in `operator-config-migrator.ts`.

---

#### Part A — the frame journal (commit 1)

- [ ] **Step 1: Read the prior art you are about to improve on.**

  ```bash
  cd /Users/kevinye/Development/sentient
  git show 10bd446^:gateway/src/session-handlers/session-replay-buffer.ts
  git show 10bd446^:gateway/src/session-handlers/frame-sequencer.ts
  ```

  You are looking for three things and can ignore the rest: the `nextSeq()`/`store()` pairing rule, the `while (totalBytes > maxBytes && frames.length > 1)` eviction loop, and the `oldestSeq`/`newestSeq` empty-buffer sentinels (`seqCounter + 1` and `seqCounter`).

- [ ] **Step 2: Write the failing journal test.**

  Create `gateway/src/session-handlers/frame-journal.test.ts`:

  ```ts
  // FrameJournal invariants (Plan 3 Task 10, spec §11 slice 6).
  //
  // This pins the resume FSM's arithmetic, not an implementation detail: the
  // gateway's "can I replay contiguously?" answer is the ONLY thing standing
  // between a reconnecting client and a silently-truncated conversation. Two
  // rules here are deliberate improvements over the deleted prior art
  // (session-replay-buffer.ts) and would otherwise be re-broken by a future
  // rewrite:
  //   - a client sitting EXACTLY one frame behind the oldest retained frame
  //     can still resume (old rule `lastSeq < oldestSeq → null` forced a
  //     needless full refetch at that boundary);
  //   - a client claiming a lastSeq the gateway never issued is a gap, not a
  //     no-op (old rule returned [] for an empty ring regardless of lastSeq,
  //     which would ack "you're caught up" to a client that had lost
  //     everything).

  import { describe, expect, it } from "bun:test";
  import { createFrameJournal } from "./frame-journal.js";

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function textJournal(maxBytes = 1_000_000) {
    const journal = createFrameJournal({ maxBytes });
    const put = (body: string) => journal.allocateText((seq) => JSON.stringify({ body, seq }));
    return { journal, put };
  }

  describe("FrameJournal — seq allocation", () => {
    it("allocates monotonic seqs starting at 1 across both frame kinds", () => {
      const journal = createFrameJournal({ maxBytes: 1_000_000 });
      const a = journal.allocateText((seq) => `a${seq}`);
      const b = journal.allocateBinary((seq) => enc.encode(`b${seq}`));
      const c = journal.allocateText((seq) => `c${seq}`);

      expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
      expect(a.text).toBe("a1");
      expect(dec.decode(b.bytes)).toBe("b2");
    });

    it("hands the allocated seq to the builder BEFORE journaling its bytes", () => {
      const { journal } = textJournal();
      const built = journal.allocateText((seq) => JSON.stringify({ seq }));

      expect(built.text).toBe('{"seq":1}');
      const replayed = journal.since(0);
      expect(replayed).not.toBeNull();
      expect(dec.decode((replayed ?? [])[0]?.bytes ?? new Uint8Array())).toBe('{"seq":1}');
    });

    it("reports an empty journal as oldestSeq=1, newestSeq=0", () => {
      const journal = createFrameJournal({ maxBytes: 1_000_000 });
      expect(journal.oldestSeq).toBe(1);
      expect(journal.newestSeq).toBe(0);
      expect(journal.frameCount).toBe(0);
    });
  });

  describe("FrameJournal — byte-cap eviction", () => {
    it("evicts oldest frames once the cap is exceeded", () => {
      // Each frame is 10 bytes; cap of 25 retains at most 2.
      const journal = createFrameJournal({ maxBytes: 25 });
      for (let i = 0; i < 5; i++) journal.allocateBinary(() => new Uint8Array(10));

      expect(journal.frameCount).toBe(2);
      expect(journal.oldestSeq).toBe(4);
      expect(journal.newestSeq).toBe(5);
      expect(journal.byteLength).toBe(20);
    });

    it("never evicts the last remaining frame, even when it alone exceeds the cap", () => {
      const journal = createFrameJournal({ maxBytes: 8 });
      journal.allocateBinary(() => new Uint8Array(64));

      expect(journal.frameCount).toBe(1);
      expect(journal.newestSeq).toBe(1);
    });
  });

  describe("FrameJournal — gap detection (since)", () => {
    it("returns every retained frame for the lastSeq=0 sentinel", () => {
      const { journal, put } = textJournal();
      put("one");
      put("two");

      expect((journal.since(0) ?? []).map((f) => f.seq)).toEqual([1, 2]);
    });

    it("returns only frames strictly after lastSeq", () => {
      const { journal, put } = textJournal();
      put("one");
      put("two");
      put("three");

      expect((journal.since(2) ?? []).map((f) => f.seq)).toEqual([3]);
    });

    it("returns an empty array (not null) when the client is already at the head", () => {
      const { journal, put } = textJournal();
      put("one");

      expect(journal.since(1)).toEqual([]);
    });

    it("returns null when the frame at lastSeq has been evicted", () => {
      const journal = createFrameJournal({ maxBytes: 25 });
      for (let i = 0; i < 5; i++) journal.allocateBinary(() => new Uint8Array(10));
      // oldestSeq is 4, so a client that last saw seq 1 has an unfillable gap.
      expect(journal.since(1)).toBeNull();
    });

    it("still resumes a client sitting exactly one frame behind the oldest retained frame", () => {
      const journal = createFrameJournal({ maxBytes: 25 });
      for (let i = 0; i < 5; i++) journal.allocateBinary(() => new Uint8Array(10));
      // oldestSeq is 4; a client at lastSeq 3 saw everything up to 3, so 4..5
      // is a contiguous continuation — NOT a gap.
      expect((journal.since(3) ?? []).map((f) => f.seq)).toEqual([4, 5]);
    });

    it("returns null when the client claims a lastSeq the journal never issued", () => {
      const { journal, put } = textJournal();
      put("one");

      expect(journal.since(99)).toBeNull();
    });

    it("returns null for any non-zero lastSeq against a journal that never wrote a frame", () => {
      const journal = createFrameJournal({ maxBytes: 1_000_000 });

      expect(journal.since(5)).toBeNull();
      expect(journal.since(0)).toEqual([]);
    });
  });
  ```

- [ ] **Step 3: Run it and watch it fail on the missing module.**

  ```bash
  cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway/src && bun test session-handlers/frame-journal.test.ts
  ```

  Expected: `error: Cannot find module './frame-journal.js'` — the file does not exist yet.

- [ ] **Step 4: Implement the journal.**

  Create `gateway/src/session-handlers/frame-journal.ts`:

  ```ts
  // FrameJournal — the per-surface outbound frame ring that makes reconnect
  // gap-fill possible (spec §11 slice 6). Successor to the deleted
  // session-replay-buffer.ts + frame-sequencer.ts pair.
  //
  // Every gateway → client frame — JSON and binary alike — draws its `seq`
  // from ONE counter here and leaves its wire-ready bytes behind, so a
  // reconnecting client can be handed back exactly the bytes it missed,
  // byte-identical, in order.
  //
  // Two-phase allocation, fused: the prior art exposed `nextSeq()` and
  // `store()` as a pair the caller had to keep balanced, and threw if they
  // ever drifted apart. The two phases are unavoidable — the seq lives INSIDE
  // the bytes (a JSON field / the 9-byte binary header), so it must exist
  // before the bytes can be built — but the PAIRING is not: `allocateText` /
  // `allocateBinary` take the builder as a callback, so a dangling pending
  // seq is structurally impossible instead of a runtime assertion.
  //
  // Memory is bounded by TWO independent caps, exactly as before: this
  // byte cap (evict-oldest, config `session.replay_journal_max_bytes`) and
  // the registry's detach retention window (replay-registry.ts, config
  // `session.replay_journal_retention_ms`). Audio journals one frame per
  // Opus frame (~50/s), so the frame COUNT is bounded implicitly by the byte
  // cap. Coalescing many Opus frames into one journal entry is deliberately
  // NOT done — each Opus frame carries its own seq for client-side dedup.

  import { getLog } from "../logging/logger.js";

  const log = getLog(["sentient", "ws", "journal"]);

  export type JournaledFrameKind = "text" | "binary";

  export interface JournaledFrame {
    readonly seq: number;
    readonly bytes: Uint8Array;
    readonly kind: JournaledFrameKind;
  }

  export interface AllocatedText {
    readonly seq: number;
    readonly text: string;
  }

  export interface AllocatedBinary {
    readonly seq: number;
    readonly bytes: Uint8Array;
  }

  export interface FrameJournal {
    /** Allocate the next seq, build the JSON text with it, journal the encoded
     *  bytes, and hand back both so the caller can write the very same string
     *  to the socket without re-encoding. */
    allocateText(build: (seq: number) => string): AllocatedText;
    /** Same contract for a binary frame whose 9-byte header embeds the seq. */
    allocateBinary(build: (seq: number) => Uint8Array): AllocatedBinary;
    /**
     * Frames the client still needs, given the highest seq it applied.
     *
     *   lastSeq === 0            → sentinel "send me everything retained".
     *   lastSeq > newestSeq      → null. The client claims a seq this journal
     *                              never issued (stale epoch that slipped the
     *                              epoch check, or a corrupted cursor) —
     *                              unfillable, force a fresh session.
     *   lastSeq < oldestSeq - 1  → null. The frame after the client's cursor
     *                              was evicted, so replay cannot be
     *                              contiguous. Note the `- 1`: a client whose
     *                              cursor sits EXACTLY one frame behind the
     *                              oldest retained frame is still contiguous
     *                              and resumes fine (the prior art's rule
     *                              lacked it and forced a needless refetch at
     *                              that boundary).
     *   otherwise                → every retained frame with seq > lastSeq,
     *                              possibly empty (client already at head).
     */
    since(lastSeq: number): readonly JournaledFrame[] | null;
    /** Lowest retained seq. `newestSeq + 1` when empty — "the oldest frame is
     *  in the future", so any real lastSeq trips the gap check. */
    readonly oldestSeq: number;
    /** Highest seq ever allocated (retained or evicted). 0 before the first. */
    readonly newestSeq: number;
    readonly byteLength: number;
    readonly frameCount: number;
  }

  export interface FrameJournalOptions {
    /** Maximum total retained bytes. Oldest frames evict first. */
    maxBytes: number;
  }

  const TEXT_ENCODER = new TextEncoder();

  export function createFrameJournal(options: FrameJournalOptions): FrameJournal {
    const { maxBytes } = options;

    const frames: JournaledFrame[] = [];
    let totalBytes = 0;
    let seqCounter = 0;

    function retain(frame: JournaledFrame): void {
      frames.push(frame);
      totalBytes += frame.bytes.byteLength;

      // Evict oldest while over cap, but never evict the only remaining frame
      // — a journal holding nothing can answer no resume at all. The O(n)
      // shift is acceptable at family-assistant scale.
      while (totalBytes > maxBytes && frames.length > 1) {
        const evicted = frames.shift();
        if (evicted === undefined) break;
        totalBytes -= evicted.bytes.byteLength;
        log.debug("journal.evicted", {
          seq: evicted.seq,
          kind: evicted.kind,
          bytes: evicted.bytes.byteLength,
          totalBytes,
          frameCount: frames.length,
        });
      }
    }

    function allocateText(build: (seq: number) => string): AllocatedText {
      seqCounter += 1;
      const seq = seqCounter;
      const text = build(seq);
      retain({ seq, bytes: TEXT_ENCODER.encode(text), kind: "text" });
      return { seq, text };
    }

    function allocateBinary(build: (seq: number) => Uint8Array): AllocatedBinary {
      seqCounter += 1;
      const seq = seqCounter;
      const bytes = build(seq);
      retain({ seq, bytes, kind: "binary" });
      return { seq, bytes };
    }

    function oldestSeq(): number {
      return frames[0]?.seq ?? seqCounter + 1;
    }

    function since(lastSeq: number): readonly JournaledFrame[] | null {
      if (lastSeq === 0) return frames.slice();

      if (lastSeq > seqCounter) {
        log.warn("journal.gap.beyond-head", {
          lastSeq,
          newestSeq: seqCounter,
          reason: "client claims a seq this journal never issued",
        });
        return null;
      }

      const oldest = oldestSeq();
      if (lastSeq < oldest - 1) {
        log.warn("journal.gap.evicted", {
          lastSeq,
          oldestSeq: oldest,
          newestSeq: seqCounter,
          reason: "the frame after the client's cursor was evicted by the byte cap",
        });
        return null;
      }

      return frames.filter((f) => f.seq > lastSeq);
    }

    return {
      allocateText,
      allocateBinary,
      since,
      get oldestSeq() {
        return oldestSeq();
      },
      get newestSeq() {
        return seqCounter;
      },
      get byteLength() {
        return totalBytes;
      },
      get frameCount() {
        return frames.length;
      },
    };
  }
  ```

- [ ] **Step 5: Run the journal test to green.**

  ```bash
  cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway/src && bun test session-handlers/frame-journal.test.ts
  ```

  Expected: 12 pass, 0 fail.

- [ ] **Step 6: Commit the journal.**

  ```bash
  cd /Users/kevinye/Development/sentient
  git add gateway/src/session-handlers/frame-journal.ts gateway/src/session-handlers/frame-journal.test.ts
  git commit -m "feat(gateway): add FrameJournal — per-surface seq ring with byte-cap eviction and gap detection"
  ```

---

#### Part B — the replay registry + config (commit 2)

- [ ] **Step 7: Add the two config keys to the zod schema.**

  In `shared/config/src/schema.ts`, replace `sessionConfigSchema` (lines 13–20):

  ```ts
  export const sessionConfigSchema = z.object({
    // Bun WS idle close timeout in ms; gateway converts to seconds at boot.
    // Bun's idleTimeout cap is 255 s → max effective value 255000 ms.
    ws_idle_timeout_ms: z.number().int().min(1000).max(255000),
    // Per-user concurrent WS session cap. Bounds memory under churn (one user /
    // reconnect-loop). Range 1–100.
    per_user_max_sessions: z.number().int().min(1).max(100),
    // Reconnect gap-fill (spec §11 slice 6). Per-surface cap on the outbound
    // frame journal that lets a reconnecting client replay what it missed.
    // Oldest frames evict first; the newest frame is never evicted. Range
    // 65536–268435456 (64 KB–256 MB).
    // `.default()` (unlike this block's two older keys) so an operator's
    // existing config.yaml keeps booting without an operator-config-migrator
    // schema_version bump.
    replay_journal_max_bytes: z.number().int().min(65536).max(268435456).default(16777216),
    // How long a DETACHED surface journal is kept for a reconnect before it is
    // dropped. Past this, a resuming client gets stream.resumed{recovered:false}
    // and REST-refetches its history. Range 1000–3600000 (1 s–1 h).
    replay_journal_retention_ms: z.number().int().min(1000).max(3600000).default(300000),
  });
  ```

- [ ] **Step 8: Add the same two keys to `gateway/config.yaml`.**

  In the `session:` block (lines 64–67), after `per_user_max_sessions`:

  ```yaml
    # --- Reconnect gap-fill (spec §11 slice 6) ---
    # Every gateway → client frame is stamped with a monotonic seq inside an
    # epoch and journaled per surface, so a client that reconnects with
    # `resume: {epoch, lastSeq}` in session.configure gets the frames it
    # missed replayed instead of a silently truncated conversation.
    replay_journal_max_bytes: 16777216    # 16 MB per surface. Range 65536–268435456 (64 KB–256 MB). Evict-oldest; the newest frame is never evicted.
    replay_journal_retention_ms: 300000   # 5 min. Range 1000–3600000. Retention for a DETACHED surface journal; past this a resuming client gets recovered:false and REST-refetches.
  ```

- [ ] **Step 9: Verify the config change parses everywhere it is asserted.**

  ```bash
  cd /Users/kevinye/Development/sentient && source scripts/env.sh
  bun run --filter '@sentient/config' test
  cd gateway/src && bun test config/gateway-config.test.ts config/operator-config-migrator.test.ts
  ```

  Expected: all pass, **unchanged**. Both new keys carry a `.default()`, so `schema.test.ts`'s `wsResilienceSession` / `validSession` fixtures and `gateway-config.test.ts`'s inline YAML strings stay valid without edits. If either suite fails, the `.default()` is missing — fix that rather than editing the fixtures.

- [ ] **Step 10: Implement the replay registry.**

  Create `gateway/src/session-handlers/replay-registry.ts`:

  ```ts
  // ReplayRegistry — the per-surface home for a FrameJournal that must OUTLIVE
  // the socket that filled it (spec §11 slice 6).
  //
  // Successor to the deleted person-session/device-buffer-store.ts, stripped to
  // the two fields 2.0 actually needs. The old store also carried a shared
  // mutable live-socket ref (so a stale in-flight ACP cycle could follow a
  // resumed surface to its new socket), a deferredTeardown callback, an
  // ActivityClock, and a forceClose hook. NONE of that transfers:
  // SessionRuntime.dispose() is immediate and idempotent, so there is no
  // orphaned pipeline to hand over and no in-flight turn that survives the
  // disconnect. What survives here is bytes, and only bytes.
  //
  // Keying: `${userId}::${surfaceId}` (surfaceId falls back to deviceId — see
  // sessionConfigureSchema.surfaceId's own contract note). Same identity
  // SessionRuntime uses, so two browser tabs of one user are two surfaces with
  // independent journals and epochs.
  //
  // Epoch: a registry-global monotonic counter, incremented every time a FRESH
  // journal is minted for any surface. Never reused, so a client holding a
  // stale epoch can never accidentally match a recreated entry.
  //
  // Retention: swept lazily inside acquire() and release() rather than on a
  // timer. release() runs on every disconnect, so the sweep does too — growth
  // is bounded without introducing a second lifecycle to reason about.

  import { getLog } from "../logging/logger.js";
  import { type FrameJournal, createFrameJournal } from "./frame-journal.js";

  const log = getLog(["sentient", "ws", "replay-registry"]);

  export interface ReplayAcquisition {
    readonly journal: FrameJournal;
    readonly epoch: number;
    /** True iff an existing journal was reused because `resumeEpoch` matched
     *  its epoch. False means a fresh journal + a fresh epoch, and the caller
     *  must answer any resume request with `recovered: false`. */
    readonly resumed: boolean;
  }

  export interface ReplayRegistry {
    acquire(surfaceKey: string, resumeEpoch: number | undefined): ReplayAcquisition;
    /** Mark the surface detached and start its retention clock. */
    release(surfaceKey: string): void;
    /** Drop the surface outright — explicit session.end, where the client is
     *  not coming back and retaining its bytes is pure waste. */
    discard(surfaceKey: string): void;
    readonly size: number;
  }

  export interface ReplayRegistryOptions {
    maxBytesPerSurface: number;
    retentionMs: number;
    /** Injectable clock — the retention sweep is an FSM worth testing without
     *  wall-clock sleeps. Defaults to Date.now. */
    now?: () => number;
  }

  interface RegistryEntry {
    journal: FrameJournal;
    epoch: number;
    /** null while a socket is attached; the detach timestamp once released. */
    detachedAtMs: number | null;
  }

  export function createReplayRegistry(options: ReplayRegistryOptions): ReplayRegistry {
    const { maxBytesPerSurface, retentionMs } = options;
    const now = options.now ?? (() => Date.now());

    const entries = new Map<string, RegistryEntry>();
    let epochCounter = 0;

    function sweep(): void {
      const nowMs = now();
      for (const [key, entry] of entries) {
        if (entry.detachedAtMs === null) continue;
        const detachedForMs = nowMs - entry.detachedAtMs;
        if (detachedForMs < retentionMs) continue;
        entries.delete(key);
        log.info("replay-registry.swept", {
          surfaceKey: key,
          epoch: entry.epoch,
          detachedForMs,
          retentionMs,
          reason: "detached past the retention window",
        });
      }
    }

    function mintFresh(surfaceKey: string, reason: string, priorEpoch: number | null): ReplayAcquisition {
      epochCounter += 1;
      const entry: RegistryEntry = {
        journal: createFrameJournal({ maxBytes: maxBytesPerSurface }),
        epoch: epochCounter,
        detachedAtMs: null,
      };
      entries.set(surfaceKey, entry);
      log.info("replay-registry.fresh", { surfaceKey, epoch: entry.epoch, priorEpoch, reason });
      return { journal: entry.journal, epoch: entry.epoch, resumed: false };
    }

    return {
      acquire(surfaceKey: string, resumeEpoch: number | undefined): ReplayAcquisition {
        sweep();

        const existing = entries.get(surfaceKey);
        if (existing === undefined) {
          return mintFresh(surfaceKey, resumeEpoch === undefined ? "fresh-connect" : "no-prior-journal", null);
        }
        if (resumeEpoch === undefined) {
          return mintFresh(surfaceKey, "no-resume-requested", existing.epoch);
        }
        if (resumeEpoch !== existing.epoch) {
          return mintFresh(surfaceKey, "epoch-mismatch", existing.epoch);
        }

        existing.detachedAtMs = null;
        log.info("replay-registry.resumed", {
          surfaceKey,
          epoch: existing.epoch,
          oldestSeq: existing.journal.oldestSeq,
          newestSeq: existing.journal.newestSeq,
          journalBytes: existing.journal.byteLength,
        });
        return { journal: existing.journal, epoch: existing.epoch, resumed: true };
      },

      release(surfaceKey: string): void {
        const entry = entries.get(surfaceKey);
        if (entry === undefined) {
          // debug, not warn: an explicit session.end discards the entry before
          // cleanupSession runs, so a missing entry here is a normal path.
          log.debug("replay-registry.release.not-found", { surfaceKey });
          return;
        }
        entry.detachedAtMs = now();
        log.info("replay-registry.released", {
          surfaceKey,
          epoch: entry.epoch,
          newestSeq: entry.journal.newestSeq,
          journalBytes: entry.journal.byteLength,
          retentionMs,
        });
        sweep();
      },

      discard(surfaceKey: string): void {
        const entry = entries.get(surfaceKey);
        if (entry === undefined) {
          log.debug("replay-registry.discard.not-found", { surfaceKey });
          return;
        }
        entries.delete(surfaceKey);
        log.info("replay-registry.discarded", { surfaceKey, epoch: entry.epoch, reason: "explicit session.end" });
      },

      get size() {
        return entries.size;
      },
    };
  }
  ```

- [ ] **Step 11: Expose the registry on `GatewayServices`.**

  In `gateway/src/bootstrap/create-gateway-services.ts`:

  (a) add the import next to the other `session-handlers` import (`GatewayTlsMaterial`, line 37):

  ```ts
  import { type ReplayRegistry, createReplayRegistry } from "../session-handlers/replay-registry.js";
  ```

  (b) add the field to the `GatewayServices` interface, immediately after `readonly session: SessionConfig;` (line 99):

  ```ts
    /** Per-surface outbound frame journals, keyed `${userId}::${surfaceId}`
     *  (Plan 3 Task 10, spec §11 slice 6). Deliberately NOT per-connection:
     *  the journal must survive the socket that filled it so a reconnecting
     *  client can replay the frames it missed. Built here rather than in a
     *  phase because it depends on nothing but `cfg.session`. */
    readonly replayRegistry: ReplayRegistry;
  ```

  (c) in the returned object literal, right after `session: cfg.session,` (line 220):

  ```ts
      replayRegistry: createReplayRegistry({
        maxBytesPerSurface: cfg.session.replay_journal_max_bytes,
        retentionMs: cfg.session.replay_journal_retention_ms,
      }),
  ```

- [ ] **Step 12: Typecheck and commit.**

  ```bash
  cd /Users/kevinye/Development/sentient && source scripts/env.sh
  bun run --filter '@sentient/config' typecheck && bun run --filter '@sentient/gateway' typecheck
  ```

  Expected: clean.

  ```bash
  git add shared/config/src/schema.ts gateway/config.yaml \
          gateway/src/session-handlers/replay-registry.ts \
          gateway/src/bootstrap/create-gateway-services.ts
  git commit -m "feat(gateway): add ReplayRegistry + session.replay_journal_* config for per-surface frame journals"
  ```

---

#### Part C — seq/epoch stamping on the send path (commit 3)

- [ ] **Step 13: Add the failing shared-seq-space test.**

  Append to `gateway/src/session-handlers/ws-turn-emitter.test.ts` (keep every existing block — Task 1's frame-shape assertions still hold, because `createEmptySessionData()` leaves `journal` null and unstamped frames are exactly what those cases assert):

  ```ts
  // ---------------------------------------------------------------------------
  // Plan 3 Task 10 — seq/epoch stamping.
  //
  // Wire-contract regression. Both client SDKs run ONE resume cursor
  // (shared/web-sdk/src/resume-cursor.ts, shared/mobile-sdk/.../ResumeCursor.kt)
  // and feed it from BOTH the JSON path and the binary path. If the gateway
  // ever draws JSON seqs and audio-header seqs from two counters, the client
  // silently drops roughly half the stream as "already applied". This pins the
  // single-seq-space invariant at the only place it can be violated.
  // ---------------------------------------------------------------------------

  import { createFrameJournal } from "./frame-journal.js";

  const BINARY_HEADER_BYTES = 9;

  interface SequencedFakeWs {
    data: SessionData;
    sentText: Record<string, unknown>[];
    sentBinary: Uint8Array[];
    send: (payload: string | Uint8Array) => void;
  }

  function sequencedFakeWs(epoch = 7): SequencedFakeWs {
    const data = createEmptySessionData();
    data.sessionId = "test-session";
    data.journal = createFrameJournal({ maxBytes: 1_000_000 });
    data.epoch = epoch;
    const ws: SequencedFakeWs = {
      data,
      sentText: [],
      sentBinary: [],
      send(payload) {
        if (typeof payload === "string") ws.sentText.push(JSON.parse(payload));
        else ws.sentBinary.push(payload);
      },
    };
    return ws;
  }

  function headerSeq(frame: Uint8Array): number {
    return Number(new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getBigUint64(0, false));
  }

  describe("createWsTurnEmitter — seq/epoch stamping (Task 10)", () => {
    it("stamps every JSON frame with a monotonic seq and the connection epoch", () => {
      const ws = sequencedFakeWs(7);
      const emitter = createWsTurnEmitter(ws as unknown as ServerWebSocket<SessionData>);

      emitter.turnStarted("turn-1", "user");
      emitter.textDelta("turn-1", "hi");
      emitter.turnCompleted("turn-1");

      expect(ws.sentText.map((f) => f.seq)).toEqual([1, 2, 3]);
      expect(ws.sentText.map((f) => f.epoch)).toEqual([7, 7, 7]);
    });

    it("draws JSON and binary audio seqs from ONE monotonic space", () => {
      const ws = sequencedFakeWs();
      const emitter = createWsTurnEmitter(ws as unknown as ServerWebSocket<SessionData>);

      emitter.audioStart("turn-1", "opus", 48000);      // seq 1 (JSON)
      emitter.audioFrame("turn-1", new Uint8Array([1])); // seq 2 (binary)
      emitter.audioFrame("turn-1", new Uint8Array([2])); // seq 3 (binary)
      emitter.audioDone("turn-1");                       // seq 4 (JSON)

      expect(ws.sentText.map((f) => f.seq)).toEqual([1, 4]);
      expect(ws.sentBinary.map(headerSeq)).toEqual([2, 3]);
      expect(ws.sentBinary[0]?.byteLength).toBe(BINARY_HEADER_BYTES + 1);
    });

    it("journals every frame it sends so a later resume can replay them verbatim", () => {
      const ws = sequencedFakeWs();
      const emitter = createWsTurnEmitter(ws as unknown as ServerWebSocket<SessionData>);

      emitter.turnStarted("turn-1", "user");
      emitter.audioFrame("turn-1", new Uint8Array([9]));

      const replayed = ws.data.journal?.since(0) ?? [];
      expect(replayed.map((f) => f.seq)).toEqual([1, 2]);
      expect(replayed.map((f) => f.kind)).toEqual(["text", "binary"]);
      expect(JSON.parse(new TextDecoder().decode(replayed[0]?.bytes ?? new Uint8Array()))).toEqual(
        ws.sentText[0] as Record<string, unknown>,
      );
    });

    it("sends unstamped and unjournaled when the connection has no journal yet", () => {
      const ws = sequencedFakeWs();
      ws.data.journal = null;
      ws.data.epoch = 0;
      const emitter = createWsTurnEmitter(ws as unknown as ServerWebSocket<SessionData>);

      emitter.turnStarted("turn-1", "user");

      expect(ws.sentText[0]?.seq).toBeUndefined();
      expect(ws.sentText[0]?.epoch).toBeUndefined();
    });
  });
  ```

  > The pre-existing `fakeWs()` in this file declares `send: (s: string) => void`. Leave it alone — the new `sequencedFakeWs` is a separate double because it must accept binary too.

- [ ] **Step 14: Run it — expect failure.**

  ```bash
  cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway/src && bun test session-handlers/ws-turn-emitter.test.ts
  ```

  Expected: the new block fails to typecheck/run — `SessionData` has no `journal` / `epoch` property, and `emitter.audioFrame` still writes through a local counter. Task 1's original cases still pass.

- [ ] **Step 15: Add the journal fields to `SessionData`.**

  In `gateway/src/session-handlers/ws-helpers.ts`, add the import:

  ```ts
  import type { FrameJournal } from "./frame-journal.js";
  ```

  and three fields to the `SessionData` interface, after `runtime` / `permissions`:

  ```ts
    /**
     * This connection's outbound frame journal (Plan 3 Task 10, spec §11
     * slice 6). Acquired from `services.replayRegistry` in
     * `handleSessionConfigure`, so it is null for every frame sent before
     * then (auth.ok, auth-gate errors) — those go out unstamped and
     * unjournaled, which is correct: the client has no cursor yet either.
     * The OBJECT is owned by the registry, not by this connection — a
     * resumed surface gets the same journal back and its seq counter simply
     * continues, which is what makes replay contiguous across the socket
     * boundary.
     */
    journal: FrameJournal | null;
    /**
     * Sequencing epoch for `journal`. Stamped on every outbound JSON frame so
     * the client can tell a genuine seq gap from a stream restart. 0 until
     * session.configure. Registry-global and never reused.
     */
    epoch: number;
    /**
     * `${userId}::${surfaceId}` — the registry key for `journal`. Held here so
     * `cleanupSession` can release the journal into its retention window
     * without re-deriving the key from a principal that may already be gone.
     * null until session.configure.
     */
    replayKey: string | null;
  ```

  and in `createEmptySessionData()`:

  ```ts
      journal: null,
      epoch: 0,
      replayKey: null,
  ```

- [ ] **Step 16: Rewrite `ws-send.ts` to stamp and journal.**

  Replace `gateway/src/session-handlers/ws-send.ts` entirely:

  ```ts
  // Outbound frame writer for the client WebSocket.
  //
  // Every gateway → client JSON frame goes through `sendGatewayFrame`, which
  // parses it against `gatewayMessageSchema` BEFORE it hits the socket. Parsing
  // here also strips any stray key an object spread picked up, so the bytes on
  // the wire are exactly the contract and nothing else.
  //
  // A validation failure LOGS AT ERROR AND DROPS THE FRAME. It never throws:
  // these calls run inside a detached turn promise chain (session-runtime.ts
  // never awaits `runTurn`), and a throw there would wedge the turn rather than
  // lose one frame.
  //
  // Plan 3 Task 10 adds sequencing on top, without touching a single call site:
  //
  //   - `sendGatewayFrame` stamps `seq` (monotonic, from this connection's
  //     FrameJournal) + `epoch` and journals the wire bytes, so a reconnecting
  //     client can be handed back exactly what it missed.
  //   - `sendAudioFrame` draws its 9-byte-header seq from the SAME journal.
  //     One seq space for JSON and binary, because both client SDKs feed one
  //     resume cursor from both paths.
  //   - `sendUnsequencedFrame` is the deliberate escape hatch used ONLY by the
  //     resume handshake (ws-resume.ts): still validated, but neither stamped
  //     nor journaled. A seq-stamped `session.ready` on the recovered path
  //     would advance the client's cursor past the replay window and it would
  //     drop every replayed frame; `stream.resumed` is a handshake ack, not
  //     replayable content.
  //
  // ORDER MATTERS: validate FIRST, stamp SECOND. Stamping before validation
  // would let a rejected frame consume a seq and tear a permanent hole in the
  // journal's contiguity.

  import { type GatewayMessage, gatewayMessageSchema } from "@sentient/protocol";
  import type { ServerWebSocket } from "bun";
  import { getLog } from "../logging/logger.js";
  import type { SessionData } from "./ws-helpers.js";

  const log = getLog(["sentient", "ws", "send"]);

  const BINARY_HEADER_BYTES = 9;
  const BINARY_TYPE_AUDIO = 0x01;
  const REASON_PREVIEW_LEN = 120;
  /** Header seq for an audio frame written before a journal exists. Both SDKs
   *  treat seq 0 as "unsequenced" and pass it through without dedup, so the
   *  audio still plays — it just cannot be replayed. Should be unreachable:
   *  session.configure mints the journal before any emitter can run. */
  const UNSEQUENCED = 0;

  function writeText(ws: ServerWebSocket<SessionData>, text: string, frameType: string): boolean {
    try {
      ws.send(text);
      return true;
    } catch (err) {
      // Bun's `ws.send` on a closed socket does not throw, but a frame can
      // still be in flight after session.end / a network drop; guard anyway per
      // the error-handling rule and log the degraded path with a reason.
      log.warn("ws-send.send-failed", {
        sessionId: ws.data.sessionId,
        frameType,
        reason: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  function validate(ws: ServerWebSocket<SessionData>, frame: GatewayMessage): GatewayMessage | null {
    const parsed = gatewayMessageSchema.safeParse(frame);
    if (parsed.success) return parsed.data;
    log.error("ws-send.invalid-frame", {
      sessionId: ws.data.sessionId,
      frameType: frame.type,
      reason: parsed.error.message.slice(0, REASON_PREVIEW_LEN),
    });
    return null;
  }

  /**
   * Validate, stamp with this connection's `seq`/`epoch`, journal the wire
   * bytes, and write. Falls back to an unstamped, unjournaled write when the
   * connection has no journal yet (every frame before session.configure).
   *
   * @returns true if the frame reached the socket.
   */
  export function sendGatewayFrame(ws: ServerWebSocket<SessionData>, frame: GatewayMessage): boolean {
    const validated = validate(ws, frame);
    if (validated === null) return false;

    const journal = ws.data.journal;
    if (journal === null) return writeText(ws, JSON.stringify(validated), frame.type);

    const epoch = ws.data.epoch;
    const allocated = journal.allocateText((seq) => JSON.stringify({ ...validated, seq, epoch }));
    log.debug("ws-send.sequenced", {
      sessionId: ws.data.sessionId,
      frameType: frame.type,
      seq: allocated.seq,
      epoch,
      journalBytes: journal.byteLength,
    });
    return writeText(ws, allocated.text, frame.type);
  }

  /**
   * Validate and write WITHOUT a seq stamp and WITHOUT journaling. Resume
   * handshake only (ws-resume.ts) — see this file's header for why.
   *
   * @returns true if the frame reached the socket.
   */
  export function sendUnsequencedFrame(ws: ServerWebSocket<SessionData>, frame: GatewayMessage): boolean {
    const validated = validate(ws, frame);
    if (validated === null) return false;
    return writeText(ws, JSON.stringify(validated), frame.type);
  }

  /**
   * Prepends the 9-byte binary header the client SDKs peel:
   *   [8-byte BE u64 seq][1-byte type = 0x01 audio][payload]
   * Clients dedupe by `seq` and treat `seq === 0` as unsequenced, so real
   * frames start at 1.
   */
  export function encodeAudioFrame(seq: number, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(BINARY_HEADER_BYTES + payload.byteLength);
    const view = new DataView(out.buffer);
    view.setBigUint64(0, BigInt(seq), false);
    view.setUint8(8, BINARY_TYPE_AUDIO);
    out.set(payload, BINARY_HEADER_BYTES);
    return out;
  }

  /**
   * Allocate the next seq from this connection's journal, frame the audio
   * payload with it, journal the framed bytes, and write.
   *
   * SIGNATURE CHANGED in Task 10: the caller no longer supplies `seq`. The
   * emitter's own counter is gone precisely so JSON and binary cannot drift
   * into two seq spaces.
   *
   * @returns the allocated seq, or 0 when the frame was written unsequenced
   *          (no journal) or failed to reach the socket.
   */
  export function sendAudioFrame(ws: ServerWebSocket<SessionData>, payload: Uint8Array): number {
    const journal = ws.data.journal;

    if (journal === null) {
      log.warn("ws-send.audio-unsequenced", {
        sessionId: ws.data.sessionId,
        payloadBytes: payload.byteLength,
        reason: "no frame journal on this connection — audio before session.configure",
      });
      writeBinary(ws, encodeAudioFrame(UNSEQUENCED, payload), UNSEQUENCED);
      return UNSEQUENCED;
    }

    const allocated = journal.allocateBinary((seq) => encodeAudioFrame(seq, payload));
    return writeBinary(ws, allocated.bytes, allocated.seq) ? allocated.seq : 0;
  }

  function writeBinary(ws: ServerWebSocket<SessionData>, framed: Uint8Array, seq: number): boolean {
    try {
      ws.send(framed);
      return true;
    } catch (err) {
      log.warn("ws-send.audio-send-failed", {
        sessionId: ws.data.sessionId,
        seq,
        frameBytes: framed.byteLength,
        reason: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
  ```

- [ ] **Step 17: Delete the emitter's local audio counter.**

  In `gateway/src/session-handlers/ws-turn-emitter.ts`:

  (a) delete the `audioSeq` declaration and its comment block (Task 1 wrote it as):

  ```ts
    // Per-connection monotonic binary-frame counter. Clients dedupe audio by
    // this seq and ignore seq 0, so the first frame is 1. JSON frames stay
    // unsequenced until Task 10 restores the replay journal.
    let audioSeq = 0;
  ```

  replacing it with a plain counter used only for logging:

  ```ts
    // Frames emitted this connection — LOG ONLY. The wire seq now comes from
    // `ws.data.journal` inside `sendAudioFrame` (ws-send.ts) so JSON and
    // binary share one monotonic space, which is what both client resume
    // cursors assume.
    let audioFramesSent = 0;
  ```

  (b) replace the `audioFrame` method:

  ```ts
      audioFrame(turnId: string, bytes: Uint8Array) {
        const seq = sendAudioFrame(ws, bytes);
        audioFramesSent += 1;
        log.debug("turn-emitter.audio-frame", { sessionId, turnId, seq, payloadBytes: bytes.byteLength });
      },
  ```

  (c) replace the `framesSent` read in `audioDone`:

  ```ts
      audioDone(turnId: string) {
        log.info("turn-emitter.audio-done", { sessionId, turnId, framesSent: audioFramesSent });
        send({ type: "turn.audio.done", turnId });
      },
  ```

  > If Task 2 (voice) reshaped `audioFrame`/`audioDone` around a per-turn counter or added an encoding field, keep its shape and change only the seq source. The invariant that must survive: **no seq counter lives in this file.**

- [ ] **Step 18: Run the emitter test to green.**

  ```bash
  cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway/src && bun test session-handlers/ws-turn-emitter.test.ts
  ```

  Expected: every Task 1 case plus all four Task 10 cases pass.

- [ ] **Step 19: Typecheck and commit the send path.**

  ```bash
  cd /Users/kevinye/Development/sentient && source scripts/env.sh && bun run --filter '@sentient/gateway' typecheck
  git add gateway/src/session-handlers/ws-send.ts \
          gateway/src/session-handlers/ws-turn-emitter.ts \
          gateway/src/session-handlers/ws-turn-emitter.test.ts \
          gateway/src/session-handlers/ws-helpers.ts
  git commit -m "feat(gateway): stamp seq/epoch on every outbound frame and journal it for replay"
  ```

---

#### Part D — the resume handshake (commit 4)

- [ ] **Step 20: Write the failing resume-contract test.**

  Create `gateway/src/session-handlers/ws-resume.test.ts`:

  ```ts
  // Reconnect gap-fill contract (Plan 3 Task 10, spec §11 slice 6).
  //
  // Two things are pinned here and nothing else:
  //
  //  1. THE WIRE CONTRACT at the gateway↔SDK boundary — the exact
  //     `stream.resumed` payloads, and the FRAME ORDER around them. The order
  //     is load-bearing client FSM behaviour, not style: both SDKs ungate
  //     their connect handshake only on `session.ready`, and their resume
  //     cursor advances `lastSeq` on ANY seq-stamped frame. A seq-stamped
  //     `session.ready` on the recovered path would jump the cursor past the
  //     replay window and the client would drop every replayed frame as a
  //     duplicate. Recovered path: raw ready → resumed ack → verbatim replay.
  //     Non-recovered path: resumed ack → stamped ready.
  //
  //  2. THE REGISTRY FSM — epoch mismatch forces a fresh stream, and a
  //     detached journal is reclaimed once its retention window expires.
  //
  // Zero cost: FakeWs doubles, an injected clock, no provider/network I/O.

  import { describe, expect, it } from "bun:test";
  import type { GatewayMessage } from "@sentient/protocol";
  import type { ServerWebSocket } from "bun";
  import { createFrameJournal } from "./frame-journal.js";
  import { createReplayRegistry } from "./replay-registry.js";
  import { type SessionData, createEmptySessionData } from "./ws-helpers.js";
  import { handleResumeOrFresh } from "./ws-resume.js";
  import { sendGatewayFrame } from "./ws-send.js";

  const decoder = new TextDecoder();

  interface FakeWs {
    data: SessionData;
    sent: (Record<string, unknown> | Uint8Array)[];
    send: (payload: string | Uint8Array) => void;
  }

  function fakeWs(): FakeWs {
    const data = createEmptySessionData();
    data.sessionId = "test-session";
    const ws: FakeWs = {
      data,
      sent: [],
      send(payload) {
        if (typeof payload === "string") ws.sent.push(JSON.parse(payload) as Record<string, unknown>);
        else ws.sent.push(payload);
      },
    };
    return ws;
  }

  function asWs(ws: FakeWs): ServerWebSocket<SessionData> {
    return ws as unknown as ServerWebSocket<SessionData>;
  }

  const readyFrame: GatewayMessage = {
    type: "session.ready",
    sessionId: "test-session",
    audioEncoding: "pcm16",
    inputSampleRate: 16000,
    outputSampleRate: 48000,
    enabledEffects: [],
  };

  /** A journal already holding three text frames, as if a prior socket filled it. */
  function filledJournal() {
    const journal = createFrameJournal({ maxBytes: 1_000_000 });
    for (const body of ["one", "two", "three"]) {
      journal.allocateText((seq) => JSON.stringify({ type: "turn.text.delta", turnId: "t", text: body, seq, epoch: 3 }));
    }
    return journal;
  }

  const jsonFrames = (ws: FakeWs) => ws.sent.filter((f): f is Record<string, unknown> => !(f instanceof Uint8Array));

  describe("handleResumeOrFresh — recovered replay", () => {
    it("emits raw session.ready, then stream.resumed, then the missed frames verbatim", () => {
      const ws = fakeWs();
      const journal = filledJournal();
      ws.data.journal = journal;
      ws.data.epoch = 3;

      const readySent = handleResumeOrFresh({
        ws: asWs(ws),
        sessionId: "test-session",
        surfaceKey: "u_deadbeef::surface-a",
        journal,
        epoch: 3,
        resumed: true,
        resumeParams: { epoch: 3, lastSeq: 1 },
        readyFrame,
      });

      expect(readySent).toBe(true);
      const frames = jsonFrames(ws);
      expect(frames.map((f) => f.type)).toEqual([
        "session.ready",
        "stream.resumed",
        "turn.text.delta",
        "turn.text.delta",
      ]);
      // The raw ready must NOT carry a seq — it would advance the client cursor
      // past the replay window.
      expect(frames[0]?.seq).toBeUndefined();
      expect(frames[1]).toEqual({ type: "stream.resumed", recovered: true, epoch: 3, fromSeq: 2, toSeq: 3 });
      // Replayed frames keep their ORIGINAL seqs — never re-stamped.
      expect(frames.slice(2).map((f) => f.seq)).toEqual([2, 3]);
    });

    it("acks recovered:true with an empty range when the client is already at the head", () => {
      const ws = fakeWs();
      const journal = filledJournal();
      ws.data.journal = journal;
      ws.data.epoch = 3;

      handleResumeOrFresh({
        ws: asWs(ws),
        sessionId: "test-session",
        surfaceKey: "u_deadbeef::surface-a",
        journal,
        epoch: 3,
        resumed: true,
        resumeParams: { epoch: 3, lastSeq: 3 },
        readyFrame,
      });

      const frames = jsonFrames(ws);
      expect(frames.map((f) => f.type)).toEqual(["session.ready", "stream.resumed"]);
      expect(frames[1]).toEqual({ type: "stream.resumed", recovered: true, epoch: 3, fromSeq: 4, toSeq: 3 });
    });

    it("continues the SAME seq space after the replay, so the client never sees a gap", () => {
      const ws = fakeWs();
      const journal = filledJournal();
      ws.data.journal = journal;
      ws.data.epoch = 3;

      handleResumeOrFresh({
        ws: asWs(ws),
        sessionId: "test-session",
        surfaceKey: "u_deadbeef::surface-a",
        journal,
        epoch: 3,
        resumed: true,
        resumeParams: { epoch: 3, lastSeq: 3 },
        readyFrame,
      });
      sendGatewayFrame(asWs(ws), { type: "turn.completed", turnId: "t" });

      const last = jsonFrames(ws).at(-1);
      expect(last).toEqual({ type: "turn.completed", turnId: "t", seq: 4, epoch: 3 });
    });
  });

  describe("handleResumeOrFresh — fallbacks", () => {
    it("sends stream.resumed{recovered:false} and defers session.ready on an epoch mismatch", () => {
      const ws = fakeWs();
      const journal = createFrameJournal({ maxBytes: 1_000_000 });
      ws.data.journal = journal;
      ws.data.epoch = 9;

      const readySent = handleResumeOrFresh({
        ws: asWs(ws),
        sessionId: "test-session",
        surfaceKey: "u_deadbeef::surface-a",
        journal,
        epoch: 9,
        resumed: false,
        resumeParams: { epoch: 3, lastSeq: 12 },
        readyFrame,
      });

      expect(readySent).toBe(false);
      expect(jsonFrames(ws)).toEqual([{ type: "stream.resumed", recovered: false, epoch: 9 }]);
    });

    it("falls back to recovered:false when the client's cursor was evicted", () => {
      const ws = fakeWs();
      const journal = createFrameJournal({ maxBytes: 25 });
      for (let i = 0; i < 5; i++) journal.allocateBinary(() => new Uint8Array(10));
      ws.data.journal = journal;
      ws.data.epoch = 3;

      const readySent = handleResumeOrFresh({
        ws: asWs(ws),
        sessionId: "test-session",
        surfaceKey: "u_deadbeef::surface-a",
        journal,
        epoch: 3,
        resumed: true,
        resumeParams: { epoch: 3, lastSeq: 1 },
        readyFrame,
      });

      expect(readySent).toBe(false);
      expect(jsonFrames(ws)).toEqual([{ type: "stream.resumed", recovered: false, epoch: 3 }]);
    });

    it("sends no stream.resumed at all on a fresh connect that asked for nothing", () => {
      const ws = fakeWs();
      const journal = createFrameJournal({ maxBytes: 1_000_000 });
      ws.data.journal = journal;
      ws.data.epoch = 1;

      const readySent = handleResumeOrFresh({
        ws: asWs(ws),
        sessionId: "test-session",
        surfaceKey: "u_deadbeef::surface-a",
        journal,
        epoch: 1,
        resumed: false,
        resumeParams: undefined,
        readyFrame,
      });

      expect(readySent).toBe(false);
      expect(ws.sent).toEqual([]);
    });
  });

  describe("ReplayRegistry — epoch + retention FSM", () => {
    it("returns the same journal and epoch when the resume epoch matches", () => {
      const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
      const first = registry.acquire("u_deadbeef::surface-a", undefined);
      first.journal.allocateText(() => "x");
      registry.release("u_deadbeef::surface-a");

      const second = registry.acquire("u_deadbeef::surface-a", first.epoch);

      expect(second.resumed).toBe(true);
      expect(second.epoch).toBe(first.epoch);
      expect(second.journal.newestSeq).toBe(1);
    });

    it("mints a fresh journal and a NEW epoch when the resume epoch does not match", () => {
      const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
      const first = registry.acquire("u_deadbeef::surface-a", undefined);
      first.journal.allocateText(() => "x");
      registry.release("u_deadbeef::surface-a");

      const second = registry.acquire("u_deadbeef::surface-a", first.epoch + 99);

      expect(second.resumed).toBe(false);
      expect(second.epoch).not.toBe(first.epoch);
      expect(second.journal.newestSeq).toBe(0);
    });

    it("keeps surfaces of the same user isolated from each other", () => {
      const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
      const tabA = registry.acquire("u_deadbeef::surface-a", undefined);
      const tabB = registry.acquire("u_deadbeef::surface-b", undefined);

      expect(tabA.epoch).not.toBe(tabB.epoch);
      tabA.journal.allocateText(() => "x");
      expect(tabB.journal.newestSeq).toBe(0);
    });

    it("reclaims a detached journal once the retention window expires", () => {
      let clock = 1_000;
      const registry = createReplayRegistry({
        maxBytesPerSurface: 1_000_000,
        retentionMs: 60_000,
        now: () => clock,
      });
      const first = registry.acquire("u_deadbeef::surface-a", undefined);
      registry.release("u_deadbeef::surface-a");

      clock += 60_001;
      const second = registry.acquire("u_deadbeef::surface-a", first.epoch);

      expect(second.resumed).toBe(false);
      expect(registry.size).toBe(1);
    });

    it("discard drops the journal outright so a later resume cannot match it", () => {
      const registry = createReplayRegistry({ maxBytesPerSurface: 1_000_000, retentionMs: 60_000 });
      const first = registry.acquire("u_deadbeef::surface-a", undefined);
      registry.discard("u_deadbeef::surface-a");

      expect(registry.size).toBe(0);
      expect(registry.acquire("u_deadbeef::surface-a", first.epoch).resumed).toBe(false);
    });
  });

  describe("journal replay bytes", () => {
    it("replays the exact bytes that were written, not a re-serialisation", () => {
      const journal = filledJournal();
      const replayed = journal.since(0) ?? [];

      expect(replayed).toHaveLength(3);
      expect(decoder.decode(replayed[0]?.bytes ?? new Uint8Array())).toBe(
        '{"type":"turn.text.delta","turnId":"t","text":"one","seq":1,"epoch":3}',
      );
    });
  });
  ```

- [ ] **Step 21: Run it and watch it fail on the missing module.**

  ```bash
  cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway/src && bun test session-handlers/ws-resume.test.ts
  ```

  Expected: `error: Cannot find module './ws-resume.js'`.

- [ ] **Step 22: Implement the resume handshake.**

  Create `gateway/src/session-handlers/ws-resume.ts`:

  ```ts
  // Resume handshake (Plan 3 Task 10, spec §11 slice 6).
  //
  // Successor to the deleted ws-resume-handover.ts, minus everything that
  // served the ACP pipeline. The old file's `goLive()` callback existed so a
  // STALE in-flight Hermes cycle could keep streaming into the NEW socket
  // after a resumable reconnect. 2.0 has no such object: the old connection's
  // SessionRuntime was disposed the moment its socket closed
  // (ws-handlers.ts's cleanupSession → runtime.dispose(), which aborts the
  // in-flight turn's signal and closes the store handle, idempotently). So
  // this file replays what the client MISSED and nothing more — there is no
  // handover, no deferred teardown, and no socket ref to re-point.
  //
  // The frame ORDER below is load-bearing client-FSM behaviour, verified
  // against shared/web-sdk/src/{sdk-message-router,resume-cursor,
  // stream-resume-handler}.ts and the KMP equivalents:
  //
  //   recovered:true  → RAW session.ready (ungates the client's connect
  //                     handshake — its FSM has no stream.resumed case for
  //                     that gate — WITHOUT a seq, so the resume cursor does
  //                     not jump past the replay window)
  //                   → RAW stream.resumed{recovered:true, epoch, fromSeq, toSeq}
  //                   → the missed frames, VERBATIM (they already carry their
  //                     original seq / 9-byte header; re-stamping them would
  //                     break the client's dedup)
  //
  //   recovered:false → RAW stream.resumed{recovered:false, epoch}; the caller
  //                     then sends a normally-stamped session.ready. The
  //                     client resets its cursor on recovered:false and
  //                     REST-refetches history, so the stamped ready starts
  //                     the new epoch cleanly.
  //
  //   no resume asked → nothing here; the caller just sends a stamped ready.
  //
  // Everything in this file is SYNCHRONOUS. There is no await between reading
  // the replay window and returning, so no live frame can interleave into the
  // middle of the replay.

  import type { GatewayMessage, SessionConfigureResume } from "@sentient/protocol";
  import type { ServerWebSocket } from "bun";
  import { getLog } from "../logging/logger.js";
  import type { FrameJournal, JournaledFrame } from "./frame-journal.js";
  import type { SessionData } from "./ws-helpers.js";
  import { sendUnsequencedFrame } from "./ws-send.js";
  // NOTE: ws-send.ts must NOT import this file back — the dependency is
  // strictly one-way (resume → send), which is what keeps the send path free
  // of any resume-specific branching.

  const log = getLog(["sentient", "ws", "resume"]);

  const decoder = new TextDecoder();

  export interface HandleResumeInput {
    readonly ws: ServerWebSocket<SessionData>;
    readonly sessionId: string;
    /** `${userId}::${surfaceId}` — logging + correlation only. */
    readonly surfaceKey: string;
    readonly journal: FrameJournal;
    readonly epoch: number;
    /** True when the registry reused an existing journal at a matching epoch. */
    readonly resumed: boolean;
    /** The `resume` object carried inside session.configure, or undefined on a
     *  fresh connect. */
    readonly resumeParams: SessionConfigureResume | undefined;
    /** The session.ready payload. Sent RAW here on the recovered path; the
     *  caller sends it (stamped) itself on every other path. */
    readonly readyFrame: GatewayMessage;
  }

  /**
   * Terminal resume decision.
   *
   * @returns true when `session.ready` was already sent here (the recovered
   *          path) and the caller must NOT send it again; false when the caller
   *          should send its normal stamped `session.ready`.
   */
  export function handleResumeOrFresh(input: HandleResumeInput): boolean {
    const { ws, sessionId, surfaceKey, journal, epoch, resumed, resumeParams, readyFrame } = input;

    // Fresh connect: the client carried no cursor, so there is nothing to ack.
    if (resumeParams === undefined) {
      log.debug("resume.fresh-connect", { sessionId, surfaceKey, epoch });
      return false;
    }

    // The registry handed back a fresh journal — no prior entry, the retention
    // window expired, or the epoch did not match. Either way there is nothing
    // to replay, but a client that ASKED still needs the ack so it knows to
    // REST-refetch instead of assuming it is caught up.
    if (!resumed) {
      sendRecoveredFalse(ws, sessionId, surfaceKey, epoch, "fresh-journal-or-epoch-mismatch", resumeParams);
      return false;
    }

    const missed = journal.since(resumeParams.lastSeq);
    if (missed === null) {
      // The frame after the client's cursor was evicted by the byte cap, so
      // contiguous replay is impossible.
      sendRecoveredFalse(ws, sessionId, surfaceKey, epoch, "gap-evicted", resumeParams);
      return false;
    }

    sendRecoveredTrue({ ws, sessionId, surfaceKey, journal, epoch, readyFrame, lastSeq: resumeParams.lastSeq, missed });
    return true;
  }

  interface RecoveredTrueInput {
    readonly ws: ServerWebSocket<SessionData>;
    readonly sessionId: string;
    readonly surfaceKey: string;
    readonly journal: FrameJournal;
    readonly epoch: number;
    readonly readyFrame: GatewayMessage;
    readonly lastSeq: number;
    readonly missed: readonly JournaledFrame[];
  }

  function sendRecoveredTrue(input: RecoveredTrueInput): void {
    const { ws, sessionId, surfaceKey, journal, epoch, readyFrame, lastSeq, missed } = input;

    // 1. RAW session.ready — no seq, so it ungates the client's connect
    //    handshake without advancing its resume cursor past the replay window.
    sendUnsequencedFrame(ws, readyFrame);

    // 2. The ack, also raw: a handshake ack is not replayable content, so it
    //    is neither stamped nor journaled. toSeq is the journal head; it is NOT
    //    bumped by the raw ready above, which bypassed the journal entirely.
    const fromSeq = lastSeq + 1;
    const toSeq = journal.newestSeq;
    sendUnsequencedFrame(ws, { type: "stream.resumed", recovered: true, epoch, fromSeq, toSeq });

    log.info("resume.recovered", {
      sessionId,
      surfaceKey,
      epoch,
      fromSeq,
      toSeq,
      replayCount: missed.length,
      replayBytes: missed.reduce((n, f) => n + f.bytes.byteLength, 0),
    });

    // 3. The missed frames, verbatim. They already carry their original seq
    //    (JSON field / binary header) — re-stamping would break client dedup.
    for (const frame of missed) {
      writeReplayFrame(ws, frame, sessionId, surfaceKey);
    }
  }

  function sendRecoveredFalse(
    ws: ServerWebSocket<SessionData>,
    sessionId: string,
    surfaceKey: string,
    epoch: number,
    reason: string,
    resumeParams: SessionConfigureResume,
  ): void {
    sendUnsequencedFrame(ws, { type: "stream.resumed", recovered: false, epoch });
    log.info("resume.not-recovered", {
      sessionId,
      surfaceKey,
      epoch,
      requestedEpoch: resumeParams.epoch,
      requestedLastSeq: resumeParams.lastSeq,
      reason,
    });
  }

  /**
   * Write one journaled frame back onto the socket exactly as it was first
   * written. Never throws — a socket that dies mid-replay must not take
   * session.configure down with it.
   */
  function writeReplayFrame(
    ws: ServerWebSocket<SessionData>,
    frame: JournaledFrame,
    sessionId: string,
    surfaceKey: string,
  ): void {
    try {
      ws.send(frame.kind === "text" ? decoder.decode(frame.bytes) : frame.bytes);
    } catch (err) {
      log.warn("resume.replay-send-failed", {
        sessionId,
        surfaceKey,
        seq: frame.seq,
        kind: frame.kind,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  ```

- [ ] **Step 23: Wire the journal + resume decision into `session.configure`.**

  In `gateway/src/session-handlers/ws-session-configure.ts`:

  (a) extend the imports:

  ```ts
  import type { ClientType, GatewayMessage, SessionConfigureResume } from "@sentient/protocol";
  import { handleResumeOrFresh } from "./ws-resume.js";
  import { sendGatewayFrame } from "./ws-send.js";
  ```

  (b) immediately after `ws.data.clientType = clientType;`, acquire the surface's journal — **before** the runtime block, so any frame the runtime can emit is already sequenced:

  ```ts
    // --- Reconnect gap-fill: acquire this surface's frame journal ---
    //
    // Keyed `${userId}::${surfaceId}`, matching SessionRuntime's own identity.
    // surfaceId falls back to deviceId when the client omits it — mandated by
    // sessionConfigureSchema.surfaceId's contract note, and the reason two
    // browser tabs of one user stay independent. The registry (not this
    // connection) OWNS the journal: a resumed surface gets the same object
    // back and its seq counter simply continues, which is what makes replay
    // contiguous across the socket boundary.
    const surfaceId = configureSurfaceId ?? configureDeviceId;
    const replayKey = `${userId}::${surfaceId}`;
    if (ws.data.replayKey !== null && ws.data.replayKey !== replayKey) {
      // A re-configure that moved this connection to a different surface —
      // park the old surface's journal rather than orphaning it attached.
      services.replayRegistry.release(ws.data.replayKey);
    }
    const acquisition = services.replayRegistry.acquire(replayKey, configureResume?.epoch);
    ws.data.journal = acquisition.journal;
    ws.data.epoch = acquisition.epoch;
    ws.data.replayKey = replayKey;
  ```

  (c) replace the trailing `ws.send(JSON.stringify({ type: "session.ready", … }))` block with the resume-aware version:

  ```ts
    const readyFrame: GatewayMessage = {
      type: "session.ready",
      sessionId,
      audioEncoding: AUDIO_ENCODING,
      inputSampleRate: INPUT_SAMPLE_RATE,
      outputSampleRate: OUTPUT_SAMPLE_RATE,
      enabledEffects: [],
      playback: {
        minEagerEndMs: services.webui.playback.min_eager_end_ms,
        preemptFadeoutMs: services.webui.playback.preempt_fadeout_ms,
      },
    };

    // On the recovered path this sends session.ready itself (RAW, before the
    // stream.resumed ack and the verbatim replay) and returns true — see
    // ws-resume.ts for why that order is load-bearing. Every other path
    // returns false and we send the normal seq-stamped ready below.
    const readyAlreadySent = handleResumeOrFresh({
      ws,
      sessionId,
      surfaceKey: replayKey,
      journal: acquisition.journal,
      epoch: acquisition.epoch,
      resumed: acquisition.resumed,
      resumeParams: configureResume,
      readyFrame,
    });
    if (!readyAlreadySent) sendGatewayFrame(ws, readyFrame);
  ```

  (d) fix the now-stale `hasResume` line in the `session-configured` log call — it currently sits under a comment claiming resume is "accepted but not acted on":

  ```ts
    log.info("session-configured", {
      sessionId,
      userId,
      capabilities,
      clientType,
      language,
      deviceId: configureDeviceId,
      surfaceId,
      hasRuntime: ws.data.runtime !== null,
      epoch: acquisition.epoch,
      resumed: acquisition.resumed,
      requestedResumeLastSeq: configureResume?.lastSeq ?? null,
      conversationId: configureConversationId ?? null,
    });
  ```

  (e) delete the two stale comment lines above the old `hasResume` entry ("Accepted but not acted on post-purge — resume/conversation-anchor wiring goes with the rest of Plan 2's orchestrator rebuild.") and update this file's header block: the sentence *"Plan 2 Task 10 adds the one piece of orchestrator wiring that belongs HERE…"* should gain a second paragraph:

  ```ts
  // Plan 3 Task 10 adds the second piece: acquiring this surface's frame
  // journal from `services.replayRegistry` and running the resume decision
  // (ws-resume.ts) before session.ready goes out. The `resume` field the
  // client folds into this frame is now honoured, not just logged.
  ```

- [ ] **Step 24: Release the journal on teardown.**

  In `gateway/src/session-handlers/ws-handlers.ts`:

  (a) `handleSessionEnd` — an explicit end means the client is not coming back to this surface, so drop the journal outright instead of paying the retention window for it:

  ```ts
  function handleSessionEnd(ws: ServerWebSocket<SessionData>, services: GatewayServices): void {
    if (!ws.data.sessionId) return;
    // Explicit end: discard rather than park. Clearing replayKey here also
    // stops cleanupSession below from re-releasing a key that no longer exists.
    if (ws.data.replayKey !== null) {
      services.replayRegistry.discard(ws.data.replayKey);
      ws.data.replayKey = null;
    }
    cleanupSession(ws, services);
    ws.close(WS_NORMAL_CLOSURE, "Session ended");
  }
  ```

  (b) `cleanupSession` — release AFTER the runtime is disposed. Insert immediately below the existing `ws.data.runtime?.dispose(); ws.data.runtime = null;` pair (which itself sits below Task 6's `permissions.denyAll()`):

  ```ts
    // Detach the frame journal LAST, after the runtime has been disposed:
    // dispose() is synchronous, and anything it still writes to this socket
    // must land in the journal so a reconnecting client replays it. The
    // journal OBJECT survives in the registry for the retention window; only
    // this connection's handle on it is cleared.
    if (ws.data.replayKey !== null) {
      services.replayRegistry.release(ws.data.replayKey);
      ws.data.replayKey = null;
    }
    ws.data.journal = null;
    ws.data.epoch = 0;
  ```

  (c) replace this function's stale doc comment sentence — *"There is no resumable-disconnect handling yet — a fresh connection always mints a fresh runtime; Plan 3 revisits reconnect/resume for the orchestrator."* — with:

  ```ts
   * A fresh connection always mints a fresh runtime; what DOES survive the
   * disconnect is this surface's outbound frame journal, parked in
   * `services.replayRegistry` for `session.replay_journal_retention_ms` so a
   * reconnect carrying `resume: {epoch, lastSeq}` can replay the frames the
   * client missed (Plan 3 Task 10). The in-flight turn is not resumed — it is
   * aborted by `dispose()` — only the already-emitted frames are.
   ```

- [ ] **Step 25: Update the routing test's `cleanupSession` service stub.**

  `gateway/src/session-handlers/ws-handlers-routing.test.ts` — Task 6 added a `cleanupServices` stub carrying `sessionManager`. `cleanupSession` now also dereferences `services.replayRegistry`, so extend that stub (and only that stub; the `unusedServices` cast used by the `text.input` / `interrupt` cases is untouched, because neither branch reaches the registry):

  ```ts
  import { createReplayRegistry } from "./replay-registry.js";

  // cleanupSession() dereferences sessionManager AND replayRegistry. A real
  // (tiny) registry is cheaper and more honest than a hand-rolled double.
  const cleanupServices = {
    sessionManager: { unbindUser: () => {}, removeSession: () => {} },
    replayRegistry: createReplayRegistry({ maxBytesPerSurface: 65536, retentionMs: 1000 }),
  } as unknown as GatewayServices;
  ```

  Add one case pinning the release-after-dispose ordering — this is the invariant that keeps a disconnect's last frames replayable:

  ```ts
  describe("ws-handlers cleanup — replay journal", () => {
    it("releases the surface journal into the registry instead of dropping it", () => {
      const registry = createReplayRegistry({ maxBytesPerSurface: 65536, retentionMs: 60_000 });
      const services = {
        sessionManager: { unbindUser: () => {}, removeSession: () => {} },
        replayRegistry: registry,
      } as unknown as GatewayServices;

      const ws = fakeAuthedWs(null);
      const acquired = registry.acquire("u_deadbeef::surface-a", undefined);
      ws.data.journal = acquired.journal;
      ws.data.epoch = acquired.epoch;
      ws.data.replayKey = "u_deadbeef::surface-a";

      cleanupSession(ws as unknown as ServerWebSocket<SessionData>, services);

      expect(ws.data.journal).toBeNull();
      expect(ws.data.replayKey).toBeNull();
      // Parked, not destroyed — a reconnect at the same epoch still resumes.
      expect(registry.acquire("u_deadbeef::surface-a", acquired.epoch).resumed).toBe(true);
    });
  });
  ```

  > `cleanupSession` and `SessionData` are already imported by this file (Task 6's step added the former); add `createReplayRegistry` and `ServerWebSocket` to its imports if they are not present.

- [ ] **Step 26: Run the whole session-handlers suite to green.**

  ```bash
  cd /Users/kevinye/Development/sentient && source scripts/env.sh && cd gateway/src && bun test session-handlers/
  ```

  Expected: every file green — `frame-journal.test.ts`, `ws-resume.test.ts`, `ws-turn-emitter.test.ts`, `ws-handlers-routing.test.ts`, `ws-auth-gate.test.ts`.

- [ ] **Step 27: Full gate.**

  ```bash
  cd /Users/kevinye/Development/sentient && source scripts/env.sh
  bun run lint && bun run typecheck && bun run test:unit
  ```

  Expected: clean. If `bun run test` reports a port conflict, stop any running local stack container first (`docker compose -f deploy/macos/docker-compose.yml down`) — a live gateway holds `:8888`.

- [ ] **Step 28: Commit the resume handshake.**

  ```bash
  cd /Users/kevinye/Development/sentient
  git add gateway/src/session-handlers/ws-resume.ts \
          gateway/src/session-handlers/ws-resume.test.ts \
          gateway/src/session-handlers/ws-session-configure.ts \
          gateway/src/session-handlers/ws-handlers.ts \
          gateway/src/session-handlers/ws-handlers-routing.test.ts
  git commit -m "feat(gateway): honour session.configure resume with stream.resumed replay and epoch fallback"
  ```

---

#### E2E matrix (this task's rows)

Run as part of Task 11 (web) against the local stack; the native equivalents ride Task 12's `reconnect` tag batch. Both rows are already in the reusable case library (`agents/docs/testing-knowledge.md`) as reconnect cases — extend, do not duplicate.

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| `reconnect-gapfill` | desktop 1280×900 | authed session, assistant mid-reply streaming `turn.text.delta` | kill the socket from devtools (offline toggle ~2 s), then restore | the reply completes with **no** missing or duplicated text; no new bubble appears; no error toast | `session-configure` with `resumed: true`; `resume.recovered` carrying `fromSeq`/`toSeq`/`replayCount ≥ 1`; client `stream.resumed.recovered`; **no** `journal.gap.*` |
| `reconnect-fresh-fallback` | mobile-sized 390×844 | authed session with prior history; gateway restarted so the registry is empty | reconnect from the client (foreground the tab) | history reloads intact via REST refetch; conversation still usable; no duplicate bubbles | `replay-registry.fresh` with `reason: "no-prior-journal"`; `resume.not-recovered`; client `stream.resumed.not-recovered — resetting cursor + refetching history` |

Both rows are **only** verifiable end-to-end (they need a real socket drop) — no unit test substitutes for them. If the local stack cannot be restarted mid-run, flag the second row in handover rather than marking it green.
