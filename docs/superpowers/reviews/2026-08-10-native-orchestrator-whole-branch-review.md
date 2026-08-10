# Native-Orchestrator Whole-Branch Review

**Branch:** `feature/native-orchestrator`
**Range:** `develop` (e74281e6) → `HEAD` (6b519934)
**Scope:** 1165 files, +141,579 / −39,859 (509 added, 431 modified, 222 deleted)
**Date:** 2026-08-10
**Method:** six read-only review subagents fanned out across dimensions (architecture, security, ReAct-loop correctness, memory+dreamer, protocol+SDK+mobile, tests+e2e), findings verified against source where flagged, then synthesized.

---

## Executive Summary

The branch delivers the Sentient 2.0 native-orchestrator pivot cleanly: the gateway owns the whole agent harness (ReAct loop, prompt caching, compaction, tool-call format, permission mediation), Hermes is demoted to one background `delegateTask` tool, the legacy ACP/cerebrum stack is purged, and a capability-based security model + a memory/dreamer subsystem are layered on top. The architecture is faithful to the canonical design spec to the letter — the one-turn-at-a-time lock, store-as-queue steering, append-only session store, divergent model/client projections, capability-by-value handles, and background-tasks-outlive-the-turn are all correctly enforced and well-documented. The legacy purge is clean (grep confirms only comments reference the deleted constructs).

**Three Critical findings block merge.** All are narrow:

1. **Time-range filter silently no-ops** — client sends `from`/`to`, server reads `start`/`end`. Affects `memory_recall` search **and** the poison-remediation `purge` path (spec §3.8). Security-relevant.
2. **Wire-mock drift in `sentient-sdk.test.ts`** — mocks `conversation.snapshot` with `entries`; the real schema field is `items`. Masks production breakage.
3. **Native-stack-migration spec has no inline e2e matrix** — violates the e2e rule ("a doc with no matrix is a wish").

**Thirteen Important findings** — mostly one-line or small-isolated fixes. The most consequential is a `revokeAuthority` bypass: the back-to-back turn path calls `startTurn` without re-checking `revokedReason`, so a revoked account's late background completion can start a headless follow-up turn under the old capability. One-line fix.

**Verdict: With fixes.** No structural rework needed. The branch is merge-ready after the three Critical fixes and the `revokeAuthority` one-liner; the remaining Important items can land in the same pass or as immediate follow-ups.

---

## Findings by Severity

### Critical (Must Fix)

#### C1 — Time-range filter silently no-ops on search AND purge
- **Files:** `gateway/src/memory/deep-memory-client.ts:84`, `capabilityServices/DeepMemoryService/src/deep_memory/index.py:343-349`, `gateway/src/tools/memory-tools.ts:836-844`
- **What:** Client declares `timeRange?: { from?: string; to?: string }` and sends exactly that. Server's `_append_time_range` reads `time_range.get("start")` / `time_range.get("end")` — both always `None`, so no SQL clause is added.
- **Why it matters:** `memory_recall` with a `timeRange` appears to work but returns unfiltered hits. Worse, `purge({timeRange})` — the poison-remediation path (spec §3.8) — silently purges **nothing** when the bound doesn't apply. A poisoned session's entries survive a time-bounded purge, giving a false sense of remediation. The stub engine ignores `time_range`, so this was invisible to wire tests.
- **Fix:** Pick one canonical pair (`from`/`to` or `start`/`end`) and align both sides. Add a wire-contract test exercising time-range filtering against the real `SqliteIndexEngine`.
- **Verified:** confirmed by direct grep — client `from`/`to` at `deep-memory-client.ts:84`, server `start`/`end` reader at `index.py:343`.

#### C2 — Wire-mock drift in `sentient-sdk.test.ts`
- **File:** `shared/web-sdk/src/sentient-sdk.test.ts:198,157,197,209`
- **What:** `:198` delivers `{ type: "conversation.snapshot", entries: [] }`, but the real schema field is `items` (`shared/protocol/src/messages.ts:610`). `:157` `auth.ok` omits the required `user` block; `:197` `session.ready` omits all four required audio/effect fields; `:209` `session.draft` omits required `ts`. Every one would fail `gatewayMessageSchema.safeParse`.
- **Why it matters:** A server sending `items` while the test asserts `entries` actively masks a real field mismatch — exactly the "convenient envelope that drifts" the testing rule warns about. The whole point of wire tests is to catch the break the mock currently hides.
- **Fix:** Match the gold standard in `permission-confirm-connector.test.ts` — include every required field with schema-valid values; ideally parse mocks through `gatewayMessageSchema` before emit.
- **Verified:** confirmed — `messages.ts:610` is `items: z.array(conversationFeedItemSchema)`.

#### C3 — Native-stack-migration spec missing inline e2e matrix
- **File:** `docs/superpowers/specs/2026-07-29-native-stack-migration-design.md:253,255,280`
- **What:** Only reduced-column summary tables (`Case | Surface | Agent-drivable?`); the full 6-column contract appears only in prose. The other four specs (2.0 design, session-model, memory-system, skill-system) all carry the required table.
- **Why it matters:** e2e rule: "A doc with no matrix is a wish, not a spec." Native-stack migration is a prod-deployed change; it needs the concrete `Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail` table.
- **Fix:** Add the inline matrix table.

### Important (Should Fix)

#### I1 — `revokeAuthority` bypass in back-to-back turn path *(security-relevant)*
- **File:** `gateway/src/runtime/session-runtime.ts:911,944`
- **What:** `onTurnSettled` calls `startTurn(nextTurnId, trigger)` at `:911`. `startTurn` (`:944`) guards only `if (inFlight !== null) return;` — it does **not** check `revokedReason`. `submit` checks `revokedReason` at `:1166` before calling `startTurn`, but the back-to-back path reaches `startTurn` directly. A background completion arriving after the running turn's last iteration, while the account is revoked, starts a new ReAct turn under the pre-revocation capability with no window attached.
- **Why it matters:** A demoted admin's late background completion triggers a headless follow-up turn dispatching tools at the old role. A chain of completions is unbounded — the spec's `revokeAuthority` comment explicitly claims to close "the unbounded case" but misses this second new-turn entry point.
- **Fix:** Add `if (revokedReason !== null) return;` at the top of `startTurn` (before the `inFlight` check). Redundant for the `submit` path, closes the back-to-back gap.
- **Verified:** confirmed — `startTurn` body checks `inFlight` only, no `revokedReason`.

#### I2 — No mid-stream timeout on the provider stream
- **File:** `gateway/src/runtime/openai-provider.ts:17`, `gateway/src/runtime/react-loop.ts:383`
- **What:** `timeout: cfg.request_timeout_ms` covers the HTTP request (time to headers), not mid-stream consumption. The `for await (const chunk of stream)` loop blocks until a chunk arrives, the stream ends, or `signal` aborts — and `signal` is only aborted by user gestures (barge-in/interrupt/dispose), not a stall detector.
- **Why it matters:** A provider that stalls mid-stream holds the one-turn lock indefinitely. The session appears "running" forever, blocking the dreamer. Inherited, not introduced, by this branch — but the orchestrator now owns the provider call directly, so it owns this.
- **Fix:** Race the stream against `AbortSignal.timeout(cfg.request_timeout_ms)` merged with the turn's signal; on timeout abort the controller (failed, not cutoff).

#### I3 — PIN change/reset does not move the credential floor
- **Files:** `gateway/src/user-auth/auth-service.ts:157-166`, `gateway/src/admin/user-provisioner.ts:259-274`
- **What:** After `changePin` or `resetPin`, `credentialsValidFrom` is not advanced. Tokens minted under the old PIN remain valid for their full TTL. The code flags this as an "open question for the owner" but ships it unfixed.
- **Why it matters:** The field name `credentialsValidFrom` implies a PIN reset revokes prior credentials. An operator resetting a PIN because a credential leaked would reasonably expect old sessions to die — but a compromised PIN's existing tokens survive the rotation.
- **Fix:** Move the floor (write `credentialsValidFrom: now` in the same update as `pinHash`). At minimum, `resetPin` (operator resetting someone else) should move the floor unconditionally — the operator is not the session being killed. Accept the UX cost (user changing their own PIN gets kicked to login).

#### I4 — Dreamer `retireEntry` cannot reach section-level index entries → superseded facts surface in spark
- **Files:** `gateway/src/memory/dreamer/reconciler.ts:494-512`, `gateway/src/memory/index-sync.ts:340-359,314-330`, `gateway/src/bootstrap/phase-services.ts:910-912`
- **What:** Session-time writes (`memory_write` → `withIndexSync` → `enqueueFile`) create section-level index entries keyed with the heading. The dreamer opens the **raw** store (not `withIndexSync`-wrapped), so reconciler MEMORY.md edits don't re-feed `enqueueFile`. When the dreamer SUPERSEDEs a line, `retireEntry` computes an id without the heading — which doesn't exist in the index. The old section-level entry stays active; the new fact-level entry coexists. Spark can return the old, superseded fact.
- **Why it matters:** Correctness gap in the retrieval surface — a superseded fact surfaces in the spark block or `memory_recall` until a `rebuildScope` drops and re-feeds the index from canonical files. Not data loss (canonical MEMORY.md is correct); the derived index is stale.
- **Fix:** Have the reconciler use the `withIndexSync`-wrapped store (option a — simpler, makes dreamer writes consistent with session-time writes), or have `retireEntry` enumerate headings and retire section-level entries (option b).

#### I5 — `resolveWriteTarget` mkdirs before the symlink-escape check
- **File:** `gateway/src/memory/memory-store.ts:232-254`
- **What:** `mkdirSync(dir, { recursive: true })` at `:234` runs **before** `realpathSync(dir)` + `isWithin` guard at `:237-241`. If `dir` is a symlink escaping the grant, `mkdirSync` follows it and creates directories at the target before the guard refuses the file write.
- **Why it matters:** Defense-in-depth gap. The file write is correctly refused (returns null), but the filesystem side-effect (mkdir outside the grant) already happened. Requires a planted symlink inside the root (out-of-band write) — second-order confused-deputy.
- **Fix:** Check `realpathOrNull(dir)` is within `memoryRoot` **before** `mkdirSync`. If `dir` doesn't exist yet, walk up to the first existing ancestor, verify within root, then mkdir.

#### I6 — `deep-memory.lock` does not ship → release build fails
- **Files:** `deploy/README.md:207-213`, `deploy/mac-prod/native/requirements/`
- **What:** Only `whisper-stt.lock` and `local-tts.lock` exist; `deep-memory.lock` is documented as "must exist before the first real wheel build" but not committed. `scripts/build-python-wheels.sh` will fail or produce incomplete wheels for deep-memory.
- **Why it matters:** A prod upgrade including deep-memory fails at the wheel-build step. `optional: true` means the gateway still boots, but the memory index engine stays absent.
- **Fix:** Generate `deep-memory.lock` via the documented `uv pip freeze` / `uv pip compile` recipe and commit it, or gate the deep-memory wheel build on the lock file's presence with a clear error.

#### I7 — `store.db_filename` not threaded from config
- **File:** `gateway/src/runtime/session-store.ts:38-43`
- **What:** `DB_FILENAME = "sessions.db"` is hardcoded. The composition root threads `cfg.store.db_filename` (zod schema + config.yaml both define it), but `openSessionStore(cap)` takes only a `Capability` and ignores the value.
- **Why it matters:** Config-rule violation — an operator who changes `store.db_filename` in config.yaml is silently ignored.
- **Fix:** Add an optional `dbFileName` param (or config on the capability), thread `cfg.store.db_filename` from the three call sites, delete the constant.

#### I8 — Connector tests systematically omit the `type` literal
- **Files:** `shared/web-sdk/src/connectors/assistant-audio-response-connector.test.ts:47,60,71,84,92`; `cognition-status-connector.test.ts:36,41-43,57-153`; `task-list-connector.test.ts:51,68,79,104,123,144,157`; `delegation-progress-connector.test.ts:79,84,93`
- **What:** Tests `mock.emit(type, payload)` with payloads missing `type: z.literal(...)`. Handler dispatches by type key so tests pass, but the mock is a payload subset, not the frame the server emits.
- **Why it matters:** Mock drift — same class as C2, lower severity because the dispatch key is present. A schema field added later won't break these tests.
- **Fix:** Add the `type` field to each emitted mock, or assert the mock round-trips through the schema.

#### I9 — `smoke-send.yaml` missing `tags:` and login subflow
- **File:** `qa/mobile/flows/smoke-send.yaml`
- **What:** The only plain happy-path flow with no `tags:` and no conditional login subflow. Rule: "New flows MUST carry real `tags:`... a conditional login subflow."
- **Fix:** Add `tags: [chat]` and a `runFlow: { when: ..., file: _helpers/login.yaml }`.

#### I10 — ~31 Maestro wait sites >3000ms without inline justifying comment
- **Files:** Android settings `*b-restore`/cleanup/save flows (8000-10000ms), `60-model-offline-save-recover.yaml:32` (45000), `61-apply-conflict-trigger.yaml:26` (45000), `12-permission-confirm.yaml:49,81` (40000)
- **What:** Rule: visibility waits ≤3000ms, longer only with an inline comment justifying the wait.
- **Fix:** Add a one-line `#` comment above each (e.g. `# LLM round-trip`, `# permission broker 120s budget`).

#### I11 — Risk-accumulator `block` level never asserted to hard-deny
- **File:** `gateway/src/security/risk-accumulator.test.ts:49,106`
- **What:** Tests assert `block` is reached, but no test pins what the ToolBroker PDP does at `block` (it treats `block` and `escalate` identically — both → confirm, never hard-refuse).
- **Fix:** Add a ToolBroker test asserting behavior at `block`-level risk, or pin the design intent (confirm-only) explicitly.

#### I12 — Mobile `AuthUser` missing `role` field (mirror contract drift)
- **File:** `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/protocol/ServerMessage.kt:330-335`
- **What:** Protocol's `authUserSchema` requires `role: userRoleSchema`. Mobile `AuthUser` has only `userId, displayName, isAdmin, avatarTint`. `WireJson.ignoreUnknownKeys = true` silently drops `role`. Mobile uses `isAdmin` for admin gating today, so no runtime break — but mobile cannot read the user's role for the tool-permission system without a future change. Violates the web-sdk mirror contract ("mirror the EXACT message fields").
- **Fix:** Add `val role: String = "adult"` to `AuthUser` (default for `coerceInputValues` resilience, matching `DEFAULT_ROLE`).

#### I13 — Two stale sealed-class variants in mobile `ServerMessage` (dead code)
- **File:** `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/protocol/ServerMessage.kt:70-71,158-162`
- **What:** `SessionPreferencesChanged` and `ConnectorTranscriptFinal` are not in `gatewayMessageSchema` and never emitted by the gateway. `UserAudioInputConnector.kt:78` still handles `ConnectorTranscriptFinal` — dead code. The variants will never decode from a real wire frame (`@SerialName` won't match → `Unknown`).
- **Why it matters:** Maintenance trap — a reader may believe the gateway still sends them.
- **Fix:** Remove both variants; drop the `ConnectorTranscriptFinal` branch (2.0 replacement is `turn.started`-driven transcript, already handled).

### Minor (Nice to Have)

| # | File | Issue |
|---|------|-------|
| M1 | `gateway/src/tools/tool-broker.ts:917-967` | Background completion chain lacks terminal `.catch` — fire-and-forget `.then().then()` rejects unhandled if a callback throws. Low risk (guards exist) but fragile; add a `.catch(log.error)`. |
| M2 | `gateway/src/runtime/react-loop.ts:509` | `sessionBlock`/`situationBlock` renders don't accept AbortSignal — local reads, unlikely to hang, but if memory recall/file read stalls the turn hangs. Follow-up if blocks grow I/O. |
| M3 | `gateway/src/runtime/session-runtime.ts:732,795` | Orphan `tool_call` left in store after dispose-during-dispatch (foreground tool in flight holds session resident, so prevented in practice). Cosmetic WARN on every future turn; not a correctness bug. |
| M4 | `gateway/src/memory/dreamer/dream-transaction.ts:537-638` | `triggerDeepDream` implemented but not wired to any tool/API/scheduler. Reserved seam, not reachable — the "on-demand deep-dream trigger" commit message implies it's live. |
| M5 | `gateway/src/memory/deep-memory-wiring.ts:143-165` | Concurrent `flush()` calls from `withIndexSync` not mutexed — no corruption (upserts idempotent) but duplicate work. Add an in-flight promise. |
| M6 | `gateway/src/memory/deep-memory-client.ts:320-331` | `readHits` casts `body.hits as Hit[]` without validating the hit shape. Service is trusted/loopback; low risk. Validate with zod or document trust. |
| M7 | `shared/mobile-sdk/.../audio/EchoGate.kt:119,130,141` | `onPlaybackStart(cycleId: String)` etc. — param unused, `cycleId` is a retired concept (WIRE.md: "cycle.* is deleted"). Rename to `turnId`/`_unused`. |
| M8 | `shared/web-sdk/src/sdk-reconnect.ts:306` | Ping probe sends unspecced `at: Date.now()`; `pingSchema` is `{ type: "ping" }`. Harmless (zod ignores), minor wire drift. Drop the field. |
| M9 | `shared/web-sdk/src/connectors/cognition-status-connector.ts:69` | Capability string `"cognition.status"` retained though the frame is deleted; connector derives from `turn.*`/`tasklist.state`. Reader-confusing. Rename to `"cognition.state"` or document. |
| M10 | `shared/config/src/schema.ts:394` | Dead `channels.delegation_prompt` toggle (default `true`) — no code calls `gate.screen(..., { channel })`; prompt-classifier scans unconditionally (actually safer). Misleading dead config — remove or document advisory-only. |
| M11 | `shared/protocol/src/roles.ts:38` | `canExecute` gives `child` the `write` tier; memory tools mitigate family writes with an explicit adult gate, but other `write`-tier MCP tools are child-reachable. By design — operator awareness when adding `write`-tier tools. |
| M12 | `gateway/src/runtime/session-handlers/session-registry.ts:380` | `max_concurrent_sessions` (spec §2.6) unenforced at the registry layer — `attach` always builds unconditionally. Spec defers the scheduler; acceptable for family-scale walking skeleton. Flag for follow-up. |
| M13 | `gateway/src/bootstrap/phase-services.ts` (1593 lines) | Cohesive composition root (cohesion passes the clean-code test), but `buildDreamScheduler` and `buildOrchestratorServices` could extract if it grows further. |
| M14 | `delegated-broker.ts:61`, `phase-services.ts:866` | `DELEGATED_HOUSEHOLD_ID = "home"` and `DREAMER_HOUSEHOLD_ID = "home"` — independent literals for the same conceptual value ("households not modelled yet"). Share a constant when households land. |
| M15 | `gateway/src/store/conversation-feed.ts:59` | `USER_CHANNEL = "text"` regardless of STT/typed origin. Known deferral (needs a contract field); worth tracking for a voice gateway. |
| M16 | `shared/web-sdk/src/sdk-message-router.test.ts:193-228` | Uses synthetic types (`"test.event"`, `"no.seq"`) not in `gatewayMessageSchema` to test the seq-dedup layer. Acceptable for testing the dedup mechanism. |
| M17 | `gateway/src/runtime/session-runtime.test.ts:1227,1597` | "New bubble, audio queues behind" follow-up sub-invariant pinned as two separate halves (cutoff + audio-outlives-turn), not one end-to-end ordering test. Both halves solid. |
| M18 | `android/05-interrupt.yaml` | Asserts only the happy arm; interrupt path honestly labeled "unasserted." Interrupt surface not exercised on Android. |

---

## Dimension Summaries

### 1. Orchestrator Architecture & Intent-Alignment — ✅ sound
Spec alignment is faithful to the letter. At-most-one-turn enforced atomically (`session-runtime.ts:438-466`). Steering via store re-read every iteration (`react-loop.ts:499`). Append-only store enforced by interface (`SessionStore` exposes only `append` + reads). `render(replay) == render(live)` structural — `projectForClient` is the single path for both snapshot (replay) and entry (live), with a convergence contract test. Capability-by-value handles, role re-resolved per call, no ambient principal. System-orchestrator: one registry, one driver map, serialized applies, identity-verified health watchdog. Large prompts in `.md` with two-tier loader (operator override → baked-in). Single composition root. Legacy purge clean. Only `store.db_filename` (I7) and `max_concurrent_sessions` (M12) drift from spec.

### 2. Security — ✅ sound
Four-layer model structurally sound. L0 `Object.freeze`'d principal minted once. L1 AccessManager sole minting point. L3 `resolveDecision` single choke point, role gate runs first unconditionally, model-emitted tool call never authorization. Confirm is real (no window/timeout/throw → fail-closed deny). Inbound gate covers all five untrusted paths (tool results, background completions, skill bodies, memory bodies, delegation prompts). Delegation prompt direct-scan (no gate) is intentional and correct. `mcp-policy.yaml` truly deleted. PASETO v4.local with 32-byte secret, no authority claims, no refresh. DeepMemoryService split credentials with constant-time compare. Memory audience filtering on both read and recall. Path traversal/symlinks rejected via realpath + `isWithin`. Log sanitizer covers PASETO/Bearer/API keys. **No Critical.** PIN floor gap (I3) is the one real security gap — a documented open question that should be decided, not left.

### 3. ReAct-Loop Correctness — ✅ sound
Concurrency core well-designed and documented. One-turn lock atomic. Steering non-blocking (append + return; loop re-reads). Back-to-back follow-up correctly sequenced (`consumedThroughSeq` advance + audio drain chain). Background tasks outlive the turn in every case (`delegate-task.ts:239-248` deliberately unsubscribes from turn signal; `cancellation.ts` never calls `background.cancelAll()`). Lost-task watchdog bounded (double backstop: retention drop + process kill timeout). taskId server-minted (`crypto.randomUUID()`), completion as stimulus never polled. AbortSignal respected at every yield point. MCP client never re-invokes on failure ("this tool may have side effects"). Background dispatch dedup within a turn. Idempotent resend durable (queries store, not in-memory set). Compaction re-check+append one synchronous block. Render invariant holds. **No Critical.** `revokeAuthority` bypass (I1) is a real contract violation — one-line fix. Mid-stream timeout (I2) inherited but now owned.

### 4. Memory + Dreamer — ⚠️ one Critical, otherwise sound
Capability-rooted store with realpath guards (read + write). Per-surface scan severity well-reasoned (journal only `hostile` because re-screens at read; the false-positive fix). Taint propagation load-bearing through projection → map → episode/fact, with `mostTainted` aggregation pinning the poison session for purge. Dreamer prompt-injection resistance: fenced untrusted inputs + "data not instructions" framing + `split().join()` replace (avoids regex `$1`/`$&` mangling). Checkpoint idempotence (mark advances last, deterministic ids). Reconciler all-or-nothing six-phase batch (pre-validates ALL before any write). DeepMemoryClient typed errors + `AbortSignal.timeout` on every call. Split-credential auth + ScopeRegistry traversal boundary. Scheduler serial chain (one shared promise — no concurrent dreams). Dependency direction correct (gateway depends on abstract interfaces, never infra). **Critical: time-range mismatch (C1).** Important: retireEntry section-level gap (I4), mkdir-before-guard (I5), missing lock file (I6).

### 5. Protocol + SDK + Mobile — ✅ sound
Protocol docs exceptional (WIRE.md + `messages.ts` "why" comments). `replyId` consistently the bubble key across all three surfaces (web, Android, iOS mirror exactly). Client never invents ids (grep confirms no `Date.now`/timestamp id derivation — only in presence/idle timers and a ping stamp). Command binding stamped at one seam per surface. TurnAudioQueue strict sequential FIFO (new turnId appends; `cancelAll()` the only flush). PrivacyGuardTest covers every content-bearing sink incl. the new `argsPreview`. Reconnect refined (not rewritten to REST/SSE); network-change reconnect (NWPathMonitor / registerDefaultNetworkCallback → ensureConnected); expired-token → login (not retry loop). ToolPermissionPatch correct (wildcard + named values; "on" writes `null` not `ALLOW` to avoid confirm→auto-approve). `task-status-connector` cleanly removed (no dangling source refs). Tests mock exact wire shapes (gold standard). Opus parity wired (kopus + OggOpusDemuxer, lazy-armed). **No Critical.** Important: mobile `AuthUser.role` (I12), stale sealed variants (I13). Minor: EchoGate `cycleId`, ping `at`, cognition.status name.

### 6. Tests + e2e — ⚠️ two Critical, otherwise strong
Every critical FSM/invariant has a dedicated, sad-path-heavy test: at-most-one-turn, barge-in/interrupt cutoff, background-task survival across cancellation, back-to-back follow-up, `render(replay)==render(live)` (whole convergence file), audience enforcement (child filter on recall AND read), dreamer double-apply guard (idempotent re-run byte-identical), lost-task watchdog. Security boundaries sad-path-heavy (auth expired/tampered/wrong-role/deleted/demotion; prompt-injection uses an ATTACKS/BENIGN/FALSE_POSITIVES/MISSES **corpus** — gold standard). `@live` tests cleanly gated (`describe.skip` + env flag, zero-cost in CI; no real API keys in unit tests). Wire-mock gold standard exists (`permission-confirm-connector.test.ts`). 4/5 specs carry the required inline matrix; `testing-knowledge.md` grew ~992 lines. `qa/native` verifies against a real docker daemon. **Critical: C2 (sentient-sdk entries/items drift), C3 (missing matrix).** Important: connector `type`-literal drift (I8), `smoke-send.yaml` no tags (I9), ~31 unjustified long waits (I10), risk `block` untested (I11). No over-testing violations found — borderline files (`background-registry`, `spec-hash`, `types.test.ts`) each pin a documented contract or landmine.

---

## Cross-Dimension Invariants Verified

| Invariant | Verdict | Evidence |
|---|---|---|
| At most one turn per SessionRuntime | ✅ enforced | atomic check-and-set (`session-runtime.ts:438`); tested |
| Mid-turn stimulus steers via store re-read | ✅ | `react-loop.ts:499`; non-blocking |
| Background tasks outlive the turn | ✅ | deliberately unsubscribed from turn signal (`delegate-task.ts:239`); watchdog bounded |
| `render(replay) == render(live)` | ✅ structural | single `projectForClient` path; convergence test |
| Client never invents ids | ✅ | grep clean across web/Android/iOS |
| Capability-by-value, no ambient principal | ✅ | handles read role off capability; re-resolved per call |
| Model-emitted tool call ≠ authorization | ✅ | role gate runs first unconditionally |
| Side-effecting tools fail-closed | ✅ | no-window/timeout/throw → deny |
| Legacy constructs not reintroduced | ✅ | grep confirms only comments reference deleted code |
| Large prompts in `.md` not inline TS | ✅ | two-tier loader |
| Dependencies flow inward (memory) | ✅ | gateway depends on abstract interfaces |

---

## Recommended Fix Order

1. **C1** — align time-range fields (one-line either side) + add wire-contract test. Security-relevant (poison purge).
2. **I1** — add `if (revokedReason !== null) return;` to `startTurn`. One line, security-relevant.
3. **C2** — fix `sentient-sdk.test.ts` mocks to schema-valid `items` + required fields.
4. **C3** — add inline matrix to native-stack-migration spec.
5. **I3** — decide PIN floor policy; at minimum `resetPin` moves the floor.
6. **I6** — commit `deep-memory.lock` (blocks release path).
7. **I4, I5** — dreamer index staleness + mkdir-before-guard.
8. **I2** — mid-stream provider timeout.
9. **I8–I13** + minors — test hygiene, mirror-contract, dead code, config threading.

---

## Assessment

**Ready to merge: With fixes.**

No structural rework needed. The architecture is exemplary — spec-faithful, well-documented, legacy cleanly purged, invariants enforced and tested. The three Critical findings are all narrow (a field rename, a mock correction, a matrix table), and the one security-relevant Important (`revokeAuthority` bypass) is a one-line fix. The memory Critical (C1) is the only one with a real production-safety implication (poison remediation silently no-ops) and should be fixed first. After C1–C3 + I1, the branch is merge-ready; I2–I13 and minors can land in the same pass or as immediate follow-ups.