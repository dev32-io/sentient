# Test-Lean Doctrine + Audit (2026-04-25)

## Why

In an agentic-workflow project, the dominant cost of a test suite is the
time agents spend repairing tests during refactors and feature work. Today
~2/3 of agent effort on refactor tasks is consumed by tests that pin
implementation rather than contracts. Coverage thresholds and "every
foo.ts MUST have foo.test.ts" rules manufacture this work: agents
reflexively generate per-file unit tests, mock internals, and pin CSS
classes / copy strings / factory wiring.

Tests have value when they catch model drift on **contracts the model
cannot see** — wire shapes, FSM invariants, security boundaries, end-to-
end flows. Tests are dead weight when they re-encode internal structure
that any rewrite would change anyway.

This spec resets the doctrine and audits the existing 227 tests against
the new bar.

## Keep-Test Bar (Approach C, strict)

A test stays only if it satisfies **at least one**:

1. **Wire / protocol contract.** Asserts on the byte-shape of messages
   crossing a process boundary (gateway↔SDK, gateway↔Hermes, gateway↔MCP,
   STT/TTS provider wire). Schema validation, frame parsing, role
   semantics.

2. **FSM / invariant with a documented learning.** The behavior is
   pinned in `agents/docs/*-details.md`, `agent/docs/learnings.md`, or
   the salience/cycle architecture rules. Examples: attention-gate
   salience accumulator, awaiting-tracker FSM, cycle-audio-queue
   serialization.

3. **Security boundary.** Auth, token verification, prompt injection
   defense layers, log sanitization (PII redaction), policy engine.

4. **`@live` or browser-smoke flow.** End-to-end against real services
   or browser. Manual smoke procedures in
   `agent/docs/testing-knowledge.md`.

A test is **deleted** if:

- It mocks an internal collaborator of the unit under test (CSS class
  pinning, copy-string assertions, internal method-call counts).
- It is a per-file unit test for a pure utility / helper / factory whose
  failure mode would surface immediately at the next consumer.
- It tests configuration wiring or DI plumbing.
- It duplicates ground already covered by an `@live` or browser smoke
  scenario.
- It tests TypeScript types or constants (tautology).
- The code under test has been refactored out and the test no longer
  reflects current contracts.

Borderline → delete. (Earlier draft was borderline-keep; user requested
stricter bar to drive higher deletion rate.)

## Scope Boundaries

- **In scope:** all `*.test.ts` / `*.test.tsx` outside `docs/research/`.
- **Out of scope:** `docs/research/**` is reference material; do not
  touch. (Includes 17 PoC tests + vendored `node_modules` test files
  inside research subdirs.)

## Doctrine Changes

### Rules

| File | Change |
|---|---|
| `.claude/rules/testing.md` | Rewrite. Replace "write tests before/alongside, never defer" + coverage threshold + 100ms unit-test rule + happy/error/edge/boundary bullet with the keep-test bar above. Keep wire-protocol-mock-reality bullet and voice-pipeline philosophy bullets that still apply. |
| `.claude/rules/typescript.md` | Drop "Every source file `foo.ts` MUST have `foo.test.ts`" and "Mock ALL external deps in unit tests" lines. |
| `.claude/rules/pipeline.md` | Drop "One file. One test file." line. |
| `agents/docs/testing-details.md` | Rewrite. Drop the "every-file-gets-a-test" example and coverage section. Replace with examples of contract / FSM / smoke tests. |
| `agent/docs/testing-knowledge.md` | Keep as-is (manual smoke procedures — high value). |

### Configs

| File | Change |
|---|---|
| `gateway/vitest.config.ts` | Strip the `coverage` block (thresholds 80/75/80/80). |
| `gateway/webui/vitest.config.ts` | Strip the `coverage` block. |

CI does not currently enforce coverage (`bun run ci` runs lint +
typecheck + test:unit, no coverage flag). No CI changes required.

## Test Deletion (114 files)

| Area | Total | Keep | Delete |
|---|---|---|---|
| gateway/webui | 57 | 3 | 54 |
| shared/web-sdk | 23 | 10 | 13 |
| gateway/src | 114 | 67 | 47 |
| shared/protocol | 5 | 5 | 0 |
| shared/config | 4 | 4 | 0 |
| shared/tls | 1 | 1 | 0 |
| sentient-auth | 4 | 4 | 0 |
| gateway/tests (@live) | 2 | 2 | 0 |
| docs/research (untouched) | 17 | 17 | 0 |
| **TOTAL** | **227** | **113** | **114** |

### gateway/webui (3 keep / 54 delete)

**KEEP:**
- `adapters/cycle-audio-queue.test.ts` — cycle audio serialization (details doc).
- `adapters/web-audio-playback.test.ts` — drain FSM (smoke covers user-visible behavior, but FSM logic is intricate enough to warrant a guard).
- `hooks/awaiting-tracker.test.ts` — FSM (details doc).

**DELETE:** all 12 `components/settings/*`, all 4 `components/auth/*`,
all 10 `components/chat/*`, all 5 `components/common/*`, all 6
`components/dock/*`, all 3 `components/shell/*`, `app.test.tsx`,
`constants.test.ts`, `types.test.ts`, `audio/ring-buffer.test.ts`,
`config/typewriter.test.ts`, `lib/render-markdown.test.ts`,
`hooks/use-auth.test.tsx`, `hooks/use-follow-latest.test.ts`,
`hooks/voice-messages.test.ts`, `hooks/voice-status.test.ts`,
`hooks/cycle-helpers.test.ts`, `hooks/use-typewriter-buffer.test.ts`,
`hooks/use-voice-client.test.ts`, `services/auth-api.test.ts`,
`adapters/web-audio-capture.test.ts`,
`adapters/web-audio-playback-peer.test.ts`.

### shared/web-sdk (10 keep / 13 delete)

**KEEP:** all 8 `connectors/*` (gateway↔SDK wire), `audio-codec.test.ts`,
`presence/idle-detector.test.ts`.

**DELETE:** `presence/presence-coordinator.test.ts`,
`presence/presence-source.test.ts`, `presence/presence-wiring.test.ts`,
`event-emitter.test.ts`, `logger.test.ts`, `voice-types.test.ts`,
`connector-types.test.ts`, `error-classifier.test.ts`,
`processing-timer.test.ts`, `recovery-resolver.test.ts`,
`session-ready-handler.test.ts`, `echo-gate.test.ts`,
`sentient-sdk.test.ts`, `sentient-sdk.presence.test.ts`.

### gateway/src (67 keep / 47 delete)

**Delete by subdir:**

- `bootstrap/`: all 6 (factory wiring tautology).
- `api/`: 9 of 10 — keep only `middleware/require-admin-auth.test.ts`.
  Delete handlers/{admin,auth,health,profile,providers,ready,webui},
  providers-deps, router.
- `cerebrum/`: preferences, session-capabilities, short-term-context,
  task-mirror, text-delta-broadcaster (covered by attention-gate or
  smoke).
- `session-handlers/`: ws-handlers, ws-server, ws-server-voice,
  session-controls-registry (smoke covers WS lifecycle).
- `tts/stages/`: emoji-stripper, markdown-stripper, emotion-tagger
  (pure text utilities; failures surface at TTS output).
- `logging/`: format, logger, prune (utility tautology). Keep
  log-sanitizer (PII redaction = security).
- `profile-store/`: profile-defaults, profile-types, template-loader.
  Keep profile-store, profile-renderer.
- `sensors/`: ambient-event, home-assistant-observer. Keep
  ambient-event-log, ha-event-templates, satellite-device-registry.
- `providers/`: catalogs/ollama-fetcher, catalogs/ollama-catalog-loader,
  tts/fish-audio-synthesizer, tts/tts-types. Keep catalogs/openrouter-
  fetcher, catalogs/fish-fetcher, tts/audio-chunk-queue,
  tts/fish-audio-protocol.
- `user-auth/`: atomic-write, paths, types. Keep auth-service,
  auth-secret, pin-service, token-service, user-store, integration.
- `adapters/stt/`: token-loader (utility). Keep all 6 others.
- `tts/pipeline.test.ts`: keep (composition).
- `util/ttl-cache.test.ts`: delete.
- `main.test.ts`: delete.
- `context/system-prompt-loader.test.ts`: delete (file load).
- `session-router-strategy-b.test.ts`: delete (inactive strategy variant).

**Total gateway/src deletions:** 47.

### Untouched

- `shared/protocol/*` (5 schema/wire tests).
- `shared/config/*` (4 config schemas).
- `shared/tls/tls.test.ts`.
- `sentient-auth/src/*` (4 auth-package tests).
- `gateway/tests/integration/{hermes-e2e,docker-control-live}.test.ts`
  (the 2 `@live` smokes).

## Execution

Single feature branch `feature/test-lean-doctrine-and-audit` off
`feature/multi-user-auth-and-settings`. One PR. Commits:

1. `chore(rules): test-lean doctrine reset` — rule files +
   vitest.config strips + agents/docs/testing-details.md rewrite.
2. `chore(test): delete UI render and primitive component tests
   (webui)` — 54 files.
3. `chore(test): trim shared/web-sdk to wire connectors + idle FSM` —
   13 files.
4. `chore(test): trim gateway/src to contract + FSM + security tests` —
   47 files.
5. `chore(spec): add 2026-04-25 test-lean spec` (this document, if not
   already committed).

Verification: `bun run ci` (lint + typecheck + test:unit) must pass.
Code-reviewer agent reviews the branch against this spec before merge.

## Rollback

Each commit is reversible. If a deleted test turns out to have caught
something real, restore from git. Doctrine commit is independent of
deletions — can revert separately.
