# Memory System Design — Sentient 2.0

**Date:** 2026-08-08
**Status:** Approved design, pre-implementation
**Branch:** `feature/native-orchestrator`
**Parent spec:** `2026-07-23-sentient-2.0-native-orchestrator-design.md` (§1.2 names gateway-owned long-term memory, dreaming, and the shared family memory space as later specs — this is that spec)
**Closest precedent:** `2026-08-08-skill-system-design.md` (per-user state + native tools + prompt index; the memory module copies its structure deliberately)

---

## 1. Purpose and goals

Sentient is a **family companion AI**, not a project-scoped coding agent. Its memory must make it feel continuous: it knows each family member durably (preferences, history, opinions, ongoing threads), and past conversations can *spark* back into the present one ("you mentioned Tahoe last week…").

Goals:

- **G1 — File memory:** a simple, fast, always-available markdown memory per user that the model reads and writes with tools. Human-inspectable and editable. Injected cheaply into every session.
- **G2 — Deep memory:** fuzzy, associative retrieval over the whole past (sessions, journal, memories) — embedding + keyword search, so "that ski vacation" finds the Tahoe trip. Two consumers: an automatic per-turn **spark** and a deliberate **`memory_recall`** tool.
- **G3 — Dreaming:** a nightly background pass that reads the day's sessions and distills durable memory — the sole curator of the distilled layer. **Deep dreaming** (wider window: week/month) is the same pipeline with a bigger lens, later.
- **G4 — Family model:** per-user private memory plus a shared household scope, isolated *and* shared at the file level — the shared scope is just another instance of the same memory module rooted at a shared location.
- **G5 — Build, don't adopt.** Survey result (2026-08-08): every credible OSS memory system is a Python/Postgres sidecar or has documented extraction-quality failures; memory is irreplaceable family data with a decade horizon, and the hard part (what to extract, what to surface) is exactly the part we want to own. We hand-build a small system inside our existing seams and steal published designs (Letta sleep-time compute, OpenClaw dreaming, Hindsight's memory-kind split, Zep's temporal supersession, Mem0's reconcile pipeline).

Non-goals (this spec):

- Recursive sub-agents (own spec, per the 2.0 design).
- Memory viewer/editor UI (follow-up; the service API is designed so one can be built without gateway changes).
- Dreamer writing to the shared scope (needs the shared-authorship permission model — same open question as shared skills; see §14).
- Speaker identification. Identity comes from the authenticated session principal, as everywhere.

## 2. Shape of the system

One reusable **memory module**, instantiated per scope root:

```
~/.sentient/gateway/users/<userId>/     # private scope (existing per-user root)
  memory/                               # file memory layer (this spec §4)
  deep-memory/                          # deep index layer (this spec §5)
~/.sentient/gateway/shared/family/      # household scope (new)
  memory/
  deep-memory/
```

`memory/` and `deep-memory/` are **sibling directories with independent lifecycles** — the file layer and the index layer never share a folder, so either can be restructured, rebuilt, or blown away without touching the other.

Four components:

| Component | Where | Job |
|---|---|---|
| **File memory** | gateway TS (`gateway/src/memory/`) | markdown store + caps + prompt rendering |
| **Deep-memory service** | `capabilityServices/DeepMemoryService/` (Python + MLX) | embeddings, hybrid index, search — a dumb, fast engine |
| **Spark + recall** | gateway TS (`memory-retriever`, `memory-tools`) | per-turn auto-injection; `memory_recall` tool |
| **Dreamer** | gateway TS (`gateway/src/memory/dreamer/`), model calls via the auxiliary seam | nightly distillation; sole curator of distilled memory |

**Sources of truth never move.** The session store (append-only per-user SQLite) and the markdown files under `memory/` are canonical. Everything under `deep-memory/` is **derived and rebuildable**: delete it, `rebuild` regenerates it from sessions + files. No irreplaceable data ever lives in the index.

## 3. Security model (read this first)

The memory system is the **highest-value injection target in the architecture**: the dreamer reads whole sessions — including tool results and delegated-task output, i.e. untrusted text — and its output is rendered into the **system prompt of every future session**. A poisoned webpage summary tonight becomes trusted "memory" tomorrow. Published attacks on liberal-write memory systems (MINJA, MemoryGraft) exceed 90% injection success. The defenses are structural, not advisory:

1. **Provenance on every entry.** Every index entry and every dreamer-written fact records origin: `user-speech | assistant | tool-derived`. A discovered poison is traceable and revocable: `purge(provenance=…, sourceRef=…)` removes it and everything derived from it.
2. **Write-time scanning, fail-closed.** Everything written into file memory — by memory tools *or* by the dreamer — passes `scanContent`; `suspicious`/`hostile` refuses the write (skill-tools precedent: `injectionScanError`). Invisible-unicode rejection as in `skill-file.ts`.
3. **Read-time gating.** Sparked snippets and `memory_recall` results enter model context through the inbound gate on a new **`memory_body`** channel: scanned, annotated (never silently dropped), findings feed `RiskAccumulator` — recalled tool-derived text can escalate a side-effecting tool to `confirm` within the turn. Memory rendered into the system prompt (MEMORY.md) does not transit the gate at read time (same as skill descriptions) — which is exactly why write-time scanning is fail-closed.
4. **Capability-scoped search only.** A session searches exactly the scopes its principal holds: own private scope + household scope. The gateway resolves capabilities to index paths; the service never sees a "search everything" request. Cross-user access is a hard deny by path before any content check, as everywhere (parent spec §2.5).
5. **New `memory` ResourceClass.** The capability union gains `"memory"`; `openMemoryStore(cap)` rejects wrong-class capabilities first (resource-class check before path check — the session-store/file-scope confused-deputy lesson). The store implements its own `realpathSync` symlink guard (`capabilityCoversPath` is lexical; skill-store precedent).
6. **Supersede, never delete.** No component — dreamer, tools, reconciler — hard-deletes memory. Facts are rewritten, superseded (with a link), or flagged stale. `MEMORY.md` is archived before every dreamer rewrite. The only true deletion is operator-initiated `purge` (poison removal) and future GDPR-style user erasure.
7. **Service boundary.** Loopback-bound, `sentient-auth` shared token, confined to `user_data_root` (refuses any path outside it). Same trust shape as whisper-stt/local-tts.
8. **No content in logs.** Memory text never appears in logs at any level — lengths, ids, counts, scores only (mobile-vitals rule applies gateway-wide here).
9. **Tested like auth.** The principal-isolation contract test extends to memory scopes: user A's session must be unable to read, search, or write user B's memory by any path.

## 4. File memory layer

### 4.1 Layout (per scope root)

```
memory/
  MEMORY.md              # core distilled memory — rendered into the system prompt every session
  topics/<slug>.md       # topic files — index line always in prompt, body lazy-loaded on demand
  journal/YYYY-MM-DD.md  # dreamer's daily narrative — audit trail + episodic source (dreamer-written)
  archive/               # timestamped MEMORY.md snapshots taken before each dreamer rewrite
```

### 4.2 Format and style

- Files are markdown with YAML frontmatter (`name`, `description`, optional `tags`), validated at write: slug regex `^[a-z0-9][a-z0-9-]{0,63}$`, length caps, invisible-char rejection — the `skill-file.ts` discipline. Obsidian-compatible; wikilinks between topic files are allowed and inert.
- **Content style is enforced by instruction, not parser:** memory is written as **one fact per line, concise bullet points** — no prose paragraphs, no examples, no filler. The tool descriptions and the memory preamble both state this: every line is injected into live sessions, so every wasted word is context tax. Line-oriented facts also make caps, diffs, and dreamer line-ops clean.

### 4.3 Caps — lines AND characters

- `MEMORY.md`: dual cap, both config (`memory.core_max_lines`, default **300**; `memory.core_max_chars`, default **12000** ≈ ~3k tokens). Rationale for the conservative default: this body is injected into *every* session; ChatGPT-class profiles run 1–2k tokens; context-rot research puts degradation onset well below what a 2000-line file would inject. Operator-tunable upward.
- `topics/<slug>.md`: lazy-loaded, so the cap is generous — `memory.topic_max_lines`, default **2000** (+ char cap `memory.topic_max_chars`, default 80000).
- **Cap enforcement is a tool contract:** every `memory_write` result reports usage (`lines 212/300, chars 8.4k/12k`). A write that would exceed a cap is **refused** with a typed error instructing the model to consolidate (merge/rewrite lines, or move detail into a topic file) before retrying. The model always knows where it stands; it is never silently truncated.

### 4.4 Native tools

Registered like skill tools (`NativeToolRunner`s under the `native` namespace, settings-projected, PDP-mediated):

| Tool | Tier | Behavior |
|---|---|---|
| `memory_list` | read | list topic files + journal dates for granted scopes, with descriptions |
| `memory_read` | read | full body of MEMORY.md, a topic file, or a journal entry |
| `memory_write` | write | add/edit lines in MEMORY.md or a topic file (scope arg: `private` default, `family` allowed); returns cap usage; refuses over cap; write-time scan fail-closed |
| `memory_forget` | write | supersede or stale-flag a fact — never a hard delete; records reason |
| `memory_recall` | read | deep search (§7); description explicitly states seconds-scale latency |

- Tool descriptions carry the style contract (concise bullet lines) and the cap contract.
- Role gate falls out of tiers: child/guest reach read-only. `memory_write(scope: family)` requires an adult role.
- Explicit user requests ("remember this") flow through `memory_write` in-turn; ambient distillation is the dreamer's job — the model is instructed *not* to write memory unprompted every turn.

### 4.5 System-prompt rendering

Composed **once per session at runtime construction** (skill-index rules: byte-stable deterministic sort, sanitized, capped with WARN on truncation):

1. A fixed **memory preamble** (baked template + operator override, `system-prompt-loader` pattern) explaining: what memory is, the style contract, the cap contract, and the **latency etiquette** — before invoking `memory_recall`, speak a short acknowledgment ("let me think back…") so TTS covers the retrieval gap.
2. **Private scope:** MEMORY.md body (capped) + topic index (`name — description` per line).
3. **Household scope:** same, clearly labeled as shared family memory.

Memory taught mid-session appears in the *next* session's prompt (cache-stability invariant A; identical to skills). The `<situation>` block remains the only per-turn text (§6).

## 5. Deep-memory service

### 5.1 Service shape

`capabilityServices/DeepMemoryService/` — Python, own venv, pinned Python version, MLX for embeddings (Metal on the mini), `managed_services.deep-memory` entry in `config.yaml`, supervised by the system-orchestrator with the standard health model. Loopback HTTP, `sentient-auth` shared token. Its own config under `~/.sentient/deep-memory/` (model id, port, log dir).

The service is a **dumb index engine**: paths + text in, ranked hits out. It knows nothing about users, sessions, or scopes — the gateway resolves capabilities to index paths and the service merely refuses any path outside its configured data root. This keeps it extractable as a standalone open-source project and lets future memory viewer/editor tools dial the same API.

### 5.2 API

| Endpoint | Purpose |
|---|---|
| `POST /upsert` | `{indexPath, entries: [{id, kind, text, timestamp, sourceRef, provenance, status}]}` — embed + FTS-index each entry |
| `POST /search` | `{indexPaths[], query, k, filters: {timeRange?, kinds?, statuses?}}` → ranked `{entry, score}` hits across the given indexes |
| `POST /set-status` | `{indexPath, ids[], status}` — active → superseded/stale transitions (dreamer, `memory_forget`) |
| `POST /purge` | `{indexPath, sourceRef? , provenance?}` — hard removal, operator/poison-response only |
| `POST /rebuild` | `{indexPath}` — drop + await re-upserts (gateway drives re-feeding from sources of truth) |
| `GET /health` | standard health contract |

### 5.3 Storage

Per-scope SQLite at `deep-memory/index.db`: an entries table, an FTS5 table, and a vector table (sqlite-vec, loaded in Python — no Bun-compile extension friction). Hybrid search = vector cosine + BM25, merged with reciprocal-rank fusion. Brute-force KNN — at family scale (thousands of entries, not millions) this is sub-millisecond; no ANN index needed.

### 5.4 Index entry schema

```
{ id, kind, text, timestamp, sourceRef, provenance, status,
  supersededBy?, statusReason?, createdAt, statusChangedAt }
```

- `kind`: `episode-summary` (dreamer, one per session — primary signal) | `journal` | `file-section` (MEMORY.md/topic sections) | `raw-chunk` (per-turn transcript chunks; **config-off by default** — noisy).
- `text`: the short summarized text that is embedded and returned as a snippet. The index stores index entries, not payloads.
- `sourceRef`: `{sessionId, entryRange}` or `{file, heading}` — recall can follow it back into the session store and read the raw transcript around the hit.
- `provenance`: `user-speech | assistant | tool-derived` (security §3.1).
- `status`: `active | superseded | stale`. Spark searches `active` only; `memory_recall` may search all statuses (superseded/stale hits are labeled as historical).

### 5.5 Embedding model

Config-pinned MLX embedding model (`deep_memory.embedding_model`), swappable without gateway changes; the index records the model id and a dimension mismatch forces `rebuild` (embeddings from different models are not comparable). Model choice and its pinned version are an implementation-plan decision verified against current releases at build time.

## 6. Spark — per-turn associative recall

The "spark" makes Sentient spontaneously remember: user mentions skiing → the Tahoe episode surfaces.

- **Trigger:** every conversational turn. Plain code, **zero LLM calls**, milliseconds.
- **Flow:** user utterance → `memory-retriever` → service `search` across the session's granted scopes (`active` only) → score filter → snippet assembly → labeled section in the `<situation>` block.
- **Cache safety by construction:** the situation block is the per-turn tail — the only per-turn prompt text in the architecture. Spark never touches the cached prefix.
- **Encapsulation:** the ReAct loop sees "optional situation-block section from `memory-retriever`" and nothing else. No vector, service, or scoring knowledge leaks out of the module.

**Pollution control — the tuning contract.** An irrelevant sparked memory is worse than none: it wastes context and degrades the model. Controls, all config:

- **Absolute relevance threshold** (`memory.spark.min_score`): below it, nothing is injected. *Prefer empty over weak* is the design stance.
- **Recency decay with a floor** (`memory.spark.recency_half_life_days`, `memory.spark.recency_floor`): score = relevance × decay(age), where decay never drops below the floor — so an old-but-strongly-relevant memory (the childhood story, last year's Tahoe trip) can still fire, while old-and-marginal ones fade. This mimics the human shape: vivid old memories resurface on a strong cue; weak ones don't.
- **Status filter:** `stale`/`superseded` never spark. They remain reachable through `memory_recall` — deliberate digging can still surface "you *used to* think X".
- **Hard caps:** `memory.spark.max_snippets` (default 3) and `memory.spark.token_budget` (default 250 tokens) — snippets are the entries' short `text`, never full documents.
- **Read-time gate:** the assembled snippet block crosses the inbound gate (`memory_body`) before injection (§3.3).
- Every spark decision (hit count, scores, injected/withheld, reason) logs at DEBUG with ids — tuning needs the trail.

## 7. `memory_recall` — deliberate remembering

For when the model knows it needs to dig ("what did we decide about the kitchen renovation?").

- **Args:** `{query, timeRange?, scope?, includeHistorical?}` — the model composes its own fuzzy query (topic, rough timeframe, mood).
- **Flow:** wider `search` (larger k, optional all-status) → optionally an **auxiliary-seam synthesis call** (`memory.recall.synthesis`, default on): a cheap out-of-band model call reads the candidate hits (and, when a hit's `sourceRef` warrants it, the raw transcript window around it from the session store) and produces a compact answer with source attributions. Results return as a normal foreground `tool_result` through the inbound gate.
- **Latency etiquette:** the tool description states seconds-scale latency; the memory preamble instructs the model to speak a short acknowledgment first, which TTS streams while the tool runs.

## 8. Dreamer — nightly distillation

The dreamer is the **sole ambient curator** of distilled memory (the model's in-turn writes happen only on explicit user request). One writer keeps the prompt-rendered layer stable between dreams, auditable, and gives poisoning a single choke point.

- **Schedule:** nightly at `memory.dreamer.hour` (default 03:00 local), in-gateway scheduler, per user sequentially. A missed night (gateway down) is caught up on next boot if the last dream is older than a day.
- **Model calls:** through the **auxiliary seam** (`orchestrator.auxiliary` — the out-of-band model-call seam whose config comment already names summarization as a next user). Prompt templates live in `system_prompts/auxiliary/` (baked) with the standard operator-override dir; the dreamer gets its own generous output cap distinct from titling's.
- **Pipeline per user (window: sessions since last dream):**
  1. **Episode summaries** — one per session: what happened, decisions, mood, notable facts. → indexed as `episode-summary`.
  2. **Journal** — `journal/YYYY-MM-DD.md`, a short day narrative. Human-readable audit trail; also indexed.
  3. **Fact reconciliation** — extract durable candidate facts (preferences, history, opinions, ongoing threads), then reconcile against current MEMORY.md/topics with explicit ops: `ADD` (new line) | `REWRITE` (fact evolved — edit the line) | `SUPERSEDE` (replaced — new line, old entry linked + status-flipped in the index) | `FLAG_STALE` (no longer relevant — removed from the live file, preserved in archive + index as `stale` with a reason). **No DELETE op exists.**
- **Safety rails:** current MEMORY.md is archived (timestamped) before any rewrite; a **preservation rail** refuses an op batch that would shrink MEMORY.md below `memory.dreamer.preservation_pct` (default 75%) of its prior line count — a hallucinating dreamer cannot wipe a life's memory in one night. Every op is logged with its reason. All writes pass the write-time scan fail-closed; all file writes are atomic (tmp + rename), applied all-or-nothing per file.
- **Scope:** v1 dreams write the **private scope only**. Shared-scope curation waits for the shared-authorship permission model (§14).
- **Deep dreaming** (later slice, seam reserved): identical pipeline with a wider window (week/month) reading episode summaries + journals instead of raw sessions — consolidation of consolidations. On-demand trigger first (operator/API); scheduling later.

## 9. Shared family scope

- The household scope is **the same memory module instantiated at** `shared/family/` — same layout, caps, index, tools. Isolation and sharing are both file-level, per the scope-root model.
- Access: every household member's session is granted the shared scope (read via prompt rendering + spark + recall; write via `memory_write(scope: family)`, adult roles only — child/guest are read-only through the tier gate). `householdId` on `UserPrincipal` keys the grant; one household v1.
- Spark and recall search both scopes in one service call (`indexPaths: [private, family]`); hits are labeled with their scope.
- Disclosure policy falls out of structure: private memory physically cannot enter another user's session (capability + path deny), so the assistant can never volunteer A's private facts to B. Family facts are exactly what someone chose to put in the shared scope.

## 10. Error handling and degradation

- **Service down:** spark silently absent (one WARN with reason, then quiet); `memory_recall` returns a typed "deep memory unavailable" tool error; file memory, prompt rendering, and write tools unaffected; sessions never block (adapter-start rule: transient dependency failure is not fatal). Supervisor retries per the standard health model.
- **Dreamer failure:** night skipped, logged with reason; catch-up on next run; no partial file state (atomic writes, all-or-nothing op application).
- **Index corruption / embedding-model change:** `rebuild` regenerates from sources of truth (session store + files). The gateway owns re-feeding; the service just re-indexes.
- **Cap overflow:** typed refusal to the model with usage numbers and consolidation instruction (§4.3); never silent truncation.
- All failable operations return typed results; errors caught at the tool/service boundary, per error-handling rules.

## 11. Configuration

New zod-validated `orchestrator.memory` block (`shared/config/src/schemas/orchestrator-config.ts`) + `managed_services.deep-memory`. Every value commented in `gateway/config.yaml` per config rules. Defaults above are starting points — spark tuning in particular is expected to be operator-iterated (all knobs hot-swappable on gateway restart, no rebuild).

```yaml
orchestrator:
  memory:
    enabled: true
    core_max_lines: 300          # MEMORY.md line cap — injected every session; raise deliberately
    core_max_chars: 12000        # ~3k tokens; dual cap with lines, first hit wins
    topic_max_lines: 2000        # topic files are lazy-loaded; generous
    topic_max_chars: 80000
    spark:
      enabled: true
      min_score: 0.55            # absolute relevance floor on the normalized (0-1) hybrid score; prefer empty over weak
      max_snippets: 3
      token_budget: 250          # hard ceiling on injected spark section
      recency_half_life_days: 90 # decay half-life for spark scoring
      recency_floor: 0.35        # decay never drops below this — strong old memories still fire
      raw_chunks: false          # index raw per-turn transcript chunks (noisy; off by default)
    recall:
      k: 12                      # candidate hits fed to synthesis
      synthesis: true            # auxiliary-seam summarization of hits
    dreamer:
      enabled: true
      hour: 3                    # local time, nightly
      preservation_pct: 75       # refuse op batches shrinking MEMORY.md below this % of prior lines
  # deep-memory service: managed_services entry + ~/.sentient/deep-memory/config.yaml
  #   (embedding_model pinned there; port loopback-bound; sentient-auth token)
```

## 12. Testing

Per the test doctrine (defensive only):

- **Security boundary:** cross-scope search/read/write hard-deny (principal-isolation contract test extended); symlink escape refusal; write-time scan fail-closed on hostile content; `memory_body` gate annotation + risk escalation.
- **Wire/protocol contract:** deep-memory service API (upsert/search/set-status/purge/health) against the exact message shapes; embedding-dimension-mismatch → rebuild-required.
- **FSM/invariant:** dreamer op application (REWRITE/SUPERSEDE/FLAG_STALE semantics, archive-before-rewrite, preservation rail refusal, atomicity); cap enforcement (refusal + usage reporting); prompt-rendering byte-stability (same inputs → identical bytes; mid-session write lands next session).
- **`@live`:** one gated flow against a running DeepMemoryService: upsert → search returns ranked hit.
- No tests for wiring, factories, or pure plumbing.

### E2E matrix (web, local stack)

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| memory-write-explicit | 1280×900 | logged-in adult, empty memory | "Remember that I hate cilantro" | assistant confirms; `memory_read` later shows the fact as one bullet line | `memory_write` PDP allow, scan pass, cap usage logged |
| memory-prompt-render | 1280×900 | MEMORY.md has facts | new session, ask "what do you know about me" | answer reflects stored facts without tool calls | session build logs memory block render (lines/chars), byte-stable |
| spark-happy | 1280×900 | indexed Tahoe episode | mention skiing in a new session | assistant naturally references the trip | spark DEBUG: hit id + score ≥ threshold, injected ≤ budget |
| spark-empty | 1280×900 | indexed memories, unrelated utterance | ask about unrelated topic | no memory reference, normal answer | spark DEBUG: withheld, below threshold; nothing injected |
| recall-tool | 1280×900 | multi-session history | "what did we decide about the kitchen?" | short spoken ack, then answer citing past discussion | `memory_recall` call, search + synthesis aux call, gate annotate, result |
| recall-degraded | 1280×900 | deep-memory service stopped | same recall ask | assistant explains memory unavailable, gracefully | typed unavailable error, WARN with reason, session alive |
| dream-run | n/a (log-driven) | day's sessions exist | trigger dreamer (test hook/time) | journal file written; MEMORY.md updated; archive snapshot exists | dreamer ops logged with reasons; preservation rail check; scan pass |
| cap-overflow | 1280×900 | MEMORY.md near cap | ask to remember many facts | assistant consolidates or explains limit | `memory_write` refusal with usage; no silent truncation |
| cross-user-isolation | 1280×900 | user A memory populated | user B session asks about A's facts | B's assistant knows nothing of A's private memory | zero A-scope paths in B's session; deny if attempted |
| family-scope | 1280×900 | family fact written by A | B's session asks about it | B's assistant knows the shared fact, labeled naturally | B session renders family scope; spark/search includes family indexPath |
| injection-attempt | 1280×900 | — | ask to remember text containing tool-envelope injection | write refused, assistant explains | scan fail-closed refusal logged; nothing persisted |
| mobile-spark | 390×844 | as spark-happy | same via mobile-sized web | same behavior | same trail |

Native-mobile parity: memory is server-side; mobile surfaces exercise it through the same session — tag `memory` cases into the existing Maestro conversation flows (surface tags per testing-knowledge), no new native driver work expected.

## 13. Implementation slices

1. **S1 — File memory:** module + store + caps + five tools (recall stubbed) + prompt rendering + config + settings projection. Useful with zero service.
2. **S2 — Deep memory:** DeepMemoryService (MLX, hybrid index) + orchestrator registration + gateway client + indexing of file writes + **spark** + real `memory_recall`.
3. **S3 — Dreamer:** nightly pipeline (episodes, journal, reconciliation ops, rails) + session-summary indexing + catch-up.
4. **S4 — Family + depth:** shared scope end-to-end, deep-dream on-demand trigger, purge/rebuild operator paths, retention/e2e hardening.

Each slice lands green (unit + smoke) before the next; the e2e matrix rows activate per slice.

## 14. Open questions / follow-ups (not blockers)

- **Shared-scope authorship model** — who may curate/edit family memory another member wrote; shared skills have the same open question; one permission model should serve both. Until then: adult-write, dreamer-private-only.
- **Dreamer-to-shared promotion** — "this looks like a family fact, promote it?" — consent-shaped UX, needs the above.
- **Memory viewer/editor UI** — repurpose the inert Hermes-era memory settings surface (`native-todo.md` §"expected-inert") against the new files + service API; separate design.
- **Retrieval-during-STT overlap** — spark currently runs on the finalized utterance; overlapping the search with STT finalization is a latency optimization available later without design change.
- **Embedding model + version pinning** — implementation plan verifies the current best MLX embedding model at build time (pinned-version rule).
- **Hermes `-z` context** — delegated Hermes keeps its own per-profile memory today; whether delegation prompts should carry a distilled memory brief is a delegation-spec question, not a memory-spec one.
