# Memory System — Implementation Plan (rev 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Rev 2 folds the dual plan review (Codex 6 blockers/18 majors + fleet 8 headlines,
> `docs/superpowers/reviews/2026-08-08-memory-system.md`): wave-1 dependency fix,
> real repo paths (user_data_root, profile-store settings, venv conventions),
> edit-ingest quarantine owner, trigger-entry taint classifier, dreamer transaction
> boundary, commit protocol, contract pins.
>
> **PARALLEL EXECUTION MODEL:** tasks are grouped into WAVES. Tasks dispatched
> CONCURRENTLY own DISJOINT file sets. TDD is preserved *inside* each task.
> Hard rules:
> 1. **Workers never run `git add`/`git commit`.** On acceptance the orchestrator
>    runs `git add -- <exact task paths>`, verifies `git diff --cached --name-only`
>    equals the task's file list (untracked files included via the add), commits,
>    then verifies the index is empty. Atomic commit per task.
> 2. **Workers run only their own task's test files** (`bun run test -- <file>`
>    from `gateway/`, or `.venv/bin/pytest <file>` inside the service dir),
>    never the whole suite; **never `bun run typecheck`/`bun run ci` mid-wave.**
> 3. **A worker touches ONLY the files its task lists.** A needed-but-unlisted
>    edit is a task-boundary bug: stop and report to the orchestrator.
> 4. **Orchestrator commits use the rule-1 protocol and skip the hook mid-wave**
>    (`--no-verify`); safe ONLY because rule 5 is the real gate.
> 5. **Every sub-wave boundary is a gate:** before dispatching any task that
>    consumes a predecessor, the orchestrator runs `bun run ci` (+ service
>    `.venv/bin/pytest` from wave 3 on) and fixes or reverts. No dispatch on red.
> 6. **No task imports a module authored by a CONCURRENTLY DISPATCHED sibling.**
>    Serial lanes inside a wave are legal: the dependent starts only after its
>    predecessor is accepted, committed, and the lane-local tests are green.
> 7. **Model sizing:** `sonnet` = mechanical/config/docs/templates/copy;
>    `opus` = everything else, including security-critical modules and the
>    serial E2E tasks. The orchestrator (fable) never delegates orchestration.

**Goal:** Per-user + shared-family memory per `docs/superpowers/specs/2026-08-08-memory-system-design.md` (rev 2). **The spec is the contract — read it first.**

**Architecture:** `gateway/src/memory/` (store, retriever, dreamer, client) + 4 native tools + `capabilityServices/DeepMemoryService/` (Python+MLX) + `memory_body` gate channel. Skill system is the precedent throughout.

**Tech Stack:** Bun/TS strict + vitest + zod (gateway); Python (version pinned in T9a after wheel-availability check, expect 3.11) + pytest + aiohttp + MLX + sqlite-vec + FTS5 (service).

## Global Constraints

- Topic slug `^[a-z0-9][a-z0-9-]{0,63}$` — code constant. Frontmatter via the existing `yaml` package + zod (skill-file.ts precedent — NOT hand-rolled).
- All tunables in `orchestrator.memory` (spec §11): block + every sub-block `.default({})`, leaf zod defaults, YAML comments with ranges.
- **Slice staging:** shipped YAML starts `spark.enabled: false`, `dreamer.enabled: false` (zod defaults stay `true` for missing-block resilience). T15 flips spark on; T20 flips dreamer on. `memory.enabled` is a real master switch consumed by T6.
- Dreamer: own `ProviderClient` runner (compaction precedent), never the auxiliary seam. No recall-time LLM synthesis.
- Provenance taint (spec §3.1) covers `tool_result` AND background-completion `trigger` entries. Write-time scan fail-closed on `suspicious` AND `hostile`. `memory_body` gate channel read-time. No memory content in logs.
- Note files are dumb (spec §4.2). Spark: similarity gates, recency only orders. Situation-block only.
- Household dir name = the principal's `householdId` (live value today: `"home"`, minted in `ws-auth-gate.ts` — spec §2's `family` is illustrative).
- Every new TS file: tagged logger. All unit tests zero-cost; `@live` env-gated (`DEEP_MEMORY_LIVE` free, `DREAMER_LIVE` paid — the only paid test). E2E rows run against a local/Ollama provider config — zero paid tokens.

## File Ownership Matrix (conflict guard)

| File set | Task | Wave | Model |
|---|---|---|---|
| `shared/config/src/schemas/orchestrator-config.ts`, `shared/config/src/schema.ts` (inbound channel + `access.shared_data_root`), `gateway/src/security/injection-scanner.ts` (`ScanChannel` union line only), `gateway/config.yaml` keys, loader test | T1 | 0 | sonnet |
| `gateway/src/access/capability.ts`, `access/access-manager.ts` (+tests) | T2 | 0 | opus |
| `gateway/src/memory/memory-file.ts` (+test) | T3a | 0 | sonnet |
| `gateway/src/memory/memory-store.ts` (+test) | T3b | 1a (sole) | opus |
| `gateway/src/memory/memory-prompt.ts` (+test), `context/system-prompt-loader.ts` (loader fn), `gateway/system_prompts/memory-preamble.md` | T4 | 1b | opus |
| `gateway/src/tools/memory-tools.ts` (+test), `api/handlers/mcp-catalog.ts` (rows) | T5 | 1b | opus |
| `bootstrap/phase-services.ts` (S1 slots incl. `GATE_CHANNELS`), `runtime/session-runtime.ts` (S1: reingest at build), composition test | T6 | 1c (sole) | opus |
| `gateway/src/profile-store/profile-types.ts` (+defaults), profile update path, `gateway/webui/src/services/profile-api.ts`, `webui/.../panes/memory-pane.tsx` (add toggles; existing Hermes editor stays), round-trip test | T7 | 2 | sonnet |
| E2E S1 (Files: `agents/docs/testing-knowledge.md` rows + Playwright evidence dir) | T8 | 2b (serial) | opus |
| `capabilityServices/DeepMemoryService/`: `pyproject.toml`, `requirements.txt`, `src/deep_memory/{__main__.py,server.py,scopes.py,auth.py,config.py,logging.py}`, `config/config.example.yaml`, `tests/test_server.py`, protocol fixtures `tests/fixtures/*.json` | T9a | 3 | opus |
| same dir: `src/deep_memory/{index.py,embedder.py,search.py}`, `tests/{test_index.py,test_search.py}`, version pins into `config.example.yaml`/`requirements.txt` | T9b | 3 (lane, after T9a) | opus |
| `gateway/src/memory/deep-memory-client.ts` (+test using T9a's committed fixtures) | T10 | 3 | opus |
| `gateway/config.yaml` `managed_services.deep-memory`, `deploy/mac-prod/setup-prod.py` (`SERVICE_SOURCES` ~169-178), `scripts/build-python-wheels.sh`, `scripts/dev-stage-code.sh`, `deploy/README.md`, service `CONTRACT.md`, `capabilityServices/DeepMemoryService/tests/test_live_roundtrip.py` (DEEP_MEMORY_LIVE-gated) | T11 | 3b (after T9b) | sonnet |
| `gateway/src/memory/index-sync.ts` (+test) | T12 | 4 | opus |
| `gateway/src/memory/memory-retriever.ts` (+test), `context/situation-block.ts` (optional `memory` dep) | T13 | 4 | opus |
| `gateway/src/tools/memory-tools.ts` (recall/read real), `gateway/src/store/session-excerpt.ts` (+test), `tools/tool-broker.ts` (`provenanceFor` routing), broker-level gate test | T14 | 4 | opus |
| `bootstrap/phase-services.ts` + `runtime/session-runtime.ts` (S2 slots: client, scopes, sync, spark turn-start hook) + `gateway/config.yaml` (`spark.enabled: true`) | T15 | 4b (sole) | opus |
| E2E S2 (Files: testing-knowledge rows + evidence) | T16 | 4c (serial) | opus |
| `gateway/src/store/project-for-dreaming.ts` (+test) | T17 | 5 | opus |
| `gateway/system_prompts/dreamer/{map.md,reduce.md}` | T18a | 5 | sonnet |
| `gateway/src/memory/dreamer/dreamer-runner.ts` (+test) | T18b | 5 (lane, after T17) | opus |
| `gateway/src/memory/dreamer/episode-writer.ts` (+test) | T19 | 5 (lane, after T18b) | opus |
| `gateway/src/memory/dreamer/scheduler.ts` (+test), `phase-services.ts` (S3a slot), `gateway/config.yaml` (`dreamer.enabled: true`) | T20 | 5b (sole) | opus |
| E2E S3a mini (spark-episode-happy, dream-reflects episodic) | T20b | 5c (serial) | opus |
| `gateway/src/memory/dreamer/reconciler.ts` (+test) | T21 | 6 | opus |
| `dreamer-runner.ts` (reduce+ops in transaction), `dreamer.live.test.ts` + `tests fixture dreamer.fixture.json`, reconciler replay test | T22 | 6 (lane, after T21) | opus |
| E2E S3 full + Maestro memory flows (`qa/mobile/flows/{android,ios}/*memory*.yaml`, testing-knowledge rows) | T23 | 6b (serial) | opus |
| household activation: `phase-services.ts` (its slot), `memory-prompt.ts`, `memory-retriever.ts`, `memory-tools.ts`, `index-sync.ts` (audience/author metadata), tests re-run list | T24 | 7 | opus |
| deep-dream trigger (`scheduler.ts`), `docs/native-todo.md`, `agents/docs/learnings.md`, `deploy/README.md` runbook | T25 | 7 | sonnet |
| E2E S4 + full-matrix regression (testing-knowledge family rows + evidence) | T26 | 7b (serial, final) | opus |

Waves: **0** T1∥T2∥T3a → gate. **1a** T3b → gate. **1b** T4∥T5 → gate. **1c** T6 → gate. **2** T7 → gate, **2b** T8. **3** (T9a→T9b) ∥ T10 → gate, **3b** T11 → gate + live round-trip. **4** T12∥T13∥T14 → gate, **4b** T15 → gate, **4c** T16. **5** T17∥T18a, lane T17→T18b→T19 → gate, **5b** T20 → gate, **5c** T20b. **6** T21→T22 → gate, **6b** T23. **7** T24∥T25 → gate, **7b** T26.

---

### Task 1: Config schema + channels + shared root + YAML

**Model:** sonnet
**Files:** Modify `shared/config/src/schemas/orchestrator-config.ts`, `shared/config/src/schema.ts` (add `memory_body` channel boolean beside the four at ~:391-394 AND `access.shared_data_root` — optional string beside `user_data_root`), `gateway/src/security/injection-scanner.ts` (`ScanChannel` union at :11 — add `"memory_body"`, no logic), `gateway/config.yaml`; Test: extend `shared/config/src/loader.test.ts`.
**Interfaces — Produces:** `config.orchestrator.memory` per spec §11 **plus** `memory.service.url` (string, default `http://127.0.0.1:8771`, loopback comment); `config.security.inbound_scan.channels.memory_body: boolean` default true; `config.access.shared_data_root?: string` (optional; consumers derive `join(dirname(user_data_root), "shared")` when absent — comment says so); `ScanChannel` includes `"memory_body"`.

- [ ] **Step 1: Failing test:**

```ts
it("parses orchestrator.memory with spec defaults", () => {
  const cfg = loadConfigFixture();
  expect(cfg.orchestrator.memory.core_max_lines).toBe(300);
  expect(cfg.orchestrator.memory.spark.min_similarity).toBe(0.6);
  expect(cfg.orchestrator.memory.service.url).toBe("http://127.0.0.1:8771");
  expect(cfg.security.inbound_scan.channels.memory_body).toBe(true);
});
it("boots a pre-upgrade config missing orchestrator.memory entirely", () => {
  const cfg = loadConfigFixture({ stripKeys: ["orchestrator.memory"] });
  expect(cfg.orchestrator.memory.enabled).toBe(true); // block-level .default({})
});
```

- [ ] **Step 2:** `bun run test -- loader` from `shared/config` — FAIL.
- [ ] **Step 3:** Implement per spec §11 (every sub-block `.default({})`, leaf `.default()` + `.min/.max` from ranges). **Shipped YAML sets `spark.enabled: false` and `dreamer.enabled: false`** (staging, Global Constraints) — zod defaults remain `true`. Full YAML block with per-key comments + ranges.
- [ ] **Step 4:** PASS. **Step 5:** report; orchestrator commits `feat(config): orchestrator.memory + memory_body channel + shared root`.

---

### Task 2: Memory capabilities

**Model:** opus
**Files:** Modify `gateway/src/access/capability.ts` (ResourceClass union at :12), `gateway/src/access/access-manager.ts`; Test: extend `gateway/src/access/access-manager.test.ts`.
**Interfaces — Consumes:** T1's `config.access.shared_data_root` (via `AccessManagerConfig` — add optional `sharedDataRoot` field; when absent derive `join(dirname(userDataRoot), "shared")`). **Produces:** `ResourceClass` gains `"memory-private" | "memory-household"`; `grant(principal, "memory-private")` → cap rooted `join(userDataRoot, principal.userId)` (the EXISTING `userHomeDir` — `user_data_root` is already `~/.sentient/gateway/users`, config.yaml:197; no extra segment); `grant(principal, "memory-household")` → cap rooted `join(sharedDataRoot, principal.householdId)`. Field name is **`cap.resource`** (capability.ts:17).

- [ ] **Step 1: Failing tests:**

```ts
it("memory-private roots in the existing user home dir", () => {
  const cap = manager.grant(p({ userId: "kevin" }), "memory-private");
  expect(cap.resource).toBe("memory-private");
  expect(cap.rootPath).toBe(join(userDataRoot, "kevin"));
});
it("memory-household roots in the shared sibling dir keyed by householdId", () => {
  const cap = manager.grant(p({ userId: "kevin", householdId: "home" }), "memory-household");
  expect(cap.rootPath).toBe(join(dirname(userDataRoot), "shared", "home"));
});
```

- [ ] Steps: FAIL → implement (mkdir-on-grant consistent with existing classes) → PASS → commit `feat(access): memory resource classes + shared root derivation`.

---

### Task 3a: memory-file — format + validation

**Model:** sonnet
**Files:** Create `gateway/src/memory/memory-file.ts` (+test).
**Interfaces — Produces:** `MEMORY_SLUG_RE`; `parseTopicFile(raw)` / `serializeTopicFile(meta, body)` using the `yaml` package + zod discriminated result (mirror `gateway/src/skills/skill-file.ts:12,51` — read it first); `validateMemoryText(text, {maxLines, maxChars}): {ok:true} | {ok:false; error:"cap_lines"|"cap_chars"|"invisible_chars"; lines; chars}`; `countUsage(text)`.
- [ ] Steps: failing tests (slug traversal reject, invisible-char reject, exact cap boundary) → implement → PASS → commit `feat(memory): memory file format + validation`.

---

### Task 3b: MemoryStore (wave 1a, sole)

**Model:** opus
**Files:** Create `gateway/src/memory/memory-store.ts` (+test).
**Interfaces — Consumes:** T2 caps, T3a validators, `scanContent` type (`import type { ScanResult } from "../security/injection-scanner"`; constructor dep `scan: typeof scanContent`). **Produces:**

```ts
openMemoryStore(cap: Capability, cfg: MemoryConfig, deps: {scan: typeof scanContent}): MemoryStore
interface MemoryStore {
  readCore(): string | null; writeCore(next: string): WriteResult;
  listTopics(): TopicMeta[]; readTopic(slug: string): string | null;
  writeTopic(slug: string, meta: TopicMeta, body: string): WriteResult;
  listJournal(): string[]; readJournal(date: string): string | null;
  writeJournal(date: string, content: string): WriteResult;
  archiveCore(): void;
  reingestEdits(): { rescanned: string[]; quarantined: string[] }; // hash-detect + re-validate + re-scan; quarantined files render absent from readCore/readTopic until re-written
}
type WriteResult = { ok: true; usage: {lines: number; chars: number} }
  | { ok: false; error: "cap_lines"|"cap_chars"|"scan_rejected"|"path_refused"; usage?: {lines: number; chars: number} }
```

Rooted `cap.rootPath + "/memory"`. Wrong-class capability rejected FIRST (accepts `memory-private` or `memory-household`); `guardedRealpath` symlink guard (skill-store.ts:85-97 precedent); scan fail-closed on `suspicious` AND `hostile`; hash + quarantine state in `memory/.ingest-state.json`; atomic tmp+rename.

- [ ] **Step 1: Failing tests** (security is the point): wrong-class rejection (`sessionStoreCap` → throw /resource class/); symlink escape → `path_refused`; cap refusal with usage; **quarantine round-trip** — write clean file, mutate on disk to injection text, `reingestEdits()` quarantines it, `readCore()` returns null + WARN logged, re-`writeCore` clears quarantine; `suspicious` verdict → `scan_rejected`, file untouched.
- [ ] Steps: FAIL → implement → PASS → commit `feat(memory): MemoryStore — caps, scan, symlink guard, edit-ingest quarantine`.

---

### Task 4: Prompt rendering (wave 1b)

**Model:** opus
**Files:** Create `gateway/src/memory/memory-prompt.ts` (+test), `gateway/system_prompts/memory-preamble.md`; Modify `gateway/src/context/system-prompt-loader.ts` (add `loadMemoryPreamble()` mirroring `loadSkillIndexPreamble` at :88).
**Interfaces — Consumes:** T3b `MemoryStore`. **Produces:** `composeMemoryBlock(stores: {private: MemoryStore; household?: MemoryStore}, cfg: MemoryConfig, opts: {childPrincipal: boolean}): string` — pure; caller runs `reingestEdits()` first (T6's job). Labeled data envelopes per scope; topic index byte-stable sort + invisible-strip; aggregate `prompt_budget_chars` with spec §4.5 drop order (WARN per truncation); `@adults`-suffixed household lines filtered when `childPrincipal`. In S1 `household` is always undefined (activated in T24).
- [ ] Steps: failing tests (byte-stability; drop order under tiny budget; `@adults` filter; empty renders preamble only) → implement (write the full preamble: what memory is, style contract, cap contract, recall latency etiquette, "don't write ambiently") → PASS → commit `feat(memory): prompt block renderer + preamble`.

---

### Task 5: The four memory tools + settings projection (wave 1b)

**Model:** opus
**Files:** Create `gateway/src/tools/memory-tools.ts` (+test); Modify `gateway/src/api/handlers/mcp-catalog.ts` (`projectNativeTools` rows at ~:332).
**Interfaces — Consumes:** T3b store, T3a validators. **Produces:** `buildMemoryTools(deps: {storeFor(scope: "private"|"family"): MemoryStore | null; scan: typeof scanContent; cfg: MemoryConfig; principal: UserPrincipal}): NativeToolRunner[]` — `memory_list`, `memory_read`, `memory_write`, `memory_recall` per spec §4.4 arg schemas verbatim. This task: `memory_recall` + session-target `memory_read` return typed `{ error: "deep_memory_unavailable" }` (canonical string — T14 maps client errors to the SAME string). `memory_write` op errors pinned: `{ error: "str_replace_ambiguous" | "str_replace_not_found" | "remove_lines_not_found" }`. `validate()` rejects `scope:"family"` for non-adult roles BEFORE PDP; family store absent (S1) → `deep_memory_unavailable`-style typed `{ error: "family_scope_unavailable" }`. File-target `memory_read` pages via `capToolResult(content, { limit: cfg.read_max_chars })` (exact signature, tool-result-cap.ts:76). Log events: `memory-tools.write.ok | lines=`, `memory-tools.write.refused | reason=cap`, `memory-tools.scan.rejected`, `memory-tools.recall.unavailable | reason=`.
- [ ] Steps: failing tests (str_replace ambiguity typed error; child family-write rejected in `validate`; cap refusal logs `reason=cap` while result carries granular kind; recall stub shape; pinned event names via logger spy) → implement → PASS → commit `feat(tools): four memory tools + settings rows`.

---

### Task 6: S1 wiring (wave 1c, sole owner)

**Model:** opus
**Files:** Modify `gateway/src/bootstrap/phase-services.ts` (memory grants/store/tools/prompt + `GATE_CHANNELS` at :154 + `describeInboundGateMode` memory-only case), `gateway/src/runtime/session-runtime.ts` (if session build needs a field); Test: extend the composition/session tests (cache-invariant precedent at `session-runtime.test.ts:3063`).
**Interfaces — Consumes:** T2 grants, T3b store, T4 compose, T5 tools, T1 `memory.enabled`. **Produces:** per session, **gated on `cfg.orchestrator.memory.enabled`** (off = no grants, no store, no tools, no prompt block): mint `memory-private` grant → open store → `store.reingestEdits()` → `composeMemoryBlock({private: store}, cfg, {childPrincipal})` appended after the skill index (once-per-session site, phase-services.ts:845) → memory tools concatenated into the `nativeTools` **array** (`[...skillTools, ...memoryTools]`, :803). Private only — household is T24's. `GATE_CHANNELS` gains `"memory_body"`. Event `memory.prompt.rendered | chars= scopes=`.
- [ ] Steps: failing tests — (a) disabled ⇒ no memory envelope, no memory tools; (b) **cache invariant, runtime-shaped** (precedent :3063): build session A, capture provider input, `memory_write` mid-A, next A turn's prefix byte-identical; new session B includes the fact; (c) quarantined file absent from the rendered block → wire → PASS → commit `feat(memory): S1 composition — store, tools, prompt, reingest, gate channels`. Wave-1c gate: full `bun run ci`.

---

### Task 7: Per-user toggles (wave 2)

**Model:** sonnet
**Files:** Modify `gateway/src/profile-store/profile-types.ts` (`profileV1Schema` at :96 — add `memory: { spark: boolean; dreaming: boolean }` with defaults `{spark: true, dreaming: true}` and the schema's missing-field resilience pattern), the profile update path in `gateway/src/profile-store/` (locate the pane's save route from `webui/src/services/profile-api.ts:18` usage), `gateway/webui/src/services/profile-api.ts` (mirror type), `gateway/webui/src/components/settings/panes/memory-pane.tsx` (ADD a toggles section — the existing pane is a LIVE Hermes-era MEMORY.md/USER.md editor; extend, do not repurpose or delete); Test: profile round-trip (persists through store re-open; missing field defaults true).
**Interfaces — Produces:** `profile.memory.spark` / `profile.memory.dreaming` booleans; gateway helper on the profile store: `memoryTogglesFor(userId): Promise<{spark: boolean; dreaming: boolean}>` (defaults true on missing/corrupt profile). Copy: "Memory sparking — bring up relevant past memories in conversation" / "Nightly dreaming — let Sentient reflect on the day and update its notes".
- [ ] Steps: failing round-trip test → implement → PASS → commit `feat(settings): per-user memory toggles`. Wave-2 gate.

---

### Task 8: E2E — S1 rows (wave 2b, serial, owns the stack)

**Model:** opus
**Files:** `agents/docs/testing-knowledge.md` (memory-tag rows), Playwright evidence dir. Provider: local/Ollama config — zero paid tokens.
- [ ] **Step 1:** `bun run ci` green. Then drive `bun run dev` stack:

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| memory-write-explicit | 1280×900 + 390×844 | adult, empty memory | "Remember that I hate cilantro" | confirmation; `memory_read` shows one bullet | `memory-tools.write.ok \| lines=` |
| memory-prompt-render | 1280×900 | MEMORY.md has facts | new session "what do you know about me" | facts reflected, no tool call | `memory.prompt.rendered \| chars=` |
| memory-cache-stability | 1280×900 | live session A | write mid-A; continue; open B | A unchanged mid-session; B knows fact | A: no re-render; B: rendered incl. fact |
| cap-overflow | 1280×900 + 390×844 | MEMORY.md near cap | remember many facts | consolidates or explains limit | `memory-tools.write.refused \| reason=cap` |
| injection-attempt | 1280×900 | — | remember tool-envelope injection text | refused, explained | `memory-tools.scan.rejected` |
| cross-user-isolation | 1280×900 | user A populated | user B asks about A | B knows nothing | zero A-scope ids in B trail (`cross-user-refused` oracle) |
| recall-degraded | 1280×900 | S1 (no service) | recall ask | graceful unavailable | `memory-tools.recall.unavailable` |

Green = behavior AND pinned events. Commit rows to testing-knowledge under `memory` tag.

---

### Task 9a: DeepMemoryService — scaffold, server, registry, auth (wave 3)

**Model:** opus
**Files:** Create `capabilityServices/DeepMemoryService/`: `pyproject.toml`, `requirements.txt`, `src/deep_memory/{__main__.py,server.py,scopes.py,auth.py,config.py,logging.py}`, `config/config.example.yaml`, `tests/test_server.py`, `tests/fixtures/*.json` (committed request/response fixtures per endpoint — T10 reuses them). **Mirror `WhisperSTTService` conventions** (pyproject + requirements + repo `.venv`; prod renames to `venv` via `scripts/dev-stage-code.sh:43` — do NOT invent a setup script). HTTP: `aiohttp`.
- [ ] **Step 1 (before any code): verify + pin versions** — Python (check MLX embedding lib + sqlite-vec wheel availability; expect 3.11 like local-tts), aiohttp, mlx deps → `requirements.txt` + `pyproject.toml` + note in `config.example.yaml`.
- [ ] **Step 2: Failing pytest** (`.venv/bin/pytest tests/test_server.py`) — for EVERY endpoint (`register-scope`, `upsert`, `search`, `set-status`, `purge`, `rebuild`, `health`): happy shape + auth-plane refusals (data token on each admin endpoint → 403; admin-only ops with data token → 403; unknown `scopeId` → 403 `unknown_scope`; `register-scope` path outside data root → 400) + malformed body → 400. Tokens from env `DEEP_MEMORY_ADMIN_TOKEN` / `DEEP_MEMORY_DATA_TOKEN`.
- [ ] Steps: FAIL → implement (index calls stubbed in-memory; persisted scope registry in the service state dir) → PASS → commit `feat(deep-memory): service scaffold — registry, split credentials, wire contract`.

---

### Task 9b: DeepMemoryService — index engine (lane, after 9a)

**Model:** opus
**Files:** Create `src/deep_memory/{index.py,embedder.py,search.py}`, `tests/{test_index.py,test_search.py}`; update `config.example.yaml` (embedding model pin).
**Produces:** per-scope SQLite (`entries` + FTS5 + sqlite-vec, schema-version row, embedding-model-id row); idempotent upsert by `id`; pinned pipeline (spec §5.3): vector top-40 cosine + BM25 top-40 → RRF k=60 → dedupe → `{entry, similarity, rank}`; filters kinds/statuses/timeRange; `purge` filter key **`sessionId`** (matches `entry.sessionRef.sessionId`) plus sourceRef/provenance/timeRange; model mismatch → startup WARN + search 409 `rebuild_required`.
- [ ] Steps: failing pytests (idempotent upsert; RRF fusion ordering; similarity ∈[0,1]; purge-by-sessionId removes episode + fact entries carrying the ref; 409) → implement → PASS → commit `feat(deep-memory): hybrid index engine`.

---

### Task 10: DeepMemoryClient (wave 3)

**Model:** opus
**Files:** Create `gateway/src/memory/deep-memory-client.ts` (+test reusing T9a's committed `tests/fixtures/*.json` — read them from the service dir; if T9a hasn't committed yet when dispatched, the fixtures' shapes are specified here and MUST match).
**Interfaces — Produces:**

```ts
createDeepMemoryClient(opts: {baseUrl: string; adminToken: string; dataToken: string; requestTimeoutMs: number}): DeepMemoryClient
interface DeepMemoryClient { registerScope(scopeId, indexPath); upsert(scopeId, entries: IndexEntry[]); search(req: {scopeIds: string[]; query: string; k: number; filters?}): Promise<Result<Hit[]>>; setStatus(scopeId, ids, status, reason); purge(scopeId, filter); rebuild(scopeId); health(); }
type Hit = { entry: IndexEntry; similarity: number; rank: number };
type IndexEntry = /* spec §5.4 verbatim + authorUserId?: string */;
type ClientError = { kind: "unavailable"|"timeout"|"rebuild_required"|"refused" };
```

`baseUrl` from `cfg.memory.service.url` (T1); tokens from env names above; every call `AbortSignal.timeout(requestTimeoutMs)`. Admin methods use adminToken; data methods dataToken.
- [ ] Steps: failing tests (timeout within budget → `{kind:"timeout"}`; 409 → `rebuild_required`; happy search from fixture) → implement (plain `fetch`) → PASS → commit `feat(memory): DeepMemoryClient`.

---

### Task 11: Packaging + registration + live round-trip (wave 3b)

**Model:** sonnet
**Files:** Modify `gateway/config.yaml` (`managed_services.deep-memory`: `launch: native`, `optional: true`, `exec: ["${SENTIENT_CODE}/deep-memory/venv/bin/python", "-m", "deep_memory"]` shape + env: config path, tokens, data root — mirror whisper-stt block :1091-1133), `deploy/mac-prod/setup-prod.py` (`SERVICE_SOURCES` :169-178), `scripts/build-python-wheels.sh` (:124 — add service), `scripts/dev-stage-code.sh` (:25,43 — add service), `deploy/README.md` (deploy + rollback smoke: install → health-gate → rollback path); Create service `CONTRACT.md`, `tests/test_live_roundtrip.py` (gated `DEEP_MEMORY_LIVE=1`: register scope → upsert → search hit).
- [ ] Steps: extend orchestrator-config test for the entry → implement → PASS → commit `feat(deploy): deep-memory packaging + managed service`. Wave-3b gate: `bun run ci` + service pytest + `DEEP_MEMORY_LIVE=1` round-trip (orchestrator boots service once).

---

### Task 12: Index sync (wave 4)

**Model:** opus
**Files:** Create `gateway/src/memory/index-sync.ts` (+test).
**Interfaces — Consumes:** T10 client, T3b store. **Produces:**

```ts
type ScopeHandle = { scopeId: string; store: MemoryStore; indexDir: string; sessionStore?: SessionStoreRead };
type EnqueueEntry = Omit<IndexEntry, "id"|"createdAt"|"statusChangedAt"|"status"> & { status?: IndexEntry["status"] }; // flush fills id (deterministic hash(scope:kind:sourceRef:contentHash)), createdAt, status default "active"
createIndexSync(scope: ScopeHandle, client: DeepMemoryClient, cfg): IndexSync
interface IndexSync { enqueueFile(file: string): void; enqueueEntries(entries: EnqueueEntry[]): void; flush(): Promise<void>; onHealthRecovered(): void; rebuildScope(): Promise<Result<void>>; }
```

Cursor persisted `deep-memory/.sync-cursor.json`. `enqueueEntries` accepts `audience`/`authorUserId`/`provenance`/`sessionRef` from callers (T19/T22/T24). Raw-chunk projection: when `cfg.spark.raw_chunks` is true, `enqueueSessionChunks(sessionId, entries)` projects turn chunks deterministically; `rebuildScope` replays files + journals + (raw chunks when enabled) via the same idempotent path.
- [ ] Steps: failing tests (outage → queue persists across recreate; flush idempotent; rebuild re-feeds; raw_chunks default-off = no chunk entries, enabled = deterministic ids) → implement → PASS → commit `feat(memory): index sync outbox`.

---

### Task 13: memory-retriever / spark (wave 4)

**Model:** opus
**Files:** Create `gateway/src/memory/memory-retriever.ts` (+test); Modify `gateway/src/context/situation-block.ts` (optional dep `memory?: () => string | null` — `SituationBlockDeps` is a fixed dep object at :51-57 and `render()` takes no args, so the memory section is a **synchronous closure returning the turn's cached spark string**; computation happens at turn start, T15 wiring).
**Interfaces — Consumes:** T10 client, the SESSION'S `InboundGate` instance (`gate.screen({channel: "memory_body", ...})` — the same instance injected into the broker, inbound-gate.ts:90; gate holds the RiskAccumulator, so spark findings raise the SAME risk the PDP reads), T7 `memoryTogglesFor`. **Produces:** `createMemoryRetriever(deps: {client; gate: InboundGate; toggles; cfg}): MemoryRetriever` with `computeSpark(turn: {utterance: string; turnId: string; scopeIds: string[]; childPrincipal: boolean}): Promise<string>` (memoized by `turnId`; "" on empty/timeout/toggle-off/gate-strip) and `cachedFor(turnId): string | null` (what the situation closure reads). Similarity gates (`min_similarity`), recency ORDERS (`orderScore = similarity × max(recency_floor, 2^(-ageDays/half_life))`), caps `max_snippets`/`token_budget`, deadline `spark.timeout_ms`. Withheld reasons enum pinned: `below-threshold | timeout | toggle-off | gate-off | empty`. Events: `memory-retriever.spark.hit | similarity= kind=`, `memory-retriever.spark.withheld | reason=below-threshold`, `memory-retriever.audience.filtered`.
- [ ] **Step 1: Failing tests:** old high-similarity fires (sim .8, age 400d → passes gate); recency orders not gates (sim .61 old vs .62 new → both injected, new first); timeout → "" + withheld log; memoized (two `computeSpark` same turnId → one search); hostile snippet → gate screen raises `gate.getRiskLevel()` on the shared accumulator.
- [ ] Steps: FAIL → implement → PASS → commit `feat(memory): spark retriever`.

---

### Task 14: Real recall + excerpt reads + gate routing (wave 4)

**Model:** opus
**Files:** Modify `gateway/src/tools/memory-tools.ts` (+test), Create `gateway/src/store/session-excerpt.ts` (+test), Modify `gateway/src/tools/tool-broker.ts` (`provenanceFor` at :769: `memory_recall` + `memory_read` → `"memory_body"`; `memory_write`/`memory_list` stay `tool_result`); broker-level test.
**Interfaces — Consumes:** T10 client, session store read API (the existing `SessionStore` read surface `openSessionStore` exposes). **Produces:** `memory_recall` per spec §4.4 (≤k hits, snippet ≤200 chars, server-minted `sessionId`/`entrySpan`); `renderSessionExcerpt(store, {sessionId, around?, offset?, contextEntries}): string` — applies span/offset FIRST, then `capToolResult(excerpt, { limit: cfg.read_max_chars })` (marker included by the helper); client `{kind:"unavailable"|"timeout"}` maps to the CANONICAL tool error `{ error: "deep_memory_unavailable" }` (same string as T5's stub). File-target reads also screen as `memory_body` (routing covers `memory_read` wholesale). Tests go **through the public ToolBroker dispatch**, not the private `provenanceFor`.
- [ ] **Step 1: Failing tests (broker-level):** dispatch `memory_recall` with a hostile fixture result → `inbound-gate.flagged | channel=memory_body` emitted AND accumulated risk escalates a subsequent side-effecting tool from allow to ask (skill precedent `inbound-scan-escalate`, testing-knowledge:980); excerpt honors span ± context + truncation marker; unavailable mapping string.
- [ ] Steps: FAIL → implement → PASS → commit `feat(tools): real recall + capped excerpt reads + memory_body routing`.

---

### Task 15: S2 wiring (wave 4b, sole owner)

**Model:** opus
**Files:** Modify `gateway/src/bootstrap/phase-services.ts`, `gateway/src/runtime/session-runtime.ts`, `gateway/config.yaml` (**flip `spark.enabled: true`**); composition test.
**Produces:** client from `createDeepMemoryClient({baseUrl: cfg.memory.service.url, ...env tokens, requestTimeoutMs})`; **scope registration is idempotent and runs at boot discovery AND per-scope construction** (post-boot user creation test — a scope constructed after boot gets registered before first search); `IndexSync` wired into store write paths; retriever constructed per session with the session's gate; **turn start** (stimulus accepted) awaits `computeSpark` (deadline-bounded) and caches; situation-block `memory` closure reads `cachedFor(turnId)`; health-recovery → `sync.onHealthRecovered()`. All gated on `memory.enabled`.
- [ ] Steps: failing composition tests (spark section present when retriever caches text, absent when ""; post-boot scope registered; disabled mode constructs none of it) → wire → PASS → commit `feat(memory): S2 composition — client, scopes, sync, spark`. Wave-4b gate.

---

### Task 16: E2E — S2 rows (wave 4c, serial)

**Model:** opus
**Files:** testing-knowledge rows + evidence dir.
- [ ] **Step 1:** `bun run ci` + service pytest green. Rows (local provider):

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| spark-file-happy | 1280×900 | indexed MEMORY.md Tahoe fact | mention skiing | reply references Tahoe naturally | `memory-retriever.spark.hit \| similarity=` |
| spark-empty | 1280×900 | indexed memories | unrelated topic | normal answer | `memory-retriever.spark.withheld \| reason=below-threshold` |
| recall-tool | 1280×900 + 390×844 | multi-session history | "what did we decide about the kitchen?" | spoken ack, then answer citing past | `memory-tools.recall.ok \| hits=` |
| recall-escalate | 1280×900 | hostile tool-derived entry seeded | recall it, then side-effecting ask | permission prompt where allow expected | `inbound-gate.flagged \| channel=memory_body` |
| recall-degraded | 1280×900 | stop service mid-stack | recall ask | graceful unavailable | `memory-tools.recall.unavailable \| reason=` |

---

### Task 17: projectForDreaming (wave 5)

**Model:** opus
**Files:** Create `gateway/src/store/project-for-dreaming.ts` (+test).
**Produces:** `projectForDreaming(entries: StoreEntry[], fromSeq, toSeq): DreamWindow` where `DreamWindow = { sessions: DreamSession[] }`, `DreamSession = { sessionId; text; containsToolDerived: boolean }`. **Source-kind→provenance classifier over the REAL stored shape** (`store/entry-types.ts`): `user`→user-speech, `assistant`→assistant, `tool_result`→tool-derived, **`trigger` (background-completion, `stimulusEntryKind` in session-runtime.ts:397) → tool-derived**, `system`/`compaction` skipped. `containsToolDerived` true iff any tool-derived-classified entry in the window. Tool call/result pairs collapsed to labeled digests; interrupted output marked; append order, seq markers kept.
- [ ] Steps: failing tests (determinism; taint true for tool_result window; **taint true for trigger-only window** — the laundering case; compaction skipped) → implement → PASS → commit `feat(store): projectForDreaming with conservative provenance classifier`.

---

### Task 18a: Dreamer prompt templates (wave 5)

**Model:** sonnet
**Files:** Create `gateway/system_prompts/dreamer/map.md`, `gateway/system_prompts/dreamer/reduce.md`. Real prompt text, JSON-only output instruction, family-assistant tone. Output contracts (discriminated, zod-validated by consumers):
map → `{ episode: string, facts: [{ text: string, kind: "durable"|"ephemeral", sources: [{fromSeq, toSeq}] }] }`;
reduce → `{ ops: [ {op:"ADD", target, line, sources} | {op:"REWRITE", target, old_line, new_line, sources} | {op:"SUPERSEDE", target, old_line, new_line, sources} | {op:"FLAG_STALE", target, old_line, reason, sources} ] }` (`target`: `"MEMORY.md" | "topics/<slug>"`).

---

### Task 18b: Dreamer runner — map stage + checkpoint (lane, after T17)

**Model:** opus
**Files:** Create `gateway/src/memory/dreamer/dreamer-runner.ts` (+test).
**Interfaces — Consumes:** `ProviderClient` (construction as compaction: `provider.stream`, compaction.ts:244), T17. **Produces:** `createDreamRunner(deps): { runMapStage(user, window): Promise<DreamResult>; readMark(user): Mark; advanceMark(user, seq): void }` where `DreamResult = { sessions: [{sessionId, episode, facts, containsToolDerived}] }`. Mark file `memory/.dream-mark.json` `{lastSeq, lastRunAt}`; chunking per `max_input_chars_per_call`; schema-validated JSON with ONE retry on parse failure; yield: polls turn-state (`yield_check_ms`) and defers while the user has an active turn; per-call INFO `dreamer.call | phase=map chars= tokens= ms= model=`. **Mark advance is NOT called here** — the transaction owner (T22; T20 for the episodic slice) advances after canonical writes.
- [ ] **Step 1: Failing tests:** chunking respects budget (provider stub asserts input size); schema-retry (first malformed, second valid → second used); yield-poll (stubbed active turn defers, resumes on idle); crash redo converges (throw after 2 of 3 sessions, rerun → deterministic outputs, no dupes).
- [ ] Steps: FAIL → implement → PASS → commit `feat(dreamer): map-stage runner + checkpoint`.

---

### Task 19: Episode/journal writer (lane, after T18b)

**Model:** opus
**Files:** Create `gateway/src/memory/dreamer/episode-writer.ts` (+test).
**Interfaces — Consumes:** T18b `DreamResult`, T3b store, T12 `IndexSync`. **Produces:** `writeEpisodicOutputs(store, sync, date, result: DreamResult, appliedOps?: AppliedOp[]): WriteResult` — journal `YYYY-MM-DD.md`: narrative + `## session <id>` episode sections + op-log section listing ONLY applied ops with citations (empty in S3a). Enqueues via `sync.enqueueEntries`: episode entries (`kind: episode-summary`, `sessionRef: {sessionId}`, `sourceRef: {file: journal, heading}`, **provenance = "tool-derived" iff session's `containsToolDerived` else "user-speech"**) + journal entry + **fact entries with `sessionRef` from op `sources`** (S3b path — the §3.8 purge contract).
- [ ] Steps: failing tests (journal greppable shape; **taint propagation to entry provenance — trigger-tainted session yields tool-derived episode entry**; fact entries carry sessionRef; idempotent re-run same ids) → implement → PASS → commit `feat(dreamer): episodic writer with taint + sessionRef stamping`.

---

### Task 20: Scheduler + S3a transaction + wiring (wave 5b, sole owner)

**Model:** opus
**Files:** Create `gateway/src/memory/dreamer/scheduler.ts` (+test); Modify `phase-services.ts` (S3a slot), `gateway/config.yaml` (**flip `dreamer.enabled: true`**).
**Produces:** nightly at `dreamer.hour` (injected clock in tests); boot catch-up per `catch_up_threshold_hours`; per-user sequential; toggled-off users skipped, mark still advanced. **S3a transaction** (episodic only, MEMORY.md untouched): `runMapStage` → `writeEpisodicOutputs` (no ops) → `sync.flush()` best-effort → `advanceMark`. Status record `memory/.dream-status.json` + `dreamer.run.ok | sessions= ops=0 duration_ms=`.
- [ ] Steps: failing tests (fires once/day; catch-up; sequential; **crash between journal write and mark → rerun redoes window, journal last-wins**) → implement + wire → PASS → commit `feat(dreamer): scheduler + episodic transaction`. Wave-5b gate.

---

### Task 20b: E2E — S3a mini (wave 5c, serial)

**Model:** opus
- [ ] `bun run ci` green, then: **spark-episode-happy** (1280×900; dreamed Tahoe episode via test-hook dream; mention skiing in new session → reply references past conversation; `memory-retriever.spark.hit | kind=episode-summary`) and **dream-reflects-next-session (episodic)** (day's chat → trigger dream → new session; journal exists; `dreamer.run.ok | sessions=`). Rows → testing-knowledge.

---

### Task 21: Reconciler (wave 6)

**Model:** opus
**Files:** Create `gateway/src/memory/dreamer/reconciler.ts` (+test).
**Interfaces — Consumes:** T18a op schema, T3b store, T10 client (narrow view: `{ setStatus }` ONLY — the type it accepts must not expose `purge`; the no-hard-delete invariant is structural). **Produces:** `applyOps(store, statusClient, ops: ReduceOp[], cfg): ApplyResult` — validates (unknown op → whole batch rejected); computes final file content for every target IN MEMORY from all ops, then ONE `writeCore`/`writeTopic` per file (single scan + single atomic rename = the all-or-nothing + fail-closed guarantee); `archiveCore()` before the MEMORY.md write; preservation rail (`dreamer.rail.refused`); SUPERSEDE/FLAG_STALE flip index entry status (deterministic ids derived from `sources` + target line content) with reason; every op logged with reason + sources. Returns `{ applied: AppliedOp[] } | { refused: reason }`.
- [ ] **Step 1: Failing tests (table-driven, all four ops):** ADD appends; REWRITE replaces line, index untouched; SUPERSEDE replaces + status-flips; FLAG_STALE removes line + flips stale; unknown op → batch refused, file untouched, archive not consumed; rail refusal → file untouched; hostile op line → single-scan `scan_rejected`, nothing applied; statusClient type has no purge.
- [ ] Steps: FAIL → implement → PASS → commit `feat(dreamer): reconciler — in-memory batch apply, archive, rail`.

---

### Task 22: Full dream transaction + live smoke (lane, after T21)

**Model:** opus
**Files:** Modify `gateway/src/memory/dreamer/dreamer-runner.ts` (+test — reduce stage + full transaction), Create `gateway/src/memory/dreamer/dreamer.live.test.ts` (`DREAMER_LIVE=1`), `gateway/src/memory/dreamer/fixtures/dreamer.fixture.json`.
**Produces:** full transaction replacing S3a's: map → reduce call (`reduce.md`, schema-validated, one retry) → `applyOps` → `writeEpisodicOutputs(..., appliedOps)` (journal op log = APPLIED ops only) → `sync.flush()` → `advanceMark`. **Crash tests at every boundary:** after map / after reduce-before-apply / after apply-before-journal / after journal-before-mark — rerun redoes the window and converges (idempotent ids, journal last-wins, ops re-derived). Live smoke: seeded session → real provider → journal + MEMORY.md fact + archive + rail held + scan pass; **capture the provider request/response into `dreamer.fixture.json` on first success** and add a zero-cost replay test through `applyOps` so rail/reconciler bugs re-verify free. Record cost in the test header.
- [ ] Steps: unit red → wire → green → live once → commit `feat(dreamer): full dream transaction + gated live smoke`.

---

### Task 23: E2E — S3 full + Maestro memory flows (wave 6b, serial)

**Model:** opus
**Files:** Create `qa/mobile/flows/android/60-memory-write.yaml`, `61-memory-recall.yaml` + iOS twins (tags: `memory` + surface tag; conditional login subflow `runFlow: {when: ..., file: _helpers/login.yaml}`; visibility waits ≤3000ms); testing-knowledge rows.
- [ ] **Step 1:** `bun run ci` + pytest green. **Step 2:** author flows via Maestro MCP `inspect_screen` ONCE per screen, then batch-run `./qa/mobile/run-e2e.sh android --tags memory` (and iOS). **Step 3:** web rows: dream-reflects-next-session (full: overnight facts in new session, `dreamer.run.ok | sessions= ops=`), family rows deferred to T26. Evidence + rows committed.

---

### Task 24: Household activation + audience (wave 7)

**Model:** opus
**Files:** Modify `phase-services.ts` (household grant + store + scope registration — ITS slot), `memory-prompt.ts` (household render live), `memory-retriever.ts` (household scopeId + audience filter for child principals), `memory-tools.ts` (family target: `@adults` suffix passthrough, `authorUserId` on writes), `index-sync.ts` (parse `@adults` → `audience: "adults"`, accept `authorUserId` on file-section enqueue); tests in each.
- [ ] Steps: failing tests (child search excludes `audience: adults`; adult family write lands in shared store + entry carries authorUserId; child family write still rejected) → implement → **re-run `memory-tools.test`, `memory-prompt.test`, `memory-retriever.test`, `index-sync.test`** → PASS → commit `feat(memory): household scope live + audience filtering`.

---

### Task 25: Deep-dream trigger + docs (wave 7)

**Model:** sonnet
**Files:** Modify `scheduler.ts` (+test), `docs/native-todo.md`, `agents/docs/learnings.md`, `deploy/README.md` (operator purge runbook: identify poisoned session → admin `purge` by sessionId → journal op-log citations → note edits → `rebuild`).
**Produces:** `triggerDeepDream(user, windowDays)` — same runner, window = journals + episode summaries (not raw sessions), on-demand only. Pinned invariants in the test: correct journal/episode window selection; nightly mark NOT advanced; no shared-scope writes.
- [ ] Steps: failing test → implement → docs → commit `feat(memory): deep-dream trigger + operator runbook`.

---

### Task 26: E2E — S4 + full regression (wave 7b, serial, final)

**Model:** opus
**Files:** testing-knowledge family rows + evidence.
- [ ] **Step 1:** `bun run ci` + pytest. **Step 2:** family rows: **family-scope** (fact by A → B's session knows it; `memory.prompt.rendered | scopes=private,family`) + **family-audience** (`@adults` fact → child session never surfaces it; `memory-retriever.audience.filtered`). **Step 3:** FULL matrix regression — every row from T8/T16/T20b/T23 + both-viewport rows at both sizes. **Step 4:** commit family rows to testing-knowledge. Pre-handover gate: all green, evidence captured, deployable artifacts build.

---

## Self-Review Notes

- Review closures: wave-1 dependency (1a/1b split); commit protocol (rule 1); T2 real paths + `cap.resource` + shared-root plumbing (T1→T2→T6); edit-ingest quarantine (T3b `reingestEdits` + T6 call + test); trigger-entry taint (T17 classifier + T19 test); fact `sessionRef` (T19); dreamer transaction + mark ownership (T20 episodic, T22 full, crash tests at every boundary); log-sweep canary (below); S1 staging flags (T1 ships false/false, T15/T20 flip); household front-load removed (T4 undefined household, T5 typed family-unavailable, T24 sole activation); `memory.enabled` consumed (T6); venv/packaging reality (T9a conventions, T11 owns wheels+stage+SERVICE_SOURCES); T7 real profile-store files; client factory + env names + fixtures (T9a/T10); `Hit`/`EnqueueEntry`/`DreamResult`/op-schema pinned; `capToolResult(content,{limit})` exact; unavailable-string unified; broker-level gate tests (T14); GATE_CHANNELS (T6); post-boot scope registration (T15); e2e Files/ci-step/inline tables/local-provider; T21 full op table + structural no-purge; T22 fixture replay; S3a e2e at 5c.
- **Log-sweep canary owner: T6** — add to T6's test list: run a unique canary string through write→render→refusal paths with all loggers captured at DEBUG; assert canary absent, ids/lengths present. (T15 extends the same test through spark/recall paths; T22 through dreamer paths — each extends the shared canary helper.)
- Types cross-checked: `MemoryStore`/`WriteResult` (T3b → T4/T5/T12/T19/T21), `Hit`/`IndexEntry`/`ClientError` (T10 → T12/T13/T14/T21/T24), `DreamWindow`/`DreamSession` (T17 → T18b), `DreamResult` (T18b → T19/T20/T22), `ReduceOp`/`AppliedOp` (T18a/T21 → T19/T22), `ScopeHandle`/`EnqueueEntry` (T12 → T15/T19/T24).
