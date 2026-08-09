# Memory System Design — Sentient 2.0

**Date:** 2026-08-08 (rev 2 — post dual review: Codex 24 findings + fleet review 10 headline findings folded; see `docs/superpowers/reviews/2026-08-08-memory-system-design.md`)
**Status:** Approved design, pre-implementation
**Branch:** `feature/native-orchestrator`
**Parent spec:** `2026-07-23-sentient-2.0-native-orchestrator-design.md` (§1.2 names gateway-owned long-term memory, dreaming, and the shared family memory space as later specs — this is that spec)
**Closest precedent:** `2026-08-08-skill-system-design.md` (per-user state + native tools + prompt index; the memory module copies its structure deliberately)

---

## 1. Purpose and goals

Sentient is a **family companion AI**, not a project-scoped coding agent. Its memory must make it feel continuous: it knows each family member durably (preferences, history, opinions, ongoing threads), and past conversations can *spark* back into the present one ("you mentioned Tahoe last week…").

Goals:

- **G1 — File memory:** a simple, **deliberately dumb** markdown note-taker per user (the Hermes `MEMORY.md` model): the model reads, writes, and prunes its own notes with tools, at its own judgment. Human-inspectable and human-editable. Injected cheaply into every session.
- **G2 — Deep memory:** fuzzy, associative retrieval over the whole past (session summaries, journal, memory files) — embedding + keyword search, so "that ski vacation" finds the Tahoe trip. Two consumers: an automatic per-turn **spark** and a deliberate **`memory_recall`** tool with a bounded drill-down read.
- **G3 — Dreaming:** a nightly background pass that reads the day's sessions and distills durable memory — the sole *ambient* curator. **Deep dreaming** (wider window: week/month) is the same pipeline with a bigger lens, later.
- **G4 — Family model:** per-user private memory plus a shared household scope, isolated *and* shared at the file level — the shared scope is another instance of the same memory module rooted at a shared location.
- **G5 — Build, don't adopt.** Survey result (2026-08-08): every credible OSS memory system is a Python/Postgres sidecar or has documented extraction-quality failures; memory is irreplaceable family data with a decade horizon, and the hard part (what to extract, what to surface) is exactly the part we want to own. We hand-build inside our existing seams and steal published designs (Letta sleep-time compute, OpenClaw dreaming, Hindsight's memory-kind split, Mem0's reconcile pipeline, the Anthropic memory-tool paging shape, claude-mem's snippet→expand tiering).

Non-goals (this spec):

- Recursive sub-agents (own spec, per the 2.0 design).
- Memory viewer/editor UI (follow-up; the service API is designed so one can be built without gateway changes).
- Dreamer writing to the shared scope (needs the shared-authorship permission model — same open question as shared skills; see §14).
- Speaker identification / room-audience awareness. Identity comes from the authenticated session principal, as everywhere. The communal-device implications (a shared speaker voicing the authenticated user's private memory to whoever is in the room) are recorded in `docs/native-todo.md` as a hard prerequisite for the ambient-device era — not a v1 surface problem, since v1 surfaces (web login, mobile app) are personally authenticated.
- Rich per-user memory controls (pause/review/undo UX) and child-specific memory policy beyond the role gate — deferred to `docs/native-todo.md` (no child at home yet; keep child handling deliberately light).

## 2. Shape of the system

One reusable **memory module**, instantiated per scope root:

```
~/.sentient/gateway/users/<userId>/     # private scope (existing per-user root)
  memory/                               # file memory layer (§4)
  deep-memory/                          # deep index layer (§5)
~/.sentient/gateway/shared/family/      # household scope (new)
  memory/
  deep-memory/
```

`memory/` and `deep-memory/` are **sibling directories with asymmetric lifecycles**: `deep-memory/` is derived from `memory/` + the session store and can be deleted and rebuilt; `memory/` is canonical and is NOT recoverable from `deep-memory/`. The two never share a folder, so the index can be restructured or blown away without touching the notes.

Four components:

| Component | Where | Job |
|---|---|---|
| **File memory** | gateway TS (`gateway/src/memory/`) | markdown note store + caps + prompt rendering |
| **Deep-memory service** | `capabilityServices/DeepMemoryService/` (Python + MLX) | embeddings, hybrid index, search — a dumb, fast engine |
| **Spark + recall** | gateway TS (`memory-retriever/`, `tools/memory-tools.ts`) | per-turn auto-injection; `memory_recall` + drill-down read |
| **Dreamer** | gateway TS (`gateway/src/memory/dreamer/` with a distinct `reconciler` module) | nightly distillation via its own provider-call runner |

**Division of labor (text vs vectors):** the gateway produces and stores **text only** (notes, journal, episode summaries). The service computes embeddings at `upsert` and owns all vector math. Date/kind/scope are structured filter columns, never embedded.

**Sources of truth:**
- **Session store** (append-only per-user SQLite) — raw history. Untouched by this spec.
- **`memory/` files** — the notes, the journal, the archive. The journal is the canonical home of dreamer output (§8), which is what makes the index fully derivable.
- **`deep-memory/index.db`** — derived, rebuildable, disposable. Rebuild re-feeds it from journals + files (+ raw session chunks when enabled). Nothing irreplaceable lives here.

## 3. Security model (read this first)

The memory system is the **highest-value injection target in the architecture**: the dreamer reads whole sessions — including tool results and delegated-task output, i.e. untrusted text — and its output is rendered into the **system prompt of every future session**. A poisoned webpage summary tonight becomes trusted "memory" tomorrow. Published attacks on liberal-write memory systems (MINJA, MemoryGraft) exceed 90% injection success. Defenses, structural:

1. **Provenance with taint propagation.** Every index entry records origin: `user-speech | assistant | tool-derived`. Dreamer outputs are **tainted by their least-trusted input**: every dreamer op must cite the source session entry ranges it distilled from; an episode summary or fact distilled from a session window containing any `tool-derived` entry carries `tool-derived`. No laundering to `assistant` through the LLM pass. File-section entries carry the provenance of their author (model-written → `assistant`, detected human edit → `user-speech`).
2. **Write-time scanning, fail-closed.** Everything written into file memory — by memory tools *or* the dreamer — passes `scanContent`; `suspicious`/`hostile` refuses the write (skill-tools precedent: `injectionScanError`). Invisible-unicode rejection as in `skill-file.ts`. **Direct human file edits are an ingest event**: the store detects out-of-band changes by content hash on session build and on index sync; changed files are re-validated and re-scanned before rendering or indexing — a failed scan quarantines the file (WARN, rendered as absent) rather than injecting it.
3. **Read-time gating.** Sparked snippets, `memory_recall` hits, and drill-down reads enter model context through the inbound gate on a new **`memory_body`** channel: scanned, annotated (never silently dropped), findings feed `RiskAccumulator` — recalled tool-derived text can escalate a side-effecting tool to `confirm` within the turn. This is a two-file extension (`ScanChannel` union + config channel toggles) plus a `provenanceFor` routing change in the ToolBroker so memory-native tools screen as `memory_body`, not `tool_result`; the spark path screens inside `memory-retriever`, which holds the gate handle and the session's `RiskAccumulator`. MEMORY.md rendered into the system prompt does not transit the gate at read time (same as skill descriptions) — which is exactly why write-time scanning and edit-ingest scanning are fail-closed. Rendered memory sits inside a fixed, clearly-labeled data envelope in the prompt (content, not instructions).
4. **Capability-scoped search only.** A session searches exactly the scopes its principal holds: own private scope + household scope. Cross-user access is a hard deny by path before any content check (parent spec §2.5).
5. **Two `memory` resource classes.** The capability union gains `memory` scoped grants minted only by `AccessManager`: a private-memory grant (rooted in the user's dir) and a household-memory grant (rooted in the shared dir — `AccessManager.grant` gains the household root as a grantable resource, keyed by `householdId`). `openMemoryStore(cap)` derives its root **from the capability**, rejects wrong-class capabilities first (resource-class check before path check — the confused-deputy lesson), and applies its own `realpathSync` symlink guard (`capabilityCoversPath` is lexical; skill-store precedent).
6. **Service scope registry — no raw paths on the wire.** At boot (and on session-scope creation) the gateway registers scopes with the service over an **admin credential**: `{scopeId → indexPath}`. Data-plane requests (`search`, `upsert`, `set-status`) carry opaque `scopeId`s and a data-plane credential; the service refuses unknown scope ids and refuses data-plane credentials on admin endpoints (`register-scope`, `purge`, `rebuild`). A forged or out-of-grant path never reaches the filesystem, and a leaked data-plane token cannot purge or re-point scopes. Loopback-bound, `sentient-auth` tokens, service confined to `user_data_root`. This is deliberately a **stronger trust shape than whisper-stt/local-tts** — it is the first multi-user capability service.
7. **History is preserved in layers, not in the note file.** The note files are the model's living notes — it may rewrite or remove lines at its own judgment (G1). Durable history lives in the journal (dreamer narrative + op log with citations), `archive/` snapshots, and the index (entries are status-flipped `superseded | stale`, never hard-deleted by any automatic path). The only hard deletions are **operator-initiated** `purge` (poison response) and future user-erasure.
8. **Poison remediation (honest contract).** `purge` removes index entries by `scopeId` + filter (`sessionId`, `sourceRef`, `provenance`, time range). Because every dreamer-derived entry cites its source session, purging by `sessionId` removes the episode summary and every fact-entry distilled from that session. File-layer remediation is explicit, not magic: the journal's op log (each op cites sources) tells the operator/model which MEMORY.md lines came from the poisoned session; removing them is a `memory_write` edit (or human edit) followed by index sync. The spec makes no "removes everything derived" claim beyond this mechanism. Available from **S2** (not S4).
9. **No content in logs.** Memory text never appears in logs at any level — lengths, ids, counts, scores only.
10. **Tested like auth.** Every defense above carries a test (§12): principal isolation extended to memory scopes, forged-scopeId refusal at the service, wrong-class capability rejection, taint propagation, edit-ingest quarantine, no-hard-delete invariant on automatic paths, log-sanitization sweep.

## 4. File memory layer

### 4.1 Layout (per scope root)

```
memory/
  MEMORY.md              # the model's core notes — rendered into the system prompt every session
  topics/<slug>.md       # overflow topic notes — index line always in prompt, body read on demand
  journal/YYYY-MM-DD.md  # dreamer-written: day narrative + per-session episode summaries + op log (canonical)
  archive/               # timestamped MEMORY.md snapshots taken before each dreamer rewrite
```

### 4.2 Format and style — deliberately dumb

The file layer is a **note-taker, not a database** (the Hermes model). `MEMORY.md` and topic files are plain markdown the model manages freely: it adds facts, rewrites them as they evolve, and **removes lines it judges stale to make room** — the caps force that judgment. No per-line IDs, no lineage metadata, no ceremony. History and auditability are the journal's, archive's, and index's job (§3.7), never the note file's.

- Topic files carry minimal YAML frontmatter (`name`, `description`) validated at write: slug regex `^[a-z0-9][a-z0-9-]{0,63}$`, invisible-char rejection (`skill-file.ts` discipline). `MEMORY.md` is bare markdown.
- **Style contract (by instruction):** one fact per line, concise bullets, no prose bloat — stated in the tool descriptions and the memory preamble: every line is injected into live sessions; every wasted word is context tax.

### 4.3 Caps — lines AND characters

- `MEMORY.md`: dual cap (`memory.core_max_lines` default **300**, `memory.core_max_chars` default **12000** ≈ ~3k tokens — injected every session; ChatGPT-class profiles run 1–2k tokens; raise deliberately).
- `topics/<slug>.md`: `memory.topic_max_lines` **2000** / `memory.topic_max_chars` **80000** (read on demand, never bulk-injected).
- **Cap enforcement is a tool contract:** every `memory_write` result reports usage (`lines 212/300, chars 8.4k/12k`). A write that would exceed a cap is **refused** with a typed error instructing the model to consolidate (rewrite/merge/remove lines, or move detail to a topic file). Never silent truncation.

### 4.4 Native tools

Four tools (skill-tools pattern: `NativeToolRunner`s under the `native` namespace, settings-projected, PDP-mediated). Exact argument schemas — the implementation plan lifts these verbatim:

| Tool | Tier | Args | Returns |
|---|---|---|---|
| `memory_list` | read | `{scope?: "private"\|"family"}` (default both granted) | topic index + journal dates per scope, with descriptions |
| `memory_read` | read | `{scope?, target: {file: "MEMORY.md"\|"topics/<slug>"\|"journal/<date>"} \| {sessionId, around?: entrySeq, offset?: number}, }` | file body or session-transcript excerpt; **always head-and-tail capped** via the existing `capToolResult` (config `memory.read_max_chars`, default 8000) with the standard "narrowed view — refine or continue with offset" marker; through the inbound gate (`memory_body`) |
| `memory_write` | write | `{scope?: "private" (default) \| "family", target: "MEMORY.md" \| "topics/<slug>", op: "append" \| "str_replace" \| "remove_lines", content?, old_str?, lines?}` | typed ok/error + cap usage; `str_replace` requires unique match (Anthropic memory-tool semantics); write-time scan fail-closed; creating a new topic = `append` to an unused slug |
| `memory_recall` | read | `{query, timeRange?, scope?, includeHistorical?: false}` | ≤ `memory.recall.k` hits: `{hitId, kind, scope, date, snippet (≤200 chars), sessionId?, entrySpan?}` — a compact hit list (~≤600 tokens), through the inbound gate; description declares seconds-scale latency |

- **Recall drill-down is `memory_read` with a `sessionId` target** — the two-step, two-round-trip shape (research: claude-mem/memsearch pattern; no production harness summarizes at recall time, and neither do we — no synthesis sub-call, no prompt to tune, no injection path through a second model). The excerpt is the client-projection rendering of the entry span ± `memory.recall.context_entries` (default 2), capped, marker-truncated. Server-minted ids only (`sessionId`, `entrySeq` from the store) — the model never invents references.
- **Tier rationale:** `write` (not skills' `confirm`) — memory writes are reversible, user-scoped state changes, not authority grants. Both map to `ask` by default.
- **Roles (child included):** memory is a core feature for every family member — children get full private-scope memory. `memory_write(scope: "family")` requires an adult role, enforced argument-aware in the tool's `validate()` (before PDP), not just by tier — the role table gives children the `write` tier, so the scope check must be explicit. Child-specific policy beyond this (parental review, transparency) → `docs/native-todo.md`.
- **`memory_forget` does not exist as a tool.** "Forget X" is a `memory_write` edit — the model removes/rewrites the line (G1). Index staleness is the dreamer's and operator's job.
- The model is instructed *not* to write memory ambiently every turn — explicit user requests and its own judgment on clearly durable facts; ambient distillation is the dreamer's job.

### 4.5 System-prompt rendering

Composed **once per session at runtime construction** (skill-index rules: byte-stable deterministic ordering, sanitized, one line per entry):

1. A fixed **memory preamble** (baked template + operator override, `system-prompt-loader` pattern): what memory is, the style contract, the cap contract, and **latency etiquette** — before `memory_recall`, speak a short acknowledgment ("let me think back…") so TTS covers the gap.
2. **Private scope:** MEMORY.md body + topic index (`name — description` lines), inside a labeled data envelope.
3. **Household scope:** same, labeled as shared family memory, filtered by `audience` (§9).

**Aggregate budget:** one `memory.prompt_budget_chars` (default 20000) bounds the whole block. Deterministic drop order when over: family topic index → private topic index → family MEMORY.md tail → private MEMORY.md tail, each truncation WARN-logged. (Write-time caps make this a backstop, not a working path.)

Memory changed mid-session appears in the *next* session's prompt (cache invariant A; identical to skills). Compaction interaction: none by construction — the memory block lives in the session-stable prefix (re-rendered only at session build), spark lives in the per-turn `<situation>` tail which is always inside the verbatim recent window.

## 5. Deep-memory service

### 5.1 Service shape

`capabilityServices/DeepMemoryService/` — Python, own venv, pinned Python version, MLX embeddings (Metal), `managed_services.deep-memory` entry (`launch: native`, standard exec/env/healthcheck wiring mirroring whisper-stt/local-tts), **`optional: true`** — the degradation model (§10) is designed non-fatal, so a dead index engine must not fail the orchestrator. Own config under `~/.sentient/deep-memory/` (embedding model id, port, log dir). S2 includes the full packaging seam: CONTRACT.md, config example, pinned dependency lock, `deploy/mac-prod/setup-prod.py` packaging-allowlist update, deploy rollback smoke.

The service is a **dumb index engine**: scope ids + text in, ranked hits out. It knows nothing about users or sessions. Gateway-side access goes through a named **`DeepMemoryClient`** interface (retriever, dreamer, and tools depend on it, never on HTTP details); every client call is deadline-bounded (`memory.service.request_timeout_ms`, default 5000).

### 5.2 API

| Endpoint | Plane | Purpose |
|---|---|---|
| `POST /register-scope` | admin | `{scopeId, indexPath}` — gateway registers/re-points scopes at boot; unknown scope ids are refused everywhere else |
| `POST /upsert` | data | `{scopeId, entries[]}` — embed + FTS-index; idempotent by entry `id` (same id → safe overwrite) |
| `POST /search` | data | `{scopeIds[], query, k, filters: {timeRange?, kinds?, statuses?}}` → ranked `{entry, similarity, rank}` |
| `POST /set-status` | data | `{scopeId, ids[], status, reason}` — active → superseded/stale (dreamer, operator) |
| `POST /purge` | admin | `{scopeId, filter: {sessionId? \| sourceRef? \| provenance? \| timeRange?}}` — hard removal, poison response (§3.8) |
| `POST /rebuild` | admin | `{scopeId}` — drop; gateway re-feeds from journals + files (+ raw chunks if enabled) |
| `GET /health` | — | standard health contract; reports embedding model id + index schema version |

### 5.3 Storage and scoring — pinned pipeline

Per-scope SQLite at `deep-memory/index.db` (entries + FTS5 + sqlite-vec, loaded in Python — no Bun-compile friction). Index schema is versioned; the recorded embedding-model id is checked at startup and search: a mismatch logs WARN at startup (proactive) and search refuses with a typed `rebuild_required` error (reactive backstop).

**Search pipeline (exact, so tuning knobs mean one thing):**
1. Vector top-40 by cosine + FTS5/BM25 top-40, per scope, filtered by `kinds`/`statuses`/`timeRange`.
2. Fuse by RRF (k=60) across both lists and all requested scopes; dedupe by entry id.
3. Each fused hit carries its **cosine `similarity`** (0–1) — the relevance gate value.
4. Return top `k` with `{similarity, rank}`.

**Spark filtering (gateway side, §6):** a hit passes iff `similarity ≥ spark.min_similarity` (threshold on **relevance alone** — an old-but-strongly-relevant memory always passes). Recency then **orders** what passed: `orderScore = similarity × max(recency_floor, 2^(-age/half_life))`. Decay never gates, only ranks — this is what makes "the childhood story still fires on a strong cue" true by construction (fixes the review's self-defeating-math finding).

### 5.4 Index entry schema

```
{ id, kind, text, timestamp, scope, sourceRef, sessionRef?, provenance, audience?,
  status, statusReason?, supersededBy?, createdAt, statusChangedAt }
```

- `kind` (open string set; unknown kinds store and filter fine — no migration to add one): `episode-summary` (dreamer, one per session — primary signal) | `journal` | `file-section` | `raw-chunk` (**config-off by default** — noisy).
- `id` is deterministic from source (`hash(scope:kind:sourceRef:contentHash)`) — upserts idempotent, re-feeds converge.
- `sourceRef`: `{file, heading}` (journals, file sections) — where the canonical text lives. `sessionRef`: `{sessionId, entrySpan}` — which session it was distilled from (episode summaries and facts carry BOTH; this is what makes purge-by-session catch derived entries, §3.8).
- `provenance`: taint-propagated per §3.1. `audience` (shared scope only): `all | adults` (§9).
- `status`: `active | superseded | stale`. Spark searches `active`; `memory_recall` may include historical (labeled).

### 5.5 Embedding model

Config-pinned MLX embedding model, swappable; dimension/model change ⇒ `rebuild` (mismatch handling per §5.3). Model choice verified against current releases at implementation time (pinned-version rule).

### 5.6 Index sync (outbox, not fire-and-forget)

File writes and dreamer outputs enqueue index work in a small per-scope **sync cursor** (source id + content hash). Sync runs after writes and on service-health recovery; a service outage therefore leaves a queue, not permanent staleness. `rebuild` = drop index + replay all sources through the same idempotent path.

## 6. Spark — per-turn associative recall

- **Trigger:** once per conversational turn, on the finalized user utterance. Plain code, zero LLM calls. **Memoized by turn** — the `<situation>` block renders per ReAct iteration, but spark computes once and reuses byte-identical text across the turn's iterations.
- **Flow:** utterance → `memory-retriever` → `DeepMemoryClient.search` (granted scopes, `active` only, deadline `spark.timeout_ms` default 500ms — on expiry, spark withheld, one WARN) → similarity gate + recency ordering (§5.3) → snippet assembly under hard caps → inbound-gate screen (`memory_body`, in-retriever, §3.3) → labeled section in the `<situation>` block (per-turn tail — cache-safe by construction).
- **Pollution controls:** `spark.min_similarity` (prefer empty over weak), `spark.max_snippets` (default 3), `spark.token_budget` (default 250) — snippets are entry `text`, never documents. `stale`/`superseded` never spark. Every decision (hits, similarities, injected/withheld + reason) logs at DEBUG with ids.
- **Per-user toggle:** `spark` on/off per user (settings surface, §11); off ⇒ retriever returns empty, everything else untouched.
- **Freshness note:** episode summaries index at the nightly dream, so same-day sessions spark only via file-sections (and raw-chunks if enabled). Accepted v1 trade; earlier session-close summarization is a named follow-up (§14).

## 7. `memory_recall` — deliberate remembering

Two bounded round-trips, no recall-time summarization (research: no production harness does recall-time LLM synthesis; it adds a full model call inside a voice turn and an injection path through the second model):

1. `memory_recall(query, …)` → compact hit list (§4.4): ≤k snippets with server-minted refs. Model reads it and usually answers directly — episode summaries are written to be sufficient for "what did we decide about X".
2. When it needs the actual moment: `memory_read({sessionId, around/offset})` → capped, marker-truncated transcript excerpt (± context entries). Rarely more than one page; the marker makes continuation possible.

Both results transit the inbound gate (`memory_body`) with the entry's stored provenance — historical `tool-derived` content raises risk like any other untrusted inbound text. Latency etiquette per §4.5. Cancellation: both are ordinary foreground tools — barge-in/interrupt aborts the turn and the in-flight call like any tool call.

## 8. Dreamer — nightly distillation

The dreamer is the **sole ambient curator**. One writer keeps prompt-rendered memory stable between dreams and gives poisoning a single auditable choke point.

- **Runner — NOT the auxiliary seam.** The auxiliary seam is session-bound, one-shot, and shares a 4k-char input truncation — titling-shaped, not batch-shaped (the review's strongest architecture finding; compaction already bypasses the seam for the same reason). The dreamer gets its own runner on `ProviderClient` (compaction precedent): chunked **map** (one call per session window: episode summary + fact candidates, schema-validated output) then **reduce** (one call: reconcile candidates against current MEMORY.md/topics into ops). Own budgets: `dreamer.max_input_chars_per_call` (default 60000), `dreamer.max_output_tokens` (default 3000). Prompt templates as `.md` (baked + operator override). Runs at low priority: while any session of that user has an active turn, the dreamer waits (config `dreamer.yield_check_ms`).
- **Input projection — defined, not assumed.** A pure `projectForDreaming(entries, fromSeq, toSeq)`: full history in append order with entry seq + kind + provenance markers retained, tool-call/result pairs collapsed to labeled digests, compaction entries skipped (raw is present), interrupted output marked. Tested like the other projections.
- **Checkpointing — idempotent by construction.** Per user, a durable high-water mark on the session-store **entry sequence** (stored in the scope's memory dir). A run: snapshot `maxSeq` → immutable window `(lastMark, maxSeq]` → per-session map calls → journal + ops staged → files committed atomically (tmp+rename, all-or-nothing per file) → index upserts (idempotent ids) → advance mark. Crash anywhere ⇒ next run redoes the window; deterministic ids make redone upserts converge; journal write is last-wins by date+session heading. Catch-up on boot when the mark is older than `dreamer.catch_up_threshold_hours` (default 24).
- **Outputs, per user (window = sessions since last mark):**
  1. **Journal** — `journal/YYYY-MM-DD.md` (canonical dreamer output): day narrative, **per-session episode summaries as sections** (`## session <id>`), and the **op log** — every fact op with its source-session citations. Because episode summaries live here, the index stays fully derivable (§2) and the op log is the file-layer remediation map (§3.8).
  2. **Fact ops** applied to MEMORY.md/topics: `ADD | REWRITE | SUPERSEDE | FLAG_STALE` — no DELETE op in the dreamer (the *model* may prune its notes; the *dreamer* may not silently destroy). SUPERSEDE/FLAG_STALE remove/replace the file line and status-flip the corresponding index entries with reason.
  3. **Index sync** — episode summaries + journal + changed file sections through the outbox (§5.6).
- **Safety rails:** MEMORY.md archived (timestamped) before rewrite; **preservation rail** refuses an op batch shrinking MEMORY.md below `dreamer.preservation_pct` (default 75%) of prior line count; every op logged with reason; all writes scan fail-closed; per-call INFO logs prompt-chars/output-tokens/latency/model; one INFO summary per completed dream (`sessions, episodes, ops{...}, duration_ms`) plus a persisted per-user status record `{lastRunAt, result, counts}` (operator-greppable; future viewer surface).
- **Per-user toggle:** `dreaming` on/off per user; off ⇒ user's sessions are skipped, mark still advances (no unbounded backlog).
- **Scope:** v1 dreams write the **private scope only** — the family scope gets file memory + spark + recall but no ambient curation (explicit `memory_write(scope: family)` is its only writer) pending §14.
- **Deep dreaming** (later slice, seam reserved): same runner, window = journals + episode summaries over a week/month (consolidation of consolidations), on-demand trigger first.

## 9. Shared family scope

- Same module instantiated at `shared/family/` (minus the dreamer, §8). Every household member's session gets the household grant (§3.5); spark and recall search both scopes in one call; hits labeled by scope.
- Writes: `memory_write(scope: "family")`, adult roles only (arg-aware, §4.4). Entries carry `authorUserId` in the index for attribution; richer cross-author etiquette → §14.
- **Audience (cheap v1):** shared entries and shared MEMORY.md sections may carry `audience: all | adults` (line suffix tag `@adults` in the file, `audience` field in the index). Child-principal sessions filter `adults` content at render and search. Richer policy (per-member audiences, sensitivity classes) → `docs/native-todo.md`.
- Disclosure falls out of structure: private memory physically cannot enter another user's session (capability + path + scope-registry deny); family facts are exactly what someone chose to put in the shared scope.

## 10. Error handling and degradation

- **Service down or slow:** every `DeepMemoryClient` call deadline-bounded (§5.1, §6). Spark → withheld (one WARN, then quiet). `memory_recall`/session-target `memory_read` → typed "deep memory unavailable". File memory, prompt rendering, write tools unaffected; sessions never block (adapter-start rule). Outbox queues index work until health recovery (§5.6).
- **Dreamer failure:** night skipped, logged with reason; idempotent catch-up per §8; no partial file state.
- **Index corruption / model change:** `rebuild` per §5.3/§5.6.
- **Cap overflow:** typed refusal with usage + consolidation instruction (§4.3).
- **Quarantined file** (failed edit-ingest scan): rendered absent + WARN with reason; model and operator informed via log; file untouched.
- All failable operations return typed results; errors caught at tool/service boundaries.

## 11. Configuration

`orchestrator.memory` in `shared/config/src/schemas/orchestrator-config.ts` — **the block and every sub-block default to `{}` with leaf-level zod defaults** (a config predating this key must keep booting: the established `.default({})` comment pattern). Every YAML value carries a comment with valid range. Per-slice additions (§13) — S1 ships caps + tools with `spark.enabled: false`, `dreamer.enabled: false`; later slices flip their sections on.

```yaml
orchestrator:
  memory:
    enabled: true                 # master switch for the whole memory module
    core_max_lines: 300           # MEMORY.md line cap; injected every session. Range 50-2000
    core_max_chars: 12000         # dual cap with lines, first hit wins. Range 2000-100000
    topic_max_lines: 2000         # topic files are read on demand. Range 100-10000
    topic_max_chars: 80000        # Range 10000-500000
    read_max_chars: 8000          # per memory_read page, head-and-tail capped. Range 1000-40000
    prompt_budget_chars: 20000    # aggregate memory block budget in the system prompt. Range 5000-100000
    service:
      request_timeout_ms: 5000    # deadline on every DeepMemoryClient call. Range 200-60000
    spark:
      enabled: true               # per-user toggle overrides downward
      min_similarity: 0.60        # relevance gate (cosine, 0-1) — gates alone; prefer empty over weak. Range 0-1
      max_snippets: 3             # hard cap on injected snippets. Range 1-10
      token_budget: 250           # hard cap on the injected spark section. Range 50-2000
      recency_half_life_days: 90  # ordering decay half-life. Range 7-3650
      recency_floor: 0.35         # decay floor — ORDERS passed hits, never gates them. Range 0-1
      timeout_ms: 500             # per-turn search deadline; expiry = spark withheld. Range 50-5000
      raw_chunks: false           # index raw transcript chunks (noisy; costly)
    recall:
      k: 5                        # hits per memory_recall. Range 1-20
      context_entries: 2          # entries of context around a drill-down hit. Range 0-10
    dreamer:
      enabled: true               # per-user toggle overrides downward
      hour: 3                     # local time, nightly. Range 0-23
      preservation_pct: 75        # refuse op batches shrinking MEMORY.md below this. Range 0-100
      max_input_chars_per_call: 60000   # per map-call session window. Range 4000-400000
      max_output_tokens: 3000     # per dreamer LLM call. Range 200-16000
      catch_up_threshold_hours: 24      # boot catch-up when last mark older. Range 1-168
      yield_check_ms: 5000        # defer while user has an active turn. Range 500-60000
  # managed_services.deep-memory: launch: native, optional: true, exec/env/healthcheck per
  # whisper-stt precedent; embedding model pinned in ~/.sentient/deep-memory/config.yaml
```

Gateway-config knobs apply on restart; `embedding_model` (service config) additionally requires `rebuild` (§5.3). Per-user toggles (spark, dreaming) live on the existing per-user settings surface. Format/versioning: index schema versioned (§5.3); canonical data is plain markdown + the session store — operator backup guidance and richer durability tooling → `docs/native-todo.md`.

## 12. Testing

Defensive doctrine. Concrete log events are part of each contract (project norm: `skill-tools.write.ok`-style pinned names).

**Security boundary (one test per §3 defense):** principal isolation across memory scopes; forged-`scopeId` refusal at the service; wrong-class capability rejection by `openMemoryStore`; symlink escape refusal; write-time scan fail-closed; edit-ingest quarantine (hostile direct file edit never renders); taint propagation (episode summary of a session containing a tool result carries `tool-derived`); no-hard-delete invariant on automatic paths; `memory_body` gate annotation + risk escalation; family-write role denial for child principal (arg-aware); audience filtering for child sessions; log-sanitization sweep (memory text absent from logs).

**Wire/protocol:** DeepMemoryService API (register-scope/upsert/search/set-status/purge/health) against exact shapes; `rebuild_required` on model mismatch; data-plane-credential-on-admin-endpoint refusal.

**FSM/invariant:** dreamer checkpoint/idempotency (crash mid-window → redo converges); op application (REWRITE/SUPERSEDE/FLAG_STALE, archive-before-rewrite, preservation-rail refusal, atomicity); `projectForDreaming` determinism; cap refusal + usage reporting; prompt-render byte-stability (same inputs → same bytes; mid-session write lands next session); spark scoring (similarity gates, recency orders — an old high-similarity entry passes); spark memoization per turn.

**`@live` (separate suite, env-gated):** (1) DeepMemoryService round-trip (upsert → ranked hit) — free, local, `DEEP_MEMORY_LIVE`; (2) **dreamer smoke** — seeded session → real provider run → journal + MEMORY.md ops + archive + rail + scan verified — paid, explicitly gated, because a mocked LLM cannot validate extraction quality or the rail against a real model.

### E2E matrix (fixed columns; log trails are pinned event names; rows land per slice — mapping in §13)

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| memory-write-explicit | 1280×900 + 390×844 | adult, empty memory | "Remember that I hate cilantro" | confirmation; later `memory_read` shows one bullet line | `memory-tools.write.ok \| lines=` |
| memory-prompt-render | 1280×900 | MEMORY.md has facts | new session: "what do you know about me" | answer reflects facts, no tool call | `memory.prompt.rendered \| chars=` |
| memory-cache-stability | 1280×900 | live session A | write fact mid-A; continue A; open session B | A's behavior unchanged mid-session; B knows the fact | A: no `memory.prompt.rendered` re-emit; B: `memory.prompt.rendered` includes fact |
| cap-overflow | 1280×900 + 390×844 | MEMORY.md near cap | ask to remember many facts | model consolidates or explains the limit | `memory-tools.write.refused \| reason=cap` |
| spark-file-happy | 1280×900 | indexed MEMORY.md Tahoe fact | mention skiing | reply naturally references Tahoe | `memory-retriever.spark.hit \| similarity=` |
| spark-empty | 1280×900 | indexed memories | unrelated topic | normal answer, no memory reference | `memory-retriever.spark.withheld \| reason=below-threshold` |
| spark-episode-happy | 1280×900 | dreamed Tahoe episode | mention skiing in new session | reply references the past conversation | `memory-retriever.spark.hit \| kind=episode-summary` |
| recall-tool | 1280×900 + 390×844 | multi-session history | "what did we decide about the kitchen?" | short spoken ack, then answer citing the past discussion | `memory-tools.recall.ok \| hits=` (+ optional `memory-tools.read.session.ok`) |
| recall-escalate | 1280×900 | index seeded with hostile tool-derived entry | recall it, then ask for a side-effecting action | permission prompt where allow was expected | `inbound-gate.flagged \| channel=memory_body` |
| recall-degraded | 1280×900 | deep-memory stopped | recall ask | graceful "can't reach deep memory" | `memory-tools.recall.unavailable \| reason=` |
| dream-reflects-next-session | 1280×900 | day's chat; trigger dream (test hook) | open NEW session: "what do you know about me" | answer reflects overnight-distilled facts | `dreamer.run.ok \| sessions= ops=` then `memory.prompt.rendered` |
| injection-attempt | 1280×900 | — | ask to remember tool-envelope injection text | write refused, explained | `memory-tools.scan.rejected` |
| cross-user-isolation | 1280×900 | user A memory populated | user B asks about A's facts | B knows nothing of A's private memory | zero A-scope ids in B's trail (reuses `cross-user-refused` oracle) |
| family-scope | 1280×900 | family fact by A | B asks about it | B's assistant knows it, labeled naturally | B: `memory.prompt.rendered \| scope=family` |
| family-audience | 1280×900 | `@adults` family fact | child-principal session asks | child's assistant does not surface it | `memory-retriever.audience.filtered` |

Durable rows get committed to `agents/docs/testing-knowledge.md` under a `memory` surface tag as they land (referencing `cross-user-refused` rather than duplicating it). **Native mobile: honestly deferred** — no existing Maestro flow prompts memory use; memory is server-side and the mobile chat surface exercises the same session, so new prompt-driven flows (`memory` tag: write + recall through chat) are authored in S3's e2e pass, not hand-waved into existing tags. `dream-run`-style filesystem assertions live in the FSM suite, not this matrix.

## 13. Implementation slices

| Slice | Contents | Matrix rows |
|---|---|---|
| **S1 — File memory** | module + store (caps, scan, edit-ingest hash detect) + 4 tools (`memory_recall` + session-`memory_read` return typed `deep_memory_unavailable` — stub == service-absent behavior) + prompt rendering + config (`spark/dreamer` off) + settings projection + per-user toggles surface | memory-write-explicit, memory-prompt-render, memory-cache-stability, cap-overflow, injection-attempt, cross-user-isolation, recall-degraded |
| **S2a — Service skeleton** | DeepMemoryService (venv, MLX embed, pinned model, health, scope registry, credentials split, purge/rebuild) + orchestrator registration + `DeepMemoryClient` + timeouts + packaging/deploy seam + wire tests | (wire + @live service round-trip) |
| **S2b — Retrieval** | outbox indexing of file writes + spark (+ memoization + gate route) + real `memory_recall` + session excerpt reads + `memory_body` channel | spark-file-happy, spark-empty, recall-tool, recall-escalate, recall-degraded (re-run against live-then-stopped service) |
| **S3a — Dreamer episodic** | runner (provider-call, map/reduce, checkpoint, yield) + `projectForDreaming` + episode summaries + journal + index sync — **never touches MEMORY.md** | spark-episode-happy, dream-reflects-next-session (episodic half) |
| **S3b — Reconciliation** | fact ops + archive + preservation rail + op log + @live dreamer smoke + mobile `memory` Maestro flows | dream-reflects-next-session (full), mobile legs |
| **S4 — Family + depth** | shared scope end-to-end for user writes + search (dreamer curation stays out, §14) + audience filtering + deep-dream on-demand trigger + operator purge runbook | family-scope, family-audience |

Each slice lands green (unit + its rows) before the next.

## 14. Open questions / follow-ups (not blockers)

- **Shared-scope authorship** — cross-author edit etiquette for family memory; one permission model with shared skills. Until then: adult-write, dreamer-private-only, `authorUserId` recorded.
- **Session-close summarization** — earlier episode summaries (idle-archive hook) to close the same-day spark gap (§6).
- **Memory viewer/editor UI** — repurpose the inert Hermes-era memory settings surface against the new files + service API; per-user review/undo of dreams rides on it.
- **Deferred to `docs/native-todo.md`** (recorded there by this spec): communal-device audience problem (private memory spoken aloud); richer audience/sensitivity policy; child-specific memory policy (parental review, transparency); richer per-user memory controls; backup/durability tooling; retrieval-during-STT overlap.
- **Embedding model + version pinning** — verified at S2a per the pinned-version rule.
- **Hermes `-z` delegation memory brief** — delegation-spec question, not a memory-spec one.
