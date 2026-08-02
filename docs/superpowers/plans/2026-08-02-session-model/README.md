# Session Model Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-08-02-session-model-and-multi-surface-design.md` — read §2.5, §3.2 and §3.4 before starting anything.

**Goal:** Make a session a server-minted, listable, re-openable resource that any number of one user's connections can attach to at once, each a window onto the same live conversation.

**Architecture:** `SessionRuntime` is re-keyed from `(userId, surfaceId)` to `sessionId`, and the single-owner `ConversationRuntimeRegistry` is replaced by a subscriber set. The frame journal moves from per-surface to per-session, split into a session lane (journaled, fanned out) and a connection lane (never journaled). Session lifetime is a derived predicate over observable work, not a stored flag.

**Tech Stack:** Bun, TypeScript strict, `bun:sqlite`, Vitest, Preact (webui), KMP (mobile SDK), zod for wire validation.

---

## Global Constraints

Copied from the spec; every task inherits these.

- **Authorization is principal → capability → membership.** `surfaceId` gates nothing; it is a client identifier used for journal keying, resume correlation and log attribution only. There are **no attachment verbs**.
- **Exactly one `SessionRuntime` per `sessionId`; N attachments to it.** Two runtimes on one partition would fork the append-only log and contend on one WAL.
- **sessionId is CSPRNG, ≥128 bits, opaque.** Never derived from userId, surfaceId or a timestamp. Do not reuse the `Math.random().toString(36)` pattern in `auth/session-manager.ts:61`.
- **An unknown sessionId is rejected**, never silently created — legacy `c::` ids included. A legacy id is accepted only if already present in the caller's store.
- **Schema changes go through the migration ladder** (`STORE_MIGRATIONS` in `store/schema.ts`), **never** by editing `STORE_DDL`. Editing the frozen baseline reaches no existing database and keeps fresh-DB tests green while real users fail — that is the D14 blind spot.
- **Every tunable lives in `gateway/config.yaml`** with an inline comment and a valid range. No magic numbers in source. Code fails loudly when a required value is missing.
- **Retention window is `session.retention_ms`, default `900000`** (15 min). It replaces `session.replay_journal_retention_ms` and the rename is carried by `config/operator-config-migrator.ts`.
- **Logging:** every session-lane line carries `sessionId` + `turnId`; every command, permission and cancellation line additionally carries `attachmentId`; a background-completion stimulus carries a `stimulusId`. Ids, lengths and reasons only — never content.
- **Test bar is narrow and high.** A test earns its place only by pinning a wire/protocol contract at a process boundary, an FSM/invariant with a documented learning, a security boundary, or a `@live` flow. Delete borderline tests rather than keeping them. One behaviour per `it()`.
- **`shared/protocol` is a frozen wire contract.** Any field addition moves the gateway, `shared/web-sdk` and `shared/mobile-sdk` together in the same task.
- **E2E is local dev stack only.** Never drive `mini0.lan` / `sentient.dev32.io`. Credentials come from `agents/docs/testing-knowledge.md`. Tool calls in verification are reads or temp-writes only — never `ha_call_service`, `ma_playback`, `ma_play_media`, `ma_volume`.

---

## File structure

**New modules** — each has one responsibility, so no task grows `session-runtime.ts` (already 35 KB) or `ws-session-configure.ts` (22 KB) further:

| File | Responsibility |
|---|---|
| `gateway/src/store/session-metadata.ts` | the `sessions` table: create, get, list, rename with compare-and-set |
| `gateway/src/session-handlers/session-id.ts` | CSPRNG minting + format validation |
| `gateway/src/session-handlers/subscriber-set.ts` | attachments for one session: attach, detach, iterate, lease identity |
| `gateway/src/session-handlers/session-registry.ts` | one `SessionRuntime` per `sessionId` + its subscriber set (replaces `conversation-runtime-registry.ts`) |
| `gateway/src/session-handlers/fan-out-emitter.ts` | `TurnEmitter` that writes once to the session journal and serves N cursors |
| `gateway/src/session-handlers/frame-lanes.ts` | the enumerated `frameType → lane` table |
| `gateway/src/runtime/turn-state-snapshot.ts` | the transient in-flight view handed to a joiner |
| `gateway/src/runtime/session-retention.ts` | `computeRetentionReasons()` / `isRetained()` + the lost-task watchdog |
| `gateway/src/runtime/session-permission-broker.ts` | session-scoped prompts: fan out, first answer wins, timeout denies |
| `gateway/src/session-handlers/command-mediator.ts` | the single choke point binding a command to `{sessionId, attachmentGeneration}` |
| `gateway/src/runtime/auxiliary-task.ts` | the reusable side-LLM seam |
| `gateway/src/runtime/titler.ts` | its first user |
| `gateway/src/api/handlers/sessions.ts` | `GET /api/v1/sessions` and `GET /api/v1/sessions/:id/messages` |

**Deleted:** `gateway/src/session-handlers/conversation-runtime-registry.ts` and its test — replaced, not generalised (spec §2.5).

---

## Task index and sequencing

Order is not arbitrary. Tasks 1–2 are foundations that later tasks rest on; task 5 is the structural cutover that 6–9 assume.

| # | Task | Why here |
|---|---|---|
| 1 | [L2 capability fixes](task-1-l2-capability-fixes.md) | Every security claim downstream rests on it. Must land before any runtime refactor. |
| 2 | [Session metadata table](task-2-session-metadata-table.md) | Nothing can be listed, titled or renamed without it. |
| 3 | [Opaque ids, minting, membership](task-3-session-identity.md) | Creates the ids tasks 4–5 address. |
| 4 | [Sessions REST + drawer](task-4-sessions-rest-and-drawer.md) | Closes D15's visible half; independently shippable. |
| 5 | [Identity rewrite + subscriber set](task-5-identity-rewrite.md) | **The structural cutover.** 6–9 are incoherent before it. |
| 6 | [Frame lanes, fan-out, attach](task-6-fanout-and-attach.md) | Multi-window delivery. |
| 7 | [Session-scoped permissions](task-7-session-permissions.md) | Needs the subscriber set from 5. |
| 8 | [Derived retention](task-8-derived-retention.md) | Needs the subscriber set; fixes a live orphaned-task defect. |
| 9 | [Command binding + arbitration](task-9-command-binding.md) | Correctness condition for switching. |
| 10 | [Auxiliary-task seam + titling](task-10-titling.md) | Needs the metadata table from 2. |
| 11 | [E2E round 3 + doc supersession](task-11-e2e-and-docs.md) | Exit criteria. |

**Wire-protocol changes are concentrated in tasks 3 and 9.** No other task may add a field to `shared/protocol`.

---

## Definition of done

The full E2E matrix in spec §10 is green, with the five `security`-tagged rows **driven** rather than reasoned about, and `bargein-cutoff` handed to the owner (it needs a real microphone).

Per task, the gate is:

```bash
source scripts/env.sh
bun run --filter '*' typecheck && bunx biome check . && (cd gateway/src && bun test 2>&1 | tail -4)
bun qa/web/stack-integrity.ts
```

Expected: no typecheck or lint errors, no failing tests, `RESULT PASS`.
