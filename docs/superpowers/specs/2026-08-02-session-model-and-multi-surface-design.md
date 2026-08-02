# Session model redesign — server-minted sessions, connections as windows

**Status:** design approved 2026-08-02. Revised twice the same day: first after an adversarial source review, then after a six-dimension fleet review. Supersedes the per-surface conversation model on `feature/native-orchestrator`.

**Goal:** A session becomes a first-class, server-owned resource that a user can create, list and re-open — and any number of that user's connections can attach to one live session at once, each a window onto the same conversation, any of them able to act in it.

> **Revision log.**
> **R1** — corrected four false claims about the current gateway and added two missing mechanisms; marked **[corrected]**.
> **R2** — made the `SessionRuntime` identity rewrite explicit (§2.5, the blocker four reviewers found independently), removed the attachment-verb layer (§3.4), fixed two impossible claims (mint atomicity §4.2, replay-equality for joiners §7.2), decided input arbitration (§8.3), promoted command binding from risk to requirement (§3.7), and added a logging contract (§7.3). Marked **[R2]**.
>
> Reviewers cited many line numbers that do not exist in this repo. **Every** finding accepted here was re-verified against the source first.

---

## 1. Why this is a redesign and not a fix

The current model derives a conversation id from the surface: `c::<userId>::<surfaceId>` (`session-handlers/ws-session-configure.ts:355`). One surface therefore has exactly one conversation, forever, and "+ new chat" has nothing to hand back because **there is no allocator**.

That shape was correct under Hermes, which owned the agent runtime and the session state — the gateway could only key a conversation by something it held itself. The gateway now owns the loop, the store and the buffer, so the constraint is gone. Keeping it costs two live defects:

- **D15** — "+ new chat" does not start a new chat; on web it does not even clear the mirror. Measured on the wire: `stream-start messageCount` 6→8 across the click, and the model recited a pre-click marker verbatim when denied an escape hatch. A **context leak**, not a cosmetic bug.
- **No past-chat list.** There is no `/api/v1/sessions` handler; both SDKs call it, and mobile's failure branch is `replaceMirror(emptyList())`.

**What this wave delivers:** a session allocator, a past-chat list, and multi-connection fan-out. It does not eliminate state drift — the store has been the single source of truth for committed entries since 2.0. It relocates a different sync problem (per-surface journals) and introduces a new one to bound (per-cursor lag, §8.1).

---

## 2. The model

**The session is the unit of state. A connection is a window onto it.**

A session owns a **session journal**: one monotonic seq space carrying the frames belonging to the conversation — turn lifecycle, text deltas, feed items, tool tiles, permission prompts, audio, title updates. A connection holds a **cursor** into it.

### 2.1 Two lanes, not one **[corrected]**

R1 said *every* outbound frame shares one seq space. Wrong — it would leak one connection's private frames to another window.

| Lane | Owner | Contents | Journaled |
|---|---|---|---|
| **Session** | the session | turn lifecycle, text deltas, feed items, tool updates, permission prompts and resolutions, audio, title updates | yes |
| **Connection** | the socket | auth results, pong, resume coordination, session-ready | never |

The implementation must produce an explicit **`frameType → lane` table** covering every type in `shared/protocol`. A frame type added later with no lane assignment is a contract break, not a default. `sendGatewayFrame` / `sendUnsequencedFrame` (`ws-send.ts`) is the existing seam that already makes this distinction *accidentally*; the plan makes it deliberate.

### 2.2 What the model buys

- **Reconnect and join share one primitive.** Both are `replay-from(seq)` plus a snapshot handshake — a reconnecter presents a seq it genuinely reached, a joiner starts at head (§7.2). One code path, two entry points.
- **Steering is unchanged.** At most one turn runs per session; input landing mid-turn *steers* it, input landing after the final answer starts a back-to-back turn (2.0 spec §5). More windows means more inputs into the same seam. Simultaneous contention is arbitrated (§8.3).
- **Fan-out is one seq space, not N.** A frame is allocated once; every cursor reads the same bytes.

### 2.3 The journal is already surface-scoped **[corrected]**

R1 said `FrameJournal` belongs to a *connection*. It does not: `ReplayRegistry` keys it `${userId}::${surfaceId}` and deliberately outlives the socket, with a lease so a superseded socket cannot mutate the live entry.

The retention sweep, the lease discipline and disconnect-survival therefore already exist. **But the lease model is a precedent for ownership hygiene only — not for the subscriber set**, whose purpose is the opposite of single-owner (§2.5).

### 2.4 What does NOT come for free **[corrected]**

R1 claimed permission prompts, Stop and steer all fall out of the model. Steer does. The others are real work:

- **`PermissionBroker` is one per connection** — *"One broker per WS connection, held on `ws.data.permissions`"* (`runtime/permission-broker.ts:14`). Session-scoped fan-out means the prompt entity lives on the session, not the socket: it survives the issuing window disconnecting, any window may answer, the **first answer resolves and any second is refused, never re-decided**, and a timeout resolves **deny** (fail-closed). A prompt with zero attached windows is denied immediately rather than queued.
- **Stop from any window** aborts the shared turn — a behaviour change from the per-surface model, where Stop only ever affected its own.

### 2.5 The identity rewrite — explicit **[R2]**

*This section exists because four independent reviewers found it missing, and R1 referred to "the subscriber set (§5.3)" — a section that defines config, not a subscriber set. The mechanism was assumed and never specified.*

**`SessionRuntime`'s key changes from `(userId, surfaceId)` to `sessionId`.** The `(userId, surfaceId)` key is retired. Everything in this spec — one journal, one turn at a time, fan-out to N cursors — is false unless the runtime *is* the session.

Consequently:

1. **`ConversationRuntimeRegistry`'s single-owner model is replaced, not generalized.** Today `claim()` makes the newest connection the sole owner and calls `previous.evict()`, which denies open prompts and disposes the runtime, aborting its in-flight turn. Under this design a second window attaching would **tear down the first** — which makes the E2E rows `two-surfaces-live`, `join-midturn` and `last-one-out` not merely unimplemented but incoherent. Evict-on-claim is **deleted** and replaced by a `SubscriberSet`: attach / detach, one lease per attachment, runtime disposed only when retention says so (§5).
2. **The invariant the old registry protected still holds and must be re-proved.** Its rationale is correct and unchanged: *two live runtimes on one partition are two ReAct loops appending to one append-only log, each having read prior context without the other's writes — breaking the store's cache-stable prefix invariant — plus two `bun:sqlite` handles contending on one WAL.* Exactly one runtime per `sessionId`; N attachments to it.
3. **`CLAUDE.md` and the 2.0 design §2.6 both still say "one `SessionRuntime` per `(userId, surfaceId)`" and are overtly superseded in this wave.** Both must be updated in the same change, or the next reader inherits a contradiction.

---

## 3. Identity and security

### 3.1 What already holds

- One SQLite file per user. `openSessionStore(cap)` derives the path from a **capability**, never from the request.
- Capabilities are minted in one place — `AccessManager.grant`, from an authenticated `UserPrincipal` — and frozen at mint.
- One call site of `openSessionStore` in the gateway.

So `session_id` is a column *inside the caller's own database*, and **a forged sessionId can only address a partition in the caller's own file**. Preserved by construction.

### 3.2 The L2 chain has a hole, and this wave closes it **[corrected]**

`CLAUDE.md` states: *"L2 resource handles — `SessionRuntime`, `FileScope`, `ToolBroker`, `ProviderClient` — hold capabilities by value, never an ambient 'current user'."* Two parts are untrue today:

- **`openSessionStore` never checks `cap.resource`** (`store/session-store.ts:85-89`) — only `capabilityCoversPath`. A `file-scope` capability has an identical `rootPath` and opens the session store fine. Confused deputy.
- **`ToolBroker` takes a `UserPrincipal`, not a capability** (`tools/tool-broker.ts:147`).

This is the **third instance on this branch** of documentation asserting a control that is not wired, after `delegateTask`'s *"would double-prompt"* and `mcp-policy.yaml`'s claimed inbound injection scan. Treat it as a known failure mode of this codebase.

**Both close in this wave**, first, before any runtime refactor: declaring a session capability-scoped is empty while resource class is unchecked. `principal` may remain for log correlation; it must not be the authorization input.

### 3.3 sessionId

**Server-minted, opaque, unguessable.**

- **CSPRNG, ≥128 bits** — mandated. The connection-session allocator uses `Math.random().toString(36)` (`auth/session-manager.ts:61`); fine for a connection id, not for a durable resource id. Do not reuse the pattern.
- Canonical length and charset, validated on input; collision-safe insertion.
- **Never derived** from userId, surfaceId or a timestamp.

### 3.4 Authorization is principal + capability + membership — and that is all **[R2]**

*R1 added an attachment-verb table (`observe`/`submit`/`interrupt`/`approve`) keyed on the surface's "registered identity". It is removed.*

`surfaceId` is a client-supplied free-form string (`ws-session-configure.ts:140`) and there is no server-side surface registry. Keying authority on it would mint a capability from a label the client chooses. But the deeper problem is that it was **a second authority system running parallel to `PrincipalRole`**, which is already the L0 trust anchor minted at auth.

So the chain is:

1. **Principal** — authenticated at connect, frozen, carries the role.
2. **Capability** — minted from the principal by `AccessManager`, selects the store.
3. **Membership** — the session must exist in the store that capability opens.

Every connection that clears all three holds the same authority, because it *is* the same authenticated user looking at their own data through another window. Showing two of a user's own windows the same tool arguments is not a leak.

**If a low-trust surface is ever needed** — a hallway cube, a shared display, a child's tablet — it authenticates as a **lesser principal** with a lesser `PrincipalRole`, and the existing PDP mediates it. That reuses the L0 anchor instead of inventing a parallel axis. No new subsystem, and no surface registry.

**`surfaceId` gates nothing** and is retained only as a client identifier for journal keying, resume correlation and log attribution.

### 3.5 Addressing

1. **Membership lookup replaces the prefix check** — stronger than a string prefix, because the store queried is chosen by capability.
2. **An unknown sessionId is REJECTED**, not silently created (today `resolveConversationId` honours any well-prefixed id, creating an empty partition). Closes junk-partition spam.
3. **The sessions route never accepts a userId.** It reads the principal.
4. **Legacy ids are addressable, not privileged** **[corrected]**. Existing `c::<userId>::<surfaceId>` partitions are rows in the caller's own store, reached through the same membership lookup. The prefix parse is **retired**: no code path may infer ownership from an id's shape, and the embedded `surfaceId` is dead metadata carrying no authority. New sessions get §3.3 ids; both shapes are handled identically.
   - **Bootstrap rule:** a legacy id is accepted only when it is already present in the caller's store. A legacy id that is absent is rejected like any other unknown id — the "create if absent" behaviour is what §3.5 #2 removes, and re-admitting it for `c::` ids would reopen the same hole.

### 3.6 Credential lifetime

`UserPrincipal` is `Object.freeze({ userId, role, householdId })` (`identity/user-principal.ts:20`) — **no expiry field** — and the PASETO token is validated once at connect. An attachment can therefore outlive its credential indefinitely.

Carry `tokenExpiresAt` on the connection state (not the principal, which is an identity anchor and must stay immutable), and revalidate before every acting command. Fail closed. A revoked or expired credential must not keep reading session content either — this covers reads, not only writes.

### 3.7 Command binding — a requirement, not a risk **[R2]**

*R1 filed this under "Risks", which would let the wave ship without it. It is the correctness condition for the headline feature.*

`text.input`, `interrupt` and permission responses carry no session id, and binary audio uses the ambient connection runtime (`ws.data.runtime`). The moment session switching exists — which is the feature — a command issued before a switch lands on the session after it.

Required in this wave:

- every command frame carries `sessionId` **and an attachment generation**;
- commands are mediated at **one choke point**, not sprinkled across `ws-handlers.ts`;
- stale-generation traffic is **dropped, not applied**, with an explicit rejection frame (`reason="stale_generation"`) rather than silence, and the in-flight STT buffer is discarded without committing a partial.

This is a wire-protocol delta. `shared/protocol` is frozen, so the plan must specify the field additions and move both SDKs together.

### 3.8 Threat notes

- **Cross-user read via forged id** — blocked structurally *and* by membership lookup. An E2E row, not an assertion.
- **Cross-window content exposure** — not a threat: same principal, same data (§3.4).
- **Stale socket acting on a live session** — the `ReplayRegistry` lease is the precedent for ownership hygiene; the subscriber set needs the same discipline.
- **`pendingId` collision across windows** — `pendingId` dedup is session-scoped (`store/session-store.ts:78`). With N windows appending to one session, two windows reusing a value would suppress the second message. `pendingId` must be unique per attachment.
- **Auxiliary-task output is untrusted content** (§6) and must never become an authorization or routing signal.
- **A background completion carries no cross-window authority.** Per canonical §2.3, a model-emitted tool call is not an authorization decision; every resulting call is re-authorized by the PDP.

---

## 4. Storage

### 4.1 A session metadata table is required **[corrected]**

R1 assumed titles could be stored and renamed. The store has **one table, `entries`, append-only**, with a deliberately frozen baseline DDL (`store/schema.ts`).

Add a `sessions` table **via the migration ladder — never by editing `STORE_DDL`**, whose header explains why: every per-user database already exists, so a column added to the baseline reaches none of them, and fresh-database tests stay green while real users fail. That blind spot deleted the `pending_id` round trip (D14).

Fields: session id, created/updated timestamps, title, **title provenance** (`generated | user`), and a **version for compare-and-set** (§6).

Any other schema change this wave needs — for example a source-attribution column, should §8.3 ever require one — goes through the same ladder.

### 4.2 Lifecycle **[R2 on minting]**

- **Fresh connection starts fresh.** A connection with no stored sessionId begins a new session; joining an existing one is always explicit.
- **Mint on first message.** Connecting yields an empty draft; the id is minted and persisted when the user sends something. Ten opened tabs leave no trace.
- **Minting is idempotent, not atomic.** R1 said the row, the entry and the id acknowledgement "commit together." **They cannot** — the ack is a wire frame and cannot join a SQLite transaction. Commit succeeds, socket drops, client retries, and a *second* session is minted while the first becomes a ghost holding a message the user can never reach.
  - The DB commit (session row + first entry) is atomic.
  - The client supplies an idempotency key with the first message; the server dedups on `(userId, key)` and **re-returns the existing id** on retry.
  - The ack is best-effort; retry is safe by construction.
- **The mint is broadcast on the session lane**, so a second window already attached to the same draft learns the id without re-attaching.
- **Retention: 15 minutes after the session stops being retained** (§5), then drop. The conversation is durable; dropping loses only the replay tail.

---

## 5. `SessionRetention` — derived, never a flag

A stored `workInFlight` boolean would be set and cleared at several sites and eventually leak one. Retention is **derived from observable state on every evaluation**:

| Term | True when |
|---|---|
| `hasSubscribers` | ≥1 attached connection |
| `isTurnInFlight` | the ReAct loop is iterating or streaming |
| `hasPendingForegroundTool` | a foreground tool call is awaiting its result |
| `hasUnfinishedBackgroundTask` | a background task is registered and unfinished |
| `hasOutstandingPrompt` | a permission prompt is unresolved |
| `hasAuxiliaryTaskInFlight` | an auxiliary task (§6) has not returned |

`computeRetentionReasons()` returns the terms that are true; `isRetained()` is the derived boolean. **Reasons are logged**, or "why is this session still resident" is unanswerable.

### 5.1 Invariants to pin

- the timer starts **only** on the transition to *not retained*;
- any term becoming true again **cancels** a running timer rather than racing it;
- **disposal is generation-stamped and re-checks retention under the same lock immediately before disposing**, so a timer that fired while a connection was attaching cannot dispose a live session;
- retention is **re-evaluated periodically**, not only on state-change events. A background worker that dies without emitting completion would otherwise leave `hasUnfinishedBackgroundTask` true forever and the timer never starts. A watchdog marks a task lost after a bounded gap, removes it from the predicate, and WARNs.

### 5.2 Why the clause is mandatory — and a live defect it exposes

Today expiry means "the client refetches". Under this design expiry **also disposes the runtime**.

Worse, the current code already has the failure this prevents: `SessionRuntime.dispose()` **deliberately leaves** registered background tasks alive (only `interrupt()` calls `background.cancelAll()`), but it closes the SQLite handle — so the completion can never land. **Closing your last tab today orphans a running delegated task.** `retention-holds-work` is therefore a defect gate, not a comfort feature.

### 5.3 Config — the sweep loop is reused, the predicate is new

`ReplayRegistry`'s sweep is a wall-clock timer over detached journals; it knows nothing about turns, tool calls, background tasks or prompts. Reusing it avoids a second lifecycle (its header argues exactly that), but the predicate feeding it is new, with hooks from `SessionRuntime`, `ToolBroker`, the permission broker and the auxiliary-task runner. Calling the whole thing "reuse" would understate it.

- `session.replay_journal_retention_ms: 300000` → **`session.retention_ms: 900000`** (15 min). The rename is required: the key now governs session lifetime, not journal bytes, and a key that under-describes its job is how the dead `session.idle_timeout_ms` survived with zero readers. `operator-config-migrator.ts` carries existing installs.
- `session.replay_journal_max_bytes` (16 MB) becomes **per session** — a 1×→N× multiplier over its tuned value. Re-tune against §8.2; log evictions.

---

## 6. Titling, as an auxiliary-task handler

Deliberately **not** a titler: one encapsulated seam taking a prompt template, a truncated conversation slice and a small output budget, returning structured output. Titles are its first user; tags, follow-up suggestions and summarisation are obvious next ones.

Follows [Open WebUI](https://docs.openwebui.com/features/workspace/prompts/), whose "task model" seam drives title generation, tag generation and follow-up suggestions from one place, with a template, JSON output, a 3–5 word target, and input truncation.

- Fires after the first **completed** assistant reply commits. A cut-off first reply does not trigger it.
- Never blocks the reply. Small output cap, reasoning effort off — what wave 1's `reasoning_effort` knob is for.
- The result lands as a **session-lane frame**, so every attached window renames live.
- **Compare-and-set against the version in §4.1, and refuse to overwrite `provenance = user`.** A rename racing the generator is a real ordering: the generator fires seconds after the first reply, exactly when a user might rename.
- On failure, fall back to a truncated first message; never permanently "Untitled". The failure log names the reason and the fallback.
- Every tunable — word target, output cap, input truncation, template path, operator override dir — gets a config key with a comment and a range. Templates live in `.md` files, per the clean-code rule.

---

## 7. Attaching

A joining connection receives, atomically: the **committed feed**, a **turn-state snapshot**, and a cursor at the journal head.

### 7.1 The linearization point **[corrected]**

R1 said "send the feed, then place the cursor at head". A frame emitted between those steps is **lost silently**. Attach must capture `{store watermark, journal seq}` atomically, register the subscriber, buffer concurrent emissions, and drain them after the snapshot.

Four separable sub-invariants, each unit-testable: the capture is atomic; no frame between watermark and cursor is dropped; none is delivered twice; the drain preserves order.

### 7.2 The snapshot, and the honest form of the replay invariant **[R2]**

Clients build in-flight UI from **transient prerequisite** frames — `turn.started` before deltas, audio-start before audio, a prompt before its resolution. A connection attaching mid-turn with only committed entries plus a head cursor receives deltas for a turn it never saw start.

The snapshot carries: active turn id, text accumulated so far, in-flight tool state, open prompts, current audio state. It **must not** replay historical audio bytes — that would re-speak what the user already heard.

**Ownership:** `SessionRuntime` owns the snapshot and emits it atomically at attach. It is **not** journaled and is recomputed live; the journal owns only the cursor watermark. If no runtime is resident at attach, the session is rehydrated first and the snapshot is empty by definition — there is no in-flight turn to describe.

**The invariant, stated correctly.** R1 asserted `render(replay) == render(live)` holds for joiners. It cannot: a joiner's live view is *snapshot + subsequent frames*, while replaying from that same cursor later yields *subsequent frames only*. They diverge across the in-flight turn. The true invariant is:

> `render(replay_from(seq)) == render(live_at(seq))` for any seq a client genuinely reached.
> A fresh joiner is not that case: it is reconstructed as `snapshot ∪ replay_from(watermark)` — a different, defined path that **converges with the committed projection once the in-flight turn commits**.

Both paths must be tested; conflating them is what made the claim false.

### 7.3 Logging contract **[R2]**

Under one connection per session, `turnId` was enough to trace a turn. With N windows it is not: an unattributed `Stop` cannot be traced to the window that sent it.

- every session-lane line carries `sessionId` and `turnId`;
- every command, permission and cancellation line additionally carries `attachmentId`;
- a background-completion stimulus carries a `stimulusId` so a steer can be folded into its turn in the log.

Content is never logged — ids, lengths and reasons only.

---

## 8. Risks and remaining decisions

### 8.1 Slow window vs a bounded shared journal — decide in-wave

`ws-send.ts` ignores transport backpressure (the `ws.send()` return value is unchecked) and the journal evicts oldest. With a per-surface journal a slow client only hurt itself; with a shared one, its prerequisite frames can be evicted while it lags — and eviction never removes the *only* frame, so a stale `turn.started` can pin itself as the last survivor.

Define maximum lag and the behaviour past it — forced re-snapshot or disconnect — **and pick one**, so two implementers do not choose opposite defaults.

### 8.2 Buffer memory

The journal now holds audio (~50 frames/s) for a *session* several windows may watch for an hour. Cap and window need re-tuning together with §5.3; evictions logged, not silent.

### 8.3 Input arbitration — DECIDED **[R2]**

Owner's decision, and it generalises past voice: **a connection is a window onto the session, and the first window to talk wins.**

- **Simultaneous contention** — two inputs racing at the same dispatch — resolves to the first; the second is refused with a busy rejection. This applies to every input form: mic onset, text, or anything later.
- **Sequential input during a turn still steers.** A message arriving three seconds into a running turn is someone else talking into the room, and is absorbed by the existing steer seam (§2.2). Arbitration is for races, not a floor lock for the whole turn — a floor lock would make one speaker own the session until their turn ended, defeating the point.
- **Barge-in from any window is honoured** whenever it lands. `cancellation.ts:43-44` already makes a second barge-in on an aborted turn a no-op, so double-abort is handled; no second cutoff entry is committed.
- **No source-attribution column this wave.** Entries carry no `sourceSurfaceId` and do not need one under this rule. If attribution is wanted later it is a §4.1 migration-ladder change — never a `STORE_DDL` edit.

Note the user-visible change this makes explicit: under the old per-surface model, barge-in on one surface affected only that surface. Under one runtime per session, it aborts the shared turn for everyone attached. That is intended.

### 8.4 The wire is frozen

Distinguishing "the user pressed +" from "the app launched" needs a new field or frame, with both SDKs moving together. Mobile fires `session.new` on **every launch**, twice per launch; minting per `session.new` would fork a conversation per app open and destroy `reload-convergence` and `restart-persistence`. The no-session-yet handshake must be specified exactly, since mobile gates its outbound queue on the `session.created` answer and would otherwise never drain.

---

## 9. Out of scope

- **Multi-user shared sessions.** A session belongs to one user.
- **Audio routing / designated speaker.** All attached windows receive frames; clients decide. Today they all play audio, which is acceptable.
- **Presence and typing indicators.**
- **Durable turn state and tool idempotency.** A crash between `tool_call` and `tool_result` can reissue a side effect; a background task completing after a restart has no resident runtime to receive its stimulus. Filed in `docs/native-todo.md`.
- **Symlink-safe capability paths.** `capabilityCoversPath` is lexical (`path.resolve` + prefix). Filed; not blocking.
- **A one-shot migration of legacy `c::` ids.** They coexist indefinitely; rewriting them is the clean eventual exit, not this wave.
- **D16 delegated-task silence** and the **untrusted-content boundary** — tracked separately.

---

## 10. E2E matrix

Local dev stack only. Credentials come from the case library in `agents/docs/testing-knowledge.md`, not from this table. Tool calls are reads or temp-writes only — no `ha_call_service`, no `ma_playback` / `ma_play_media` / `ma_volume`.

| Case | Tags | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|---|
| `newchat-mints` | session | desktop | authed, non-empty feed | press "+", then send | feed clears; model has NO prior context | id minted on first message; `stream-start messageCount` counts only the fresh turn |
| `newchat-idempotent` | session | — | unit/integration | retry the first message with the same idempotency key | one session, not two | dedup on `(userId, key)`; existing id re-returned |
| `newchat-not-on-launch` | session, mobile | mobile | authed | launch twice | no new session appears | `session.new` resolves to the existing session both times |
| `draft-leaves-no-ghost` | session | desktop | authed | open a tab, close without typing | history unchanged | no session persisted |
| `title-appears` | session | desktop ×2 | both attached, new session | send the first message | a title appears in BOTH without refresh | auxiliary task fires after commit; title frame on the session lane |
| `title-rename-wins` | session | desktop | new session | rename before the generator returns | the user's title survives | CAS refuses the generated write; `provenance=user` |
| `title-fallback` | session | desktop | titling forced to fail | send the first message | a readable fallback, never "Untitled" | `titler.failed reason=… fallback="truncated-first-message"` |
| `sessions-list` | session | desktop | ≥2 sessions | open the drawer | both listed, newest first, no error | 200, scoped to the principal |
| `session-resume` | session, reconnect | desktop | authed | open an older session | full history; a new turn continues it | `render(replay_from(seq)) == render(live_at(seq))` |
| `legacy-session-opens` | session | desktop | a pre-existing `c::` partition | open it from the list | full history renders | membership lookup succeeds; no prefix parse |
| `two-windows-live` | multisurface | desktop ×2 | same session | send from A | **B shows the same reply streaming** | one `react-loop.start`; both cursors advance; both lines carry `sessionId` |
| `two-windows-steer` | multisurface | desktop ×2 | same session | send from B mid-turn on A | folded into the running turn | steer path; NOT a second turn |
| `two-windows-race` | multisurface | desktop ×2 | same session, idle | both send at once | one is accepted, one gets a busy rejection | arbitration logged with the winning `attachmentId` |
| `join-midturn` | multisurface | desktop ×2 | A streaming; B attaches | B opens the session | B renders coherently, no re-spoken audio | snapshot incl. active turn; `audio.skip-reason="midturn-join"` |
| `join-race` | multisurface | desktop ×2 | A streaming fast | B attaches during a delta burst | B misses no frame and shows no duplicate | atomic watermark + drain |
| `permission-either-answers` | permission | desktop ×2 | same session | prompt from A, answer on B | resolves once; A's dialog closes with the outcome | one resolution; second answer refused |
| `permission-issuer-leaves` | permission | desktop ×2 | prompt raised on A | close A; answer on B | still answerable | prompt lives on the session, not the socket |
| `permission-timeout-denies` | permission | desktop | prompt raised | answer nobody | denied | fail-closed; timeout logged |
| `stop-from-either` | multisurface | desktop ×2 | A's turn streaming | Stop on B | stops for both | one abort; `cutoff="interrupt"`; `attachmentId` names B |
| `bargein-cutoff` | voice, physical-only | desktop | TTS speaking | speak over it | audio stops; the partial is kept | `cutoff="barge-in"`; background tasks untouched |
| `stale-generation-dropped` | multisurface | desktop | switch sessions mid-input | send, then switch, then let the old command land | the old input does not appear in the new session | dropped; `reason="stale_generation"`; STT buffer discarded |
| `connection-lane-private` | multisurface | desktop ×2 | same session | force resume + ping + auth refresh on A | B receives NONE of them | connection lane never journaled |
| `last-one-out` | multisurface | desktop ×2 | same session | close A, keep B | B keeps working | runtime NOT disposed |
| `retention-holds-work` | session | desktop | delegated task running | close every window | on reattach the result is there | reason names `hasUnfinishedBackgroundTask`; no dispose |
| `retention-bg-followup` | session | desktop | delegated task completes after the final answer | wait | a follow-up turn delivers the result | `trigger="background-completion"` with its `stimulusId` |
| `retention-drops-idle` | session | desktop | idle session | close all, wait past the window | reattach shows full history | dispose logged with no reasons; rehydrate |
| `retention-timer-race` | session, fault-armed | — | timer fires while a window is attaching | attach at the boundary | session survives | generation-stamped disposal re-checks under lock |
| `unknown-session-refused` | security | desktop | authed | present an id the server never minted | no session opens; clean error | rejected, not created |
| `cross-user-refused` | security | desktop | Ada authed | present Grace's sessionId | no data from Grace | refusal logged; membership lookup failed |
| `wrong-capability-refused` | security | — | unit | open the session store with a `file-scope` capability | throws | resource-class check fires |
| `expired-credential-refused` | security | desktop | attached, token expired | issue any command | refused | fail-closed; revalidation logged |
| `reload-convergence` | reconnect | desktop ×2 | shared session with tool calls | reload both | identical feeds | replay == live at the reached seq |

The five `security`-tagged rows must be **driven**, not reasoned about. `bargein-cutoff` needs a real microphone and is owner-driven.

---

## 11. Decisions, for the record

| Decision | Choice | Why |
|---|---|---|
| Who shares a session | One user, many connections | Keeps the per-user DB and the capability chain intact |
| Runtime identity | **`SessionRuntime` keyed by `sessionId`**; evict-on-claim deleted | Everything else in the spec is false without it |
| Fresh connection default | Always a new session | Predictable; joining is explicit |
| sessionId shape | Server-minted, opaque, CSPRNG ≥128 bits | Removes id-as-authorization; prevents enumeration |
| Unknown id | Rejected, legacy ids included | A client must never present an id the server did not mint |
| Legacy ids | Addressable, not privileged; embedded surfaceId is dead metadata | The owner's real history lives there; no migration |
| Mint timing | On first message; DB atomic, ack idempotent | No ghosts; a retry cannot fork a session |
| Authority | Principal + capability + membership; **no attachment verbs** | A second authority axis beside `PrincipalRole` was unnecessary; a low-trust surface gets a lesser principal |
| `surfaceId` | A client identifier that gates nothing | It is not in the authorization chain |
| Frame lanes | Session vs connection, enumerated per frame type | A connection's auth frame must never reach another window |
| Permission broker | Relocated to session scope; first answer wins, timeout denies | It is per-connection today; fan-out is real work |
| Input arbitration | **First window to talk wins on simultaneous contention**; later input still steers | A floor lock for the whole turn would defeat multi-window |
| Command binding | Wave-1 requirement, not a risk | It is the correctness condition for session switching |
| Audio fan-out | All windows; client decides | Avoids inventing a routing policy nobody asked for |
| Retention | 15 min, derived predicate, generation-stamped, periodically re-evaluated | One lifecycle; work in flight is never dropped |
| Titling | Auxiliary-task seam, CAS against user rename | Reusable; never delays a reply; never overwrites a person |
| L2 capability gap | Fixed first, before any runtime refactor | Everything downstream rests on it |
