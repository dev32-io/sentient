# Multi-Dimensional Fleet Review — Memory System Implementation Plan

**Plan:** `docs/superpowers/plans/2026-08-08-memory-system.md` (2026-08-08, T1–T26, 7 waves)
**Spec:** `docs/superpowers/specs/2026-08-08-memory-system-design.md` (rev 2 — this plan is the first plan off that spec; the spec itself was dual-reviewed and is not re-reviewed here)
**Review date:** 2026-08-08
**Method:** six parallel read-only subagents, one per dimension — spec-fidelity & coverage, task-decomposition & wave parallelism, interface & type consistency, security-implementation fidelity, testing & e2e, executability & risk. Each read the plan + spec, the project rules (`.claude/rules/*.md`), the skill-system plan + spec (declared precedent), and grounded claims against the current source at `feature/native-orchestrator` HEAD (`file:line` citations). No agent modified files or git state (no stash/checkout/reset — all read-only).
**Corroboration policy:** a finding raised independently by ≥2 dimensions is promoted to the headline and marked `[corroborated N×]`; isolated findings stay under their dimension.

---

## Headline — eight findings reach across dimensions

### 1. Wave 1 is structurally broken: T4 and T5 import T3b's `MemoryStore` in the same wave (CRITICAL, decomposition) [corroborated 2×]

The wave schedule (plan line 88) declares `**1** T3b∥T4∥T5 → gate` — all three parallel. But T4 (line 197: `Consumes: T3b MemoryStore`) and T5 (line 209: `Consumes: T3b store, T3a validators`) both import the `MemoryStore` type from `memory-store.ts` — T3b's file. Rule 6 (plan line 26): *"No task imports a module authored by a same-wave sibling."* T4/T5 cannot compile until T3b lands. The interface-consistency dimension independently flagged the same contract (T4's `composeMemoryBlock({private: MemoryStore, ...})`, T5's `buildMemoryTools({storeFor(scope): MemoryStore | null, ...})` both reference T3b's export).

**Fix:** Split wave 1 into `1a: T3b → gate`, then `1b: T4∥T5 → gate`, then `1c: T6 → gate` (T6 already consumes wave-1 outputs; rename the existing `1b` T6 slot). T4 and T5 don't consume each other (T5 consumes T3a, wave 0), so they stay parallel after T3b.

### 2. T2 household root path is wrong AND the config field it needs has no owner (CRITICAL → HIGH, spec-fidelity + executability) [corroborated 2×]

T2 (plan line 124) roots `memory-household` at `<user_data_root>/shared/<householdId>/` and `memory-private` at `<user_data_root>/users/<userId>/`. But `gateway/config.yaml:201` sets `user_data_root: ~/.sentient/gateway/users` — that *is* the users root, not the gateway root. `access-manager.ts:41` computes the current user dir as `join(config.userDataRoot, principal.userId)` (no extra `users` segment). So the plan's private root resolves to `~/.sentient/gateway/users/users/<userId>/memory/` (double-`users`) and the household root to `~/.sentient/gateway/users/shared/family/` — a *child* of `users/`, not the spec §2 sibling (`~/.sentient/gateway/shared/family/`). The pinned tests (plan lines 130/136) are self-consistent with the wrong impl and would pass while deployed paths diverge from the spec.

Executability adds the harder half: `AccessManagerConfig` (access-manager.ts:16-31) has only `userDataRoot` — there is no `sharedDataRoot`/gateway-root field, and T2's file set (capability.ts, access-manager.ts, +tests) does **not** include the gateway config schema or the composition root. So even if T2 derives a sibling path, no task plumbs it: T6 (owns phase-services.ts) never mentions passing a shared root into `createAccessManager`.

**Fix:** T2 must (a) root `memory-private` at the EXISTING `userHomeDir(principal)` = `join(config.userDataRoot, principal.userId)` (no extra `users`); (b) root `memory-household` at a sibling of `users/` — `join(dirname(config.userDataRoot), "shared", principal.householdId)`; (c) add `access.shared_data_root` (or use the `dirname` derivation) to `gatewayConfigSchema` in `shared/config/src/schema.ts` and add that file to T2's ownership row; (d) add an explicit T6 step passing `sharedDataRoot` into `createAccessManager`. Update T2 tests to `join(root, "kevin")` and `join(dirname(root), "shared", "family")`.

### 3. Fact-derived index entries lack `sessionRef` — §3.8 poison remediation is un-mechanized on its load-bearing path (HIGH, security + spec-fidelity) [corroborated 2×]

Spec §5.4 (line 172): *"episode summaries and facts carry BOTH [sourceRef + sessionRef]; this is what makes purge-by-session catch derived entries, §3.8."* Spec §3.8 (line 73): *"purging by sessionId removes the episode summary and every fact-entry distilled from that session."* T19 (plan line 386) stamps `sessionRef` on `episode-summary` entries explicitly, but for facts it says only "changed file sections" — which route through T12's `enqueueFile(scope, file)` (plan line 303), deriving `file-section` entries from file content **without** `sessionRef`. No task enqueues dreamer-derived fact entries with `sessionRef`. T9b's purge test (plan line 262) asserts "purge by `sessionRef.sessionId` removes episode **+ fact** entries carrying that ref" — but no task ensures fact entries actually carry it. The earlier spec review's headline #7 flagged exactly this; spec rev 2 §3.8+§5.4 claim the fix (facts carry `sessionRef`), but the plan does not mechanize it.

**Fix:** T19 (or T21 after applying ops) must call `sync.enqueueEntries(scope, factEntries)` explicitly for each dreamer-derived fact, with `sessionRef` from the op's `sources` citation (T18a's `sources: [seqRange]`) and taint-derived provenance — NOT rely on `enqueueFile`. Add a T19 test asserting the fact-derived file-section entry carries the source `sessionRef`. Alternatively, narrow spec §3.8 to "episode summaries + journal entries" and make file-layer fact remediation fully manual (§3.8's second sentence already hedges this way; the first sentence is the overclaim).

### 4. Edit-ingest re-scan + quarantine at session build has no owning task (HIGH) [corroborated 4× — spec-fidelity M1, security M1, interface M7, testing M5]

Spec §3.2 (line 67): *"the store detects out-of-band changes by content hash on session build and on index sync; changed files are re-validated and re-scanned before rendering or indexing — a failed scan quarantines the file (WARN, rendered as absent)."* Spec §12 lists "edit-ingest quarantine (hostile direct file edit never renders)" as a security-boundary test. The plan provides only the **detection** half: T3b's `changedSinceLastSeen(): ChangedFile[]` (plan line 170) + test (line 184). The **re-scan + quarantine at render** half is unassigned:
- T3b declares no `reingest`/`quarantine` method.
- T4 `composeMemoryBlock` is "Pure: reads stores once, returns a string" (plan line 197) — a pure function cannot quarantine.
- T6 (line 221) "stores opened → memory block appended" — never calls `changedSinceLastSeen()` or re-scans.
- T12 calls it at index-sync only.

So a hostile direct edit to `MEMORY.md` between sessions is rendered into the next session's prompt without re-scan — the §3.2 defense has no owner at the session-build path, and the quarantine test named in §12 is unpinned.

**Fix:** Add a store method that does detection + re-validate + re-scan + quarantine in one call (e.g. `reingestEdits(): { rescanned: ChangedFile[]; quarantined: string[] }`, updating internal state so `readCore`/`readTopic` return absent for quarantined files). Assign T6 to call it at session build before `composeMemoryBlock`. Add the §12 "edit-ingest quarantine" test to T3b or T6 (write file → mutate on disk to injection text → session-build path → file rendered absent + WARN).

### 5. Dreamer mark-advance timing diverges from spec §8 idempotency for reduce-stage crashes (HIGH, spec-fidelity)

Spec §8 (line 207): *"per-session map calls → journal + ops staged → files committed atomically → index upserts → advance mark. Crash anywhere ⇒ next run redoes the window."* T18b (plan line 375) "advances mark ONLY after all canonical writes commit" — but reduce-op application is split to T21/T22 (later waves): T18b produces the reduce output and returns it; T22 (line 411) wires reduce→reconciler. T18b's tested crash case (plan line 377) kills after 2 of 3 **map** calls — not a reduce-stage crash. If the mark advances after map outputs but before T21's reconciler applies ops to MEMORY.md, a reconciler crash post-mark leaves the window's ops permanently un-applied; the next run redoes nothing because the mark already advanced. The spec's idempotency invariant is only tested for the map stage.

**Fix:** T18b must define mark-advance as occurring AFTER reduce-ops are applied (post-reconciler), OR T22 must re-specify the mark-advance to include the reconciler's file commits. Add a T18b (or T22) test: kill after reduce produced but before reconciler commits → rerun redoes the full window including reduce.

### 6. Log-sanitization sweep (spec §3.9/§3.10/§12) is a named security-boundary test with no owning task (HIGH) [corroborated 3× — testing H2, security M4, spec-fidelity m3]

Spec §3.9: "Memory text never appears in logs at any level — lengths, ids, counts, scores only." Spec §12 lists "log-sanitization sweep (memory text absent from logs)" as a required security-boundary test. The plan's Global Constraints (line 47) restate the rule, but no task's failing-test step owns it. T5/T13/T18b pin event *names* with `chars=`/`hits=`/`similarity=`/`kind=` (all non-content), but none asserts the *absence* of content. The Self-Review (line 449) maps §3 defenses to tasks but names no log-sweep owner.

**Fix:** Add a failing test (T3b or T5) that writes known memory content via tools + dreamer paths, captures all tagged-logger output, and asserts the content string never appears (only lengths/ids/counts/scores). Extend the existing `PrivacyGuardTest` precedent.

### 7. S1 ships with `spark.enabled: true` / `dreamer.enabled: true`, contradicting spec §13 staging (HIGH, spec-fidelity)

Spec §13 (line 235): *"S1 ships caps + tools with `spark.enabled: false`, `dreamer.enabled: false`; later slices flip their sections on."* T1 (plan line 115) copies spec §11's YAML verbatim (`spark.enabled: true`, `dreamer.enabled: true`, lines 250/261). No task flips these to `false` for S1 or back on at S2/S3. The shipped `config.yaml` would enable subsystems whose code doesn't exist until S2/S3 (no consumer, so not a functional break, but a direct contradiction of an explicit staging instruction) and leaves no slice boundary at which to flip them on.

**Fix:** T1 must write the shipped `config.yaml` block with `spark.enabled: false` and `dreamer.enabled: false` for S1 (zod *defaults* stay `true` per §11 for missing-block resilience). Add a step at T15 (S2) to flip `spark.enabled: true` and at T20 (S3) to flip `dreamer.enabled: true`.

### 8. Household scope is front-loaded into S1 — T6 mints household grants + opens store, T5 validates family writes, T4 renders family, all before S4 (MAJOR, spec-fidelity)

Spec §13 places "shared scope end-to-end for user writes + search" in S4. But the plan's S1 tasks already make family writes reachable: T6 (line 221) "private (+household) memory grants minted → stores opened"; T5 (line 210) `memory_write` `validate()` rejects `scope:"family"` for non-adults (validation logic present); T4 (line 197) `composeMemoryBlock({private, household?})` renders the household block with `@adults` filtering. So an adult user in S1 can successfully `memory_write(scope: "family")` — a feature the spec slices into S4 — and the S1 matrix exercises none of it.

**Fix:** T6 should open ONLY the private store in S1. T5 should reject `scope: "family"` outright in S1 (store absent → typed error) or gate family-write behind the S4 wiring. T4 may keep the `household?` optional in its signature (undefined in S1) but must not render a live household block until T24. Mint the household grant + open the household store in T24, not T6.

---

## Dimension A — Spec fidelity & coverage

(C1→headline 2, M1→headline 4, M2→headline 8 above; remaining isolated findings.)

- **[MAJOR] S3a e2e rows deferred to T23/S3b** (→ also testing H1, headline-adjacent). Spec §13 assigns S3a rows `spark-episode-happy` + `dream-reflects-next-session (episodic half)` and says "each slice lands green (unit + its rows) before the next." The plan runs all dream e2e in T23 (wave 6b, after S3b), so S3a lands on unit tests only. **Fix:** add a serial e2e task at the wave-5b boundary driving the two S3a rows, or document the deferral as a spec-noted deviation and amend §13.
- **[MINOR] `GATE_CHANNELS` not updated for `memory_body`** (→ also executability L1). `phase-services.ts:154` hardcodes `["tool_result","background_completion","skill_body"]`; `memory_body` is a real gate channel (T13/T14 call `gate.screen` with it). T1's file set excludes `phase-services.ts`. `describeInboundGateMode` under-reports if `memory_body` is the only on channel. **Fix:** add `"memory_body"` to `GATE_CHANNELS` in T6 (wiring slot) and add `phase-services.ts` to that task's file note.
- **[MINOR] File-target `memory_read` gate screening not confirmed.** Spec §4.4 says file-target `memory_read` goes "through the inbound gate (`memory_body`)". T5 stubs session-target + recall; T14 screens "both results" (recall + session read). Neither explicitly screens the file-target read. **Fix:** T14 explicitly screens file-target `memory_read` via the `provenanceFor` routing.
- **[MINOR] No-hard-delete invariant on automatic paths not tested.** Spec §3.7/§12. T21 tests SUPERSEDE *flips* status (confirms status-flip, not absence of delete). **Fix:** add a T21 test asserting the reconciler's client interface exposes only `setStatus`, never `purge`.
- **[MINOR] T9a admin-credential refusal tested only on `/purge`.** Spec §3.6 lists admin endpoints `register-scope`, `purge`, `rebuild`; T9a (line 252) tests only `/purge`. **Fix:** add data-token-on-`/rebuild` and data-token-on-`/register-scope` refusal cases.

**Verified clean:** §5.3 spark formula (T13 faithful, test math correct), §6 spark memoization/deadline (T13), §5.2 all 7 API endpoints (T9a/T9b/T10), §4.4 tool args (T5 verbatim), §4.5 drop order (T4), §8 runner-not-auxiliary-seam (T18b + Global Constraints line 45), §5.6 outbox (T12), §10 degradation (T10/T13/T14/T12/T15), §14 non-goals all excluded, §11 config keys present in T1 (defaults spot-checked), skill-store symlink-guard precedent faithfully mirrored, `provenanceFor` routing extension, `loadSkillIndexPreamble` precedent exists for T4.

---

## Dimension B — Task decomposition & wave parallelism

(C1→headline 1 above; the rest.)

- **[MEDIUM] Wave 3 file-ownership ambiguity: T9a "entire dir" overlaps T11's `config.example.yaml`/`CONTRACT.md`.** T9a matrix row (line 67) claims the "entire dir"; T9a body creates `config/config.example.yaml`; T11 matrix row (line 70) also claims `service config.example.yaml`. T11 body only creates `CONTRACT.md`. Both wave 3. **Fix:** narrow T9a to its specific files; remove `service config.example.yaml` from T11's row (T11 owns only `CONTRACT.md` + gateway-side files). The service `config.example.yaml` is T9a's (created) + T9b's (pinned versions), same sequential lane.
- **[MEDIUM] T14 lists T12 as a consume "for nothing — read-only."** T14 (line 334) declares it consumes T12 but doesn't use it; both are wave 4. Listing it invites a rule-6-violating import. **Fix:** remove `T12 sync` from T14's Consumes; if a type reference is needed, move it to T15.
- **[MEDIUM] Three security-critical tasks sized opus, not fable.** Rule 7 (line 28-33): fable for "security-critical or architecture-heavy." T3b (symlink-escape, wrong-class rejection, scan fail-closed, edit-ingest — own tests say "the security ones are the point"), T9a (split credentials, scope-registry confinement — "first multi-user capability service"), T19 (taint propagation — spec §3.1 #1 defense) are security-critical by the plan's own framing. **Fix:** size T3b/T9a/T19 as `fable`. (Judgment call — opus is also strong; the plan's rule says "when in doubt, size UP," and these are not borderline.)
- **[MEDIUM] Missing inter-sub-wave gates; E2E tasks don't run `bun run ci` as step 1.** The skill plan's T13 runs `bun run ci` before driving E2E; the memory plan's T8/T16/T23/T26 omit it. Several sub-wave boundaries lack explicit gates (2: T7→T8; 4b: T15→T16; 5→5b; 6→6b; 7→7b). **Fix:** add `→ gate` at every producing→consuming sub-wave boundary; add `bun run ci` (+ service pytest from wave 3 on) as Step 1 of T8/T16/T23/T26.
- **[LOW] T14 bundles three distinct responsibilities** (recall replacement, session-excerpt renderer, `provenanceFor` routing). Cohesive enough, but the natural split fault line is `provenanceFor` (one-line routing, parallelizable) vs the renderer vs the tool logic.
- **[LOW] T14 consumes "session store read handle" without naming the interface.** Name it (e.g. the existing `SessionStore` read API) for contract precision.

**Verified clean:** spec §13 slice→task mapping is complete (all slice contents map to tasks; no spec functionality lacks a task). §3.8 poison remediation correctly splits: `purge` endpoint in T9b (S2), operator runbook in T25 (S4). §3.7 no-hard-delete covered by T21 ops + T9b operator-only purge.

---

## Dimension C — Interface & type consistency

(M3→T2 field name; M7→headline 4; M2→DreamResult; L2/L3→log strings; below.)

- **[MEDIUM] T2 test uses `cap.resourceClass` but the field is `cap.resource`.** `capability.ts:17`: `readonly resource: ResourceClass;`. T2 tests (plan lines 131/135) assert `cap.resourceClass`. Won't compile. **Fix:** assert `cap.resource`.
- **[MEDIUM] `authorUserId` in spec §9 but absent from spec §5.4 `IndexEntry` schema.** T10 (line 284) declares `IndexEntry = /* spec §5.4 verbatim */` → omits `authorUserId`. T24 (line 427) needs it. The Self-Review's IndexEntry consumer list omits T24. **Fix:** add `authorUserId?: string` to spec §5.4 + T10's `IndexEntry`; add T24 to the consumer list.
- **[MEDIUM] `DreamResult` (T18b produces, T19 consumes) shape unpinned — breaks the taint-bit flow T17→T18b→T19.** T17's `DreamWindow` carries per-session `containsToolDerived`; T19 consumes T18b's `DreamResult`, not `DreamWindow` directly. `DreamResult` is never defined, so the per-session taint bit T19 needs to set `provenance = tool-derived iff ...` has no enforced contract. The Self-Review claims T19 consumes `DreamWindow`; it consumes `DreamResult`. **Fix:** T18b pin `DreamResult` (e.g. `{ sessions: {sessionId, episode, facts[], containsToolDerived}[], ops[] }`); T19 read `containsToolDerived` from it.
- **[MEDIUM] `DeepMemoryClient.search` return type `Hit[]` never declared.** T10 (line 277) references `Hit[]` but never defines it. Spec §5.2: `{entry, similarity, rank}`. T13 gates on `similarity`; T14 builds the hit list. If a worker defines `Hit = IndexEntry`, T13's relevance gate has nothing to read. **Fix:** T10 declare `type Hit = { entry: IndexEntry; similarity: number; rank: number }`.
- **[MEDIUM] T12 `enqueueEntries` input type undefined.** T12's `flush()` fills `id`; but `IndexEntry` also needs `createdAt`/`status`/`statusChangedAt` — unclear whether the caller (T19/T24) or `flush` supplies them. **Fix:** T12 declare an explicit input type (`Omit<IndexEntry, "id"|"createdAt"|"statusChangedAt"> & { status?: ... }`) and document `flush` fills the rest, defaults `status: "active"`.
- **[MEDIUM] T14 "unavailable passthrough" diverges from T5's stub string.** T5 stub (line 210): `{ error: "deep_memory_unavailable" }` (== spec §13/§10 canonical). T14 (line 336): passes client `{kind:"unavailable"}` through → tool result `{ error: "unavailable" }`. **Fix:** T14 map client `{kind:"unavailable"}` → tool `{ error: "deep_memory_unavailable" }`; state explicitly.
- **[LOW] Self-Review omits T12 as `MemoryStore` consumer (T12 `rebuildScope(scope, stores)` re-feeds via store) and T15 as `DeepMemoryClient.registerScope` consumer.** No contract break; the consistency claim is incomplete.
- **[LOW] T9b prose says "purge by sessionRef" but spec §5.2 filter key is `sessionId`.** Clarify: purge by `sessionId` (matching `entry.sessionRef.sessionId`).
- **[LOW] T5 `str_replace`/`remove_lines` op-error shape not pinned.** These are tool-level (store writes full bodies; op semantics live in T5), distinct from `WriteResult`. **Fix:** T5 declare `{ error: "str_replace_ambiguous" | "str_replace_not_found" | "remove_lines_not_found" }`.
- **[LOW] `family-scope` matrix expects `scope=family` but T6's `scope=` may be multi-scope (`private,family`).** Clarify single-vs-multi-scope semantics in T6 or the matrix.
- **[LOW] cap-overflow matrix `reason=cap` vs `WriteResult.error` `cap_lines`/`cap_chars`; spark-empty `reason=below-threshold` not pinned.** (→ also testing M3/M4.) **Fix:** T5 normalize cap refusals to `reason=cap` in the log (keep granular kind in the tool result); T13 enumerate withheld reasons (`below-threshold`/`timeout`/`gate-off`/`toggle-off`) and pin `below-threshold` in a test.

**Verified clean:** `WriteResult` error union (T3b→T5→T21) consistent across all four kinds; config keys (T1→all consumers) every `cfg.memory.*` exists; `Capability`/`ResourceClass` grant shape sound (`UserPrincipal.householdId` exists at `user-principal.ts:21`); tool arg schemas (T5 vs §4.4) verbatim; `DeepMemoryClient` method coverage complete (every consumer method declared; `purge` correctly operator-only); `ScanChannel`+`memory_body` (T1) accurate against `injection-scanner.ts:11` + `schema.ts:391-394`.

---

## Dimension D — Security-implementation fidelity

(H1→headline 3; M1→headline 4; M4→headline 6; below.)

- **[MEDIUM] T21 all-or-nothing vs per-op scan ambiguity.** T21 (line 404) "applies ops through the store (scan fail-closed inherited)" + "all-or-nothing per file." But the store scans **per write** (T3b line 175); if T21 applies ops as N separate store writes and op 3 is hostile, ops 1-2 are already committed. The test asserts "hostile op text → whole batch scan_rejected," implying pre-pass scanning, but the impl description contradicts it. **Fix:** T21 compute the final file content from all ops in memory, then a single `store.writeCore`/`writeTopic` (one atomic tmp+rename, one scan) — make the store's scan + atomic write the all-or-nothing guarantee. Disambiguate explicitly.
- **[MEDIUM] T13 spark gate accumulator — risk-feeding path ambiguous.** T13 (line 313) declares `sparkFor(turn: { ..., risk: RiskAccumulator })` — risk as a *parameter*. But `inbound-gate.ts:85` shows the gate *holds* the accumulator internally (injected at construction); the broker's PDP reads risk via `inboundGate.getRiskLevel()`. If T13 builds a *separate* gate instance with a *separate* accumulator, spark findings feed a throwaway accumulator and never reach the PDP — the §3.3 risk-escalation-to-confirm path is silently defeated for spark. **Fix:** T13 deps include `gate: InboundGate` (the session's instance, same one injected into the broker). Remove `risk` from `sparkFor` params (the gate holds it). T15 passes the session's gate to the retriever. T13 test asserts a hostile spark finding raises `gate.getRiskLevel()` on the same accumulator the PDP reads.
- **[LOW] T3b scan fail-closed test covers only "hostile" — should also test "suspicious."** Skill-tools precedent (`skill-tools.ts:135`) fails on both. **Fix:** add a `maxSeverity: "suspicious"` → `scan_rejected` case.
- **[LOW] `provenanceFor` "memory-native tools" routing ambiguous.** T14 should specify: `memory_recall` + `memory_read` → `memory_body`; `memory_write` + `memory_list` → `tool_result` (or `memory_body` — harmless, but be explicit).
- **[LOW] `ScanVerdict` vs `ScanResult` naming drift.** T3b (line 175) says `scan: (text) => ScanVerdict`; the codebase type is `ScanResult` (`injection-scanner.ts:40`), function `typeof scanContent`. **Fix:** use `typeof scanContent` / `ScanResult`.

**Verified clean (defenses faithfully mechanized):** §3.1 provenance taint — rev-2 headline #2 is CLOSED: T17 `containsToolDerived` (taint bit true iff any tool_result) + T19 `provenance = tool-derived iff window's taint bit else user-speech-min` IS the least-trust-of-inputs, not the weaker "writer identity" version (over-tainting `user-speech` floor is safe, not a gap). §3.2 write-time scan injected as constructor dep (not ambient) on tool + dreamer paths. §3.3 MEMORY.md-in-system-prompt correctly NOT gated (T4 pure, no gate call). §3.4 capability-scoped search structural (T6 mints → T15 registers → T9a refuses unknown scopeId = the path check). §3.5 wrong-class rejected FIRST (T3b, plan line 175, tested). §3.6 registry all three refusals in T9a. §3.7 no DELETE op (T18a ops), archive-before-rewrite (T21). Child/family-write arg-aware BEFORE PDP confirmed: T5 `validate()` rejects family for non-adult, and the broker calls `validate()` BEFORE `resolveDecision` (`tool-broker.ts:1041-1052`).

---

## Dimension E — Testing & e2e

(H1→S3a rows (dim A MAJOR); H2→headline 6; H3 below; below.)

- **[HIGH] `recall-escalate` matrix row's pinned log event `inbound-gate.flagged | channel=memory_body` not pinned by any unit test.** T13/T14 use `gate.screen` but neither asserts the gate emits this exact event. T16 drives the row end-to-end; with no unit pin, the gate may emit a differently-named event and the e2e log oracle fails with no unit red to fix against. (→ also interface L5.) **Fix:** add a T13/T14 failing test feeding a hostile `memory_body` payload through the gate, asserting the exact event + risk escalation.
- **[MEDIUM] `DEEP_MEMORY_LIVE` @live round-trip has no durable test-file owner.** T11 runs it ad-hoc ("orchestrator runs it") but T11's file set has no `*.live.test.ts`; T16's mention is conditional ("if not already green from T11"). The @live rule wants a committed, env-gated, repeatable suite. **Fix:** assign T11 or T16 to commit `deep-memory.live.test.ts` (or pytest `test_live_roundtrip.py`) gated on `DEEP_MEMORY_LIVE=1`.
- **[MEDIUM] T26 family rows never committed to `testing-knowledge.md`.** T25's "final row sync" runs *before* T26 drives `family-scope`/`family-audience`. So the catalog ends without the two family rows. **Fix:** move the final row sync to T26, or add an explicit T26 step committing the two family rows under the `memory` tag.
- **[MEDIUM] T21 pins SUPERSEDE but not REWRITE, FLAG_STALE, or batch atomicity.** Spec §12 demands all four ops + archive + rail + atomicity. T21 tests only SUPERSEDE status-flip + rail refusal + hostile-batch. **Fix:** add REWRITE (line replaced, index status unchanged), FLAG_STALE (line kept, entry → stale), atomicity (one op in a multi-op batch fails → no file mutation, archive not consumed).
- **[MEDIUM] Plan does not reproduce the e2e matrix inline (e2e rule §19).** The rule: "Every spec AND every implementation plan MUST contain a concrete e2e matrix INLINE." T8/T16/T23/T26 list row *names* and reference "spec §12" but never reproduce the fixed-column table. **Fix:** add the 15-row matrix table (or per-task sub-tables with the fixed columns) inline, referencing `cross-user-refused` by short name.
- **[LOW] T8 "Files: none" is inaccurate** — it edits `testing-knowledge.md`. **Fix:** `Files: agents/docs/testing-knowledge.md (memory-tag rows only) + Playwright evidence dir`.
- **[LOW] T23 omits the Maestro authoring workflow + tag-batch runner** the e2e rule mandates (`inspect_screen` once per screen; `run-e2e.sh --tags`). **Fix:** add "Author via Maestro MCP `inspect_screen` once per new chat screen; run via `./qa/mobile/run-e2e.sh {android,ios} --tags memory`."
- **[LOW] T7 settings round-trip test is borderline** per the test-bar (DI/plumbing). **Fix:** justify as a persistence-contract pin (survives a store re-open) or drop and rely on T13/T20 surfacing a broken helper.
- **[LOW] E2E rows burn paid LLM calls unflagged.** Unlike the explicitly-gated T22, T8/T16/T23/T26 invoke the LLM provider via chat. **Fix:** note rows should run against a local/Ollama provider config to keep e2e zero-cost.

**Verified clean:** TDD discipline strong (failing-test → implement → PASS on every code task; T18a prompt templates + T22 reduce-call wiring correctly exempt as copy/wiring). Zero-cost invariant holds (T22 is the only paid test, gated). @live gating modeled (DEEP_MEMORY_LIVE free-local, DREAMER_LIVE paid). Security-boundary coverage largely mapped (T2/T3b/T5/T9a/T13/T14/T19/T21).

---

## Dimension F — Executability & risk

(H1→headline 2; L1→GATE_CHANNELS (dim A MINOR); below.)

- **[MEDIUM] T9a `setup-venv.sh` precedent does not exist.** Neither `WhisperSTTService/` nor `LocalTTSService/` has one. Venvs are built centrally by `deploy/mac-prod/native/install-venv.sh` (setup-prod.py:181), `--no-index` from vendored wheels, keyed off `requirements.txt`. A per-service `setup-venv.sh` diverges and risks conflicting with T11's packaging. **Fix:** drop `setup-venv.sh`; T9a creates `requirements.txt` (+ `pyproject.toml` if needed), relies on centralized `install-venv.sh`; T11 wires DeepMemoryService into `SERVICE_SOURCES` (setup-prod.py:169).
- **[MEDIUM] T9a/T9b Python-version pin is ordered backwards.** T9b's "first step: verify + pin MLX embedding + sqlite-vec" runs AFTER T9a's venv skeleton. DeepMemoryService depends on MLX — likely the same 3.14-wheel gap that forced local-tts to 3.11. If T9a mirrors whisper-stt's 3.14 and the MLX embedding lib lacks 3.14 wheels, T9a's venv won't build and T9b/T16 stall. **Fix:** move version-verification to T9a's first step; pin Python explicitly (almost certainly 3.11, matching local-tts). T9b inherits the pin and verifies embedding-model + sqlite-vec against that Python.
- **[MEDIUM] T7's file-location greps return nothing useful; existing `memory-pane.tsx` is a trap.** The first grep hits only wire-frame comments about `user.preferences.patch`; there's no dedicated user-settings type in `shared/protocol`. The second grep returns zero per-user-boolean matches. Meanwhile `gateway/webui/src/components/settings/panes/memory-pane.tsx` exists and is NOT inert — it's a full Hermes-era `MEMORY.md`/`USER.md` editor persisting via `services/profile-api.js`. A worker could wrongly repurpose it or spin looking for a precedent the plan doesn't name. **Fix:** name the exact files — add `memory: { spark: boolean; dreaming: boolean }` to the user profile schema (name the file), add two checkboxes to `memory-pane.tsx` (or a new pane), pin the persistence path. Replace both grep hints with concrete paths.
- **[MEDIUM] T22 paid-test has no cheap replay fallback.** A rail/reconciler bug found after the first run requires a second paid call to re-verify. **Fix:** add a T22 step: capture the first successful run's provider request/response into `dreamer.fixture.json`; add a non-paid unit test in `reconciler.test.ts` (T21) that replays it against the rail + scan. State the fixture path.
- **[MEDIUM] T18b bundles 7 sub-responsibilities behind 4 tests** (mark-file I/O, window chunking, per-session map calls + schema retry, yield-while-active-turn polling, staged outputs, mark-advance, status record). The yield-poll and schema-retry behaviors aren't directly covered by the 4 tests. **Fix:** either split into T18b1 (checkpoint + chunking) / T18b2 (map orchestration + yield + schema retry), OR add two explicit tests: yield-poll defers while stubbed turn-state reports active, resumes on idle; schema-retry: first call malformed JSON, second valid, output is the second.
- **[LOW] T24 re-opens T4/T5/T13/T14 files; PASS step should re-run their tests.** T24's `@adults` passthrough + `authorUserId` edits could break T14's green tests. **Fix:** T24 PASS step explicitly re-run `memory-tools.test`, `memory-prompt.test`, `memory-retriever.test`.
- **[LOW] `nativeTools` is an array, not a "map" (T6 wording).** `phase-services.ts:803` — `nativeTools: skillTools` (`NativeToolRunner[]`). T6 concatenates `[...skillTools, ...memoryTools]`. **Fix:** change "map" to "array."
- **[LOW] setup-prod.py line hint slightly off (T11).** `SERVICE_SOURCES` dict is at 169-178, not "161-183." **Fix:** "~lines 169-178 (`SERVICE_SOURCES` dict)."

**File-location accuracy (verified green):** `composeSessionSystemPrompt` phase-services.ts:845 ✓; whisper-stt block config.yaml:1091 ✓; `ScanChannel` injection-scanner.ts:11 (4 members incl. `delegation_prompt`) ✓; channel booleans schema.ts:391-394 ✓; `loadSkillIndexPreamble` system-prompt-loader.ts:88 ✓; `provider.stream` compaction.ts:244 ✓; `provenanceFor` tool-broker.ts:769 ✓; `screen` inbound-gate.ts:90 ✓; `projectNativeTools` mcp-catalog.ts:332 ✓; `capToolResult` tool-result-cap.ts:76 ✓; `ResourceClass` capability.ts:12 (3 classes) ✓; `householdId` on `UserPrincipal` ✓; `situation-block.ts` collaborator pattern ✓; `orchestrator-config.ts` has `skills`/`delegation`, no `memory` ✓; `gateway/src/memory/` doesn't exist (all new) ✓; skill-file.ts/skill-store.ts/skill-tools.ts precedents exist ✓. Only stale claim: `setup-venv.sh` (above).

---

## Cross-dimension corroboration index

| Finding | Dimensions that raised it |
|---|---|
| T2 household root path wrong + config field unowned | spec-fidelity C1, executability H1 |
| Edit-ingest re-scan/quarantine at session build no owner | spec-fidelity M1, security M1, interface M7, testing M5 |
| Fact-derived entries lack `sessionRef` (§3.8 purge) | security H1, spec-fidelity M4 |
| Log-sanitization sweep no owner | testing H2, security M4, spec-fidelity m3 |
| S3a e2e rows deferred to S3b | testing H1, spec-fidelity M2 |
| `GATE_CHANNELS` missing `memory_body` | spec-fidelity m1, executability L1 |
| cap-overflow / spark-empty reason strings unpinned | testing M3/M4, interface L2/L3 |
| `recall-escalate` gate event not unit-pinned | testing H3, interface L5 |

---

## Net assessment

The plan is a strong, source-grounded breakdown — the skill-system precedent is real and present, file-location hints are accurate within ±5 lines (one stale: `setup-venv.sh`), and the spec→task mapping is complete (no spec functionality lacks a task). The security model is faithfully mechanized on its load-bearing defenses (provenance taint rev-2 #2 is CLOSED; wrong-class-first; arg-aware family-write before PDP; no DELETE op).

The findings that will actually stall a wave if dispatched as-written, ordered by blocking risk:

1. **Wave 1 rule-6 violation** (headline 1) — T4/T5 won't compile against T3b's missing export. Mechanical fix.
2. **T2 household root + config plumbing** (headline 2) — surfaces at T6 or T24 as a broken household grant; the test passes on a fixture while production breaks.
3. **Fact-entry `sessionRef`** (headline 3) — §3.8 poison remediation silently partial; T9b's own test assumes a contract no task produces.
4. **Edit-ingest quarantine at session build** (headline 4) — a §3.2 defense with no owner at the render path.
5. **T9a Python-pin ordering + `setup-venv.sh`** (dim F M1/M2) — T9a venv may not build, blocking T9b/T16.

Headlines 5–8 (dreamer mark-advance, log-sweep, S1 staging flags, household front-load) and the medium interface gaps (`DreamResult` unpinned, `Hit[]` undeclared, `enqueueEntries` input, `authorUserId`) are correctness/contract gaps a competent worker resolves but will cost orchestrator intervention mid-wave. Recommend fixing headlines 1–4 + dim F M1/M2/M3 in the plan text before dispatch; the rest can land as task-acceptance corrections.