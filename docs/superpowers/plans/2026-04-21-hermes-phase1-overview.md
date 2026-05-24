# Hermes Cerebrum Integration — Phase 1 Implementation Plan (Overview)

> **For agentic workers:** this is the INDEX file. Pick ONE sub-phase plan file at a time (listed in §3 below) and execute its tasks in order. Do NOT hold all sub-phase plans in context simultaneously.

**Spec:** `docs/superpowers/specs/2026-04-21-hermes-cerebrum-integration-design-v4.md` (with the 2026-04-21 amendment). Read the spec's §2.5 ("What Hermes provides"), §3 (decision log), and §5 (component design) BEFORE starting any sub-phase.

**Goal:** a fully-functional POC user session by end of Phase 1. A family member can:
- Have a natural voice conversation (STT + LLM + TTS, with barge-in + interrupt).
- Control Home Assistant via the agent (lights, locks, alarm with approval, etc.).
- Ask questions that need current information (web search + fetch).
- Switch identity via "I am X" voice phrase.
- Keep per-user memory/persona across sessions.

**What gets deleted at the end:** ~4000–6000 LOC of custom cerebrum (CognitiveCycle, effect dispatch, in-gateway ReAct, conversation-history, task-manager). Replaced by a thin adapter to Hermes Agent running in a sidecar container per user.

---

## 1. Repository rules that apply to EVERY task

Read these once and obey them on every sub-phase. All rules live in `.claude/rules/`:

- `.claude/rules/clean-code.md` — **files <300 lines (split at 250), functions <40 lines (extract at 30), max nesting 3 levels, no magic numbers, no commented code, boolean-as-question names, function-as-action names.**
- `.claude/rules/architecture.md` — **dependencies flow inward (domain → application → infrastructure), one module per file, feature-based organization, interfaces at boundaries.**
- `.claude/rules/pipeline.md` — **every streaming stage = one decorator unit (AsyncGenerator in, AsyncGenerator out, one responsibility, one file, one test file). NEVER own connection lifecycle inside a unit. ALWAYS respect AbortSignal.**
- `.claude/rules/testing.md` — **write tests alongside implementation, never defer. ≥80% statements / 75% branches. Unit tests <100 ms each. Integration tests for multi-component flows. Connector/wire-protocol tests MUST mock exact message types the server emits.**
- `.claude/rules/config.md` — **every tunable constant goes in `gateway/config.yaml`. No magic numbers. Env vars via `${VAR}` for secrets only. Inline YAML comments explain each value.**
- `.claude/rules/error-handling.md` — **Result types or typed error unions. Catch at system boundaries only. Error messages include what/why/context. Never swallow silently. Timeout every external call.**
- `.claude/rules/git-workflow.md` — **one logical change per commit. `type(scope): description` messages. Before merging: quality gate must pass.**
- `.claude/rules/llm-protocol.md` — **tool_calls round-trip requires both assistant message AND role:"tool" result. Ephemeral per-cycle state lives at the END of messages[] as role:"system", never in messages[0]. Sensor inputs labeled in user messages (`[trigger/sensor.X] ...`). Before touching OpenAI model behavior, consult official docs / context7 MCP / fresh web fetch — never rely on training-data recall.**

**Shell env:** every Bun/test command requires `source scripts/env.sh` first. Without it, `bun` is not on PATH.

---

## 2. Cross-cutting standards (apply to every file you create)

### 2.1 File naming

- TypeScript source: kebab-case matching primary export (`hermes-client.ts`, `session-router.ts`).
- Test files: alongside source with `.test.ts` suffix (`hermes-client.test.ts`).
- Config YAML: kebab-case (`hermes-profile.yaml.tmpl`).
- Markdown: kebab-case (`SOUL.md.tmpl` — exception for convention from Hermes).

### 2.2 TypeScript conventions

- `strict: true` — already on, don't touch.
- **No `any`.** Use `unknown` at boundaries, narrow with Zod or explicit type guards.
- **Results over throws.** Return `{ ok: true, value } | { ok: false, error }` or `Result<T, E>` where E is a typed union. Throw only in unreachable branches.
- **Zod schemas** for every external payload (WebSocket messages, HTTP responses, config files). Import zod as `import { z } from "zod"`.
- **AbortSignal** on every async function that makes an external call. Pipe through.
- **Structured logging.** Import `createLogger(["tag1","tag2"])` (already established pattern); never `console.log`.

### 2.3 Testing conventions

- `vitest` is the test runner. Invoke via `bun run test` (NEVER `bun test` — different runtime; breaks jsdom/RTL).
- **One test file per source file.** Colocated.
- Test names: describe behavior, not implementation. `describe("HermesClient")` > `describe("constructor")`.
- **Mock at protocol boundary, not internals** (per `.claude/rules/testing.md`). For Hermes tests, mock SSE bytes that Hermes actually emits, not a convenient wrapper.

### 2.4 Extensive debug logging (non-negotiable per memory)

Every new stream/pipeline stage logs at DEBUG:
- Entry/exit of the stage.
- Per-chunk decisions (pass-through, drop, transform).
- Per-fallback (what failed, what we did instead).

Example:
```typescript
const log = createLogger(["sentient.gateway.tts", "markdown-stripper"]);
// entry
log.debug("enter", { bufferSize, hasMarkdown });
// per-chunk
log.debug("chunk", { inputLen, outputLen, strippedChars });
// fallback
log.debug("fallback.remove-markdown-error", { err: err.message });
```

### 2.5 Commit conventions

- Follow `type(scope): description` from `.claude/rules/git-workflow.md`.
- One logical change per commit. Example: "feat(hermes-client): add SSE consumer" is atomic; "feat(hermes-client): add SSE consumer + refactor session manager" is not.
- **Co-author line** at the end (the user's custom convention — see recent commits):
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
  Use whatever model you actually are.
- **Never commit until the pre-commit hook passes.** If typecheck fails, fix — don't skip.

### 2.6 Quality gate

Before committing at the end of a sub-phase:

```bash
source scripts/env.sh && bun run ci
```

This runs: lint + typecheck + all tests. Must be green. If a test you wrote fails, fix it; if a pre-existing test breaks because of your change, fix the underlying issue. **Never skip/delete tests to make CI pass.**

**Before running tests**, check for port conflicts (per memory `feedback_docker_ps_before_tests.md`):

```bash
docker ps --format "table {{.Names}}\t{{.Ports}}"
```

If `sentient-gateway` (port 8888) or similar is running, `docker stop <name>` first.

### 2.7 When stuck

- Read the rule first. Read the spec second. Read the skill/agent doc third (`agents/docs/<topic>-details.md`).
- If still stuck, **check `agent/docs/learnings.md` for recent discoveries on the topic.**
- Use the `context7` MCP tool (or web search) for library docs, especially OpenAI/Hermes APIs.
- NEVER read `.env` or `.zshrc` — read consuming source code for var names instead (per memory).

### 2.8 Preferred models (from memory)

If any task requires calling a small model for utility work (e.g., LLM-summarizer), default to: **`gpt-4o-mini`, `gpt-4.1-nano`, `deepseek-chat`, `gemini-flash`**. Do NOT default to Anthropic Claude models — too expensive for this project.

---

## 3. Sub-phase execution order

Execute strictly in order. Each sub-phase depends on earlier ones being merged.

| # | Plan file | Output |
|---|---|---|
| 1.0 | [`2026-04-21-hermes-phase1.0-empirical-gates.md`](./2026-04-21-hermes-phase1.0-empirical-gates.md) | **Data only, no code.** Measures Hermes idle RAM, cold-start time, SSE event fidelity. Outputs inform Phase 1.1+ choices. |
| 1.1 | [`2026-04-21-hermes-phase1.1-scaffolding.md`](./2026-04-21-hermes-phase1.1-scaffolding.md) | Slim Hermes Dockerfile. `docker-compose.yml` dev stub. `HermesClient` skeleton (types + no SSE yet). `SessionRouter` skeleton. Profile template stubs. |
| 1.2 | [`2026-04-21-hermes-phase1.2-wire-parity.md`](./2026-04-21-hermes-phase1.2-wire-parity.md) | Full `HermesClient` consuming real SSE. Event translator producing existing wire messages. `ConversationMirror` + `TaskMirror`. Contract tests against a real Hermes container. |
| 1.3 | [`2026-04-21-hermes-phase1.3-tts-chain.md`](./2026-04-21-hermes-phase1.3-tts-chain.md) | TTS decorator chain: `barge-in-gate` → `markdown-stripper` → `emoji-stripper` → `utterance-aggregator` → `emotion-tagger` → Fish Audio. Moves utterance-aggregator + emotion-tagger from `effects/`. |
| 1.4 | [`2026-04-21-hermes-phase1.4-gateway-mcp.md`](./2026-04-21-hermes-phase1.4-gateway-mcp.md) | Gateway-hosted MCP server (stdio-over-Unix-socket). Tools: `identify_user`, `pause_audio`, `resume_audio`, `set_channel`. |
| 1.5 | [`2026-04-21-hermes-phase1.5-ha-mcp.md`](./2026-04-21-hermes-phase1.5-ha-mcp.md) | HA MCP wired into per-profile `config.yaml` (no tools.exclude per D-19). `HomeAssistantObserver` (subscribes, logs to `AmbientEventLog`; not dispatched in Phase 1). |
| 1.6 | [`2026-04-21-hermes-phase1.6-web-tools.md`](./2026-04-21-hermes-phase1.6-web-tools.md) | `duckduckgo-mcp-server` installed in slim image; per-profile `config.yaml` wired. Egress proxy allowlist extended. |
| 1.7 | [`2026-04-21-hermes-phase1.7-multi-profile-satellite.md`](./2026-04-21-hermes-phase1.7-multi-profile-satellite.md) | `SessionRouter` full implementation (Strategy A always-on). Device-identity registry. `identify_user` rebind flow end-to-end. ESP32 WS auth. |
| 1.8 | [`2026-04-21-hermes-phase1.8-security.md`](./2026-04-21-hermes-phase1.8-security.md) | Rootless containers, read-only FS, egress-proxy container, Docker secrets, policy-as-code engine, session risk accumulator, tool-result injection scanner. |
| 1.9 | [`2026-04-21-hermes-phase1.9-cleanup.md`](./2026-04-21-hermes-phase1.9-cleanup.md) | Delete old cerebrum code (CognitiveCycle, dispatch, effects except moved TTS stages, task-manager). Supersede Phase 4/5 plans. |
| 1.10 | [`2026-04-21-hermes-phase1.10-poc-acceptance.md`](./2026-04-21-hermes-phase1.10-poc-acceptance.md) | Pi deploy. Run the acceptance checklist with a real user. Tune SOUL.md / salience / config based on observations. |

---

## 4. Branch and commit flow

- **Feature branch:** `feature/hermes-cerebrum-integration` (already created off develop).
- **Commits land on this branch**, one logical change per commit.
- **Sub-phase completion** = all tasks in that sub-phase plan checked off, quality gate green, commits pushed (locally only — never push to remote unless explicitly asked).
- **End of Phase 1**: single PR to develop. Not multiple PRs per sub-phase — one integrated PR so the review happens on a coherent whole.

---

## 5. How to navigate between tasks

Each sub-phase plan has numbered `Task X.Y` sections with `- [ ]` checkbox steps. To execute:

1. Read the sub-phase's §1 "Context and prerequisites."
2. Pick the FIRST task with unchecked steps.
3. Complete the steps in order. Each step has:
   - **Files:** which to create/modify (absolute paths).
   - **Action:** what to do.
   - **Code template:** starting code (smaller models: use verbatim and adapt; larger models: treat as guideline).
   - **Verification:** exact command + expected result.
4. When all steps in a task are complete, commit with `type(scope): description` and the co-author line.
5. Move to the next task.

If you skip ahead, you WILL break the build. Dependencies are listed at the top of each sub-phase.

---

## 6. Escape hatches

If during execution you discover the spec is wrong, the plan is infeasible, or there's a major unknown:

- **STOP.** Don't improvise architecture changes — they will cascade badly.
- Write a short note in a new file `docs/superpowers/plans/notes/2026-04-21-phase1-blocker-<topic>.md` describing the issue.
- Stop the current sub-phase, commit what you have as WIP, and notify the user.

Architectural decisions require the `superpowers:brainstorming` flow, not improvisation mid-plan.

---

## 7. Acceptance for "Phase 1 complete"

All of the following must be true:

- [ ] All 10 sub-phase plans completed.
- [ ] `bun run ci` green on `feature/hermes-cerebrum-integration`.
- [ ] Pi deployment documented and demonstrated.
- [ ] POC acceptance checklist (in `2026-04-21-hermes-phase1.10-poc-acceptance.md`) fully ticked during a live demo with a real user.
- [ ] Phase 4/5 plan files in `docs/superpowers/plans/` marked as SUPERSEDED (see Phase 1.9).
- [ ] A retrospective note drafted (`docs/superpowers/retros/2026-MM-DD-hermes-phase1-retro.md`) capturing what worked, what surprised us, what changed vs the v4 spec.
- [ ] Memory updated (`/Users/kevinye/.claude/projects/-Users-kevinye-Development-sentient/memory/`) with a `project_phase1_hermes_complete.md` marking the milestone.
