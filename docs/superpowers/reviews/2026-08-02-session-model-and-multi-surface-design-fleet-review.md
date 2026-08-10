# Multi-Dimensional Fleet Review — Session Model & Multi-Surface Design

**Spec:** `docs/superpowers/specs/2026-08-02-session-model-and-multi-surface-design.md` (2026-08-02, 644 lines)
**Review date:** 2026-08-02
**Method:** six parallel read-only subagents, one per dimension — security, architecture, maintainability, correctness/internal-consistency, session-model/state-ownership, testing/observability. Each read the spec plus referenced canonical design, rules, and source for grounding. No agent modified files or git state.
**Relationship to existing `*-review.md`:** that earlier file is the spec author's own adversarial pass / revision log. This file is an independent multi-dimension review of the current spec state (post-revision).

---

## Headline — one finding reaches across four dimensions

**`SessionRuntime` identity is implicitly rewritten, never stated.** The spec's thesis — *one session, many attached surfaces, one shared journal, "at most one turn runs per session"* (§2.2) — only holds if `SessionRuntime` becomes **1:1 with `sessionId`**. But the canonical 2.0 design (§2.6) and `CLAUDE.md` both still pin `SessionRuntime` as **one per `(userId, surfaceId)`**, and the live registry (`conversation-runtime-registry.ts`) enforces *single-owner, evict-on-claim*: a second surface attaching calls `claim()` and tears down the first (`previous.evict()` → `denyAll()` on open prompts + `runtime.dispose()` aborting the in-flight turn).

Four independent reviewers flagged this, each from their own lens:

| Dimension | What it sees |
|---|---|
| **Correctness (B1)** | Implementer A keys runtime per-session, B keeps per-surface → N runtimes each run a ReAct loop on one append-only log → cache-stable-prefix breaks, torn feeds, double TTS. "At most one turn per session" unenforced. |
| **Session-model (B1)** | The tagline "server-minted sessions, surfaces as observers" only earns its keep if the runtime *is* the session. Leaving the identity change implicit makes the spec inconsistent with the model it claims to supersede. |
| **Security (H2)** | As written, surface B attaching to A's live session evicts A's runtime — directly contradicting the spec's own e2e rows `two-surfaces-live`, `join-midturn`, `last-one-out`, `retention-holds-work`. The security properties those cases pin are incoherent under the current registry shape. |
| **Architecture (Major 3)** | The spec cites the journal lease as "precedent" but never names the registry cutover. "Precedent" invites reuse; the registry's whole purpose (single-owner enforcement) is the *opposite* of the new design. |

**Fix (all four agree):** Add an explicit "Identity rewrite" section stating:
1. `SessionRuntime` key changes from `(userId, surfaceId)` to `sessionId`; the `(userId, surfaceId)` key is retired.
2. `ConversationRuntimeRegistry`'s `claim`/`release` single-owner model is **replaced** by a `SubscriberSet` (attach/detach; lease per attachment); eviction-on-newer-connection is **deleted**, not generalized.
3. The per-connection `PermissionBroker` relocates to the session with N subscribers (named seam, not a thin wrapper — see Arch Major 4).
4. The old per-surface runtime is retired; 2.0 §2.6 and `CLAUDE.md` are overtly superseded in the same wave.

Until this is written down, the spec is not safe to drive implementation from.

---

## Findings by dimension

### Security

| Sev | Finding | Location |
|---|---|---|
| **HIGH** | **H1 — `surfaceId` is unauthenticated, yet §3.4 keys verb rights on it.** The spec excludes self-declared `clientType`/`capabilities` from policy but `surfaceId` is equally self-declared (`messages.ts:119` free-form string; `ws-session-configure.ts:140` client-supplied). A user sending `session.configure` with `surfaceId: "owner-phone"` receives that surface's verb grant — up to all four verbs — regardless of actual device. The verb mechanism becomes a capability minted from a spoofable label. | §3.4 |
| **HIGH** | **H2 — Runtime registry is single-owner-eviction, not a subscriber set** (the cross-dimension headline above). | §2.3, §2.4, §10 |
| **MED** | **M3 — `observe` leaks full content.** Verbs gate *answering* (`approve`) and *acting* (`submit`/`interrupt`) but not *seeing*. `permission.request` carries `inv.args` verbatim (`permission-broker.ts:200`); tool tiles carry results incl. untrusted `delegateTask` output. A low-trust observer (hallway cube, child's tablet) learns file paths, query contents, contact addresses from every tool call the owner's phone dispatched. A "policy entry" can deny verbs but cannot redact frame content. | §3.4, §2.1 |
| **MED** | **M4 — `approve` is session-wide and default-granted to every "interactive" surface.** Any approved surface can authorize any tool call on the session, including one it did not initiate. Today `permission.response` can only settle a prompt *this socket* issued; after relocation, surface B approves a side-effecting call dispatched from A's turn. Default `approve` should be restricted to the highest-trust tier only. | §3.4, §2.4 |
| **MED** | **M5 — Barge-in bypasses the verb table.** `interrupt` = "abort the running turn," but barge-in *also* aborts the turn and is triggered by mic onset, not a mediated command. `audio.start` carries no verb check (`ws-handlers.ts:178` → `bargeIn()` unconditional, `cancellation.ts:217`). A surface denied `interrupt` can still halt the owner's phone turn by speaking into its mic — the verb policy is bypassable by voice. | §3.4, §8.3 |
| **MED** | **M6 — Token-expiry revalidation is asserted but unmechanized; TOCTOU.** `UserPrincipal` is `Object.freeze({ userId, role, householdId })` with no expiry field (`user-principal.ts:18`); `ws-auth-gate` validates PASETO once and never re-checks. A token expiring mid-session keeps authorizing `submit`/`interrupt`/`approve` for hours; a revoked user's existing attachment keeps approving. Specify: `tokenExpiresAt` on `SessionData` (not the principal); gate `submit`/`interrupt`/`approve`/`audio.start` on it, fail closed. | §3.6 |
| **MED** | **M7 — Legacy-id bootstrapping tension.** "Unknown sessionId is REJECTED" (§3.5 #2) vs "legacy `c::` ids remain reachable, handled identically" (§3.5 #4). For a legacy `c::` id on a fresh surface, membership lookup fails → rejecting breaks fresh-surface bootstrapping; special-casing "create if absent" for `c::` re-opens the junk-partition vector §3.5 #2 closes (today `resolveConversationId` honors any client-supplied `c::<userId>::*` id). Specify the bootstrap rule: legacy id accepted only when re-derivable server-side from the authenticated principal + an authenticated surface. | §3.5 #2/#4, §4.2 |
| **LOW** | **L8 — `pendingId` is session-scoped; cross-surface collision suppresses.** With multiple surfaces appending to one session, a reused `pendingId` dedups the second. State `pendingId` is per-attachment. | `session-store.ts:78` |
| **LOW** | **L9 — Auxiliary-task output not marked untrusted.** §6 feeds user content into a titling prompt; future uses (tags, suggestions, summarization) named in §6 could become injection vectors if they drive routing/authz. Add: "auxiliary-task output is untrusted content; never an authorization or routing signal without re-validation." | §6 |
| **LOW** | **L10 — Background-completion stimulus cross-surface authority unstated.** Restate canonical §2.3 ("a model-emitted tool call is not an authorization decision") for the cross-surface case: the completion carries no authority across surfaces; the steering surface's rights + L3 PDP re-authorize every resulting call. | §4.4 (canonical) |

**Sound areas (verified against source):** §3.3 sessionId minting (CSPRNG ≥128 bits, opaque, do-not-reuse — correctly flags live `Math.random().toString(36)` as inadequate for a durable id); §3.2 L2 resource-class hole (verified `session-store.ts:85-89` checks `capabilityCoversPath` but not `cap.resource`; `ToolBroker` takes `UserPrincipal` not a capability); §2.1 two-lane separation (real leak fix); replay cannot alter future auth (auth re-minted from token at each connection, store holds no auth tokens); cross-user read blocked structurally (one SQLite file per user, path chosen by capability) and by membership lookup.

**Security verdict:** strongest where it corrects the L2 chain (§3.2) and minting (§3.3); under-specifies the new authority surface it introduces — surface identity unauthenticated (H1), the subscriber-set registry it relies on is actually single-owner-eviction (H2), and the verb table gates acting/answering but neither seeing (M3) nor voice-triggered barge-in (M5). Resolve H1/H2 and tighten M3/M5/M6 before this is implementable as a secure design.

---

### Architecture

| Sev | Finding | Location |
|---|---|---|
| **Major 1** | **SSOT claim overreaches; transient-state owner unnamed.** Store is SSOT for *committed* entries. The §7.2 snapshot (active turn id, accumulated text, in-flight tool, prompts, audio state) is in-memory transient state — a third source of truth the spec's "no separate mirror" framing silently excludes. Qualify: SSOT for *committed* entries; transient in-flight state lives on `SessionRuntime`, materialized as a read-only view at attach time. Name the owner module. | §7.2 vs 2.0 §3.3 |
| **Major 2** | **`SessionRuntime` cohesion: ~5 new units piled in without a module map.** Spec adds derived-retention + timer + generation-stamped disposal, the subscriber set + lease, attachment-verb mediation, the attach linearization point, and the relocated permission broker — none named as modules. Against `architecture.md` "split a unit the moment its responsibilities diverge." Provide a module map in §11: `runtime/session-retention.ts`, `session/subscribers.ts`, `runtime/session-permission-broker.ts`, `runtime/auxiliary-task.ts`, `runtime/turn-state-snapshot.ts`. | §5, §2.4, §3.4, §7.2, §6, §2.4 |
| **Major 3** | **Registry inversion is unnamed** (headline above). | §2.3 |
| **Major 4** | **PermissionBroker relocation seam undefined.** Existing broker (`permission-broker.ts:14`) is hard-wired to `ws.data.permissions` + single `requestConfirm` sink; `ToolBroker.requestConfirm` is bound to *this connection's* broker at the composition root. New shape must fan out to N eligible attachments, accept first answer, refuse seconds, survive a subscriber leaving mid-prompt, respect per-attachment `approve`. Define a `SessionPermissionBroker` interface + rebind point, or a thin wrapper will re-introduce per-connection resolution semantics under a session-scope façade. | §2.4 |
| **Major 5** | **Command-binding mediator unnamed.** Today `ws.data.runtime` is the per-connection ambient seam (`ws-session-configure.ts:52`). For multi-surface, commands must bind to session + attachment generation, pass a verb check, drop stale-generation traffic — at a single choke point (mirroring `ToolBroker`'s single-gate discipline). Name a `CommandMediator` / `AttachmentPDP` or verb enforcement gets sprinkled across `ws-handlers.ts`. | §8.4, §3.4 |
| **Minor 6** | **"Observer" naming undersells the coupling.** `submit`/`interrupt`/`approve` are commands, not observations. "Observer" nudges toward a passive subscriber API when the spec needs an active-participant API with attenuated verbs. Use "attached participant / subscriber with rights." | §2 |
| **Minor 7** | **Journal lane boundary not stated as a boundary.** Today `FrameJournal` journals *every* outbound frame. Spec narrows it to the session lane but states it as a table row, not a boundary. State: journal is the session lane; connection-lane frames emitted unjournaled; `FrameJournal` gains a lane tag or session-only write API. | §2.1 |
| **Minor 8** | **TTS/audio fan-out composition unspecified.** Decorator rule needs AsyncGenerator in/out at every stage. Fan-out can sit at synth output (N WS emitters, new pipeline stage) or at the journal (one frame, N cursors, pipeline unchanged). Specify the journal choice so the decorator chain stays linear. | §9 |
| **Minor 9** | **Module-file map absent from §11** (cf. Major 2). | §11 |
| **Minor 10** | **Voice abort model is connection-scoped, not session-scoped.** `bargeIn` arrives on the WS connection that owns the ambient runtime (`session-runtime.ts:149`). The §8.3 deferral reads as an arbitration policy, but the actual architectural issue is that `bargeIn` lives on the connection — the *input* to the arbitration is wrong-scoped. Note the re-scoping is part of the §8.3 decision, not separable. | §8.3 |

**Sound:** §3.2 capability-hole closure, §3.3 minting, §5 derived-retention (right instinct, matches fail-closed), §4.1 migration-ladder, §7.1 linearization point (atomic `{store watermark, journal seq}` + buffer + drain), §2.1 two-lane split, §8.1/§8.3 honestly flagged.

**Architecture verdict:** sound at the seam level — opaque server-minted sessions, capability-scoped store, attached participants with attenuated verbs, two-lane journal, derived retention with generation-stamped disposal, auxiliary-task seam are all correct and well-grounded. Gap is unit decomposition and boundary naming: ~5 load-bearing units introduced without a module map or interface definitions; SSOT claim unqualified for transient turn state; two registry inversions named as relocations rather than the seam-replacing cutovers they are. Implementation risk = a `SessionRuntime` god-class + thin wrappers re-introducing per-connection behavior.

---

### Maintainability

| Sev | Finding | Location |
|---|---|---|
| **Major 1** | **Retention predicate: magic terms and unconfig'd tunables baked in.** Six boolean terms combined with `||` (`subscribers > 0`, `a turn in flight`, `awaiting foreground tool`, `background task unfinished`, `permission prompt outstanding`, `auxiliary task not returned`) — none named. `15 minutes` literal appears 3×; only `replay_journal_retention_ms` (renamed) is named. An implementer invents six field names and tunes timers with no config home. Name each term per "booleans as questions" (`hasSubscribers`, `isTurnInFlight`, `hasPendingForegroundTool`, `hasUnfinishedBackgroundTask`, `hasOutstandingPrompt`, `hasAuxiliaryTaskInFlight`); state the retention window is *only* the renamed config key. | §5, §5.3 |
| **Major 2** | **Two-lane frame taxonomy asserted but not enumerated.** Spec mandates an enumeration ("a frame type added later with no lane assignment is a contract break") but provides only examples. "Audio" alone is several frame types. Untestable as written. Add an explicit `frame_type → lane` table against the current wire protocol in `shared/protocol/`. | §2.1 |
| **Major 3** | **"Stimulus"/"surface"/"turn"/"replay"/"attachment" used as defined terms but never defined.** "Turn" is overloaded (turn in flight / active turn id / mid-turn / back-to-back turn / running turn — is a turn a ReAct iteration or the whole lifecycle?). "Replay" used two ways. Add a short Terms block. | throughout |
| **Major 4** | **Titling knobs have no config home.** "3–5 word target", "small output cap", "reasoning effort off", "small input truncation chars" — all tunable per the clean-code rule, none given config keys. Sketch `orchestrator.titling: { … }` + name the `.md` template path + operator override dir. | §6 |
| **Major 5** | **Attachment verbs hardcoded 4-tuple, no extensibility story.** §3.4 claims extensibility ("a restricted surface is a policy entry, not a redesign") but hardcodes the verbs; a 5th verb (e.g. `speak`, `delegate`) is a code change to the enum + every mediator, not a policy entry. Either say the verb set is closed for this wave (honest) or hoist it into a policy enum so the claim holds. | §3.4, §11 |
| **Minor 1** | **`replay_journal_max_bytes` "becomes per session" — silent invariant change.** Today per-surface (config comment line 73); spec says per-session = 1×→N× multiplier with no re-tune. Cite §8.2 in §5.3. | §5.3 |
| **Minor 2** | **E2E matrix has hardcoded credentials/surface list and no tags.** "Ada PIN 1234" / "desktop ×2" / "mobile" hardcoded per row; no `Tags` column; cube (foreseeable 3rd surface, ESP32) not assumed. Defer credentials to the case library; add tags so `run-e2e.sh --tags` works. | §10 |
| **Minor 3** | **Legacy `c::<userId>::<surfaceId>` shape will rot.** Add a sunset note: one-shot migration rewriting `session_id` to a §3.3 id is the clean exit. | §3.5.4 |
| **Minor 4** | **§8.3 voice-concurrency decision criterion unstated.** Three options (arbitrate / queue / reject), no selection axis. State the trade-off axis so the next person has a frame. | §8.3 |
| **Minor 5** | **`SessionRetention` is a noun, not an action/question.** Per rules: functions as actions, booleans as questions. Rename to `computeRetentionReasons()` returning a non-empty list when retained; `isRetained()` derived. | §5 |
| **Minor 6** | **§7.1 linearization point invariant entanglement.** Four sub-steps testable only as a whole. State the four sub-invariants separately + note which are unit-testable in isolation. | §7.1 |
| **Minor 7** | **§2.2 "Reconnect stops being special" contradicted by §7.** §2.2 sells one unified operation; §7 distinguishes joiner (snapshot, no audio replay) vs reconnecter (cursor replay incl. audio). Soften §2.2: they share the journal+cursor primitive, differ in the snapshot handshake. | §2.2 vs §7 |

**Maintainability verdict:** well-argued and honestly reconciled with source, but written to *persuade* more than to *implement* — load-bearing invariants (the retention predicate's six unnamed terms, the frame→lane enumeration, the titling tunables) are prose where named constants, an explicit table, and a sketched config section would let an implementer proceed without guessing. Maintainable once filled in; as written a maintainer spends a real afternoon reverse-engineering terms and tunables the spec should have pinned.

---

### Correctness / Internal Consistency

| Sev | Finding | Location |
|---|---|---|
| **Blocker 1** | **`SessionRuntime` cardinality never redefined** (headline above). | §2.2, §5 |
| **Major 1** | **"Mint atomically" claims an atomicity impossible across DB commit + wire send.** The id ack is a connection-lane wire frame (§2.1) that cannot be part of a SQLite transaction. Failure: server commits row+entry, socket drops before ack, client retries → a *second* session is minted, first is a ghost with an orphaned entry the user can never address. Either make the client idempotent on mint (client `clientId`, server dedups on `(userId, clientId)`) or weaken to "DB commit atomic; ack best-effort; retry MUST be idempotent" + specify the retry contract. | §4.2 |
| **Major 2** | **`render(replay) == render(live)` asserted for joiners but not mechanized; snapshot not journaled.** Joiner live = snapshot + future frames; joiner later replay-from-head = future frames only (snapshot is transient, deltas behind the cursor). They diverge for the in-flight turn. §8.1's "forced re-snapshot" path admits replay ≠ live. Pick one: (a) journal the snapshot as a synthetic `turn.snapshot` frame at the joiner's cursor seq; (b) define replay as "snapshot-at-replay-time" server-derived; (c) narrow the invariant to committed entries and carve out the in-flight turn as a documented exception. | §7.2 |
| **Major 3** | **Concurrent voice (§8.3) "undefined," but at-most-one-turn invariant silently depends on it.** Cancellation is surface-agnostic (2.0 §4.7 barge-in on ambient runtime; entries carry no `sourceSurface`). Two surfaces' STT both calling `bargeIn` on the shared runtime = two aborts on one `AbortController`; spec doesn't say whether the second is no-op, throws, double-commits a cutoff entry, or races the first. Specify the interim contract: "barge-in is idempotent within a turn — once aborted, further barge-in signals are dropped without a second cutoff entry." Note whether `sourceSurface` is added this wave (a §4.1 migration-ladder change). | §8.3 vs §2.2 |
| **Minor 1** | **§2.2/§7.2 joiner-vs-reconnecter presentation** (same as Maintainability Minor 7; correctness-wise it *is* one operation `replay-from(N)` + `snapshot`, N==head vs N<head — state it to avoid two code paths). | §2.2, §7.2 |
| **Minor 2** | **§3.6 "privileged commands" undefined.** Which verbs require revalidation? Suggest all four — `observe` is reading session content a revoked principal must not keep doing. | §3.6 |
| **Minor 3** | **Titling on a cutoff first reply unspecified.** Does the titler fire on a committed-but-cutoff entry? Say: fires on the first *completed* assistant entry only; a cutoff does not trigger it. | §6 |
| **Minor 4** | **Retention has no periodic re-evaluation; a lost bg-task completion leaks the session forever.** Derivation triggers on state-change events. If a bg worker crashes without emitting completion, "registered and unfinished" stays true forever → 15-min timer never starts. Specify a re-eval heartbeat + a watchdog on registered bg tasks (max heartbeat gap marks "lost", removes from predicate, WARN). | §5 |
| **Minor 5** | **Barge-in racing a bg-task completion unstated.** Confirm: "if a barge-in and a bg-task completion land in the same tick, abort commits the cutoff first; completion becomes the first stimulus of the next turn. Order is fixed, not racy." | §8.3 / 2.0 §4.5 |
| **Minor 6** | **Eviction-vs-replay resolution listed as "define," not decided** (bears on Major 2's invariant). State the chosen direction (snapshot vs disconnect) so implementers don't pick opposite defaults. | §8.1 |
| **Minor 7** | **§8.4 command-binding describes direction, not contract.** "Dropped" = silent? error frame? STT reset = discard buffer or commit partial? Specify: drop + emit `command.rejected reason=stale_generation` + discard in-flight STT buffer without committing. | §8.4 |
| **Minor 8** | **§4.1 / §8.3 don't cross-reference the migration ladder.** A `sourceSurface` column is a §4.1 migration-ladder change, not a `STORE_DDL` edit — an implementer might ship the exact D14 bug §4.1 warns about. | §8.3 vs §4.1 |

**Sound (verified):** two-lane separation, sessionId security (§3.3), unknown-id rejection (§3.5 #2 — closes live `ws-session-configure.ts:355` silent-create), legacy coexistence without prefix parsing, L2 hole identification, titling CAS (version + `provenance=user` refusal), retention FSM generation-stamped disposal, permission fan-out contract.

**Correctness verdict:** internally coherent on identity, security, lane separation, retention, and `[corrected]` claims hold against source — but under-specifies the one structural change everything depends on (B1) and makes two false atomicity/universal-invariant claims (mint "commits together" across DB+wire, M1; `render(replay)==render(live)` for joiners without a journaled snapshot, M2). Fix B1, M1, M2, and the §8.3 interim contract (M3) before this spec drives implementation.

---

### Session Model / State Ownership

| Sev | Finding | Location |
|---|---|---|
| **Blocker 1** | **Runtime identity change implicit** (headline above). | §2, §2.2, §11 |
| **Major 1** | **Surfaces are not pure observers; tagline oversells.** §7.2 concedes a joining surface receives in-flight transient state (active turn id, deltas, prompts, audio state) NOT in the committed store, and must hold/mutate that snapshot locally — a participant with render-local state, not an observer. Restate: "A surface is a *subscriber* — observer of the journal + a one-time transient snapshot + owner of its own playback queue; holds no authority except attachment verbs." Drop "pure observer." | §2, §7.2 |
| **Major 2** | **`render(replay) == render(live)` does not hold for a fresh joiner without the snapshot** (correctness Major 2, from the ownership lens). A reconnecter replays from a seq it reached; a fresh joiner mid-turn cannot reach live state by replaying the store. State precisely: `render(replay_from_seq) == render(live_at_seq)` for any seq the client genuinely reached; a fresh joiner at seq=0 mid-turn is reconstructed via `snapshot ∪ replay_from_watermark` — a different, defined path — converging once the in-flight turn commits. | §7.2 |
| **Major 3** | **Snapshot ownership undefined.** §7 lists snapshot fields, assigns no owner. Candidates: `SessionRuntime` (owns live turn), journal (owns in-flight frames — would carry transient frames projections don't read), a new projection (derives transient state). The choice determines whether the runtime is reachable from attach, whether the journal holds non-store frames, and whether the snapshot is recomputable after a runtime crash. Recommend: `SessionRuntime` owns and emits it atomically on attach; journal owns the cursor watermark; snapshot is *not* journaled (recomputed live). State what happens if the runtime is not resident at attach. | §7, §7.1 |
| **Major 4** | **§8.4 command binding is a prerequisite for the D15 fix, not a "risk."** The redesign's stated motivation (D15 — "+ new chat" leaks context) requires session switching; §8.4 says in-flight commands today carry no session id and use the ambient runtime — so the moment you allow switching, a pre-switch command lands on the wrong session. Filing this under "Risks" lets the wave ship without it. Promote to wave-1 requirement: all command frames MUST carry `sessionId` + `attachmentGeneration`; stale dropped + STT reset. It is the prerequisite for the headline feature. | §8.4, §1 |
| **Major 5** | **Drift is relocated, not eliminated.** The old `ConversationMirror` drift was already fixed by the 2.0 store-as-SSOT move. The drift this wave addresses is the *frame journal* being per-surface — a different sync problem — and the redesign introduces NEW drift: a slow subscriber's prerequisite frames evicted while it lags (§8.1), shared journal now holds audio for an hour across N surfaces (§8.2). §1 "fixes drift" oversells. Reframe: win is "+ new chat allocator + past-chat list + multi-surface fan-out," not "fixes drift." Promote §8.1's bounded-lag policy to a wave-1 decision. | §1, §2.3, §8.1, §8.2 |
| **Major 6** | **Voice concurrency (§8.3) is the sharpest demonstration the identity change has teeth, and is unresolved.** Under the old per-surface model, barge-in on A aborts A's turn — B unaffected. Under one-runtime-per-session, barge-in on *any* surface aborts the *shared* turn for *all*. This is where the model changes user-visible behavior, not just bookkeeping — and voice is the primary surface. Decide in-wave: arbitrate (first STT onset wins; others rejected with a "session busy" frame); state whether entries gain `sourceSurfaceId` (compatible with canonical Invariant A). Tag a `two-surfaces-voice` e2e row once decided. | §8.3 |
| **Minor 1** | **Mint acknowledgement broadcast to all attached surfaces unspecified.** Two surfaces can attach to an empty draft before either sends. When the first message mints the id, the spec says the *sender* gets the ack — but other attached surfaces hold a draft with no id. Add: mint broadcasts the new `sessionId` on the session lane to every attached surface; a draft-attached surface transitions to the minted id without re-attach. | §4.2 |
| **Minor 2** | **Compaction × snapshot interaction unspecified.** §7 snapshot includes in-flight tool state but not a compaction boundary. A joiner arriving just after compaction needs the marker in its model projection. State: the snapshot's model-projection slice is computed from the latest `compaction` entry forward, identically to a live iteration; the snapshot carries no compaction field. | §7 / 2.0 §3.4 |
| **Minor 3** | **Permission-prompt timeout outcome unstated.** Restate: timeout resolves to `deny` (fail-closed); a prompt with zero eligible approvers is denied immediately, not queued. | §2.4 |
| **Minor 4** | **Legacy `surfaceId` embedded in `c::` is now dead metadata.** State it is *ignored* (carries no authority), preserved only for id stability. | §3.5.4 |
| **Minor 5** | **Background-task crash-recovery multi-surface angle is new.** Under the new model a bg task completing after gateway restart has no resident runtime to receive its stimulus. Append to the filed `docs/native-todo.md` item. | §9 |

**Session-model verdict:** "server-minted sessions, surfaces as observers" is coherent and defensible *if and only if* the spec makes the implicit `SessionRuntime` identity rewrite explicit (B1) — until then it is internally inconsistent with the canonical 2.0 design and `CLAUDE.md`, both of which still pin runtime identity to `(userId, surfaceId)`. The redesign earns its keep on multi-surface fan-out and the "+ new chat" allocator, but does not eliminate drift so much as relocate it (per-surface mirror → per-cursor lag in a shared journal), and the "surfaces as observers" tagline is oversold — the spec's own attach protocol (§7.2) requires surfaces to carry a server-sent transient snapshot and own their audio playback head, making them subscribers with render-local state, not pure observers.

---

### Testing / Observability

**Clears the mandatory bar:** inline e2e matrix exists (§10) with the required fixed columns (`Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail`); security rows flagged drivable (not reasoned); multi-surface happy + edge paths present (`two-surfaces-live`, `join-midturn`, `join-race`, `permission-either-answers`, `stop-from-either`, `last-one-out`, `connection-lane-private`, `reload-convergence`); `render(replay)==render(live)` exercised by `reload-convergence` + `session-resume`; log-trail column reuses the 2.0 log-tag vocabulary; privacy respected (matrix asserts ids/tags/reasons, not transcript).

| Sev | Finding | Location |
|---|---|---|
| **Major 1** | **Barge-in cutoff absent from the matrix.** `stop-from-either` produces `cutoff="interrupt"`; no row produces `cutoff="barge-in"`. Cutoff kind is an FSM invariant (CLAUDE.md: "Cutoff kinds: interrupt \| barge-in"); if it silently round-trips to NULL/`interrupt` on persist, `render(replay)==render(live)` is meaningless. Add `barge-in-cutoff` (real-mic / physical-only, flagged) OR explicitly defer with the reason. | §10 / §8.3 |
| **Major 2** | **Background-task follow-up turn + aborted-mid-tool entries lack rows.** `retention-holds-work` covers one clause; the retention predicate has five. Missing: (a) bg task completing after the dispatching turn's final answer (back-to-back follow-up — the delegation seam's hallmark; template = `delegate-hermes-bg` / `steer-followup-audio`); (b) Stop while a foreground tool is in flight (entry committed with cutoff + `isError` tool tile, recoverable in replay). | §10 / §2.2, §5 |
| **Major 3** | **Disposal race + retention timer invariants have no row.** `retention-drops-idle` checks happy disposal, but the race §5.1 explicitly singles out ("a timer that fired while a surface was attaching cannot dispose a live session") has no row. This is an FSM/invariant with a documented learning — exactly the testing.md bar. Add `retention-timer-race` (mark `fault-armed` if it needs harness timing injection). | §5.1 / §10 |
| **Major 4** | **Attachment generation / stale-command binding unexercised.** §8.4 calls stale-generation drop a required behavior; no row drives it. A session switch mid-`text.input` is the cross-session analog of reconnect/cross-tab. Add `stale-generation-dropped`. | §8.4 / §10 |
| **Major 5** | **Loggable IDs under-specified for multi-surface tracing.** Rules require `utteranceId`/`responseId`/`sessionId`/`cycleId` for tracing. Spec mints `sessionId` + reuses `turnId` but never names: a **surface/attachment id** (needed to attribute "Stop from B vs A" in a multi-surface log stream), a **stimulus id** (to fold a steer into a turn in the log), and whether `sessionId` is threaded onto *every* log line. With N surfaces one session, `[runtime:react-loop] react-loop.start turnId=…` no longer tells you which session. This is the single biggest observability regression the design introduces. Add a "Logging contract" subsection: every session-lane line carries `sessionId`+`turnId`; every command/permission/Stop line carries `attachmentId`+`sessionId`; every bg-completion stimulus carries a `stimulusId`. Reference these in the matrix log-trail column. | §3.3, §7, §10 |
| **Minor 6** | **Retention "returns reasons, not boolean, and logs them" asserted but not driven.** Five clauses each deserve a one-liner that the reason string names the holding clause. Pin the literal format (e.g. `retained reason="background-task-unfinished"`). | §5 / §10 |
| **Minor 7** | **Titler fallback log thin.** Matrix says "failure logged with a reason" but doesn't pin the literal — an implementer could log `title.failed` (no reason) and pass. Specify: `titler.failed reason=<…> fallback="truncated-first-message" provenance="generated"`. | §6 / §10 |
| **Minor 8** | **Two-lane privacy boundary has only one row.** `connection-lane-private` only checks `resume`. Widen to force resume + ping + auth refresh on A and assert the full connection-lane set absent on B. | §2.1 / §10 |
| **Minor 9** | **`join-midturn` doesn't assert "no re-spoken audio" log evidence.** Log column says "cursor at head" but doesn't assert audio-replay suppression. Add: `[ws:turn-emitter] audio.skip-reason="midturn-join"`. | §7.2 / §10 |

**Testing/observability verdict:** clears the mandatory bar (concrete inline matrix, security rows drivable, multi-surface + reload/replay covered) — but the cutoff kind (`barge-in`), the background-completion follow-up turn, the §5.1 disposal race, and the §8.4 stale-generation drop are all named in the spec's prose as required behaviors yet missing from the matrix, under-covering the very FSM edges the design exists to protect. The bigger observability gap: the spec introduces multi-surface fan-out without mandating `sessionId` + `attachmentId` + `stimulusId` on the log contract — under one-surface-per-session `turnId` threading sufficed; with N subscribers an unattributed `Stop` or un-threaded `react-loop.start` makes a turn un-traceable end-to-end, silently breaking the "logs answer every transition" guarantee the logging rules require.

---

## Cross-dimension synthesis — what to fix first

Ranked by how many dimensions independently flagged each item:

1. **`SessionRuntime` identity rewrite must be explicit** — security H2, architecture Major 3, correctness B1, session-model B1. *Do this first; everything else hangs off it.* Add the "Identity rewrite" section; replace the registry; update 2.0 §2.6 + `CLAUDE.md`.
2. **`render(replay)==render(live)` for joiners is not mechanized** — correctness M2, session-model M2, architecture Major 1, testing Major 1 (the cutoff-kind row that would expose it). Decide snapshot-vs-replay and journal-or-derive; write it down.
3. **Mint atomicity across DB+wire is a false claim** — correctness M1, session-model Minor 1 (broadcast), session-model Minor 2 (compaction). Specify client idempotency on mint + the ack broadcast contract.
4. **§8.3 voice-concurrency interim contract + the `barge-in` verb/abort gap** — security M5, architecture Minor 10, correctness M3, session-model Major 6, testing Major 1. Even if full arbitration is deferred, the interim idempotency + the `audio.start` verb gate + the `barge-in` re-scoping must be in-wave.
5. **Surface identity is unauthenticated** — security H1 alone, but it invalidates the verb table the architecture and session-model reviews treat as load-bearing. Without this, M3/M4/M5 fixes are cosmetic.
6. **Module map + named seams** — architecture Major 2/4/5, maintainability Major 1/2/3. ~5 units introduced without file/interface definitions; the `SessionRuntime` god-class risk is real and the codebase has the scars (`ws-session-configure.ts` 22 KB, `session-runtime.ts` 35 KB).
7. **§8.4 command binding is a prerequisite, not a risk** — session-model Major 4, correctness Minor 7, testing Major 4. It is the correctness condition for the D15 feature the redesign exists to ship; promote to wave-1.
8. **Multi-surface logging contract** — testing Major 5. The biggest observability regression; cheap to specify now, expensive to retrofit.

**Two framing fixes** (cheap, high-clarity): restate §1 — the win is the allocator + past-chat list + fan-out, not "fixes drift" (drift is relocated, §8.1/§8.2 introduce new lag/eviction drift); and drop "surfaces as observers" in favor of "subscribers with rights" (§7.2's own attach protocol contradicts the tagline).

---

## Areas verified sound (do not re-litigate)

- §3.3 sessionId minting (CSPRNG ≥128 bits, opaque, do-not-reuse) — correctly flags live `Math.random().toString(36)`.
- §3.2 L2 resource-class hole — verified against `session-store.ts:85-89` and `tool-broker.ts:147`; real confused-deputy gap.
- §3.5 #2 unknown-id rejection — closes live `ws-session-configure.ts:355` silent-create.
- §4.1 migration-ladder instruction — respects `schema.ts` frozen-baseline + the D14 lesson.
- §7.1 attach linearization point (atomic `{store watermark, journal seq}` + buffer + drain) — correct race-free pattern.
- §5 derived-retention + generation-stamped disposal — right instinct, matches fail-closed (gated on the missing re-eval heartbeat, correctness Minor 4).
- §6 titling CAS (version + `provenance=user` refusal) — sound two-guard scheme.
- Replay cannot alter future auth — auth re-minted from token at each connection; store holds no auth tokens.
- Cross-user read blocked structurally (one SQLite file per user, capability-chosen path) + by membership lookup.

---

*End of fleet review. Six dimensions, one structural blocker reaching across four of them. The spec is honest and well-grounded against source; the gaps are in making the implicit identity rewrite explicit, mechanizing the two universal invariants it asserts, and pinning the new authority/observability surfaces it introduces.*