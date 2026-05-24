# Sentient — Implementation Design Spec

> Date: 2026-04-04
> Status: Draft — pending user review
> Scope: Foundation through full assistant, phased delivery

## 1. Overview

Implement the Sentient voice gateway and web client. The system is a family AI assistant running on Raspberry Pi 5, with a TypeScript/Bun gateway orchestrating STT→LLM→TTS streaming, and thin clients (web, Android, iOS).

This spec covers:
- Monorepo structure and tooling
- Agent rules and quality enforcement
- GitLab CI/CD pipeline
- Docker deployment and Pi continuous delivery
- 6 implementation phases with deliverable checkpoints
- Testing strategy at every layer

## 2. External Services

| # | Service | Purpose | Env Variable | Est. Monthly |
|---|---|---|---|---|
| 1 | Deepgram | STT (Nova-3) | `DEEPGRAM_API_KEY` | ~$6-10 |
| 2 | OpenRouter | LLM routing | `OPENROUTER_API_KEY` | ~$3-8 |
| 3 | Fish Audio | TTS | `FISH_AUDIO_API_KEY` | ~$2-3 |
| 4 | Picovoice | Wake word (mobile, Phase 6) | `PICOVOICE_ACCESS_KEY` | $0 |

**Fish Audio STT rejected** — batch REST only (no WebSocket streaming), BETA, no endpointing. Deepgram stays for STT.

Secret management: `.env` file (gitignored) for local dev, GitLab CI/CD Variables (Protected+Masked) for CI, age-encrypted `secrets.enc` for Pi production.

## 3. Monorepo Structure

```
sentient/
├── CLAUDE.md                          # Ultra-lean (<60 lines)
├── .claude/
│   ├── settings.json                  # Hooks, quality gates
│   └── rules/                         # Cross-project rules
│       ├── architecture.md
│       ├── clean-code.md
│       ├── testing.md
│       ├── error-handling.md
│       └── git-workflow.md
├── agents/
│   └── docs/                          # Rule details + examples
│       ├── architecture-details.md
│       ├── clean-code-details.md
│       ├── testing-details.md
│       └── error-handling-details.md
│
├── gateway/                           # Bun/TypeScript voice gateway
│   ├── CLAUDE.md                      # Gateway context (~40 lines)
│   ├── .claude/rules/
│   │   ├── bun-typescript.md
│   │   ├── provider-integration.md
│   │   └── pipeline.md
│   ├── agents/docs/
│   │   ├── bun-typescript-details.md
│   │   ├── provider-integration-details.md
│   │   └── pipeline-details.md
│   ├── src/
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   └── vitest.config.ts
│
├── web/                               # Preact web client
│   ├── CLAUDE.md
│   ├── .claude/rules/
│   │   ├── preact-components.md
│   │   ├── state-management.md
│   │   └── audio.md
│   ├── agents/docs/
│   │   ├── preact-components-details.md
│   │   ├── state-management-details.md
│   │   └── audio-details.md
│   ├── src/
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   └── vite.config.ts
│
├── android/                           # Kotlin/Compose (Phase 6, stub only)
│   ├── CLAUDE.md
│   ├── .claude/rules/
│   │   ├── android-architecture.md
│   │   ├── android-viewmodel.md
│   │   ├── android-compose.md
│   │   └── android-testing.md
│   └── agents/docs/
│       ├── android-architecture-details.md
│       └── android-testing-details.md
│
├── ios/                               # Swift/SwiftUI (Phase 6, stub only)
│   ├── CLAUDE.md
│   ├── .claude/rules/
│   │   ├── ios-architecture.md
│   │   ├── ios-swiftui.md
│   │   └── ios-testing.md
│   └── agents/docs/
│       ├── ios-architecture-details.md
│       └── ios-testing-details.md
│
├── shared/
│   ├── protocol/                      # WebSocket message types, frame types
│   │   ├── src/
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── config/                        # Shared config schemas, env resolution
│   └── testing/                       # Test factories, mock providers
│
├── deploy/
│   ├── docker/
│   │   ├── docker-compose.yml         # Production
│   │   └── docker-compose.dev.yml     # Local development (watch, volumes)
│   ├── pi/
│   │   ├── docker-compose.yml         # Pi prod (with watchtower)
│   │   └── setup.sh                   # First-time Pi setup
│   └── ci/
│       └── templates/                 # Reusable CI job templates
│
├── scripts/
│   └── dev.sh                         # Pull + run develop images locally
│
├── docs/
│   ├── research/                      # Existing research (untouched)
│   └── superpowers/specs/             # Design specs
│
├── .gitlab-ci.yml
├── .env.example
├── biome.json
└── .gitignore
```

## 4. CLAUDE.md Convention

All CLAUDE.md files follow the same ultra-lean pattern. Rules live in `.claude/rules/`, details in `agents/docs/`.

### Root CLAUDE.md (~50 lines)

```markdown
# Sentient

Voice gateway for a family AI assistant on Raspberry Pi 5.

## MANDATORY — Read Rules First

Before exploring codebase, modifying code, or thinking about a solution, you MUST read all files in the corresponding `.claude/rules/` directory for the project you are working in. Start with root rules, then project-specific rules.

When a rule is unclear and you need examples, read the corresponding file in `agents/docs/`.

## Project Map

| Project | Directory | Description |
|---------|-----------|-------------|
| Root rules | `.claude/rules/` | Cross-project architecture, clean code, testing, error handling |
| Gateway | `gateway/` | Bun/TypeScript voice gateway |
| Web | `web/` | Preact web client |
| Android | `android/` | Kotlin/Compose mobile client (Phase 6) |
| iOS | `ios/` | Swift/SwiftUI mobile client (Phase 6) |
| Shared | `shared/` | Protocol types, config schemas, test utilities |
| Deploy | `deploy/` | Docker, CI, Pi deployment |

## Commands

bun run dev           — Gateway + web dev servers
bun run test          — All tests
bun run test:unit     — Unit tests only
bun run test:int      — Integration tests
bun run lint          — Biome lint + format check
bun run typecheck     — TypeScript strict check
bun run ci            — Full local CI (lint + typecheck + test)

## Architecture

Gateway (Bun/TS on RPi5) orchestrates: Client↔WebSocket↔Auth→STT(Deepgram)→Classifier→LLM(OpenRouter)→SentenceAggregator→TTS(FishAudio)→Client.

Key patterns:
- Single WebSocket per client (binary audio + JSON control, 22 message types)
- AsyncGenerator for all streaming (STT, LLM, TTS)
- Frame-based pipeline: SystemFrame (priority) > DataFrame > ControlFrame
- Streaming overlap: TTS starts on first sentence while LLM continues (50-70% latency cut)
- Classifier routes 70% conversation→Haiku, 30% tools→Sonnet (saves ~$40/mo)
- PASETO v4.local auth, 6-layer prompt injection defense
- AbortSignal cancel propagation for barge-in
- Per-user memory: sectioned markdown, tiered storage, end-of-session extraction

Providers: Deepgram Nova-3 (STT, WS streaming), OpenRouter (LLM, SSE), Fish Audio (TTS, WS+MsgPack)
Clients: Preact web (toggle-to-talk), Android (Kotlin/Compose), iOS (Swift/SwiftUI)
Hardware: RPi5 8GB, ~60-90MB for 10 sessions, massive headroom

For PoC results and exploration details, see `docs/research/`.
```

### Project CLAUDE.md (~30-40 lines each)

Example — `gateway/CLAUDE.md`:

```markdown
# Gateway

Bun/TypeScript voice gateway. Orchestrates STT→LLM→TTS streaming pipeline.

## MANDATORY — Read Rules First

Before modifying any code in this project, you MUST read ALL files in `.claude/rules/` in this directory AND the root `.claude/rules/`. When a rule is unclear, read the corresponding file in `agents/docs/`.

## Stack

- Runtime: Bun
- Language: TypeScript (strict mode)
- Test runner: Vitest
- WebSocket: Bun built-in
- Providers: Deepgram (STT), OpenRouter (LLM), Fish Audio (TTS)

## Commands

bun run dev       — Start gateway with hot reload
bun run test      — Run gateway tests
bun run build     — Production build

## Key Patterns

- AsyncGenerator for all streaming (STT, LLM, TTS)
- Frame-based pipeline (SystemFrame > DataFrame > ControlFrame)
- AbortSignal for cancel propagation
- Circuit breaker via cockatiel for provider resilience
```

## 5. Rules Structure

### Conventions

- Each `.claude/rules/*.md` file: **under 40 lines**, bullet points, strong imperative language
- Each `agents/docs/*-details.md` file: examples, rationale, anti-patterns (can be longer)
- Positive instructions only ("Use X" not "Don't use Y")
- Anchor 3 most critical rules at top of each file

### Root Rules (apply everywhere)

**`.claude/rules/architecture.md`**
- Dependencies flow inward only: domain → application → infrastructure
- One module per file. File name matches primary export.
- Feature-based organization. Group by domain, not by type.
- Define interfaces at boundaries. Concrete implementations behind interfaces.
- Shared types live in `shared/`. Never duplicate type definitions across projects.
- When approaching 300 lines, split the file immediately.

**`.claude/rules/clean-code.md`**
- Files MUST stay under 300 lines. Split at 250.
- Functions MUST stay under 40 lines. Extract at 30.
- Max nesting depth: 3 levels. Use early returns to flatten.
- No magic numbers or hardcoded strings. Use named constants.
- No commented-out code. Delete it. Git has history.
- No unused imports, variables, or parameters.
- Prefer pure functions. Minimize side effects.
- Return new objects for state changes. Never mutate parameters.
- Name booleans as questions: `isReady`, `hasPermission`, `canExecute`.
- Name functions as actions: `createSession`, `validateToken`, `parseFrame`.

**`.claude/rules/testing.md`**
- Every source file `foo.ts` MUST have `foo.test.ts` in the same directory.
- Write tests BEFORE or ALONGSIDE implementation. Never defer.
- Coverage minimum: 80% statements, 75% branches. CI enforces this.
- One behavior per `it()` block. Name: `it('returns X when Y')`.
- Mock ALL external deps in unit tests. Use factories from `shared/testing/`.
- Unit tests MUST complete in under 100ms each.
- Cover: happy path, error path, edge cases, boundary values.
- Prefer integration tests for multi-component flows over excessive mocks.
- When a test fails, fix the implementation, not the test (unless test is wrong).

**`.claude/rules/error-handling.md`**
- Failable operations return a Result type or typed error union. Never throw from business logic.
- Catch errors at system boundaries only (HTTP handlers, WebSocket handlers, CLI entry).
- Error messages MUST include: what failed, why, and actionable context.
- Never swallow errors silently. Log or propagate.
- Use `unknown` for caught errors, narrow with type guards.
- Timeout every external call. No unbounded waits.

**`.claude/rules/git-workflow.md`**
- Work on `feature/*` branches only. Never push to `main` or `develop` directly.
- Commit message format: `type(scope): description` (feat, fix, refactor, test, chore, docs).
- One logical change per commit. Atomic commits.
- Before merging to develop: self-review diff, simplify, run `bun run ci`, verify all tests pass.
- Merge feature branch into develop when all checks pass. Delete feature branch after merge.

### Project-Specific Rules (examples)

**`gateway/.claude/rules/bun-typescript.md`**
- Use `unknown` for all external input. Validate with zod schemas.
- Explicit return types on all exported functions.
- Use string literal unions over enums.
- Use `interface` for extendable shapes, `type` for unions and utilities.
- AsyncGenerator for all streaming operations. Always call `.return()` on cleanup.
- AbortSignal threads through every async operation for cancel propagation.
- Use `using` keyword (TC39 explicit resource management) for auto-cleanup where Bun supports it.

**`web/.claude/rules/preact-components.md`**
- One component per file. File name matches component name.
- Props type defined and exported in same file as component.
- Container components own data. Presentational components receive props and are pure.
- Use signals for local state. Use context sparingly (auth, theme only).
- Derive computed values. Never store redundant state.
- Semantic HTML first. No generic div stacks.
- CSS custom properties for all design tokens.

## 6. Testing Architecture

```
Test Pyramid
├── Unit Tests (~70% of tests, <100ms each)
│   ├── Pure functions, state machines, parsers, validators
│   ├── All external deps mocked (providers, WebSocket, filesystem)
│   ├── Run: bun run test:unit
│   └── Trigger: every push, every task completion
│
├── Integration Tests (~25%, <5s each)
│   ├── Real event loops, mock providers with realistic behavior
│   ├── Multi-component flows: auth → session → pipeline → response
│   ├── WebSocket protocol tests with real WS server + test client
│   ├── Run: bun run test:int
│   └── Trigger: MR pipelines, merge to develop/main
│
└── E2E Tests (~5%, <30s each)
    ├── docker-compose up → real WebSocket → verify response
    ├── Mock provider containers (not real cloud APIs)
    ├── Run: bun run test:e2e
    └── Trigger: MR to main only
```

### Coverage Thresholds (enforced in CI)

| Metric | Minimum |
|--------|---------|
| Statements | 80% |
| Branches | 75% |
| Functions | 80% |
| Lines | 80% |

### Test Factories (shared/testing/)

Reusable factories for all projects:
- `createMockWebSocket()` — mock WS with send/receive/close
- `createMockSession(overrides?)` — session with defaults
- `createMockProvider(type, behavior?)` — mock STT/LLM/TTS with configurable latency/errors
- `createTestPipeline(processors[])` — wired pipeline for integration tests
- `createAuthToken(claims?)` — valid PASETO token for testing

### Claude Code Quality Gate Hooks

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": { "toolName": "Write|Edit" },
      "hooks": [{
        "type": "command",
        "command": "cd /Users/kevinye/Development/sentient && bun run typecheck 2>&1 | tail -5"
      }]
    }],
    "TaskCompleted": [{
      "hooks": [{
        "type": "command",
        "command": "cd /Users/kevinye/Development/sentient && bun run lint && bun run typecheck && bun run test:unit 2>&1 | tail -20; if [ $? -ne 0 ]; then echo 'BLOCKED: Fix lint/typecheck/test failures before completing.' >&2; exit 2; fi"
      }]
    }]
  }
}
```

## 7. GitLab CI/CD

### Branch Strategy

```
main       ← production, protected (push restricted), triggers image build + Pi deploy
  ↑ merge from develop (manual, human decision)
develop    ← integration, protected (push restricted)
  ↑ merge from feature/* (agent: self-review → fix → verify → merge)
feature/*  ← agent working branches, ephemeral
```

Phase 0 commits directly to main. After Phase 0, switch to feature branch workflow.

**No PRs/MRs.** Agents work on feature branches, self-review and fix locally, verify all tests pass, then merge directly into develop. This keeps the workflow simple — quality is enforced by local CI checks and Claude Code hooks, not by a review ceremony.

### Pipeline Stages

| Event | lint | typecheck | unit test | integration | docker build | publish |
|---|---|---|---|---|---|---|
| Push `feature/*` | Yes | Yes | Yes | — | — | — |
| Push `develop` | Yes | Yes | Yes | Yes | Yes | `:develop` tag |
| Push `main` | Yes | Yes | Yes | Yes | Yes | `:production` + `:latest` |

### Agent Workflow (Post Phase 0)

```
1. git checkout -b feature/xxx develop
2. Implement with ralph-loop (persistent until verified)
3. Self-review: read own diff, simplify, fix issues
4. bun run ci (lint + typecheck + test:unit)
5. git merge feature/xxx into develop
6. CI runs on develop push (includes integration tests + docker build)
7. Delete feature branch
```

### Monorepo CI Scoping

Jobs use `rules:changes` to only run for affected packages:
- `gateway/**/*` changes → run gateway lint/test/build
- `web/**/*` changes → run web lint/test/build
- `shared/**/*` changes → run all downstream (gateway + web)

### Docker Multi-Arch Build

Build `linux/amd64` + `linux/arm64` images using `docker buildx`. Push to GitLab Container Registry.

## 8. Deployment

### Production (Pi)

```yaml
# deploy/pi/docker-compose.yml
services:
  gateway:
    image: registry.gitlab.example.com/group/sentient/gateway:production
    restart: unless-stopped
    env_file: .env
    ports:
      - "3000:3000"

  watchtower:
    image: containrrr/watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /home/pi/.docker/config.json:/config.json:ro
    environment:
      WATCHTOWER_POLL_INTERVAL: 300
      WATCHTOWER_CLEANUP: "true"
      WATCHTOWER_ROLLING_RESTART: "true"
    command: gateway
```

Web client served as static files from gateway — no separate container.

### Local Development Testing

```bash
# scripts/dev.sh — pull and run develop images locally
docker compose -f deploy/docker/docker-compose.dev.yml pull
docker compose -f deploy/docker/docker-compose.dev.yml up --rm
```

## 9. Implementation Phases

### Phase 0: Foundation

**Goal:** Clone → `bun install` → `bun run ci` → green. `docker-compose up` → health endpoint responds. All rules and quality gates in place. Commits directly to main.

**Deliverables:**
- [ ] Monorepo scaffold (all directories, package.json files, tsconfig configs)
- [ ] All CLAUDE.md files (root, gateway, web, android, ios)
- [ ] All `.claude/rules/` files (root + per-project)
- [ ] All `agents/docs/` detail files with examples
- [ ] `shared/protocol/` — all 22 message types as TypeScript discriminated unions + zod schemas + tests
- [ ] `shared/config/` — config loading (YAML + env var resolution) + tests
- [ ] `shared/testing/` — test factories (mock WS, mock session, mock providers)
- [ ] Biome config (`biome.json`) — lint + format for gateway + web
- [ ] Vitest config per project with coverage thresholds
- [ ] Lefthook — pre-commit: lint+typecheck, pre-push: test:unit
- [ ] `.claude/settings.json` — quality gate hooks
- [ ] Dockerfiles (gateway multi-stage, web build→serve)
- [ ] `deploy/docker/docker-compose.yml` + `docker-compose.dev.yml`
- [ ] `deploy/pi/docker-compose.yml` (with watchtower)
- [ ] `.gitlab-ci.yml` — full pipeline (lint, typecheck, test, docker build)
- [ ] `.env.example` — documented, no secrets
- [ ] `.gitignore`
- [ ] `scripts/dev.sh`
- [ ] Reference tests — 2-3 tests per project showing exact patterns
- [ ] Android/iOS stubs — CLAUDE.md, `.claude/rules/`, `agents/docs/` (no source code)

**CHECKPOINT:** `bun install && bun run ci` passes. `docker compose up` → `curl localhost:3000/health` → `{"status":"ok"}`.

**After Phase 0:** Inform user of manual GitLab steps (protect branches, create CI variables, create bot token, set approval rules).

### Phase 1: Gateway Core — Text Loop

**Goal:** WebSocket connect → authenticate → send text → receive streaming LLM response.

| Task | Tests | Checkpoint |
|------|-------|------------|
| 1.1 Bun WebSocket server + health endpoint | ~10 | Server starts, health responds |
| 1.2 PASETO auth (verify, session create, 10-cap) | ~25 | Connect + auth → session.ready |
| 1.3 Pipeline framework (frames, processors, queues) | ~20 | Frames route through pipeline |
| 1.4 OpenRouter LLM provider (AsyncGenerator, SSE) | ~15 | Mock provider returns streaming tokens |
| 1.5 Context assembly (persona.md only) | ~10 | Persona injected into LLM context |
| 1.6 Config system (YAML + env vars) | ~10 | Config loads, env vars resolve |
| 1.7 Text-to-text integration | ~15 | **text.input → streaming response.text.delta** |

**CHECKPOINT:** `wscat -c ws://localhost:3000` → send auth → send text.input → see streaming response.

### Phase 2: Gateway Voice — Audio Loop

**Goal:** Audio in → STT → LLM → TTS → audio out, with barge-in.

| Task | Tests | Checkpoint |
|------|-------|------------|
| 2.1 Deepgram STT provider (raw WS, endpointing) | ~20 | Audio frames → transcripts |
| 2.2 Audio relay processor | ~10 | Binary WS → Deepgram relay |
| 2.3 Sentence aggregator | ~30 | Correct splitting (port PoC 30 cases) |
| 2.4 Fish Audio TTS provider (WS, MsgPack, Opus) | ~15 | Sentences → audio frames |
| 2.5 Streaming overlap | ~10 | TTS starts before LLM finishes |
| 2.6 Barge-in + cancel propagation | ~15 | AbortController stops all processors |
| 2.7 Session lifecycle (persist, reconnect, shutdown) | ~20 | Reconnect within 120s works |

**CHECKPOINT:** Full voice loop via test client. Audio in → hear response audio.

### Phase 3: Web Client — Browser Interface

**Goal:** Browser UI with text chat and toggle-to-talk voice.

| Task | Tests | Checkpoint |
|------|-------|------------|
| 3.1 Preact + Vite scaffold, static serving | ~5 | Page loads from gateway |
| 3.2 Auth flow (URL token, PIN entry) | ~10 | Family + guest auth works |
| 3.3 Chat UI components | ~15 | Messages render, input works |
| 3.4 WebSocket hook (connect, auth, reconnect) | ~15 | Connection state machine works |
| 3.5 Streaming text rendering | ~10 | Delta assembly, smooth rendering |
| 3.6 Toggle-to-talk button | ~10 | Click start → recording → click stop |
| 3.7 Audio capture (MediaRecorder → Opus → WS) | ~15 | Audio frames sent correctly |
| 3.8 Audio playback (AudioWorklet ring buffer) | ~15 | TTS audio plays, barge-in clears |
| 3.9 Safari polyfill (opus-media-recorder WASM) | ~5 | Safari records Opus correctly |

**CHECKPOINT:** Open browser → authenticate → text chat works → toggle-to-talk voice works in Chrome + Safari.

### Phase 4: Classifier + Security

**Goal:** Smart model routing, prompt injection defense, production-ready security.

| Task | Tests | Checkpoint |
|------|-------|------------|
| 4.1 Regex classifier fast-path | ~78 | Port all PoC test cases |
| 4.2 LLM classifier fallback (Haiku) | ~10 | Ambiguous cases classified |
| 4.3 Model routing (conversation→Haiku, tools→Sonnet) | ~10 | Correct model per intent |
| 4.4 6-layer prompt injection defense | ~50 | 95%+ detection, 0% FP |
| 4.5 Docker production config | ~10 | Healthchecks, resource limits |

**CHECKPOINT:** Production-grade deployment. Classifier routes correctly. Injection defense holds.

### Phase 5: Intelligence Layer

**Goal:** Tools, skills, memory, guest mode — real assistant.

| Task | Tests | Checkpoint |
|------|-------|------------|
| 5.1 Tool registry + ReAct loop | ~30 | Tools execute within loop |
| 5.2 Tool confirmation flow | ~15 | Confirm tier asks user |
| 5.3 Built-in tools (weather, time, reminders) | ~20 | "What time is it" works |
| 5.4 Skill engine (YAML+MD, hot-reload, scoped) | ~30 | Drop .md → skill available |
| 5.5 Per-user memory (extraction, tiers, isolation) | ~30 | Remembers across sessions |
| 5.6 Guest mode (PIN, ephemeral, restricted) | ~25 | Guest flow end-to-end |
| 5.7 Audit logging + metrics endpoint | ~15 | Logs written, /metrics responds |

**CHECKPOINT:** Family assistant with memory, tools, skills, guest access. Production-ready.

### Phase 6+: Mobile + Advanced (Deferred)

- Gateway VAD (Silero double-endpointing)
- Whisper.cpp local STT fallback
- TTS failover (Cartesia or text-only)
- Android client (Kotlin/Compose, Porcupine, OkHttp)
- iOS client (Swift/SwiftUI, Porcupine, URLSession)
- Token management CLI

## 10. Estimated Test Counts

| Phase | Unit | Integration | E2E | Total |
|-------|------|-------------|-----|-------|
| 0: Foundation | 30 | 5 | 2 | ~37 |
| 1: Text Loop | 75 | 25 | 5 | ~105 |
| 2: Voice Loop | 90 | 25 | 5 | ~120 |
| 3: Web Client | 70 | 25 | 5 | ~100 |
| 4: Security | 120 | 25 | 8 | ~153 |
| 5: Intelligence | 120 | 35 | 10 | ~165 |
| **Total** | **~505** | **~140** | **~35** | **~680** |

## 11. Workflow Per Phase (Post Phase 0)

```
1. superpowers:writing-plans → decompose phase into bite-sized tasks
2. For each task:
   a. git checkout -b feature/xxx develop
   b. Implement with ralph-loop (persistent until verified)
   c. Self-review: read own diff, simplify, fix
   d. bun run ci (lint + typecheck + test:unit) — must pass
   e. git checkout develop && git merge feature/xxx
   f. CI runs on develop push (integration tests + docker build)
   g. Delete feature branch
3. superpowers:verification-before-completion → prove phase checkpoint passes
4. When phase is complete: merge develop → main (human decision)
```

## 12. Post-Phase 0 Manual Steps (For User)

After Phase 0 is committed to main, the user must:

1. **Create GitLab project** — private, under preferred group
2. **Push repo** — `git remote add origin <url> && git push -u origin main`
3. **Protect branches** — Settings > Repository > Protected Branches:
   - `main`: merge=Maintainers, push=No one
   - `develop`: merge=Developers+, push=No one
4. **Create `develop` branch** — `git checkout -b develop && git push -u origin develop`
5. **Add CI/CD variables** — Settings > CI/CD > Variables (all Protected+Masked):
   - `DEEPGRAM_API_KEY`, `OPENROUTER_API_KEY`, `FISH_AUDIO_API_KEY`
   - `PASETO_SECRET_KEY` (generate: `openssl rand -hex 32`)
6. **Create deploy token** — Settings > Repository > Deploy Tokens:
   - Name: `pi-deploy`, scope: `read_registry`
   - Use on Pi: `docker login registry.gitlab.example.com -u pi-deploy -p <token>`
7. **Verify CI** — Push a feature branch, confirm pipeline runs
8. **Setup Pi** — Run `deploy/pi/setup.sh` on the Raspberry Pi

## 13. Key Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime | Bun | 2.1x faster WS, native TS, validated in PoC |
| Linter | Biome (gateway+web only) | Single tool, fast, replaces eslint+prettier |
| Test runner | Vitest | Fast, native ESM, workspace support |
| Git hooks | Lefthook | Fast, no npm deps for hook runner |
| STT | Deepgram Nova-3 | Real-time streaming, endpointing, $200 free credit |
| TTS | Fish Audio | Best price-performance, native Opus, WS streaming |
| LLM | OpenRouter | Provider failover, model routing, OpenAI SDK compat |
| Auth | PASETO v4.local | Encrypted tokens, zero client dependencies |
| Web framework | Preact + Vite | 4.5KB, React-like, fast builds |
| Web voice UX | Toggle-to-talk | Click to start/stop, better for longer utterances |
| Docker | Multi-stage, multi-arch (amd64+arm64) | Runs on dev machines and Pi |
| Pi deploy | Watchtower 5-min poll | No inbound ports, minimal disruption, rolling restart |
| Code review | Local self-review + CI quality gates | Simple, no PR ceremony, quality via tests + hooks |
| Env: production | Pi only, `:production` tag | Single environment, simple |
| Env: develop | Local via `scripts/dev.sh` | Pull + run develop images with `--rm` |
