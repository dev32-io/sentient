# Review: Session model redesign — server-minted sessions, surfaces as observers

**Spec:** `docs/superpowers/specs/2026-08-02-session-model-and-multi-surface-design.md`  
**Branch:** `feature/native-orchestrator` (clean at review time)  
**Reviewed:** 2026-08-02  
**Against:** current gateway source (`gateway/src/...`), `shared/config/src/schema.ts`, `docs/native-todo.md`

---

## 1. Overall assessment

The spec is a coherent, security-conscious redesign. It correctly identifies why the current per-surface conversation model is no longer necessary after the native-orchestrator pivot, and it pins the two live defects that justify the work (D15 — “+ new chat” leaks context; no past-session list). The adversarial self-corrections in §2.3/§2.4/§3.2/§3.5/§7.1 are exactly the kind of source-grounded honesty this codebase needs.

That said, the document is a **design approval**, not an implementation plan. Several mechanisms it declares (“both are closed in this wave”, “fan-out is real work”, “retention is derived”) do not exist in the source yet, and the gap between the current per-surface/connection runtime and the proposed per-session runtime is larger than the spec’s concise prose suggests. Before coding starts, three things need more detail: (1) the wire-protocol delta, (2) the new session-scoped subscriber set and derived-retention wiring, and (3) the undefined voice-concurrency and command-binding surfaces.

---

## 2. Verified claims

I re-checked every source citation in the spec against the current code. The corrected findings are accurate:

| Spec claim | Source evidence | Verdict |
|---|---|---|
| Conversation id is derived from surface; no allocator | `gateway/src/session-handlers/ws-session-configure.ts:355` builds `c::<userId>::<surfaceId>` | Confirmed |
| `FrameJournal` is already surface-scoped, not connection-scoped | `gateway/src/session-handlers/replay-registry.ts:13-15` keys by `${userId}::${surfaceId}`; `frame-journal.ts` is a per-surface ring | Confirmed |
| `PermissionBroker` is one per WS connection | `gateway/src/runtime/permission-broker.ts:14` “One broker per WS connection, held on `ws.data.permissions`” | Confirmed |
| `openSessionStore` does not check `cap.resource` | `gateway/src/store/session-store.ts:85-89` only calls `capabilityCoversPath(cap, dbPath)` | Confirmed |
| `ToolBroker` takes a `UserPrincipal`, not a capability | `gateway/src/tools/tool-broker.ts:147` `principal: UserPrincipal` | Confirmed |
| Connection-session id uses `Math.random()` | `gateway/src/auth/session-manager.ts:61-63` | Confirmed |
| Client-advertised capabilities are stored as-is | `gateway/src/session-handlers/ws-session-configure.ts:122` `ws.data.grantedCapabilities = new Set(capabilities)` | Confirmed |
| Store has one append-only `entries` table | `gateway/src/store/schema.ts:31-50` | Confirmed |
| Current retention is a detached-surface timer | `shared/config/src/schema.ts:29-32` default 300000 ms; `gateway/src/session-handlers/replay-registry.ts:118-133` | Confirmed |

The L2-capability holes in §3.2 are real. They are also **not closed yet** in the source — the spec records an owner decision to close them, but no implementation exists. That is fine for a design doc, but the implementation plan needs explicit tasks for both, with unit tests matching the E2E matrix’s `wrong-capability-refused` row.

---

## 3. Strengths

1. **Threat model is front and center.** §3.4 attachment verbs, §3.5 membership lookup, and §3.6 threat notes turn a multi-surface design from a cross-surface leak waiting to happen into a mediated, rights-based surface. The matrix also calls out the four security rows as “driven, not reasoned about.”
2. **Two-lane frame taxonomy.** Distinguishing the session lane from the connection lane (`auth`, `pong`, resume handshake) is the right primitive. It needs an explicit enumerated table in the implementation plan.
3. **Derived retention predicate.** A stored `workInFlight` boolean would leak; deriving retention from observable state (subscribers, in-flight turn, foreground tool wait, background task, permission prompt, auxiliary task) is the only safe shape.
4. **Atomic mint-on-first-message.** “Ten opened tabs leave no trace” is a strong, testable invariant. The atomic commit of session row + first entry + id ack prevents the orphan-first-message hazard.
5. **Compare-and-set titling.** Treating title generation as the first instance of a reusable auxiliary-task seam, with CAS against a user rename, avoids a known race without over-engineering the first wave.
6. **Legacy-id addressability.** Keeping old `c::<userId>::<surfaceId>` partitions reachable via the same membership lookup, while retiring prefix-based ownership inference, is the least-migration path.

---

## 4. Issues, gaps, and risks

### 4.1 L2 capability fixes are decisions, not code

The spec says the `openSessionStore` resource-class check and the `ToolBroker` capability replacement are “closed in this wave.” The current source still has both holes. This is the single highest-risk area because every later security claim in the spec rests on it.

- `gateway/src/store/session-store.ts:85-89` must validate `cap.resource === "session-store"` before trusting `capabilityCoversPath`.
- `gateway/src/tools/tool-broker.ts:147` must accept a capability (or a capability-derived `ToolBroker` context), not a bare `UserPrincipal`. `principal` can remain for log correlation, but it must not be the authorization input.
- The E2E matrix row `wrong-capability-refused` needs a unit test, not only an integration row.

**Recommendation:** Make these two fixes the first implementation slice, and require green tests before any runtime refactor begins.

---

### 4.2 Attachment rights need a surface-identity registry that does not exist

§3.4 says rights “come from server-side policy keyed on the authenticated principal and the surface’s registered identity — never from client-advertised `clientType` or capabilities.” But today the surface identity is exactly what the client sends (`surfaceId` or fallback `deviceId`), and there is no server-side registry of which surfaces a principal owns or what trust class they belong to.

This is a genuine new subsystem, not a policy tweak. Someone must decide:

- How a surface is registered (first `session.configure`? a provisioning flow? derived from device attestation?).
- Whether a principal can have surfaces of different trust classes simultaneously (phone vs. hallway cube).
- Where the policy lives (YAML config, per-user profile, a new `surfaces` table?).

**Recommendation:** Add a short §3.4 appendix or a separate mini-spec defining the surface registry and policy format before the rights mechanism can be implemented. Otherwise implementers will default to the very client-advertised shape the spec forbids.

---

### 4.3 PermissionBroker relocation to session scope is under-specified

§2.4 and §3.4 correctly note that fanning permission prompts to every eligible surface is “real work.” The current `PermissionBroker` (`gateway/src/runtime/permission-broker.ts`) is deliberately connection-scoped: `requestId`s are issued per socket, and the second answer is refused because the prompt is removed from the map. To move it to session scope, the design must answer:

- Are prompt `requestId`s session-global or per-surface? If session-global, the fan-out frame to each surface must carry the same `requestId`; if per-surface, the broker must maintain a 1-to-N mapping and refuse any second answer from *any* surface.
- What happens when the surface that received the prompt disconnects? The spec says its timeout must survive and another surface must still be able to answer. That means the prompt entity must live in the session, not on the socket.
- How does the PDP/ToolBroker know which surfaces have the `approve` right at dispatch time? The `requestConfirm` seam currently returns a single boolean; it must now be a multi-subscriber resolution.

**Recommendation:** Add a sequence diagram or at least a state table for the session-scoped permission prompt lifecycle. The E2E rows `permission-either-answers` and `permission-right-enforced` depend on this.

---

### 4.4 Shared journal + slow subscriber = silent cross-surface loss

§8.1 and §8.2 correctly flag the risk, but they do not yet propose a policy. Today:

- `gateway/src/session-handlers/ws-send.ts:64` ignores `ws.send()` backpressure.
- `gateway/src/session-handlers/frame-journal.ts:98-116` evicts oldest frames when the byte cap is exceeded, keeping only the newest frame.

With a per-session journal, one slow surface can evict prerequisite frames (`turn.started`, `audio.start`) before a faster surface has consumed them, breaking `render(replay) == render(live)` for everyone.

The spec says “define maximum lag, and what happens past it — forced re-snapshot or disconnect.” This is a hard requirement. Without it, the multi-surface design will regress reconnect reliability.

**Recommendation:** Decide the policy in the spec (e.g., per-subscriber watermarks, max-lag disconnect, or periodic forced snapshot) before implementation. The current 16 MB per-surface cap also needs re-tuning if it becomes per-session audio.

---

### 4.5 SessionRuntime sharing across surfaces is more than a registry rename

The current `ConversationRuntimeRegistry` (`gateway/src/session-handlers/conversation-runtime-registry.ts`) enforces **one live runtime per conversation** and *evicts* the previous connection. The new design requires **one runtime per session with a subscriber set of multiple surfaces**. The existing registry is therefore the wrong primitive:

- It must allow N attachments instead of evicting.
- It must not dispose the runtime until the retention predicate is false.
- It must fan out frames to all attached cursors, not a single socket.
- Joining mid-turn requires the atomic `{store watermark, journal seq}` capture described in §7.1; the current `handleSessionConfigure` path (`gateway/src/session-handlers/ws-session-configure.ts:285-298`) sends a snapshot and then a seq-stamped ready frame, but not atomically across the session’s shared journal.

**Recommendation:** Treat the session-runtime registry as a new module, not a rename of `conversation-runtime-registry.ts`. The E2E rows `two-surfaces-live`, `join-midturn`, and `join-race` are acceptance tests for this module.

---

### 4.6 Background tasks are not retained today

§5’s retention predicate includes “any background task is registered and unfinished.” Currently:

- `gateway/src/runtime/session-runtime.ts:728-752` `dispose()` aborts the in-flight turn, cancels audio, and closes the store handle — but does **not** call `broker.background.cancelAll()` (only `interrupt()` does that).
- `gateway/src/session-handlers/ws-handlers.ts:340-392` `cleanupSession()` disposes the runtime on disconnect and does not wait for background tasks.
- `gateway/src/tools/tool-broker.ts:341-438` dispatches a background task, registers it in `BackgroundRegistry`, and later calls `completionSink` — but if the runtime is disposed, `submit()` becomes a no-op, so the completion never re-enters the session.

This means a delegated task whose only attached surface closes could be orphaned or dropped, not retained. The derived-retention design must either keep the runtime alive until the task completes, or move background task bookkeeping outside the runtime.

**Recommendation:** Decide whether background tasks are owned by the session runtime or by a session-level task manager that survives runtime disposal. The E2E row `retention-holds-work` pins whichever choice is made.

---

### 4.7 Voice concurrency is genuinely undefined

§8.3 is correct: stored entries carry no source-surface field, and STT onset calls `bargeIn` on the ambient runtime. Two people speaking into two surfaces on the same session will race. The spec demands a decision and forbids silent deferral, but it does not itself make the decision.

The options are mutually exclusive and have UX consequences:

- **Arbitrate first-onset wins** → second speaker is rejected or queued until the first turn finishes. Simplest, but two family members cannot interrupt each other.
- **Queue** → preserves both utterances, but ordering/latency becomes complex.
- **Reject second** → clean but unfriendly.
- **Add source-surface column** → enables attribution and per-surface STT state, but changes the store schema and model projection.

**Recommendation:** Add a decision to §11 before implementation. If arbitration is chosen, document it explicitly and add an E2E/FSM test.

---

### 4.8 Command binding needs wire-protocol detail

§8.4 notes that `text.input`, `interrupt`, permission responses, and binary audio all use the ambient connection runtime. With session switching, in-flight traffic can land on the wrong session. The fix is “session binding and an attachment generation; stale-generation traffic is dropped and STT state reset.”

This is a wire-protocol change. The current protocol (`shared/protocol/src/messages.ts`) does not carry a session id on `text.input` or `interrupt`. Someone must specify:

- New optional `sessionId` field on these frames.
- Server-side attachment generation and validation.
- What happens when a surface sends a command for a session it is no longer attached to (drop + log + reset STT).
- Whether `session.configure` now returns the opaque session id or still returns the legacy conversation id.

**Recommendation:** Add a short protocol delta to the spec before implementation, or it will be improvised per SDK.

---

### 4.9 Mint-on-first-message may break mobile’s existing anchor handshake

§4.2 says a fresh surface starts fresh and the id is minted atomically on first message; “ten opened tabs leave no trace.” This conflicts with the current mobile SDK behavior documented in `gateway/src/session-handlers/ws-session-new.ts:12-36`: mobile fires `session.new` on every launch and gates its outbound queue on the `session.created` answer. If the answer is “you have no session yet,” the queue may never drain, or the SDK may need a temporary draft anchor.

The spec hints at this in §8.5 (“Distinguishing ‘the user pressed +’ from ‘the app launched’ needs a new field or a new frame”), but it does not resolve it.

**Recommendation:** Define the exact handshake for the no-session-yet state. Options: (a) server returns a draft id that is not persisted until first message; (b) client sends first message with no id and server mints then; (c) `session.new` is split into `session.draft` and `session.create`. This decision gates the E2E row `newchat-not-on-launch`.

---

### 4.10 The “reuse existing timer” claim understates the wiring

§5.3 says to reuse the existing timer rather than add a second lifecycle. The existing `ReplayRegistry` (`gateway/src/session-handlers/replay-registry.ts:118-133`) sweeps detached surface journals on a wall-clock timer. That timer knows nothing about in-flight turns, foreground tool calls, background tasks, or permission prompts.

Implementing derived retention means creating a new `SessionRetention` module with hooks from:

- `SessionRuntime` (turn in flight)
- `ToolBroker` (foreground call awaiting result, background task registered)
- `PermissionBroker` (prompt outstanding)
- auxiliary-task runner (titling)

Calling this “reuse” is misleading; it is a new coordination surface. The registry can keep the sweep loop, but the predicate feeding it is new.

**Recommendation:** Rename §5.3 to “sweep loop is reused, predicate is new,” and list the hook points explicitly in the implementation plan.

---

### 4.11 Config rename and migration need a concrete diff

§5.3 proposes renaming `session.replay_journal_retention_ms` because it now governs session lifetime, not only journal bytes. `operator-config-migrator.ts` is mentioned as carrying existing installs. The current schema is in `shared/config/src/schema.ts:28-32`.

Before implementation, specify:

- The new key name (e.g., `session.retention_ms`).
- The new default (900000).
- The migration statement in `gateway/src/config/operator-config-migrator.ts`.
- Whether `replay_journal_max_bytes` is also renamed or only reinterpreted as per-session.

**Recommendation:** Add a config-schema diff block to the spec or an implementation plan.

---

### 4.12 E2E matrix assumes several features that do not exist

The matrix in §10 is comprehensive, but many rows cannot be driven until the underlying mechanisms land:

- `permission-either-answers`, `permission-right-enforced`, `stop-from-either` require session-scoped permission fan-out.
- `two-surfaces-live`, `two-surfaces-either-speaks`, `join-midturn`, `join-race` require the session-subscriber runtime.
- `sessions-list`, `session-resume`, `legacy-session-opens` require the new REST route and metadata table.
- `retention-holds-work` and `retention-drops-idle` require derived retention.

This is acceptable if the implementation plan sequences the rows, but the spec does not sequence them.

**Recommendation:** Add an implementation-slice ordering that maps matrix rows to features, so “done” can be checked incrementally.

---

## 5. Code-level findings

### 5.1 `sendGatewayFrame` already validates before sequencing — good

`gateway/src/session-handlers/ws-send.ts:112-129` validates against `gatewayMessageSchema` before allocating a seq. This matches the spec’s “enumerate frame lane” requirement: anything sent via `sendUnsequencedFrame` is connection-lane, anything sent via `sendGatewayFrame` is session-lane. The implementation plan should make that correspondence explicit, not accidental.

### 5.2 `FrameJournal` eviction never evicts the only frame

`gateway/src/session-handlers/frame-journal.ts:102-105` keeps at least one frame. With a shared session journal, this could leave a stale `turn.started` or `audio.start` as the only entry and then never evict it. Re-tune or document this edge case.

### 5.3 `session-store.ts` is not symlink-safe

The spec notes this in §9 as out of scope, but it is worth restating: `capabilityCoversPath` (`gateway/src/access/capability.ts:28-33`) uses `path.resolve` and a string prefix. A symlink inside the user’s scoped root can redirect the SQLite path outside the grant. The fix is real-path resolution plus a no-follow open; it becomes load-bearing once delegated tools can write files.

---

## 6. Recommendations

1. **Do not start runtime refactor before L2 capability fixes.** Close `session-store.ts` resource-class check and `tool-broker.ts` capability input first, with unit tests.
2. **Produce a wire-protocol delta document.** Cover `sessionId` on `text.input`/`interrupt`, attachment generation, `session.new` behavior, and the REST routes (`GET /api/v1/sessions`, `GET /api/v1/sessions/:id/messages`).
3. **Define the surface-identity registry.** Without it, attachment rights cannot be implemented as specified.
4. **Sequence the work by acceptance slices.** Suggested order:
   - Slice 1: capability fixes + store metadata migration.
   - Slice 2: opaque session id + REST list/resume + legacy-id lookup.
   - Slice 3: session-scoped runtime subscriber set + shared journal + atomic join.
   - Slice 4: session-scoped permission broker + attachment rights.
   - Slice 5: derived retention + background-task hold.
   - Slice 6: auxiliary-task seam + titling.
   - Slice 7: voice concurrency decision + command binding + STT generation reset.
5. **Add a decision to §11 for voice concurrency** and one for command binding before any implementation begins.
6. **Keep the E2E matrix as the exit criteria**, but tag each row with the slice that enables it.

---

## 7. Conclusion

The spec is correct in its diagnosis and strong in its security framing. It should be approved as the design direction, but it should not be treated as ready-to-implement without an accompanying plan that resolves the open protocol, registry, and concurrency questions above. The biggest risk is underestimating the distance from the current per-surface/connection runtime to the proposed per-session runtime; the second-biggest is implementing fan-out or retention without first closing the L2 capability holes they rest on.
