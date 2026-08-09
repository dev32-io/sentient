# Memory System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **PARALLEL EXECUTION MODEL (identical to the skill-system plan):** tasks are
> grouped into WAVES. Tasks inside a wave own DISJOINT file sets and may run as
> concurrent subagents on this one branch. TDD is preserved *inside* each task.
> Hard rules that make same-branch parallelism safe:
> 1. **Workers never run `git add`/`git commit`.** The orchestrator commits each
>    task's exact file set serially when the task is accepted (atomic commit per
>    task; no index-lock races).
> 2. **Workers run only their own task's test files** (`bun run test -- <file>`
>    from `gateway/`, or `./venv/bin/pytest <file>` inside the service dir),
>    never the whole suite; **never `bun run typecheck`/`bun run ci` mid-wave** —
>    a repo-wide check sees siblings' half-written files and its red is noise.
> 3. **A worker touches ONLY the files its task lists.** A needed-but-unlisted
>    edit is a task-boundary bug: stop and report to the orchestrator.
> 4. **Orchestrator commits use an explicit pathspec and skip the hook
>    mid-wave:** `git status --porcelain -- <task files>` must show ONLY that
>    task's changes, then `git commit --no-verify -m "…" -- <task files>`.
>    `--no-verify` is safe ONLY because rule 5 is the real gate.
> 5. **The wave boundary IS the gate:** after a wave's last task commits, the
>    orchestrator runs `bun run ci` (and, once the service exists,
>    `capabilityServices/DeepMemoryService/venv/bin/pytest`) and fixes or
>    reverts before dispatching the next wave. No wave starts on a red gate.
> 6. **No task imports a module authored by a same-wave sibling.** Cross-wave
>    imports are safe only because the source wave's gate was green.
> 7. **Model sizing:** each task carries a `Model:` line — `sonnet` for
>    mechanical/config/docs/copy work, `opus` for standard module
>    implementation, `fable` (inherit) for security-critical or
>    architecture-heavy tasks (dreamer runner, reconciler, search pipeline)
>    and for the serial E2E tasks. The orchestrator passes it to the Agent
>    call; when in doubt, size UP.

**Goal:** Per-user + shared-family memory: dumb markdown note files rendered into the system prompt, a native MLX deep-memory index service with per-turn spark and two-step recall, and a nightly dreamer that distills sessions into journal + notes — per `docs/superpowers/specs/2026-08-08-memory-system-design.md` (rev 2). **Read the spec first; it is the contract.**

**Architecture:** `gateway/src/memory/` (store, retriever, dreamer, client) + 4 native tools + `capabilityServices/DeepMemoryService/` (Python+MLX, scope-registry API) + `memory_body` inbound-gate channel. Skill system is the pattern precedent throughout.

**Tech Stack:** Bun/TypeScript strict + vitest + zod (gateway); Python 3.11 + pytest + MLX + sqlite-vec + FTS5 (service); no new gateway deps.

## Global Constraints

- Topic slug: `^[a-z0-9][a-z0-9-]{0,63}$` — protocol constant in code, not config.
- All tunables in `orchestrator.memory` (spec §11) — block AND every sub-block `.default({})`, leaf zod defaults, YAML comments with ranges. Defaults verbatim from spec §11.
- Dreamer does NOT use the auxiliary seam (spec §8) — its own `ProviderClient` runner, compaction precedent.
- No recall-time LLM synthesis. Recall = hit list; drill-down = capped `memory_read` (spec §7).
- Provenance taint propagation (spec §3.1); write-time scan fail-closed; `memory_body` gate channel read-time; no memory content in logs (lengths/ids/counts/scores only).
- Note files are dumb (spec §4.2): no per-line IDs; model may remove lines; history lives in journal/archive/index.
- Every new TS file: tagged logger, hierarchy-true tags. Service: its own tagged logging per the Python services' convention.
- Spark: similarity gates, recency only orders (spec §5.3). Situation-block only; never the cached prefix.
- All unit tests zero-cost. `@live` suites env-gated (`DEEP_MEMORY_LIVE`, `DREAMER_LIVE`); the dreamer smoke is the ONLY paid test.
- Pinned-versions rule: T9 verifies the MLX embedding model + sqlite-vec versions against current releases before pinning.

## File Ownership Matrix (conflict guard)

| File set | Task | Wave | Model |
|---|---|---|---|
| `shared/config/src/schemas/orchestrator-config.ts` + `shared/config/src/schema.ts` (inbound channels) + `gateway/src/security/injection-scanner.ts` (`ScanChannel` union only) + `gateway/config.yaml` keys + loader test | T1 | 0 | sonnet |
| `gateway/src/access/capability.ts`, `access/access-manager.ts` (+tests) | T2 | 0 | opus |
| `gateway/src/memory/memory-file.ts` (+test) | T3a | 0 | sonnet |
| `gateway/src/memory/memory-store.ts` (+test) | T3b | 1 (after T2+T3a) | opus |
| `gateway/src/memory/memory-prompt.ts` (+test), `context/system-prompt-loader.ts` (loader fn only), `gateway/system_prompts/memory-preamble.md` | T4 | 1 | opus |
| `gateway/src/tools/memory-tools.ts` (+test), `api/handlers/mcp-catalog.ts` (rows only) | T5 | 1 | opus |
| `gateway/src/bootstrap/phase-services.ts` + `runtime/session-runtime.ts` (S1 wiring: store, tools, prompt) | T6 | 1b (sole owner) | opus |
| webui per-user toggles (settings pane + store) + `shared/protocol` settings fields | T7 | 2 | sonnet |
| E2E: S1 matrix rows (no source edits) | T8 | 2 (serial, owns stack) | fable |
| `capabilityServices/DeepMemoryService/` (entire dir: server, registry, auth, health, pytest) | T9a | 3 | opus |
| `capabilityServices/DeepMemoryService/` index engine (sqlite+vec+FTS+RRF+embed) — same lane as T9a | T9b | 3 (after T9a) | fable |
| `gateway/src/memory/deep-memory-client.ts` (+test, mock server) | T10 | 3 | opus |
| `gateway/config.yaml` `managed_services.deep-memory` + `deploy/mac-prod/setup-prod.py` allowlist + `deploy/README.md` + service `config.example.yaml`/`CONTRACT.md` | T11 | 3 | sonnet |
| `gateway/src/memory/index-sync.ts` (outbox/cursor, +test) | T12 | 4 | opus |
| `gateway/src/memory/memory-retriever.ts` (+test), `context/situation-block.ts` (collaborator slot) | T13 | 4 | fable |
| `gateway/src/tools/memory-tools.ts` (recall/read real impl), `store/` excerpt projection helper, `tools/tool-broker.ts` (`provenanceFor` memory_body) | T14 | 4 | opus |
| `bootstrap/phase-services.ts` (S2 wiring: client, retriever, sync) | T15 | 4b (sole owner) | opus |
| E2E: S2 rows + `@live` service round-trip | T16 | 4b (serial) | fable |
| `gateway/src/store/project-for-dreaming.ts` (+test) | T17 | 5 | opus |
| `gateway/system_prompts/dreamer/{map.md,reduce.md}` | T18a | 5 | sonnet |
| `gateway/src/memory/dreamer/dreamer-runner.ts` (+test: checkpoint, idempotency, yield) | T18b | 5 (after T17) | fable |
| `gateway/src/memory/dreamer/episode-writer.ts` (journal+episodes, +test) | T19 | 5 (same lane, after T18b) | opus |
| `gateway/src/memory/dreamer/scheduler.ts` (+test) + `phase-services.ts` (S3 wiring; sole owner in its slot) | T20 | 5b | opus |
| `gateway/src/memory/dreamer/reconciler.ts` (+test: ops, rail, archive) | T21 | 6 | fable |
| `@live` dreamer smoke (`*.live.test.ts`) + reduce-call integration | T22 | 6 (after T21) | opus |
| `qa/mobile/flows/*` memory flows + E2E S3 rows | T23 | 6b (serial) | fable |
| household grant + shared-scope instantiation + audience filter (`access/`, `memory-prompt.ts`, `memory-retriever.ts`, `memory-tools.ts` validate) | T24 | 7 | opus |
| deep-dream trigger + operator purge runbook + `docs/native-todo.md`/`agents/docs/learnings.md`/`testing-knowledge.md` updates | T25 | 7 | sonnet |
| E2E: S4 rows + full-matrix regression | T26 | 7b (serial, final) | fable |

Waves: **0** T1∥T2∥T3a → gate. **1** T3b∥T4∥T5 → gate, **1b** T6 → gate. **2** T7, then T8 (serial) → S1 done. **3** (T9a→T9b)∥T10∥T11 → gate + `@live` service. **4** T12∥T13∥T14 → gate, **4b** T15 → T16 (serial) → S2 done. **5** T17∥T18a, then T18b→T19; **5b** T20 → gate. **6** T21→T22, **6b** T23 (serial) → S3 done. **7** T24∥T25, **7b** T26 → S4 done. Gate = orchestrator runs `bun run ci` (+ service pytest from wave 3 on).

---

### Task 1: Config schema + channels + YAML

**Model:** sonnet
**Files:** Modify `shared/config/src/schemas/orchestrator-config.ts`, `shared/config/src/schema.ts` (security.inbound_scan.channels), `gateway/src/security/injection-scanner.ts` (add `"memory_body"` to the `ScanChannel` union — one line, no logic), `gateway/config.yaml`; Test: extend `shared/config/src/loader.test.ts`.
**Interfaces — Produces:** `config.orchestrator.memory` exactly as spec §11 (keys, defaults, ranges); `config.security.inbound_scan.channels.memory_body: boolean` (default true); `ScanChannel` includes `"memory_body"`.

- [ ] **Step 1: Failing test** — two cases, upgrade-safety is the important one:

```ts
it("parses orchestrator.memory with spec defaults", () => {
  const cfg = loadConfigFixture();
  expect(cfg.orchestrator.memory.core_max_lines).toBe(300);
  expect(cfg.orchestrator.memory.spark.min_similarity).toBe(0.6);
  expect(cfg.orchestrator.memory.dreamer.preservation_pct).toBe(75);
  expect(cfg.security.inbound_scan.channels.memory_body).toBe(true);
});
it("boots a pre-upgrade config missing orchestrator.memory entirely", () => {
  const cfg = loadConfigFixture({ stripKeys: ["orchestrator.memory"] });
  expect(cfg.orchestrator.memory.enabled).toBe(true); // block-level .default({})
});
```

- [ ] **Step 2:** `bun run test -- loader` from `shared/config` — FAIL.
- [ ] **Step 3:** Implement zod per spec §11 — every sub-block (`service`, `spark`, `recall`, `dreamer`) `.default({})`, every leaf `.default(<spec value>)` with `.min/.max` from the spec's ranges. Add `memory_body: z.boolean().default(true)` beside the four existing channel booleans. Add the full YAML block from spec §11 verbatim (comments + ranges are part of the deliverable).
- [ ] **Step 4:** PASS (own test file only). **Step 5:** Report; orchestrator commits `feat(config): orchestrator.memory + memory_body channel`.

---

### Task 2: Memory capabilities

**Model:** opus
**Files:** Modify `gateway/src/access/capability.ts` (ResourceClass union), `gateway/src/access/access-manager.ts`; Test: extend `gateway/src/access/access-manager.test.ts`.
**Interfaces — Produces:** `ResourceClass` gains `"memory-private" | "memory-household"`; `AccessManager.grant(principal, "memory-private")` → capability rooted at `<user_data_root>/users/<userId>/`; `grant(principal, "memory-household")` → capability rooted at `<user_data_root>/shared/<householdId>/` (dir name = householdId; the spec's `shared/family/` is household id `family`). Existing grants untouched.

- [ ] **Step 1: Failing tests** — household root derivation; cross-class rejection material for T3b:

```ts
it("mints a household memory capability rooted in the shared dir", () => {
  const cap = manager.grant(principal({ userId: "kevin", householdId: "family" }), "memory-household");
  expect(cap.resourceClass).toBe("memory-household");
  expect(cap.rootPath).toBe(join(root, "shared", "family"));
});
it("memory-private capability roots in the user dir, not shared", () => {
  const cap = manager.grant(principal({ userId: "kevin" }), "memory-private");
  expect(cap.rootPath).toBe(join(root, "users", "kevin"));
});
```

- [ ] **Step 2:** FAIL. **Step 3:** Extend the grant map (union + switch); mkdir-on-grant consistent with existing classes. **Step 4:** PASS. **Step 5:** commit `feat(access): memory-private + memory-household resource classes`.

---

### Task 3a: memory-file — format + validation

**Model:** sonnet
**Files:** Create `gateway/src/memory/memory-file.ts` (+test).
**Interfaces — Produces:** `MEMORY_SLUG_RE`; `parseTopicFile(raw): {name, description, body} | {error}`; `serializeTopicFile(meta, body)`; `validateMemoryText(text, {maxLines, maxChars}): {ok} | {error: "cap_lines"|"cap_chars"|"invisible_chars", lines, chars}`; `countUsage(text): {lines, chars}`. Mirror `skill-file.ts` (hand-rolled frontmatter, invisible-char rejection).

- [ ] Steps: failing tests (slug regex reject `../evil`, invisible-char reject `"fact​"`, cap counting exact at boundary) → implement → PASS → commit `feat(memory): memory file format + validation`.

---

### Task 3b: MemoryStore

**Model:** opus
**Files:** Create `gateway/src/memory/memory-store.ts` (+test). (Same lane as T3a; starts after T2+T3a accepted.)
**Interfaces — Consumes:** T2 capabilities, T3a validators. **Produces:**

```ts
openMemoryStore(cap: Capability, cfg: MemoryConfig): MemoryStore
interface MemoryStore {
  readCore(): string | null;                     // MEMORY.md
  writeCore(next: string): WriteResult;          // caps + scan hook + atomic tmp+rename
  listTopics(): TopicMeta[]; readTopic(slug): string | null;
  writeTopic(slug, meta, body): WriteResult;
  listJournal(): string[]; readJournal(date): string | null;
  writeJournal(date, content): WriteResult;      // dreamer only (not exposed as a tool)
  archiveCore(): void;                           // timestamped snapshot into archive/
  changedSinceLastSeen(): ChangedFile[];         // content-hash edit-ingest detection (spec §3.2)
}
type WriteResult = { ok: true; usage: {lines,chars} } | { ok: false; error: "cap_lines"|"cap_chars"|"scan_rejected"|"path_refused"; usage? }
```

Rooted at `cap.rootPath + "/memory"`. Rejects wrong-class capability FIRST (class check before path), own `guardedRealpath` symlink guard (skill-store precedent), scan injected as `scan: (text) => ScanVerdict` constructor dep. Hash state file `.ingest-hashes.json` inside the memory dir.

- [ ] **Step 1: Failing tests** (the security ones are the point):

```ts
it("rejects a session-store capability outright", () => {
  expect(() => openMemoryStore(sessionStoreCap, cfg)).toThrow(/resource class/);
});
it("refuses a symlinked topics dir escaping the root", () => { /* mk symlink out of root; writeTopic → path_refused */ });
it("refuses a write that would exceed core_max_lines with usage numbers", () => { /* 300-line file + append → cap_lines, usage.lines === 301 */ });
it("detects an out-of-band human edit by content hash", () => { /* write; mutate file directly via fs; changedSinceLastSeen() lists it */ });
it("fail-closed on hostile scan verdict", () => { /* scan stub → hostile; writeCore → scan_rejected; file untouched */ });
```

- [ ] Steps: FAIL → implement → PASS → commit `feat(memory): capability-rooted MemoryStore with caps, scan, edit-ingest`.

---

### Task 4: Prompt rendering

**Model:** opus
**Files:** Create `gateway/src/memory/memory-prompt.ts` (+test), `gateway/system_prompts/memory-preamble.md`; Modify `gateway/src/context/system-prompt-loader.ts` (add `loadMemoryPreamble()`, two-tier baked/override like `loadSkillIndexPreamble` — locate with `grep -n loadSkillIndexPreamble`).
**Interfaces — Consumes:** T3b `MemoryStore`. **Produces:** `composeMemoryBlock(stores: {private: MemoryStore, household?: MemoryStore}, cfg, opts: {childPrincipal: boolean}): string` — preamble + labeled data envelopes per scope + topic index lines (byte-stable sort, invisible-char strip), aggregate `prompt_budget_chars` with the spec §4.5 drop order (each truncation WARN-logged), `@adults`-tagged household lines filtered when `childPrincipal`. Pure: reads stores once, returns a string; called once per session build.

- [ ] **Step 1: Failing tests** — byte-stability (`compose(x) === compose(x)`), drop order under a tiny budget (family topic index vanishes first), `@adults` line filtered for child, empty-memory renders preamble only.
- [ ] Steps: FAIL → implement → PASS → commit `feat(memory): system-prompt memory block renderer + preamble`.

**Preamble content (write it, don't stub):** what memory is; style contract (one fact per line, concise, no prose); cap contract (usage in every write result; consolidate when refused); latency etiquette ("before memory_recall, speak a short acknowledgment so the user isn't waiting in silence"); "don't write ambiently — explicit requests and clearly durable facts only; the nightly dreamer does the rest."

---

### Task 5: The four memory tools + settings projection

**Model:** opus
**Files:** Create `gateway/src/tools/memory-tools.ts` (+test); Modify `gateway/src/api/handlers/mcp-catalog.ts` (add rows to `projectNativeTools` — rows only, mirror skill tools).
**Interfaces — Consumes:** T3b store, T3a validators. **Produces:** `buildMemoryTools(deps: {storeFor(scope): MemoryStore | null, scan, cfg, principal}): NativeToolRunner[]` — `memory_list`, `memory_read`, `memory_write`, `memory_recall`, tiers/args/results exactly per spec §4.4 (arg schemas verbatim). In this task `memory_recall` and session-target `memory_read` return the typed stub `{ error: "deep_memory_unavailable" }` (== S2's service-down shape, spec §13 S1). `memory_write` `validate()` rejects `scope:"family"` for non-adult roles BEFORE PDP (arg-aware, spec §4.4). File-target `memory_read` caps via `capToolResult` (import from `tools/tool-result-cap.ts`). Log events pinned by tests: `memory-tools.write.ok`, `memory-tools.write.refused`, `memory-tools.scan.rejected`, `memory-tools.recall.unavailable`.

- [ ] **Step 1: Failing tests** — `str_replace` uniqueness (ambiguous match → typed error), family-write child rejection in `validate`, cap-refusal usage passthrough, recall stub shape, pinned log event names (spy on logger).
- [ ] Steps: FAIL → implement → PASS → commit `feat(tools): four memory tools + settings projection rows`.

---

### Task 6: S1 wiring (sole owner of phase-services)

**Model:** opus
**Files:** Modify `gateway/src/bootstrap/phase-services.ts`, `gateway/src/runtime/session-runtime.ts` (only if the session build needs a new field); Test: extend the existing composition test beside `phase-services` (locate: `grep -rn "composeSessionSystemPrompt" gateway/src --include="*.test.ts"`).
**Interfaces — Consumes:** T2 grants, T3b store, T4 `composeMemoryBlock`, T5 `buildMemoryTools`. **Produces:** per-session: private (+household) memory grants minted → stores opened → memory block appended to the composed system prompt (after the skill index, same once-per-session site, ~`phase-services.ts:840-850`) → memory tools registered in the broker's `nativeTools` map beside skill tools. Emits `memory.prompt.rendered | chars= scope=` once per session build.

- [ ] Steps: failing composition test (system prompt contains the labeled memory envelope; second call byte-identical) → wire → PASS → commit `feat(memory): session composition — stores, tools, prompt block`. Wave-1b gate: full `bun run ci`.

---

### Task 7: Per-user toggles

**Model:** sonnet
**Files:** Modify `shared/protocol` user-settings type (locate: `grep -rn "settings" shared/protocol/src | grep -i user`), the settings store + webui pane that carries per-user prefs (mirror how an existing per-user boolean lands; find with `grep -rn "per-user" gateway/webui/src/components/settings`); Test: settings round-trip test beside the store.
**Interfaces — Produces:** `settings.memory: { spark: boolean; dreaming: boolean }` (default true/true) persisted per user; gateway reads them where T13/T20 will consume (`sparkEnabledFor(userId)`, `dreamingEnabledFor(userId)` helpers exported from the settings module).

- [ ] Steps: failing round-trip test → implement (two checkboxes, copy: "Memory sparking — bring up relevant past memories in conversation" / "Nightly dreaming — let Sentient reflect on the day and update its notes") → PASS → commit `feat(settings): per-user memory toggles`.

---

### Task 8: E2E — S1 rows (serial, owns the stack)

**Model:** fable
**Files:** none (evidence under the Playwright output dir). Drive `bun run dev` stack per e2e rules.
Rows (spec §12): memory-write-explicit (both viewports), memory-prompt-render, memory-cache-stability, cap-overflow (both), injection-attempt, cross-user-isolation, recall-degraded. Green = user-visible behavior AND pinned log events match. Add durable rows to `agents/docs/testing-knowledge.md` under `memory` tag (this file edit is allowed here; no source edits).

---

### Task 9a: DeepMemoryService — server, registry, auth, health

**Model:** opus
**Files:** Create `capabilityServices/DeepMemoryService/` — `src/deep_memory/{__main__.py,server.py,scopes.py,auth.py}`, `config/config.example.yaml`, `tests/test_server.py`, `setup-venv.sh` (mirror `WhisperSTTService`'s layout, HTTP lib, logging and venv conventions — read that dir first).
**Interfaces — Produces:** loopback HTTP per spec §5.2: `POST /register-scope` (admin credential) maintains `{scopeId → indexPath}` (persisted to the service state dir; refuses paths outside its configured data root); data endpoints refuse unknown `scopeId` and admin endpoints refuse the data credential; `GET /health` reports `{status, embedding_model, index_schema_version}`. Two bearer tokens (admin/data) from env, `sentient-auth` shared-token model.

- [ ] **Step 1: Failing pytest** — forged/unknown scopeId → 403 `unknown_scope`; data token on `/purge` → 403; `register-scope` with out-of-root path → 400; health shape.
- [ ] Steps: FAIL → implement (endpoints stubbed to in-memory registry; no index yet) → PASS (`./venv/bin/pytest tests/test_server.py`) → commit `feat(deep-memory): service skeleton — scope registry, split credentials, health`.

---

### Task 9b: DeepMemoryService — index engine (same lane, after 9a)

**Model:** fable
**Files:** Create `src/deep_memory/{index.py,embedder.py,search.py}`, `tests/test_index.py`, `tests/test_search.py`.
**Interfaces — Produces:** per-scope SQLite (`entries` + FTS5 + sqlite-vec vector table, schema version row); `upsert` idempotent by entry `id`; `search` implements the pinned pipeline (spec §5.3): vector top-40 cosine + BM25 top-40 → RRF k=60 → dedupe → hits carry `{similarity, rank}`; filters `kinds/statuses/timeRange`; `set-status`, `purge` (by sessionRef/sourceRef/provenance/timeRange), `rebuild` (drop tables, bump nothing — gateway re-feeds); embedding-model mismatch → startup WARN + `409 rebuild_required` on search. **First step of this task: verify + pin the MLX embedding model and sqlite-vec versions against current releases (pinned-versions rule) and record them in `config.example.yaml`.**

- [ ] **Step 1: Failing pytests** — idempotent upsert (same id twice → one row, new text wins); RRF fusion (an entry ranked #1 by FTS only and #3 by vector beats one ranked #5/#5); cosine similarity present and ∈[0,1]; purge by `sessionRef.sessionId` removes episode + fact entries carrying that ref; model-mismatch 409.
- [ ] Steps: FAIL → implement → PASS → commit `feat(deep-memory): hybrid index engine — FTS5 + sqlite-vec + RRF`.

---

### Task 10: DeepMemoryClient (gateway)

**Model:** opus
**Files:** Create `gateway/src/memory/deep-memory-client.ts` (+test with a local mock HTTP server in the test).
**Interfaces — Produces:**

```ts
interface DeepMemoryClient {
  registerScope(scopeId, indexPath): Promise<Result<void>>;
  upsert(scopeId, entries: IndexEntry[]): Promise<Result<void>>;
  search(req: {scopeIds, query, k, filters?}): Promise<Result<Hit[]>>;
  setStatus(scopeId, ids, status, reason): Promise<Result<void>>;
  purge(scopeId, filter): Promise<Result<void>>;  rebuild(scopeId): Promise<Result<void>>;
  health(): Promise<Result<HealthInfo>>;
}
// every call deadline-bounded by cfg.memory.service.request_timeout_ms; typed errors
// { kind: "unavailable" | "timeout" | "rebuild_required" | "refused" }
type IndexEntry = /* spec §5.4 verbatim, incl. provenance, sessionRef?, audience?, status */
```

- [ ] Steps: failing tests (timeout → `{kind:"timeout"}` within budget; 409 → `rebuild_required`; happy search) → implement (plain `fetch`, AbortSignal.timeout) → PASS → commit `feat(memory): DeepMemoryClient with typed errors + deadlines`.

---

### Task 11: Orchestrator registration + packaging

**Model:** sonnet
**Files:** Modify `gateway/config.yaml` (`managed_services.deep-memory`: `launch: native`, `optional: true`, exec/env/healthcheck mirroring `whisper-stt` at `config.yaml:1091-1133`), `deploy/mac-prod/setup-prod.py` (packaging allowlist — locate the native-service source/venv list at ~lines 161-183), `deploy/README.md`; Create `capabilityServices/DeepMemoryService/CONTRACT.md`.
- [ ] Steps: extend the existing orchestrator config test for the new service entry → implement → PASS → commit `feat(deploy): deep-memory managed service + packaging seam`. Wave-3 gate + `DEEP_MEMORY_LIVE=1` round-trip (orchestrator runs it): boot service, register scope, upsert, search returns the hit.

---

### Task 12: Index sync (outbox)

**Model:** opus
**Files:** Create `gateway/src/memory/index-sync.ts` (+test).
**Interfaces — Consumes:** T10 client, T3b store. **Produces:** `createIndexSync(client, cfg): IndexSync` — `enqueueFile(scope, file)` / `enqueueEntries(scope, entries)` persist `{sourceId, contentHash}` cursor rows (file in the scope's `deep-memory/` dir); `flush()` builds deterministic-id entries (spec §5.4: `hash(scope:kind:sourceRef:contentHash)`) and upserts; retried on `flush()` after failure; `onHealthRecovered()` triggers flush; `rebuildScope(scope, stores)` = client.rebuild + full re-feed (files + journals).

- [ ] Steps: failing tests (outage → queue persists across recreate; flush idempotent; rebuild re-feeds everything) → implement → PASS → commit `feat(memory): index sync outbox + rebuild re-feed`.

---

### Task 13: memory-retriever (spark)

**Model:** fable
**Files:** Create `gateway/src/memory/memory-retriever.ts` (+test); Modify `gateway/src/context/situation-block.ts` (optional `memory` collaborator slot — the renderer already composes labeled sections; add one).
**Interfaces — Consumes:** T10 client, gate (`security/inbound-gate.ts` `screen` — same call shape the broker uses), per-user toggle helper (T7). **Produces:** `createMemoryRetriever(deps): { sparkFor(turn: {utterance, turnId, scopeIds, risk: RiskAccumulator}): Promise<string> }` — memoized by `turnId`; deadline `spark.timeout_ms`; similarity gate + recency ORDERING per spec §5.3 exactly; ≤`max_snippets`, ≤`token_budget`; assembled block screened through the gate (`channel:"memory_body"`, findings → risk); returns `""` on anything (empty, timeout, gate-off, toggle-off). Pinned events: `memory-retriever.spark.hit | similarity= kind=`, `memory-retriever.spark.withheld | reason=`, `memory-retriever.audience.filtered`.

- [ ] **Step 1: Failing tests** — the scoring semantics are the heart:

```ts
it("old high-similarity memory passes the gate and fires", async () => {
  // similarity .8, age 400d (decay at floor .35): gate compares .8 ≥ min_similarity — passes
});
it("recency orders but never gates", async () => { /* two passing hits: newer .62 ranks above older .61? NO — orderScore: .61*.35=.213 vs .62*1=.62 → newer first; both injected if budget allows */ });
it("returns empty on timeout within spark.timeout_ms", async () => { /* client stub hangs; expect "" and a withheld log */ });
it("memoizes by turnId", async () => { /* two calls same turnId → one client.search */ });
```

- [ ] Steps: FAIL → implement → PASS → commit `feat(memory): spark retriever — gated, memoized, budgeted`.

---

### Task 14: Real recall + session excerpt read + gate routing

**Model:** opus
**Files:** Modify `gateway/src/tools/memory-tools.ts` (+test) — replace stubs; Create `gateway/src/store/session-excerpt.ts` (+test) — client-projection excerpt renderer; Modify `gateway/src/tools/tool-broker.ts` (`provenanceFor`: memory-native tools → `memory_body`).
**Interfaces — Consumes:** T10 client, T12 sync (for nothing — read-only), session store read handle (same access the runtime holds). **Produces:** `memory_recall` per spec §4.4 (hit list ≤k, snippets ≤200 chars, server refs); `memory_read` session target renders `renderSessionExcerpt(store, sessionId, {around, offset, contextEntries})` → capped by `capToolResult(cfg.memory.read_max_chars)`; both results screen as `memory_body`. Events: `memory-tools.recall.ok | hits=`, `memory-tools.read.session.ok`, `memory-tools.recall.unavailable | reason=`.

- [ ] Steps: failing tests (hit-list shape + snippet cap; excerpt honors span ± context and the truncation marker; `provenanceFor("memory_recall") === "memory_body"`; unavailable passthrough from client `{kind:"unavailable"}`) → implement → PASS → commit `feat(tools): real memory_recall + capped session excerpt reads`.

---

### Task 15: S2 wiring (sole owner of phase-services)

**Model:** opus
**Files:** Modify `gateway/src/bootstrap/phase-services.ts` (+ composition test): construct `DeepMemoryClient` from config; register scopes at boot (admin credential from env); wire `IndexSync` into store writes (tool path + dreamer later); wire retriever into the situation-block renderer per session; health-recovery hook → `sync.onHealthRecovered()`.
- [ ] Steps: failing composition test (spark section appears in situation render when retriever returns text; absent when "") → wire → PASS → commit `feat(memory): S2 composition — client, scopes, sync, spark`. Wave-4b gate.

---

### Task 16: E2E — S2 rows (serial)

**Model:** fable
Rows: spark-file-happy, spark-empty, recall-tool (both viewports), recall-escalate, recall-degraded (live-then-stopped service). Plus `DEEP_MEMORY_LIVE` service round-trip in the unit-live suite if not already green from T11. Update `testing-knowledge.md` rows.

---

### Task 17: projectForDreaming

**Model:** opus
**Files:** Create `gateway/src/store/project-for-dreaming.ts` (+test).
**Interfaces — Produces:** `projectForDreaming(entries: StoreEntry[], fromSeq, toSeq): DreamWindow` — spec §8: append order, seq + kind + provenance markers kept, tool call/result pairs collapsed to labeled digests (`[tool websearch → 1.2k chars]` + result text), compaction entries skipped, interrupted output marked, per-session grouping `{sessionId, text, containsToolDerived: boolean}` (the taint bit T19 consumes).
- [ ] Steps: failing tests (determinism: same input → same output; taint bit true iff any tool_result in window; compaction skipped) → implement → PASS → commit `feat(store): projectForDreaming`.

---

### Task 18a: Dreamer prompt templates

**Model:** sonnet
**Files:** Create `gateway/system_prompts/dreamer/map.md` (per-session: produce episode summary + fact candidates as strict JSON `{episode: string, facts: [{text, kind: "durable"|"ephemeral", sources: [seqRange]}]}`), `gateway/system_prompts/dreamer/reduce.md` (candidates + current MEMORY.md → ops JSON `{ops: [{op: "ADD"|"REWRITE"|"SUPERSEDE"|"FLAG_STALE", target?, line, sources}]}`). Real prompt text, family-assistant-toned, explicit "output JSON only". Operator-override dir noted in file headers.

---

### Task 18b: Dreamer runner

**Model:** fable
**Files:** Create `gateway/src/memory/dreamer/dreamer-runner.ts` (+test). (After T17.)
**Interfaces — Consumes:** `ProviderClient` (same construction compaction uses — `grep -rn "provider.stream" gateway/src/runtime/compaction.ts`), T17 projection, T3b store (journal/archive), T12 sync. **Produces:** `runDream(user, deps, cfg): Promise<DreamResult>` — reads mark file (`memory/.dream-mark.json`: `{lastSeq, lastRunAt}`), snapshots `maxSeq`, chunks window per `max_input_chars_per_call`, map call per session (schema-validated JSON, one retry on parse fail, per-call INFO `dreamer.call | phase=map chars= tokens= ms=`), yields while the user has an active turn (`yield_check_ms` poll against the runtime's turn state), staged outputs, advances mark ONLY after all canonical writes commit; status record `memory/.dream-status.json`; `dreamer.run.ok | sessions= ops= duration_ms=`. Reduce-call application lands in T21/T22 — here the reduce output is produced and returned, not applied.

- [ ] **Step 1: Failing tests** — crash-window redo converges (run, kill after 2 of 3 map calls (throw), rerun → same deterministic entry ids, no dupes); mark advances only on success; toggle-off user skipped but mark advances; provider stub asserts input ≤ budget.
- [ ] Steps: FAIL → implement → PASS → commit `feat(dreamer): checkpointed map/reduce runner`.

---

### Task 19: Episode + journal writer

**Model:** opus
**Files:** Create `gateway/src/memory/dreamer/episode-writer.ts` (+test). (Same lane, after T18b.)
**Interfaces — Produces:** `writeDreamOutputs(store, sync, dayResults): void` — journal `YYYY-MM-DD.md`: narrative + `## session <id>` episode sections + op log section (ops listed with source citations — content from T18b result); enqueues index entries: episode summaries (`kind: episode-summary`, `sessionRef`, provenance = `tool-derived` iff window's taint bit else `user-speech`-min), journal entry, changed file sections. Atomic via store.
- [ ] Steps: failing tests (journal shape greppable by heading; taint propagation to entry provenance — THE security assertion; idempotent re-run same ids) → implement → PASS → commit `feat(dreamer): journal + episode writer with taint propagation`.

---

### Task 20: Scheduler + S3 wiring

**Model:** opus
**Files:** Create `gateway/src/memory/dreamer/scheduler.ts` (+test); Modify `gateway/src/bootstrap/phase-services.ts` (sole owner in this slot).
**Interfaces:** nightly at `dreamer.hour` local; boot catch-up when mark older than `catch_up_threshold_hours`; per-user sequential; skips toggled-off users. Test with injected clock.
- [ ] Steps: failing tests (fires once per day; catch-up on boot; sequential not concurrent) → implement + wire → PASS → commit `feat(dreamer): nightly scheduler + catch-up`. Wave-5b gate.

---

### Task 21: Reconciler

**Model:** fable
**Files:** Create `gateway/src/memory/dreamer/reconciler.ts` (+test).
**Interfaces — Consumes:** T18b reduce output, T3b store, T10 client (status flips). **Produces:** `applyOps(store, client, ops, cfg): ApplyResult` — validates ops (unknown op → reject batch), `archiveCore()` FIRST, preservation rail (post-apply line count < `preservation_pct`% of prior → refuse whole batch, log `dreamer.rail.refused`), applies ADD/REWRITE/SUPERSEDE/FLAG_STALE to MEMORY.md/topics through the store (scan fail-closed inherited), SUPERSEDE/FLAG_STALE also `setStatus` on matching index entries with reason; every op logged with reason + sources; all-or-nothing per file.
- [ ] Steps: failing tests (rail refusal restores nothing — file untouched; archive exists before rewrite; SUPERSEDE flips index status; hostile op text → whole batch scan_rejected) → implement → PASS → commit `feat(dreamer): reconciler — ops, archive, preservation rail`.

---

### Task 22: Reduce integration + @live dreamer smoke

**Model:** opus
**Files:** Modify `gateway/src/memory/dreamer/dreamer-runner.ts` (call reconciler after reduce); Create `gateway/src/memory/dreamer/dreamer.live.test.ts` (env-gated `DREAMER_LIVE` — the only paid test: seeded session fixture → real provider → journal exists, MEMORY.md gained ≥1 fact, archive exists, rail held, scan passed).
- [ ] Steps: wire → unit green → run live once, record cost in the test header comment → commit `feat(dreamer): end-to-end dream pipeline + gated live smoke`.

---

### Task 23: E2E — S3 rows + mobile memory flows (serial)

**Model:** fable
**Files:** Create `qa/mobile/flows/{android,ios}/…-memory-write.yaml` + `…-memory-recall.yaml` (tags: `memory` + surface; conditional login subflow; visibility waits ≤3000ms) — prompt-driven chat flows ("remember I hate cilantro" → confirmation bubble; recall question → answer references it). Drive web rows: spark-episode-happy, dream-reflects-next-session (test-hook dream trigger). Update `testing-knowledge.md`.

---

### Task 24: Family scope + audience

**Model:** opus
**Files:** Modify `gateway/src/bootstrap/phase-services.ts` (household store per session — established owner pattern), `gateway/src/memory/memory-prompt.ts` (audience filter already from T4 — verify + extend tests), `gateway/src/memory/memory-retriever.ts` (household scopeId in search + `audience` filter for child principals), `gateway/src/tools/memory-tools.ts` (family target writes `@adults` tag passthrough; `authorUserId` into index entries via sync).
- [ ] Steps: failing tests (child search excludes `audience: adults` entries; family write by adult lands in shared store; child family-write still rejected) → implement → PASS → commit `feat(memory): household scope live + audience filtering`.

---

### Task 25: Deep-dream trigger + docs

**Model:** sonnet
**Files:** Modify `gateway/src/memory/dreamer/scheduler.ts` (exported `triggerDeepDream(user, windowDays)` — same runner, journal/episode sources, no schedule), `docs/native-todo.md` (check off what landed; keep deferrals accurate), `agents/docs/learnings.md`, `agents/docs/testing-knowledge.md` (final row sync), `deploy/README.md` (operator purge runbook: identify session → `purge` via admin endpoint → journal op-log line references → note edit).
- [ ] Steps: small test for trigger → implement → docs → commit `feat(memory): deep-dream trigger + operator runbook + docs`.

---

### Task 26: E2E — S4 rows + full regression (serial, final)

**Model:** fable
Rows: family-scope, family-audience, then the FULL matrix regression (all rows, both-viewport rows at both sizes). Pre-handover gate: every case green, evidence captured, `bun run ci` + service pytest clean.

---

## Self-Review Notes

- Spec coverage: §3 defenses → T1 (channel), T2/T3b (capability+symlink), T5 (validate/scan/log events), T9a (registry+credentials), T13 (gate+risk), T14 (provenance routing), T19 (taint), T21 (rail+no-delete), T8/T16/T23/T26 (matrix). §5.6 outbox → T12. §8 checkpoint/yield → T18b. §9 → T24. §11 → T1+T7. §13 slice mapping preserved as waves.
- Deliberately NOT in this plan: dreamer-to-shared, viewer UI, session-close summarization — spec §14 deferrals.
- Type consistency: `MemoryStore`/`WriteResult` (T3b) consumed by T4/T5/T19/T21; `DeepMemoryClient`/`IndexEntry` (T10) by T12/T13/T14/T21; `DreamWindow` (T17) by T18b/T19. Names match across tasks.
