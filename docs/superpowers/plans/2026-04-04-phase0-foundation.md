# Phase 0: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clone → `bun install` → `bun run ci` → green. `docker compose up` → health endpoint responds. All rules, quality gates, and project scaffolding in place.

**Architecture:** Bun workspace monorepo with gateway/, web/, shared/ as TS packages, android/ and ios/ as stub directories. Phase 0 commits directly to main — no feature branches yet.

**Tech Stack:** Bun 1.2+, TypeScript 5.8+ (strict), Vitest, Biome, Lefthook, Docker, GitLab CI

---

## File Structure

```
sentient/
├── CLAUDE.md
├── package.json                       # Root workspace
├── tsconfig.base.json                 # Shared TS config
├── biome.json
├── lefthook.yml
├── .gitignore
├── .env.example
├── .claude/
│   ├── settings.json
│   └── rules/
│       ├── architecture.md
│       ├── clean-code.md
│       ├── testing.md
│       ├── error-handling.md
│       └── git-workflow.md
├── agents/
│   └── docs/
│       ├── architecture-details.md
│       ├── clean-code-details.md
│       ├── testing-details.md
│       └── error-handling-details.md
├── gateway/
│   ├── CLAUDE.md
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── Dockerfile
│   ├── .claude/rules/
│   │   ├── bun-typescript.md
│   │   ├── provider-integration.md
│   │   └── pipeline.md
│   ├── agents/docs/
│   │   ├── bun-typescript-details.md
│   │   ├── provider-integration-details.md
│   │   └── pipeline-details.md
│   └── src/
│       ├── index.ts                   # Entry point (health endpoint)
│       └── index.test.ts              # Reference test
├── web/
│   ├── CLAUDE.md
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── vitest.config.ts
│   ├── Dockerfile
│   ├── index.html
│   ├── .claude/rules/
│   │   ├── preact-components.md
│   │   ├── state-management.md
│   │   └── audio.md
│   ├── agents/docs/
│   │   ├── preact-components-details.md
│   │   ├── state-management-details.md
│   │   └── audio-details.md
│   └── src/
│       ├── app.tsx                    # Root component
│       ├── app.test.tsx               # Reference test
│       └── main.tsx                   # Entry point
├── android/
│   ├── CLAUDE.md
│   ├── .claude/rules/                 # Ported from dotJournal
│   └── agents/docs/
├── ios/
│   ├── CLAUDE.md
│   ├── .claude/rules/                 # Ported from dotJournal
│   └── agents/docs/
├── shared/
│   ├── protocol/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── messages.ts            # All 22 message types
│   │       ├── messages.test.ts
│   │       ├── frames.ts             # Frame type hierarchy
│   │       ├── frames.test.ts
│   │       ├── errors.ts             # Close codes, error types
│   │       ├── errors.test.ts
│   │       ├── roles.ts              # User roles, impact tiers
│   │       ├── roles.test.ts
│   │       └── index.ts              # Re-exports
│   ├── config/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── loader.ts             # YAML + env var resolution
│   │       ├── loader.test.ts
│   │       ├── schema.ts             # Config zod schemas
│   │       ├── schema.test.ts
│   │       └── index.ts
│   └── testing/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── mock-websocket.ts
│           ├── mock-session.ts
│           ├── mock-provider.ts
│           ├── mock-auth.ts
│           └── index.ts
├── deploy/
│   ├── docker/
│   │   ├── docker-compose.yml
│   │   └── docker-compose.dev.yml
│   └── pi/
│       ├── docker-compose.yml
│       └── setup.sh
├── scripts/
│   └── dev.sh
├── .gitlab-ci.yml
└── docs/
    ├── research/                      # Existing (untouched)
    └── superpowers/                   # Specs + plans
```

---

## Task 1: Root Monorepo Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.env.example`

- [ ] **Step 1: Create root `package.json` with Bun workspaces**

```json
{
  "name": "sentient",
  "private": true,
  "workspaces": [
    "gateway",
    "web",
    "shared/*"
  ],
  "scripts": {
    "dev": "bun run --filter './gateway' dev & bun run --filter './web' dev",
    "test": "bun run --filter '*' test",
    "test:unit": "bun run --filter '*' test:unit",
    "test:int": "bun run --filter '*' test:int",
    "lint": "bunx biome check .",
    "lint:fix": "bunx biome check --write .",
    "typecheck": "bun run --filter '*' typecheck",
    "ci": "bun run lint && bun run typecheck && bun run test:unit"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "lefthook": "^1.10.0",
    "typescript": "^5.8.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "types": ["bun-types"]
  }
}
```

- [ ] **Step 3: Create `.gitignore`**

```gitignore
# Dependencies
node_modules/
bun.lockb

# Build
dist/
.vite/

# Environment
.env
.env.local
.env.*.local
secrets.enc

# IDE
.idea/
.vscode/
*.swp
*.swo
*~

# OS
.DS_Store
Thumbs.db

# Test
coverage/

# Python venv (from research PoCs)
venv/
__pycache__/
*.pyc

# Docker
.docker/
```

- [ ] **Step 4: Create `.env.example`**

```bash
# Voice Gateway — External Service Keys
# Copy to .env and fill in real values. NEVER commit .env.

# STT — Deepgram Nova-3 (https://console.deepgram.com)
DEEPGRAM_API_KEY=your_key_here

# LLM — OpenRouter (https://openrouter.ai/keys)
OPENROUTER_API_KEY=your_key_here

# TTS — Fish Audio (https://fish.audio/developers)
FISH_AUDIO_API_KEY=your_key_here

# Auth — PASETO secret key (generate: openssl rand -hex 32)
PASETO_SECRET_KEY=

# Gateway
GATEWAY_PORT=3000
GATEWAY_HOST=0.0.0.0
```

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.base.json .gitignore .env.example
git commit -m "chore: root monorepo scaffold with Bun workspaces"
```

---

## Task 2: Root CLAUDE.md and Quality Gate Hooks

**Files:**
- Create: `CLAUDE.md`
- Create: `.claude/settings.json`

- [ ] **Step 1: Create `CLAUDE.md`**

```markdown
# Sentient

Voice gateway for a family AI assistant on Raspberry Pi 5.

## MANDATORY — Read Rules First

Before exploring codebase, modifying code, or thinking about a solution, you MUST read all files in the corresponding `.claude/rules/` directory for the project you are working in. Start with root `.claude/rules/`, then project-specific rules.

When a rule is unclear and you need examples, read the corresponding file in `agents/docs/`.

## Project Map

| Project | Directory | Description |
|---------|-----------|-------------|
| Root rules | `.claude/rules/` | Cross-project architecture, clean code, testing, error handling |
| Gateway | `gateway/` | Bun/TypeScript voice gateway |
| Web | `web/` | Preact web client |
| Android | `android/` | Kotlin/Compose mobile client (deferred) |
| iOS | `ios/` | Swift/SwiftUI mobile client (deferred) |
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
- Classifier routes 70% conversation→Haiku, 30% tools→Sonnet
- PASETO v4.local auth, 6-layer prompt injection defense
- AbortSignal cancel propagation for barge-in
- Per-user memory: sectioned markdown, tiered storage, end-of-session extraction

Providers: Deepgram Nova-3 (STT), OpenRouter (LLM), Fish Audio (TTS)
Clients: Preact web (toggle-to-talk), Android (Kotlin), iOS (Swift)

For PoC results and exploration details, see `docs/research/`.
```

- [ ] **Step 2: Create `.claude/settings.json`**

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": {
          "toolName": "Write|Edit"
        },
        "hooks": [
          {
            "type": "command",
            "command": "cd /Users/kevinye/Development/sentient && bun run typecheck 2>&1 | tail -5"
          }
        ]
      }
    ],
    "TaskCompleted": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "cd /Users/kevinye/Development/sentient && bun run lint && bun run typecheck && bun run test:unit 2>&1 | tail -20; if [ $? -ne 0 ]; then echo 'BLOCKED: Fix lint/typecheck/test failures before completing.' >&2; exit 2; fi"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md .claude/settings.json
git commit -m "chore: root CLAUDE.md and quality gate hooks"
```

---

## Task 3: Root Rules (`.claude/rules/`)

**Files:**
- Create: `.claude/rules/architecture.md`
- Create: `.claude/rules/clean-code.md`
- Create: `.claude/rules/testing.md`
- Create: `.claude/rules/error-handling.md`
- Create: `.claude/rules/git-workflow.md`

- [ ] **Step 1: Create `.claude/rules/architecture.md`**

```markdown
# Architecture Rules

- Dependencies flow inward only: domain → application → infrastructure.
- One module per file. File name matches primary export.
- Feature-based organization. Group by domain, not by type.
- Define interfaces at boundaries. Concrete implementations behind interfaces.
- Shared types live in `shared/`. NEVER duplicate type definitions across projects.
- When approaching 300 lines, split the file immediately.

> When a rule is unclear, read `agents/docs/architecture-details.md`.
```

- [ ] **Step 2: Create `.claude/rules/clean-code.md`**

```markdown
# Clean Code Rules

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

> When a rule is unclear, read `agents/docs/clean-code-details.md`.
```

- [ ] **Step 3: Create `.claude/rules/testing.md`**

```markdown
# Testing Rules

- Every source file `foo.ts` MUST have `foo.test.ts` in the same directory.
- Write tests BEFORE or ALONGSIDE implementation. Never defer.
- Coverage minimum: 80% statements, 75% branches. CI enforces this.
- One behavior per `it()` block. Name: `it('returns X when Y')`.
- Mock ALL external deps in unit tests. Use factories from `shared/testing/`.
- Unit tests MUST complete in under 100ms each.
- Cover: happy path, error path, edge cases, boundary values.
- Prefer integration tests for multi-component flows over excessive mocks.
- When a test fails, fix the implementation, not the test (unless test is wrong).

> When a rule is unclear, read `agents/docs/testing-details.md`.
```

- [ ] **Step 4: Create `.claude/rules/error-handling.md`**

```markdown
# Error Handling Rules

- Failable operations return a Result type or typed error union. Never throw from business logic.
- Catch errors at system boundaries only (HTTP handlers, WebSocket handlers, CLI entry).
- Error messages MUST include: what failed, why, and actionable context.
- Never swallow errors silently. Log or propagate.
- Use `unknown` for caught errors, narrow with type guards.
- Timeout every external call. No unbounded waits.

> When a rule is unclear, read `agents/docs/error-handling-details.md`.
```

- [ ] **Step 5: Create `.claude/rules/git-workflow.md`**

```markdown
# Git Workflow Rules

- Work on `feature/*` branches only. Never push to `main` or `develop` directly.
- Commit message format: `type(scope): description` (feat, fix, refactor, test, chore, docs).
- One logical change per commit. Atomic commits.
- Before merging to develop: self-review diff, simplify, run `bun run ci`, verify all tests pass.
- Merge feature branch into develop when all checks pass. Delete feature branch after merge.
```

- [ ] **Step 6: Commit**

```bash
git add .claude/rules/
git commit -m "chore: root cross-project rules"
```

---

## Task 4: Root Agent Detail Docs (`agents/docs/`)

**Files:**
- Create: `agents/docs/architecture-details.md`
- Create: `agents/docs/clean-code-details.md`
- Create: `agents/docs/testing-details.md`
- Create: `agents/docs/error-handling-details.md`

- [ ] **Step 1: Create `agents/docs/architecture-details.md`**

```markdown
# Architecture Rules — Details & Examples

## Dependency Direction

Dependencies MUST flow inward. Outer layers know about inner layers, never reverse.

```
Infrastructure (providers, DB, HTTP)
  ↓ depends on
Application (use cases, orchestration)
  ↓ depends on
Domain (types, interfaces, business rules)
```

### Good Example — Gateway Provider

```typescript
// domain/providers.ts — interface (inner layer)
export interface STTProvider {
  transcribe(audio: AsyncIterable<Uint8Array>, signal: AbortSignal): AsyncGenerator<Transcript>;
}

// infrastructure/deepgram.ts — implementation (outer layer)
import type { STTProvider } from "../domain/providers.ts";

export function createDeepgramProvider(config: DeepgramConfig): STTProvider {
  return { transcribe: async function* (audio, signal) { /* ... */ } };
}
```

### Bad Example — Domain importing infrastructure

```typescript
// domain/session.ts — WRONG: domain depends on infrastructure
import { DeepgramProvider } from "../infrastructure/deepgram.ts"; // VIOLATION
```

## Feature-Based Organization

Group by what the code does, not what kind of file it is.

### Good

```
gateway/src/
  auth/
    verify-token.ts
    verify-token.test.ts
    session.ts
    session.test.ts
  pipeline/
    processor.ts
    processor.test.ts
    frame.ts
    frame.test.ts
```

### Bad

```
gateway/src/
  controllers/     # grouped by type — hard to navigate
  services/
  models/
  tests/           # tests separated from source — hard to find
```

## File Size Limits

When a file approaches 250 lines, proactively split it. A 300-line file is a bug.

Split strategies:
- Extract a helper function into its own file
- Split a type file into one-type-per-file
- Move test utilities into shared/testing/
```

- [ ] **Step 2: Create `agents/docs/clean-code-details.md`**

```markdown
# Clean Code Rules — Details & Examples

## Early Returns

Flatten nested conditionals with early returns.

### Good

```typescript
export function validateToken(token: string): Result<Claims> {
  if (!token) return { ok: false, error: "Token is empty" };
  if (!token.startsWith("v4.local.")) return { ok: false, error: "Invalid token prefix" };

  const claims = decrypt(token);
  if (isExpired(claims)) return { ok: false, error: "Token expired" };

  return { ok: true, value: claims };
}
```

### Bad — Deeply nested

```typescript
export function validateToken(token: string): Result<Claims> {
  if (token) {
    if (token.startsWith("v4.local.")) {
      const claims = decrypt(token);
      if (!isExpired(claims)) {
        return { ok: true, value: claims };
      } else {
        return { ok: false, error: "Token expired" };
      }
    } else {
      return { ok: false, error: "Invalid token prefix" };
    }
  } else {
    return { ok: false, error: "Token is empty" };
  }
}
```

## Named Constants

```typescript
// Good
const MAX_SESSIONS = 10;
const AUTH_TIMEOUT_MS = 5_000;
const KEEPALIVE_INTERVAL_MS = 30_000;

if (sessions.size >= MAX_SESSIONS) { /* ... */ }

// Bad
if (sessions.size >= 10) { /* ... */ }
```

## Pure Functions

A pure function has no side effects and returns the same output for the same input.

```typescript
// Good — pure
export function buildContext(persona: string, memory: string, history: Message[]): string {
  return [persona, memory, ...history.map(formatMessage)].join("\n\n");
}

// Bad — impure (mutates input)
export function addToHistory(history: Message[], message: Message): void {
  history.push(message); // mutating parameter
}

// Good — immutable update
export function addToHistory(history: Message[], message: Message): Message[] {
  return [...history, message];
}
```
```

- [ ] **Step 3: Create `agents/docs/testing-details.md`**

```markdown
# Testing Rules — Details & Examples

## Test File Structure

```typescript
// src/auth/verify-token.test.ts
import { describe, it, expect } from "vitest";
import { verifyToken } from "./verify-token.ts";
import { createAuthToken } from "@sentient/testing";

describe("verifyToken", () => {
  it("returns claims for valid token", () => {
    const token = createAuthToken({ role: "adult", userId: "user-1" });
    const result = verifyToken(token, TEST_SECRET);

    expect(result.ok).toBe(true);
    expect(result.value.role).toBe("adult");
  });

  it("returns error for expired token", () => {
    const token = createAuthToken({ expiresIn: -1 });
    const result = verifyToken(token, TEST_SECRET);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("expired");
  });

  it("returns error for empty string", () => {
    const result = verifyToken("", TEST_SECRET);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("empty");
  });
});
```

## Test Naming

Pattern: `it('returns/throws/emits X when Y')`

```typescript
// Good — describes behavior and condition
it("returns empty array when input is empty")
it("throws timeout error when provider exceeds 5 seconds")
it("emits transcript.final when speech ends")

// Bad — vague or describes implementation
it("works correctly")
it("tests the auth function")
it("calls decrypt and checks expiry")
```

## Mock Factories (from shared/testing/)

```typescript
import { createMockWebSocket, createMockSession, createAuthToken } from "@sentient/testing";

// Mock WebSocket with controllable behavior
const ws = createMockWebSocket();
ws.simulateMessage(JSON.stringify({ type: "text.input", text: "hello" }));
expect(ws.sentMessages).toHaveLength(1);

// Mock session with defaults that can be overridden
const session = createMockSession({ userId: "user-1", role: "adult" });

// Generate valid PASETO tokens for tests
const token = createAuthToken({ role: "child", deviceId: "ipad-1" });
```

## Coverage Requirements

Enforced in `vitest.config.ts`:
- Statements: 80%
- Branches: 75%
- Functions: 80%
- Lines: 80%

CI blocks merges that drop below thresholds.
```

- [ ] **Step 4: Create `agents/docs/error-handling-details.md`**

```markdown
# Error Handling Rules — Details & Examples

## Result Type Pattern

Use a discriminated union for failable operations instead of try/catch.

```typescript
// shared/protocol/src/result.ts
export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };
```

### Usage

```typescript
export function parseMessage(raw: string): Result<ClientMessage> {
  try {
    const parsed = JSON.parse(raw);
    const validated = clientMessageSchema.safeParse(parsed);
    if (!validated.success) {
      return { ok: false, error: `Invalid message: ${validated.error.message}` };
    }
    return { ok: true, value: validated.data };
  } catch {
    return { ok: false, error: "Malformed JSON" };
  }
}

// Consumer
const result = parseMessage(raw);
if (!result.ok) {
  logger.warn("Bad message", { error: result.error, raw });
  return;
}
// result.value is typed correctly here
processMessage(result.value);
```

## Boundary Error Handling

Catch and translate errors only at system boundaries:

```typescript
// Good — boundary handler catches and logs
server.ws("/ws", {
  message(ws, raw) {
    try {
      handleMessage(ws, raw);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error("WebSocket handler failed", { error: message });
      ws.send(JSON.stringify({ type: "error", code: "internal", message }));
    }
  },
});

// Good — business logic returns Result, never throws
function handleMessage(ws: WebSocket, raw: string): Result<void> {
  const parsed = parseMessage(raw);
  if (!parsed.ok) return parsed;
  // ...
}
```

## Timeouts

Every external call MUST have a timeout:

```typescript
const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
```
```

- [ ] **Step 5: Commit**

```bash
git add agents/
git commit -m "docs: root agent detail docs with examples"
```

---

## Task 5: Gateway Package Scaffold

**Files:**
- Create: `gateway/package.json`
- Create: `gateway/tsconfig.json`
- Create: `gateway/vitest.config.ts`
- Create: `gateway/src/index.ts`
- Create: `gateway/src/index.test.ts`

- [ ] **Step 1: Create `gateway/package.json`**

```json
{
  "name": "@sentient/gateway",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --hot src/index.ts",
    "build": "bun build src/index.ts --outdir dist --target bun",
    "start": "bun dist/index.js",
    "test": "vitest run",
    "test:unit": "vitest run --project unit",
    "test:int": "vitest run --project integration",
    "test:watch": "vitest watch",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@sentient/protocol": "workspace:*",
    "@sentient/config": "workspace:*",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@sentient/testing": "workspace:*",
    "bun-types": "latest",
    "vitest": "^3.1.0"
  }
}
```

- [ ] **Step 2: Create `gateway/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "paths": {
      "@sentient/protocol": ["../shared/protocol/src"],
      "@sentient/config": ["../shared/config/src"],
      "@sentient/testing": ["../shared/testing/src"]
    }
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `gateway/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
```

- [ ] **Step 4: Create `gateway/src/index.ts`** — minimal health endpoint

```typescript
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? "3000");
const GATEWAY_HOST = process.env.GATEWAY_HOST ?? "0.0.0.0";

const server = Bun.serve({
  port: GATEWAY_PORT,
  hostname: GATEWAY_HOST,
  fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Gateway listening on ${server.hostname}:${server.port}`);

export { server };
```

- [ ] **Step 5: Write reference test `gateway/src/index.test.ts`**

```typescript
import { describe, it, expect, afterAll } from "vitest";
import { server } from "./index.ts";

const BASE_URL = `http://${server.hostname}:${server.port}`;

afterAll(() => {
  server.stop();
});

describe("health endpoint", () => {
  it("returns ok status as JSON", async () => {
    const response = await fetch(`${BASE_URL}/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });

  it("returns 404 for unknown paths", async () => {
    const response = await fetch(`${BASE_URL}/unknown`);

    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd gateway && bun test`

Expected: 2 tests pass.

- [ ] **Step 7: Commit**

```bash
git add gateway/package.json gateway/tsconfig.json gateway/vitest.config.ts gateway/src/
git commit -m "feat(gateway): scaffold with health endpoint and reference test"
```

---

## Task 6: Gateway Rules and Agent Docs

**Files:**
- Create: `gateway/CLAUDE.md`
- Create: `gateway/.claude/rules/bun-typescript.md`
- Create: `gateway/.claude/rules/provider-integration.md`
- Create: `gateway/.claude/rules/pipeline.md`
- Create: `gateway/agents/docs/bun-typescript-details.md`
- Create: `gateway/agents/docs/provider-integration-details.md`
- Create: `gateway/agents/docs/pipeline-details.md`

- [ ] **Step 1: Create `gateway/CLAUDE.md`**

```markdown
# Gateway

Bun/TypeScript voice gateway. Orchestrates STT→LLM→TTS streaming pipeline on Raspberry Pi 5.

## MANDATORY — Read Rules First

Before modifying any code in this project, you MUST read ALL files in `.claude/rules/` in this directory AND the root `.claude/rules/`. When a rule is unclear, read the corresponding file in `agents/docs/`.

## Stack

- Runtime: Bun
- Language: TypeScript (strict mode)
- Test runner: Vitest
- WebSocket: Bun built-in
- Providers: Deepgram (STT), OpenRouter (LLM), Fish Audio (TTS)
- Resilience: cockatiel (circuit breaker)
- Validation: zod

## Commands

    bun run dev       — Start gateway with hot reload
    bun run test      — Run all gateway tests
    bun run build     — Production build
    bun run typecheck — TypeScript strict check
```

- [ ] **Step 2: Create `gateway/.claude/rules/bun-typescript.md`**

```markdown
# Bun TypeScript Rules

- Use `unknown` for all external input. Validate with zod schemas.
- Explicit return types on all exported functions.
- Use string literal unions over enums.
- Use `interface` for extendable shapes, `type` for unions and utilities.
- AsyncGenerator for all streaming operations. Always call `.return()` on cleanup.
- AbortSignal threads through every async operation for cancel propagation.
- Prefer `Bun.serve()` over Express/Hono. Use built-in WebSocket server.
- Use `structuredClone()` for deep copies, spread for shallow.

> When a rule is unclear, read `agents/docs/bun-typescript-details.md`.
```

- [ ] **Step 3: Create `gateway/.claude/rules/provider-integration.md`**

```markdown
# Provider Integration Rules

- All providers implement Protocol interfaces (structural typing, not inheritance).
- Streaming providers return `AsyncGenerator<T>`. Consumers use `for await...of`.
- Every provider call MUST accept an `AbortSignal` parameter.
- Wrap provider connections with circuit breaker (cockatiel): 5 failures → open, 30s cooldown.
- Timeout every external call: STT keepalive 10s, LLM response 30s, TTS chunk 10s.
- Raw WebSocket for Deepgram and Fish Audio. OpenAI SDK for OpenRouter.
- Configuration via YAML file with `${ENV_VAR}` resolution.

> When a rule is unclear, read `agents/docs/provider-integration-details.md`.
```

- [ ] **Step 4: Create `gateway/.claude/rules/pipeline.md`**

```markdown
# Pipeline Rules

- Three-tier frame hierarchy: SystemFrame (priority 1) > DataFrame (priority 2) > ControlFrame (priority 2).
- InterruptionFrame is a SystemFrame — always processed before data frames.
- Each processor has an async input queue and processes frames sequentially.
- Processors MUST be stateless between sessions. Session state lives in session context.
- SentenceAggregator sits between LLM and TTS — buffers tokens, emits complete sentences.
- UninterruptibleFrame mixin: tool results survive barge-in for next-turn reference.
- Pipeline wiring is explicit: processor A output → processor B input.

> When a rule is unclear, read `agents/docs/pipeline-details.md`.
```

- [ ] **Step 5: Create gateway agent detail docs**

Create `gateway/agents/docs/bun-typescript-details.md`:

```markdown
# Bun TypeScript — Details & Examples

## AsyncGenerator Pattern

All streaming operations (STT, LLM, TTS) use AsyncGenerator for composability.

```typescript
async function* streamLLMResponse(
  prompt: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const response = await openai.chat.completions.create({
    model: "anthropic/claude-haiku",
    messages: [{ role: "user", content: prompt }],
    stream: true,
  });

  for await (const chunk of response) {
    if (signal.aborted) return;
    const content = chunk.choices[0]?.delta?.content;
    if (content) yield content;
  }
}

// Consumer — always clean up
const generator = streamLLMResponse(prompt, controller.signal);
try {
  for await (const token of generator) {
    process(token);
  }
} finally {
  await generator.return(undefined); // mandatory cleanup
}
```

## AbortSignal Threading

Every async function that calls an external service MUST accept AbortSignal:

```typescript
export async function transcribe(
  audio: AsyncIterable<Uint8Array>,
  signal: AbortSignal,  // REQUIRED
): AsyncGenerator<Transcript> { /* ... */ }
```

## Zod Validation at Boundaries

```typescript
import { z } from "zod";

const configSchema = z.object({
  port: z.number().int().min(1).max(65535),
  host: z.string().min(1),
});

// Validate at boundary
const config = configSchema.parse(rawConfig); // throws ZodError
// or
const result = configSchema.safeParse(rawConfig); // returns { success, data/error }
```
```

Create `gateway/agents/docs/provider-integration-details.md`:

```markdown
# Provider Integration — Details & Examples

## Protocol Interface Pattern

Define provider contracts as TypeScript interfaces (structural typing):

```typescript
// domain/stt-provider.ts
export interface STTProvider {
  connect(config: STTConfig, signal: AbortSignal): Promise<void>;
  transcribe(audio: AsyncIterable<Uint8Array>, signal: AbortSignal): AsyncGenerator<TranscriptEvent>;
  disconnect(): Promise<void>;
}
```

Implementations satisfy the interface structurally — no `implements` keyword needed:

```typescript
// infrastructure/deepgram.ts
export function createDeepgramProvider(apiKey: string): STTProvider {
  return {
    async connect(config, signal) { /* ... */ },
    async *transcribe(audio, signal) { /* ... */ },
    async disconnect() { /* ... */ },
  };
}
```

## Circuit Breaker

```typescript
import { CircuitBreakerPolicy, ConsecutiveBreaker } from "cockatiel";

const breaker = new CircuitBreakerPolicy(
  new ConsecutiveBreaker(5),  // open after 5 consecutive failures
  { halfOpenAfter: 30_000 },  // probe after 30 seconds
);

const result = await breaker.execute(() => provider.transcribe(audio, signal));
```

## Config with Env Resolution

```yaml
# config.yaml
stt:
  provider: deepgram
  api_key: ${DEEPGRAM_API_KEY}
  model: nova-3
  endpointing_ms: 300
```

The config loader resolves `${VAR}` from environment at load time.
```

Create `gateway/agents/docs/pipeline-details.md`:

```markdown
# Pipeline — Details & Examples

## Frame Hierarchy

```typescript
// Three priority tiers
type SystemFrame = InterruptionFrame | ConfigFrame;  // Priority 1 — always processed first
type DataFrame = AudioFrame | TextFrame | TranscriptFrame;  // Priority 2 — ordered, cancellable
type ControlFrame = StartFrame | StopFrame;  // Priority 2 — ordered, cancellable

type Frame = SystemFrame | DataFrame | ControlFrame;
```

## Processor Pattern

Each processor is a function that takes an input queue and produces output:

```typescript
export interface Processor {
  process(frame: DataFrame, context: SessionContext): Promise<DataFrame[]>;
  handleSystem(frame: SystemFrame, context: SessionContext): Promise<void>;
}
```

When an InterruptionFrame arrives, the pipeline:
1. Delivers it to all processors via `handleSystem()` (priority queue)
2. Clears pending DataFrames from all queues
3. Processors reset internal state (e.g., SentenceAggregator clears buffer)

## Streaming Overlap

```
LLM tokens:  "The weather" "in Tokyo" "is sunny" "today."
                                        ↓
SentenceAggregator:    "The weather in Tokyo is sunny today."
                                        ↓
TTS starts:            [audio for first sentence]
                       ↑ TTS starts HERE while LLM may still be generating
```

50-70% perceived latency reduction because user hears first sentence before LLM finishes.
```

- [ ] **Step 6: Commit**

```bash
git add gateway/CLAUDE.md gateway/.claude/ gateway/agents/
git commit -m "docs(gateway): rules and agent detail docs"
```

---

## Task 7: Web Package Scaffold

**Files:**
- Create: `web/package.json`
- Create: `web/tsconfig.json`
- Create: `web/vite.config.ts`
- Create: `web/vitest.config.ts`
- Create: `web/index.html`
- Create: `web/src/main.tsx`
- Create: `web/src/app.tsx`
- Create: `web/src/app.test.tsx`

- [ ] **Step 1: Create `web/package.json`**

```json
{
  "name": "@sentient/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:unit": "vitest run",
    "test:int": "echo 'No integration tests yet'",
    "test:watch": "vitest watch",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "preact": "^10.25.0"
  },
  "devDependencies": {
    "@preact/preset-vite": "^2.9.0",
    "@testing-library/preact": "^3.2.0",
    "bun-types": "latest",
    "jsdom": "^26.0.0",
    "vite": "^6.2.0",
    "vitest": "^3.1.0"
  }
}
```

- [ ] **Step 2: Create `web/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
    "outDir": "dist",
    "rootDir": "src",
    "paths": {
      "@sentient/protocol": ["../shared/protocol/src"]
    }
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

- [ ] **Step 3: Create `web/vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: "dist",
  },
});
```

- [ ] **Step 4: Create `web/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/main.tsx"],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
```

- [ ] **Step 5: Create `web/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Sentient</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `web/src/main.tsx`**

```tsx
import { render } from "preact";
import { App } from "./app.tsx";

render(<App />, document.getElementById("app")!);
```

- [ ] **Step 7: Create `web/src/app.tsx`**

```tsx
export function App() {
  return (
    <main>
      <h1>Sentient</h1>
      <p>Voice assistant — coming soon.</p>
    </main>
  );
}
```

- [ ] **Step 8: Create reference test `web/src/app.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/preact";
import { App } from "./app.tsx";

describe("App", () => {
  it("renders heading", () => {
    const { getByText } = render(<App />);
    expect(getByText("Sentient")).toBeTruthy();
  });
});
```

- [ ] **Step 9: Run test**

Run: `cd web && bun test`

Expected: 1 test passes.

- [ ] **Step 10: Commit**

```bash
git add web/
git commit -m "feat(web): Preact scaffold with reference test"
```

---

## Task 8: Web Rules and Agent Docs

**Files:**
- Create: `web/CLAUDE.md`
- Create: `web/.claude/rules/preact-components.md`
- Create: `web/.claude/rules/state-management.md`
- Create: `web/.claude/rules/audio.md`
- Create: `web/agents/docs/preact-components-details.md`
- Create: `web/agents/docs/state-management-details.md`
- Create: `web/agents/docs/audio-details.md`

- [ ] **Step 1: Create `web/CLAUDE.md`**

```markdown
# Web Client

Preact web client for Sentient voice assistant. Served as static files from the gateway.

## MANDATORY — Read Rules First

Before modifying any code in this project, you MUST read ALL files in `.claude/rules/` in this directory AND the root `.claude/rules/`. When a rule is unclear, read the corresponding file in `agents/docs/`.

## Stack

- Framework: Preact + Vite
- Language: TypeScript (strict mode)
- Test runner: Vitest + Testing Library
- Audio: MediaRecorder (capture), AudioWorklet (playback)

## Commands

    bun run dev       — Vite dev server with HMR
    bun run build     — Production build
    bun run test      — Run all web tests
    bun run typecheck — TypeScript strict check
```

- [ ] **Step 2: Create `web/.claude/rules/preact-components.md`**

```markdown
# Preact Component Rules

- One component per file. File name matches component name.
- Props type defined and exported in same file as component.
- Container components own data loading. Presentational components receive props and are pure.
- Use signals for local state. Use context sparingly (auth, theme only).
- Derive computed values. Never store redundant state.
- Semantic HTML first. No generic div stacks.
- CSS custom properties for all design tokens (colors, spacing, type scale).
- Suffix screens with `Screen`, reusable components with no suffix.

> When a rule is unclear, read `agents/docs/preact-components-details.md`.
```

- [ ] **Step 3: Create `web/.claude/rules/state-management.md`**

```markdown
# State Management Rules

- Server state (data from gateway): managed by WebSocket hook, never duplicated.
- Client state (UI state): signals or useState. Keep local to component when possible.
- URL state (shareable): use URL params for filters, tabs, search.
- Form state: controlled inputs with local state.
- NEVER duplicate server state into client stores.
- Derive computed values from source state. Never store computed values.

> When a rule is unclear, read `agents/docs/state-management-details.md`.
```

- [ ] **Step 4: Create `web/.claude/rules/audio.md`**

```markdown
# Audio Rules

- MediaRecorder for audio capture (Opus in WebM container, 100ms timeslice).
- AudioWorklet for TTS playback (ring buffer, 96KB, drop-oldest overflow).
- Safari: lazy-load opus-media-recorder WASM polyfill (~300KB).
- COOP/COEP headers required for SharedArrayBuffer (AudioWorklet).
- Toggle-to-talk: click once to start recording, click again to stop.
- Barge-in: stop playback, clear ring buffer, send barge_in message.
- Handle mic permission denial gracefully (text-only fallback).

> When a rule is unclear, read `agents/docs/audio-details.md`.
```

- [ ] **Step 5: Create web agent detail docs**

Create `web/agents/docs/preact-components-details.md`:

```markdown
# Preact Components — Details & Examples

## Component File Pattern

```tsx
// src/components/connection-status.tsx

export interface ConnectionStatusProps {
  state: "connecting" | "connected" | "disconnected";
}

export function ConnectionStatus({ state }: ConnectionStatusProps) {
  const label = {
    connecting: "Connecting…",
    connected: "Connected",
    disconnected: "Disconnected",
  }[state];

  return <span class={`status status--${state}`}>{label}</span>;
}
```

## Container vs Presentational

```tsx
// Container — owns data, passes to presentational
export function ChatScreen() {
  const { messages, send } = useWebSocket();
  return <MessageList messages={messages} onSend={send} />;
}

// Presentational — pure, receives props
export function MessageList({ messages, onSend }: MessageListProps) {
  return (
    <section>
      {messages.map((m) => <MessageBubble key={m.id} message={m} />)}
      <InputBar onSend={onSend} />
    </section>
  );
}
```
```

Create `web/agents/docs/state-management-details.md`:

```markdown
# State Management — Details & Examples

## Signal Pattern (Preact Signals)

```tsx
import { signal, computed } from "@preact/signals";

const messages = signal<Message[]>([]);
const unreadCount = computed(() => messages.value.filter(m => !m.read).length);

// Update immutably
messages.value = [...messages.value, newMessage];
```

## Never Duplicate Server State

```tsx
// BAD — duplicating WebSocket data into local state
const [messages, setMessages] = useState<Message[]>([]);
ws.onmessage = (e) => setMessages(prev => [...prev, parse(e.data)]);

// GOOD — single source of truth from hook
const { messages } = useWebSocket();
```
```

Create `web/agents/docs/audio-details.md`:

```markdown
# Audio — Details & Examples

## Toggle-to-Talk State Machine

```
idle → (click) → recording → (click) → processing → idle
                     ↓
              (error/timeout)
                     ↓
                   idle
```

## MediaRecorder Capture

```typescript
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const recorder = new MediaRecorder(stream, {
  mimeType: "audio/webm;codecs=opus",
});

recorder.ondataavailable = (e) => {
  if (e.data.size > 0) ws.send(e.data); // binary frame
};

recorder.start(100); // 100ms timeslice
```

## AudioWorklet Ring Buffer

The ring buffer holds ~2 seconds of audio (96KB at 48kHz).
On overflow, oldest samples are dropped (acceptable for real-time audio).
On barge-in, the buffer is cleared in under one process() cycle (~2.67ms at 128 samples).
```

- [ ] **Step 6: Commit**

```bash
git add web/CLAUDE.md web/.claude/ web/agents/
git commit -m "docs(web): rules and agent detail docs"
```

---

## Task 9: Android and iOS Stubs

**Files:**
- Create: `android/CLAUDE.md` + `.claude/rules/` (port from dotJournal) + `agents/docs/`
- Create: `ios/CLAUDE.md` + `.claude/rules/` (port from dotJournal) + `agents/docs/`

- [ ] **Step 1: Create `android/CLAUDE.md`**

```markdown
# Android Client

Kotlin/Compose mobile client for Sentient voice assistant. Deferred to Phase 6.

## MANDATORY — Read Rules First

Before modifying any code in this project, you MUST read ALL files in `.claude/rules/` in this directory AND the root `.claude/rules/`. When a rule is unclear, read the corresponding file in `agents/docs/`.

## Stack

- Language: Kotlin
- UI: Jetpack Compose
- DI: Koin
- Networking: OkHttp WebSocket
- Wake word: Porcupine (Picovoice)
- Audio: AudioRecord + ring buffer
- Build: Gradle

## Status

Not yet implemented. Rules and architecture documented for when Phase 6 begins.
```

- [ ] **Step 2: Create android rules (port from dotJournal)**

Create `android/.claude/rules/android-architecture.md`:

```markdown
# Android Architecture Rules

- Follow layered architecture: UI → ViewModel → UseCase → Repository → DataSource.
- Dependencies flow inward only — outer layers depend on inner, never reverse.
- Domain layer (`domain/`) has zero dependencies on `data/` or `ui/`.
- Use Koin for all dependency injection.
- Never manually instantiate ViewModels or Repositories in UI code.
- ViewModels are obtained via `koinViewModel()` in Composables.

> When a rule is unclear, read `agents/docs/android-architecture-details.md`.
```

Create `android/.claude/rules/android-viewmodel.md`:

```markdown
# Android ViewModel Rules

- Define a single `data class {Feature}UiState` per ViewModel.
- Expose state as `StateFlow` via `_uiState.asStateFlow()`.
- Never expose `MutableStateFlow` publicly.
- Mutate state only via `_uiState.value = _uiState.value.copy(...)`.
- Launch async work with `viewModelScope.launch`.
- Keep ViewModel methods non-suspend.
- Derive computed values as `val` properties on the UiState data class.
- Cancel in-flight jobs by storing and canceling `Job` references.

> When a rule is unclear, read `agents/docs/android-viewmodel-details.md`.
```

Create `android/.claude/rules/android-compose.md`:

```markdown
# Android Compose Rules

- One Composable per source file. File name matches the Composable name.
- Every `@Composable` function must have a `@Preview` in the same file.
- Hoist state — Composables receive state and callbacks as parameters.
- Reusable components must not reference ViewModels directly.
- Screen-level Composables may take a ViewModel via `koinViewModel()`.
- Use `MaterialTheme.colorScheme` and `MaterialTheme.typography` for all styling.
- No hardcoded colors or font sizes. Use theme and string resources.

> When a rule is unclear, read `agents/docs/android-compose-details.md`.
```

Create `android/.claude/rules/android-testing.md`:

```markdown
# Android Testing Rules

- Tests live in `src/test/java/`.
- Name test files `{Class}Test.kt`.
- Use backtick-quoted test names: `` fun `returns zero for empty dates`() ``.
- Create `Fake{Interface}` implementations for dependencies — no mocking frameworks.
- Use `runTest { }` for coroutine tests.
- Test use cases and ViewModels, not Composables directly.
- Each use case must have a corresponding test file.

> When a rule is unclear, read `agents/docs/android-testing-details.md`.
```

- [ ] **Step 3: Create android agent docs stubs**

Create `android/agents/docs/android-architecture-details.md`:

```markdown
# Android Architecture — Details & Examples

Ported from dotJournal. Full examples will be expanded when Phase 6 begins.

## Layered Architecture

```
UI (Compose Screens, ViewModels)
  ↓ depends on
Domain (UseCases, Repository interfaces, models)
  ↓ depends on (nothing — this is the inner layer)

Data (Repository implementations, API clients, DAOs, Entities)
  ↓ depends on
Domain
```

Domain layer has ZERO imports from `data/` or `ui/`. All dependencies flow inward.
```

Create `android/agents/docs/android-testing-details.md`:

```markdown
# Android Testing — Details & Examples

## Fake Implementation Pattern

Use hand-written fakes instead of mocking frameworks (Mockito, MockK).

```kotlin
class FakeJournalRepository : JournalRepository {
    private val entries = mutableListOf<JournalEntry>()

    override suspend fun getAll(): List<JournalEntry> = entries.toList()
    override suspend fun save(entry: JournalEntry) { entries.add(entry) }
}
```

## Coroutine Test Pattern

```kotlin
@Test
fun `loads entries on init`() = runTest {
    val repo = FakeJournalRepository()
    val viewModel = JournalViewModel(repo)

    advanceUntilIdle()

    assertEquals(expected, viewModel.uiState.value.entries)
}
```
```

- [ ] **Step 4: Create `ios/CLAUDE.md`**

```markdown
# iOS Client

Swift/SwiftUI mobile client for Sentient voice assistant. Deferred to Phase 6.

## MANDATORY — Read Rules First

Before modifying any code in this project, you MUST read ALL files in `.claude/rules/` in this directory AND the root `.claude/rules/`. When a rule is unclear, read the corresponding file in `agents/docs/`.

## Stack

- Language: Swift
- UI: SwiftUI
- Networking: URLSessionWebSocketTask
- Wake word: Porcupine (Picovoice)
- Audio: AVAudioEngine + TPCircularBuffer
- Build: Xcode + xcodegen

## Status

Not yet implemented. Rules and architecture documented for when Phase 6 begins.
```

- [ ] **Step 5: Create iOS rules (port from dotJournal)**

Create `ios/.claude/rules/ios-architecture.md`:

```markdown
# iOS Architecture Rules

- Follow layered architecture: Views → ViewModel → UseCase → Repository → DataSource.
- Dependencies flow inward only — outer layers depend on inner, never reverse.
- `Domain/` has zero imports from `Data/` or `Views/`.
- Use constructor injection with protocol types.
- Use `any` keyword for existential protocol types in parameters.
- ViewModels are passed to Views via init parameters.

> When a rule is unclear, read `agents/docs/ios-architecture-details.md`.
```

Create `ios/.claude/rules/ios-swiftui.md`:

```markdown
# iOS SwiftUI Rules

- One View per source file. File name matches the struct name.
- Every View must have a `#Preview` macro in the same file.
- Screen-level Views receive dependencies via init parameters.
- Reusable components take only data and callbacks — no ViewModel references.
- Use `@Observable` macro on ViewModels. Never use `ObservableObject`/`@Published`.
- Use `@State` for local view state only.
- No hardcoded colors or font sizes. Use design tokens.

> When a rule is unclear, read `agents/docs/ios-swiftui-details.md`.
```

Create `ios/.claude/rules/ios-testing.md`:

```markdown
# iOS Testing Rules

- Name test files `{Class}Tests.swift` (plural).
- Use XCTest framework.
- Name methods `test{Behavior}` in camelCase.
- Create `Fake{Protocol}` implementations for dependencies — no mocking frameworks.
- Use `async` test methods for testing async code.
- Prefer `async` over `XCTestExpectation` when possible.
- Each use case must have a corresponding test file.

> When a rule is unclear, read `agents/docs/ios-testing-details.md`.
```

- [ ] **Step 6: Create iOS agent docs stubs**

Create `ios/agents/docs/ios-architecture-details.md`:

```markdown
# iOS Architecture — Details & Examples

Ported from dotJournal. Full examples will be expanded when Phase 6 begins.

## Layered Architecture

```
Views (SwiftUI Screens, ViewModels)
  ↓ depends on
Domain (UseCases, Repository protocols, models)
  ↓ depends on (nothing — this is the inner layer)

Data (Repository implementations, API clients, SwiftData models)
  ↓ depends on
Domain
```

Domain layer has ZERO imports from `Data/` or `Views/`. All dependencies flow inward.
```

Create `ios/agents/docs/ios-testing-details.md`:

```markdown
# iOS Testing — Details & Examples

## Fake Implementation Pattern

```swift
final class FakeJournalRepository: JournalRepositoryProtocol {
    private var entries: [JournalEntry] = []

    func getAll() -> [JournalEntry] { entries }
    func save(_ entry: JournalEntry) { entries.append(entry) }
}
```

## Async Test Pattern

```swift
func testLoadsEntries() async {
    let repo = FakeJournalRepository()
    let viewModel = JournalViewModel(repository: repo)

    await viewModel.loadEntries()

    XCTAssertEqual(viewModel.entries.count, expectedCount)
}
```
```

- [ ] **Step 7: Commit**

```bash
git add android/ ios/
git commit -m "docs(mobile): Android and iOS stubs with rules ported from dotJournal"
```

---

## Task 10: Shared Protocol Types

**Files:**
- Create: `shared/protocol/package.json`
- Create: `shared/protocol/tsconfig.json`
- Create: `shared/protocol/src/messages.ts`
- Create: `shared/protocol/src/messages.test.ts`
- Create: `shared/protocol/src/frames.ts`
- Create: `shared/protocol/src/frames.test.ts`
- Create: `shared/protocol/src/errors.ts`
- Create: `shared/protocol/src/errors.test.ts`
- Create: `shared/protocol/src/roles.ts`
- Create: `shared/protocol/src/roles.test.ts`
- Create: `shared/protocol/src/index.ts`

- [ ] **Step 1: Create `shared/protocol/package.json`**

```json
{
  "name": "@sentient/protocol",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "test:unit": "vitest run",
    "test:int": "echo 'No integration tests'",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "bun-types": "latest",
    "vitest": "^3.1.0"
  }
}
```

- [ ] **Step 2: Create `shared/protocol/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `shared/protocol/src/roles.ts`**

```typescript
import { z } from "zod";

export const USER_ROLES = ["adult", "child", "guest"] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const userRoleSchema = z.enum(USER_ROLES);

export const IMPACT_TIERS = ["read", "write", "confirm", "admin"] as const;
export type ImpactTier = (typeof IMPACT_TIERS)[number];
export const impactTierSchema = z.enum(IMPACT_TIERS);

/** Which impact tiers each role can use */
export const ROLE_PERMISSIONS: Record<UserRole, readonly ImpactTier[]> = {
  adult: ["read", "write", "confirm", "admin"],
  child: ["read", "write"],
  guest: ["read"],
} as const;

export function canExecute(role: UserRole, tier: ImpactTier): boolean {
  return (ROLE_PERMISSIONS[role] as readonly string[]).includes(tier);
}
```

- [ ] **Step 4: Create `shared/protocol/src/roles.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { canExecute, userRoleSchema } from "./roles.ts";

describe("canExecute", () => {
  it("allows adult all tiers", () => {
    expect(canExecute("adult", "read")).toBe(true);
    expect(canExecute("adult", "admin")).toBe(true);
  });

  it("blocks child from confirm and admin", () => {
    expect(canExecute("child", "read")).toBe(true);
    expect(canExecute("child", "write")).toBe(true);
    expect(canExecute("child", "confirm")).toBe(false);
    expect(canExecute("child", "admin")).toBe(false);
  });

  it("limits guest to read only", () => {
    expect(canExecute("guest", "read")).toBe(true);
    expect(canExecute("guest", "write")).toBe(false);
    expect(canExecute("guest", "confirm")).toBe(false);
    expect(canExecute("guest", "admin")).toBe(false);
  });
});

describe("userRoleSchema", () => {
  it("accepts valid roles", () => {
    expect(userRoleSchema.parse("adult")).toBe("adult");
    expect(userRoleSchema.parse("child")).toBe("child");
    expect(userRoleSchema.parse("guest")).toBe("guest");
  });

  it("rejects invalid roles", () => {
    expect(() => userRoleSchema.parse("superadmin")).toThrow();
    expect(() => userRoleSchema.parse("")).toThrow();
  });
});
```

- [ ] **Step 5: Create `shared/protocol/src/errors.ts`**

```typescript
import { z } from "zod";

export const CLOSE_CODES = {
  AUTH_FAILED: 4001,
  SESSION_LIMIT: 4002,
  TOKEN_EXPIRED: 4003,
  PROTOCOL_ERROR: 4004,
} as const;

export type CloseCode = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES];

export const ERROR_TYPES = [
  "auth_failed",
  "session_limit",
  "token_expired",
  "protocol_error",
  "provider_error",
  "internal_error",
] as const;

export type ErrorType = (typeof ERROR_TYPES)[number];

export const errorMessageSchema = z.object({
  type: z.literal("error"),
  code: z.enum(ERROR_TYPES),
  message: z.string(),
});

export type ErrorMessage = z.infer<typeof errorMessageSchema>;

export function createErrorMessage(code: ErrorType, message: string): ErrorMessage {
  return { type: "error", code, message };
}
```

- [ ] **Step 6: Create `shared/protocol/src/errors.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { CLOSE_CODES, createErrorMessage, errorMessageSchema } from "./errors.ts";

describe("CLOSE_CODES", () => {
  it("has expected values", () => {
    expect(CLOSE_CODES.AUTH_FAILED).toBe(4001);
    expect(CLOSE_CODES.SESSION_LIMIT).toBe(4002);
    expect(CLOSE_CODES.TOKEN_EXPIRED).toBe(4003);
    expect(CLOSE_CODES.PROTOCOL_ERROR).toBe(4004);
  });
});

describe("createErrorMessage", () => {
  it("creates valid error message", () => {
    const msg = createErrorMessage("auth_failed", "Invalid token");

    expect(msg.type).toBe("error");
    expect(msg.code).toBe("auth_failed");
    expect(msg.message).toBe("Invalid token");
  });

  it("passes schema validation", () => {
    const msg = createErrorMessage("provider_error", "Deepgram timeout");
    const result = errorMessageSchema.safeParse(msg);

    expect(result.success).toBe(true);
  });
});

describe("errorMessageSchema", () => {
  it("rejects unknown error codes", () => {
    const result = errorMessageSchema.safeParse({
      type: "error",
      code: "unknown_code",
      message: "test",
    });

    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 7: Create `shared/protocol/src/frames.ts`**

```typescript
export type FramePriority = 1 | 2;

/** SystemFrames — priority 1, always processed first */
export interface InterruptionFrame {
  kind: "system";
  type: "interruption";
  sessionId: string;
  timestamp: number;
}

export interface ConfigFrame {
  kind: "system";
  type: "config";
  key: string;
  value: unknown;
}

export type SystemFrame = InterruptionFrame | ConfigFrame;

/** DataFrames — priority 2, ordered, cancellable */
export interface AudioFrame {
  kind: "data";
  type: "audio";
  data: Uint8Array;
  encoding: "opus" | "pcm16";
  sampleRate: number;
}

export interface TextFrame {
  kind: "data";
  type: "text";
  text: string;
  isFinal: boolean;
}

export interface TranscriptFrame {
  kind: "data";
  type: "transcript";
  text: string;
  isFinal: boolean;
  confidence: number;
}

export type DataFrame = AudioFrame | TextFrame | TranscriptFrame;

/** ControlFrames — priority 2, ordered */
export interface StartFrame {
  kind: "control";
  type: "start";
  sessionId: string;
}

export interface StopFrame {
  kind: "control";
  type: "stop";
  sessionId: string;
  reason: string;
}

export type ControlFrame = StartFrame | StopFrame;

export type Frame = SystemFrame | DataFrame | ControlFrame;

export function framePriority(frame: Frame): FramePriority {
  return frame.kind === "system" ? 1 : 2;
}

export function isSystemFrame(frame: Frame): frame is SystemFrame {
  return frame.kind === "system";
}

export function isDataFrame(frame: Frame): frame is DataFrame {
  return frame.kind === "data";
}
```

- [ ] **Step 8: Create `shared/protocol/src/frames.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { framePriority, isSystemFrame, isDataFrame } from "./frames.ts";
import type { InterruptionFrame, AudioFrame, StartFrame } from "./frames.ts";

describe("framePriority", () => {
  it("returns 1 for system frames", () => {
    const frame: InterruptionFrame = {
      kind: "system",
      type: "interruption",
      sessionId: "s1",
      timestamp: Date.now(),
    };
    expect(framePriority(frame)).toBe(1);
  });

  it("returns 2 for data frames", () => {
    const frame: AudioFrame = {
      kind: "data",
      type: "audio",
      data: new Uint8Array(0),
      encoding: "opus",
      sampleRate: 48000,
    };
    expect(framePriority(frame)).toBe(2);
  });

  it("returns 2 for control frames", () => {
    const frame: StartFrame = {
      kind: "control",
      type: "start",
      sessionId: "s1",
    };
    expect(framePriority(frame)).toBe(2);
  });
});

describe("type guards", () => {
  it("identifies system frames", () => {
    const frame: InterruptionFrame = {
      kind: "system",
      type: "interruption",
      sessionId: "s1",
      timestamp: Date.now(),
    };
    expect(isSystemFrame(frame)).toBe(true);
    expect(isDataFrame(frame)).toBe(false);
  });
});
```

- [ ] **Step 9: Create `shared/protocol/src/messages.ts`**

All 22 WebSocket message types as discriminated unions with zod schemas.

```typescript
import { z } from "zod";
import { userRoleSchema } from "./roles.ts";

// ─── Client → Gateway Messages (10 types) ───

export const authMessageSchema = z.object({
  type: z.literal("auth"),
  token: z.string().min(1),
});

export const sessionStartSchema = z.object({
  type: z.literal("session.start"),
  encoding: z.enum(["opus", "pcm16"]).default("pcm16"),
  pretriggerMs: z.number().int().min(0).max(5000).default(0),
});

export const audioStartSchema = z.object({
  type: z.literal("audio.start"),
});

export const audioEndSchema = z.object({
  type: z.literal("audio.end"),
});

export const textInputSchema = z.object({
  type: z.literal("text.input"),
  text: z.string().min(1).max(10000),
});

export const bargeInSchema = z.object({
  type: z.literal("barge_in"),
});

export const toolConfirmSchema = z.object({
  type: z.literal("tool.confirm"),
  toolCallId: z.string(),
  approved: z.boolean(),
});

export const sessionEndSchema = z.object({
  type: z.literal("session.end"),
});

export const pingSchema = z.object({
  type: z.literal("ping"),
});

export const guestAuthSchema = z.object({
  type: z.literal("guest.auth"),
  pin: z.string().length(6),
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  authMessageSchema,
  sessionStartSchema,
  audioStartSchema,
  audioEndSchema,
  textInputSchema,
  bargeInSchema,
  toolConfirmSchema,
  sessionEndSchema,
  pingSchema,
  guestAuthSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ─── Gateway → Client Messages (12 types) ───

export const authOkSchema = z.object({
  type: z.literal("auth.ok"),
  sessionId: z.string(),
  role: userRoleSchema,
});

export const transcriptPartialSchema = z.object({
  type: z.literal("transcript.partial"),
  text: z.string(),
});

export const transcriptFinalSchema = z.object({
  type: z.literal("transcript.final"),
  text: z.string(),
});

export const responseTextDeltaSchema = z.object({
  type: z.literal("response.text.delta"),
  text: z.string(),
});

export const responseTextDoneSchema = z.object({
  type: z.literal("response.text.done"),
});

export const responseAudioStartSchema = z.object({
  type: z.literal("response.audio.start"),
});

export const responseAudioDoneSchema = z.object({
  type: z.literal("response.audio.done"),
});

export const toolConfirmRequestSchema = z.object({
  type: z.literal("tool.confirm_request"),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.record(z.unknown()),
  description: z.string(),
});

export const bargeInAckSchema = z.object({
  type: z.literal("barge_in.ack"),
});

export const errorSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

export const pongSchema = z.object({
  type: z.literal("pong"),
});

export const sessionExpiredSchema = z.object({
  type: z.literal("session.expired"),
  reason: z.string(),
});

export const gatewayMessageSchema = z.discriminatedUnion("type", [
  authOkSchema,
  transcriptPartialSchema,
  transcriptFinalSchema,
  responseTextDeltaSchema,
  responseTextDoneSchema,
  responseAudioStartSchema,
  responseAudioDoneSchema,
  toolConfirmRequestSchema,
  bargeInAckSchema,
  errorSchema,
  pongSchema,
  sessionExpiredSchema,
]);

export type GatewayMessage = z.infer<typeof gatewayMessageSchema>;
```

- [ ] **Step 10: Create `shared/protocol/src/messages.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { clientMessageSchema, gatewayMessageSchema } from "./messages.ts";

describe("clientMessageSchema", () => {
  it("parses auth message", () => {
    const result = clientMessageSchema.safeParse({
      type: "auth",
      token: "v4.local.abc123",
    });
    expect(result.success).toBe(true);
  });

  it("parses text.input message", () => {
    const result = clientMessageSchema.safeParse({
      type: "text.input",
      text: "What is the weather?",
    });
    expect(result.success).toBe(true);
  });

  it("parses session.start with defaults", () => {
    const result = clientMessageSchema.safeParse({
      type: "session.start",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("session.start");
    }
  });

  it("rejects empty text.input", () => {
    const result = clientMessageSchema.safeParse({
      type: "text.input",
      text: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown message type", () => {
    const result = clientMessageSchema.safeParse({
      type: "unknown.type",
    });
    expect(result.success).toBe(false);
  });

  it("rejects auth with empty token", () => {
    const result = clientMessageSchema.safeParse({
      type: "auth",
      token: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("gatewayMessageSchema", () => {
  it("parses auth.ok message", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "auth.ok",
      sessionId: "session-123",
      role: "adult",
    });
    expect(result.success).toBe(true);
  });

  it("parses response.text.delta message", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "response.text.delta",
      text: "The weather is",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid role in auth.ok", () => {
    const result = gatewayMessageSchema.safeParse({
      type: "auth.ok",
      sessionId: "session-123",
      role: "superadmin",
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 11: Create `shared/protocol/src/index.ts`**

```typescript
export * from "./messages.ts";
export * from "./frames.ts";
export * from "./errors.ts";
export * from "./roles.ts";
```

- [ ] **Step 12: Run tests**

Run: `cd shared/protocol && bun test`

Expected: All tests pass (~20 tests).

- [ ] **Step 13: Commit**

```bash
git add shared/protocol/
git commit -m "feat(protocol): shared message types, frames, roles with zod schemas and tests"
```

---

## Task 11: Shared Config Package

**Files:**
- Create: `shared/config/package.json`
- Create: `shared/config/tsconfig.json`
- Create: `shared/config/src/loader.ts`
- Create: `shared/config/src/loader.test.ts`
- Create: `shared/config/src/schema.ts`
- Create: `shared/config/src/schema.test.ts`
- Create: `shared/config/src/index.ts`

- [ ] **Step 1: Create `shared/config/package.json`**

```json
{
  "name": "@sentient/config",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "test:unit": "vitest run",
    "test:int": "echo 'No integration tests'",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "yaml": "^2.7.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "bun-types": "latest",
    "vitest": "^3.1.0"
  }
}
```

- [ ] **Step 2: Create `shared/config/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `shared/config/src/loader.ts`**

```typescript
import { parse as parseYaml } from "yaml";
import type { ZodSchema } from "zod";

const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

/** Replace ${VAR} placeholders with environment variable values */
export function resolveEnvVars(value: string): string {
  return value.replace(ENV_VAR_PATTERN, (_, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new Error(`Environment variable ${varName} is not set`);
    }
    return envValue;
  });
}

/** Recursively resolve env vars in a parsed YAML object */
export function resolveEnvVarsDeep(obj: unknown): unknown {
  if (typeof obj === "string") return resolveEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(resolveEnvVarsDeep);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVarsDeep(value);
    }
    return result;
  }
  return obj;
}

/** Load and validate a YAML config file */
export function loadConfig<T>(yamlContent: string, schema: ZodSchema<T>): T {
  const raw = parseYaml(yamlContent);
  const resolved = resolveEnvVarsDeep(raw);
  return schema.parse(resolved);
}
```

- [ ] **Step 4: Create `shared/config/src/loader.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveEnvVars, resolveEnvVarsDeep, loadConfig } from "./loader.ts";
import { z } from "zod";

describe("resolveEnvVars", () => {
  beforeEach(() => {
    process.env.TEST_KEY = "test_value";
    process.env.TEST_PORT = "3000";
  });

  afterEach(() => {
    delete process.env.TEST_KEY;
    delete process.env.TEST_PORT;
  });

  it("replaces single env var", () => {
    expect(resolveEnvVars("${TEST_KEY}")).toBe("test_value");
  });

  it("replaces multiple env vars in one string", () => {
    expect(resolveEnvVars("${TEST_KEY}:${TEST_PORT}")).toBe("test_value:3000");
  });

  it("returns string unchanged when no vars present", () => {
    expect(resolveEnvVars("plain string")).toBe("plain string");
  });

  it("throws for undefined env var", () => {
    expect(() => resolveEnvVars("${UNDEFINED_VAR}")).toThrow(
      "Environment variable UNDEFINED_VAR is not set",
    );
  });
});

describe("resolveEnvVarsDeep", () => {
  beforeEach(() => {
    process.env.API_KEY = "sk-test";
  });

  afterEach(() => {
    delete process.env.API_KEY;
  });

  it("resolves nested objects", () => {
    const input = { provider: { api_key: "${API_KEY}", model: "nova-3" } };
    const result = resolveEnvVarsDeep(input) as Record<string, Record<string, string>>;

    expect(result.provider.api_key).toBe("sk-test");
    expect(result.provider.model).toBe("nova-3");
  });

  it("resolves arrays", () => {
    const input = ["${API_KEY}", "plain"];
    const result = resolveEnvVarsDeep(input);

    expect(result).toEqual(["sk-test", "plain"]);
  });

  it("passes through numbers and booleans", () => {
    expect(resolveEnvVarsDeep(42)).toBe(42);
    expect(resolveEnvVarsDeep(true)).toBe(true);
    expect(resolveEnvVarsDeep(null)).toBe(null);
  });
});

describe("loadConfig", () => {
  beforeEach(() => {
    process.env.TEST_API_KEY = "sk-live";
  });

  afterEach(() => {
    delete process.env.TEST_API_KEY;
  });

  it("loads and validates YAML with env vars", () => {
    const yaml = `
port: 3000
api_key: \${TEST_API_KEY}
`;
    const schema = z.object({
      port: z.number(),
      api_key: z.string(),
    });

    const config = loadConfig(yaml, schema);

    expect(config.port).toBe(3000);
    expect(config.api_key).toBe("sk-live");
  });

  it("throws on schema validation failure", () => {
    const yaml = "port: not_a_number";
    const schema = z.object({ port: z.number() });

    expect(() => loadConfig(yaml, schema)).toThrow();
  });
});
```

- [ ] **Step 5: Create `shared/config/src/schema.ts`**

```typescript
import { z } from "zod";

export const sttConfigSchema = z.object({
  provider: z.literal("deepgram"),
  api_key: z.string().min(1),
  model: z.string().default("nova-3"),
  endpointing_ms: z.number().int().min(0).default(300),
  utterance_end_ms: z.number().int().min(0).default(1000),
});

export type STTConfig = z.infer<typeof sttConfigSchema>;

export const llmConfigSchema = z.object({
  provider: z.literal("openrouter"),
  api_key: z.string().min(1),
  chat_model: z.string().default("anthropic/claude-haiku"),
  tool_model: z.string().default("anthropic/claude-sonnet"),
  classifier_model: z.string().default("google/gemini-flash-lite"),
});

export type LLMConfig = z.infer<typeof llmConfigSchema>;

export const ttsConfigSchema = z.object({
  provider: z.literal("fish-audio"),
  api_key: z.string().min(1),
  voice_id: z.string().default("default"),
  latency: z.enum(["normal", "balanced"]).default("balanced"),
});

export type TTSConfig = z.infer<typeof ttsConfigSchema>;

export const gatewayConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(3000),
  host: z.string().default("0.0.0.0"),
  max_sessions: z.number().int().min(1).max(100).default(10),
  auth_timeout_ms: z.number().int().min(1000).default(5000),
  session_persist_ms: z.number().int().min(0).default(120000),
  stt: sttConfigSchema,
  llm: llmConfigSchema,
  tts: ttsConfigSchema,
});

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
```

- [ ] **Step 6: Create `shared/config/src/schema.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { gatewayConfigSchema } from "./schema.ts";

describe("gatewayConfigSchema", () => {
  const validConfig = {
    port: 3000,
    host: "0.0.0.0",
    max_sessions: 10,
    auth_timeout_ms: 5000,
    session_persist_ms: 120000,
    stt: { provider: "deepgram", api_key: "sk-test", model: "nova-3", endpointing_ms: 300, utterance_end_ms: 1000 },
    llm: { provider: "openrouter", api_key: "sk-test" },
    tts: { provider: "fish-audio", api_key: "sk-test" },
  };

  it("accepts valid config", () => {
    const result = gatewayConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });

  it("applies defaults for LLM models", () => {
    const result = gatewayConfigSchema.parse(validConfig);
    expect(result.llm.chat_model).toBe("anthropic/claude-haiku");
    expect(result.llm.tool_model).toBe("anthropic/claude-sonnet");
  });

  it("rejects missing STT api_key", () => {
    const invalid = { ...validConfig, stt: { provider: "deepgram", api_key: "" } };
    const result = gatewayConfigSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects port out of range", () => {
    const invalid = { ...validConfig, port: 99999 };
    const result = gatewayConfigSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 7: Create `shared/config/src/index.ts`**

```typescript
export { loadConfig, resolveEnvVars, resolveEnvVarsDeep } from "./loader.ts";
export * from "./schema.ts";
```

- [ ] **Step 8: Run tests**

Run: `cd shared/config && bun test`

Expected: All tests pass (~12 tests).

- [ ] **Step 9: Commit**

```bash
git add shared/config/
git commit -m "feat(config): YAML config loader with env var resolution and gateway schema"
```

---

## Task 12: Shared Testing Package

**Files:**
- Create: `shared/testing/package.json`
- Create: `shared/testing/tsconfig.json`
- Create: `shared/testing/src/mock-websocket.ts`
- Create: `shared/testing/src/mock-session.ts`
- Create: `shared/testing/src/mock-provider.ts`
- Create: `shared/testing/src/mock-auth.ts`
- Create: `shared/testing/src/index.ts`

- [ ] **Step 1: Create `shared/testing/package.json`**

```json
{
  "name": "@sentient/testing",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@sentient/protocol": "workspace:*"
  },
  "devDependencies": {
    "bun-types": "latest"
  }
}
```

- [ ] **Step 2: Create `shared/testing/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "paths": {
      "@sentient/protocol": ["../protocol/src"]
    }
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `shared/testing/src/mock-websocket.ts`**

```typescript
/** Mock WebSocket for testing message handling */
export interface MockWebSocket {
  sentMessages: (string | ArrayBuffer)[];
  isClosed: boolean;
  closeCode?: number;
  closeReason?: string;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  simulateMessage(data: string | ArrayBuffer): void;
  simulateClose(code?: number, reason?: string): void;
  onMessage?: (data: string | ArrayBuffer) => void;
  onClose?: (code: number, reason: string) => void;
}

export function createMockWebSocket(): MockWebSocket {
  const ws: MockWebSocket = {
    sentMessages: [],
    isClosed: false,

    send(data) {
      if (ws.isClosed) throw new Error("WebSocket is closed");
      ws.sentMessages.push(data);
    },

    close(code = 1000, reason = "") {
      ws.isClosed = true;
      ws.closeCode = code;
      ws.closeReason = reason;
    },

    simulateMessage(data) {
      ws.onMessage?.(data);
    },

    simulateClose(code = 1000, reason = "") {
      ws.isClosed = true;
      ws.onClose?.(code, reason);
    },
  };

  return ws;
}
```

- [ ] **Step 4: Create `shared/testing/src/mock-session.ts`**

```typescript
import type { UserRole } from "@sentient/protocol";

export interface MockSession {
  sessionId: string;
  userId: string;
  role: UserRole;
  deviceId: string;
  createdAt: number;
  abortController: AbortController;
}

export function createMockSession(overrides: Partial<MockSession> = {}): MockSession {
  return {
    sessionId: `session-${Math.random().toString(36).slice(2, 8)}`,
    userId: "user-1",
    role: "adult",
    deviceId: "device-1",
    createdAt: Date.now(),
    abortController: new AbortController(),
    ...overrides,
  };
}
```

- [ ] **Step 5: Create `shared/testing/src/mock-provider.ts`**

```typescript
export type ProviderType = "stt" | "llm" | "tts";

export interface MockProviderBehavior {
  latencyMs?: number;
  shouldFail?: boolean;
  failAfterChunks?: number;
  errorMessage?: string;
}

/** Creates a mock async generator that simulates a streaming provider */
export async function* createMockStream<T>(
  chunks: T[],
  behavior: MockProviderBehavior = {},
): AsyncGenerator<T> {
  const { latencyMs = 0, shouldFail = false, failAfterChunks, errorMessage = "Provider error" } = behavior;

  for (let i = 0; i < chunks.length; i++) {
    if (shouldFail && failAfterChunks !== undefined && i >= failAfterChunks) {
      throw new Error(errorMessage);
    }
    if (latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
    }
    yield chunks[i];
  }

  if (shouldFail && failAfterChunks === undefined) {
    throw new Error(errorMessage);
  }
}
```

- [ ] **Step 6: Create `shared/testing/src/mock-auth.ts`**

```typescript
import type { UserRole } from "@sentient/protocol";

export interface MockTokenClaims {
  sub: string;
  role: UserRole;
  deviceId: string;
  iat: number;
  exp: number;
  jti: string;
}

/** Creates mock PASETO token claims for testing. NOT real encryption. */
export function createMockTokenClaims(overrides: Partial<MockTokenClaims> = {}): MockTokenClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "user-1",
    role: "adult",
    deviceId: "device-1",
    iat: now,
    exp: now + 30 * 24 * 60 * 60, // 30 days
    jti: `jti-${Math.random().toString(36).slice(2, 10)}`,
    ...overrides,
  };
}

/** Creates a fake token string for testing. NOT a real PASETO token. */
export function createMockToken(claims: Partial<MockTokenClaims> = {}): string {
  const fullClaims = createMockTokenClaims(claims);
  const encoded = btoa(JSON.stringify(fullClaims));
  return `v4.local.test.${encoded}`;
}
```

- [ ] **Step 7: Create `shared/testing/src/index.ts`**

```typescript
export { createMockWebSocket, type MockWebSocket } from "./mock-websocket.ts";
export { createMockSession, type MockSession } from "./mock-session.ts";
export { createMockStream, type MockProviderBehavior } from "./mock-provider.ts";
export { createMockToken, createMockTokenClaims, type MockTokenClaims } from "./mock-auth.ts";
```

- [ ] **Step 8: Commit**

```bash
git add shared/testing/
git commit -m "feat(testing): shared test factories for WebSocket, sessions, providers, auth"
```

---

## Task 13: Biome, Lefthook, and Tooling Config

**Files:**
- Create: `biome.json`
- Create: `lefthook.yml`

- [ ] **Step 1: Create `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "organizeImports": {
    "enabled": true
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": {
        "noUnusedImports": "error",
        "noUnusedVariables": "error"
      },
      "style": {
        "noNonNullAssertion": "warn",
        "useConst": "error"
      },
      "suspicious": {
        "noExplicitAny": "error",
        "noConsoleLog": "warn"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 120
  },
  "files": {
    "include": ["gateway/**/*.ts", "web/**/*.ts", "web/**/*.tsx", "shared/**/*.ts"],
    "ignore": ["**/node_modules", "**/dist", "**/coverage", "android/**", "ios/**", "docs/**"]
  }
}
```

- [ ] **Step 2: Create `lefthook.yml`**

```yaml
pre-commit:
  parallel: true
  commands:
    lint:
      glob: "*.{ts,tsx}"
      run: bunx biome check --no-errors-on-unmatched {staged_files}
    typecheck:
      run: bun run typecheck

pre-push:
  commands:
    test:
      run: bun run test:unit
```

- [ ] **Step 3: Install lefthook**

Run: `cd /Users/kevinye/Development/sentient && bunx lefthook install`

Expected: Git hooks installed.

- [ ] **Step 4: Commit**

```bash
git add biome.json lefthook.yml
git commit -m "chore: Biome lint config and Lefthook git hooks"
```

---

## Task 14: Docker Setup

**Files:**
- Create: `gateway/Dockerfile`
- Create: `web/Dockerfile`
- Create: `deploy/docker/docker-compose.yml`
- Create: `deploy/docker/docker-compose.dev.yml`
- Create: `deploy/pi/docker-compose.yml`
- Create: `deploy/pi/setup.sh`
- Create: `scripts/dev.sh`

- [ ] **Step 1: Create `gateway/Dockerfile`**

```dockerfile
# Stage 1: Install dependencies
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lockb* ./
COPY gateway/package.json gateway/
COPY shared/protocol/package.json shared/protocol/
COPY shared/config/package.json shared/config/
COPY shared/testing/package.json shared/testing/
RUN bun install --frozen-lockfile --production

# Stage 2: Build
FROM oven/bun:1 AS build
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY tsconfig.base.json .
COPY gateway/ gateway/
COPY shared/ shared/
RUN cd gateway && bun build src/index.ts --outdir dist --target bun

# Stage 3: Runtime
FROM oven/bun:1-slim
WORKDIR /app
COPY --from=build /app/gateway/dist ./dist
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1))" || exit 1
CMD ["bun", "dist/index.js"]
```

- [ ] **Step 2: Create `web/Dockerfile`**

```dockerfile
# Stage 1: Build
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lockb* ./
COPY web/package.json web/
COPY shared/protocol/package.json shared/protocol/
RUN bun install --frozen-lockfile
COPY tsconfig.base.json .
COPY web/ web/
COPY shared/protocol/ shared/protocol/
RUN cd web && bun run build

# Stage 2: Serve
FROM nginx:alpine
COPY --from=build /app/web/dist /usr/share/nginx/html
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

Note: Create a minimal `web/nginx.conf` with COOP/COEP headers:

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    # Required for SharedArrayBuffer (AudioWorklet)
    add_header Cross-Origin-Opener-Policy same-origin;
    add_header Cross-Origin-Embedder-Policy require-corp;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Create `web/nginx.conf` with the above content.

- [ ] **Step 3: Create `deploy/docker/docker-compose.yml`**

```yaml
services:
  gateway:
    build:
      context: ../..
      dockerfile: gateway/Dockerfile
    ports:
      - "${GATEWAY_PORT:-3000}:3000"
    env_file:
      - ../../.env
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "bun", "-e", "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1))"]
      interval: 30s
      timeout: 3s
      retries: 3

  web:
    build:
      context: ../..
      dockerfile: web/Dockerfile
    ports:
      - "80:80"
    depends_on:
      gateway:
        condition: service_healthy
    restart: unless-stopped
```

- [ ] **Step 4: Create `deploy/docker/docker-compose.dev.yml`**

```yaml
services:
  gateway:
    build:
      context: ../..
      dockerfile: gateway/Dockerfile
    ports:
      - "${GATEWAY_PORT:-3000}:3000"
    env_file:
      - ../../.env
    volumes:
      - ../../gateway/src:/app/gateway/src
      - ../../shared:/app/shared
    command: ["bun", "--hot", "gateway/src/index.ts"]
```

- [ ] **Step 5: Create `deploy/pi/docker-compose.yml`**

```yaml
services:
  gateway:
    image: ${CI_REGISTRY_IMAGE:-registry.gitlab.example.com/group/sentient}/gateway:production
    restart: unless-stopped
    env_file: .env
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD", "bun", "-e", "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1))"]
      interval: 30s
      timeout: 3s
      retries: 3

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

- [ ] **Step 6: Create `deploy/pi/setup.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "=== Sentient Pi Setup ==="

# Check Docker
if ! command -v docker &>/dev/null; then
  echo "Docker not found. Install with: curl -fsSL https://get.docker.com | sh"
  exit 1
fi

# Check Docker Compose
if ! docker compose version &>/dev/null; then
  echo "Docker Compose not found. Install the compose plugin."
  exit 1
fi

# Login to registry
echo "Log in to your GitLab container registry:"
echo "  docker login registry.gitlab.example.com"
echo ""
read -p "Press Enter after logging in..."

# Create .env if missing
if [ ! -f .env ]; then
  echo "Creating .env from template..."
  cp ../../.env.example .env
  echo "IMPORTANT: Edit .env with your real API keys before starting."
  exit 0
fi

# Start
echo "Starting Sentient..."
docker compose up -d

echo "=== Done ==="
echo "Gateway: http://$(hostname -I | awk '{print $1}'):3000/health"
```

- [ ] **Step 7: Create `scripts/dev.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Pull and run develop images locally for testing
echo "Pulling latest develop images..."
docker compose -f deploy/docker/docker-compose.dev.yml pull 2>/dev/null || true

echo "Starting in dev mode..."
docker compose -f deploy/docker/docker-compose.dev.yml up --build --remove-orphans
```

- [ ] **Step 8: Make scripts executable**

Run: `chmod +x deploy/pi/setup.sh scripts/dev.sh`

- [ ] **Step 9: Commit**

```bash
git add gateway/Dockerfile web/Dockerfile web/nginx.conf deploy/ scripts/
git commit -m "chore: Docker setup for gateway, web, Pi deployment, and dev scripts"
```

---

## Task 15: GitLab CI Pipeline

**Files:**
- Create: `.gitlab-ci.yml`

- [ ] **Step 1: Create `.gitlab-ci.yml`**

```yaml
stages:
  - quality
  - test
  - build

default:
  image: oven/bun:1
  cache:
    key:
      files:
        - bun.lockb
    paths:
      - node_modules/

# ─── Quality ───

lint:
  stage: quality
  script:
    - bun install --frozen-lockfile
    - bun run lint
  rules:
    - if: '$CI_PIPELINE_SOURCE == "push"'

typecheck:
  stage: quality
  script:
    - bun install --frozen-lockfile
    - bun run typecheck
  rules:
    - if: '$CI_PIPELINE_SOURCE == "push"'

# ─── Tests ───

test:unit:
  stage: test
  script:
    - bun install --frozen-lockfile
    - bun run test:unit
  rules:
    - if: '$CI_PIPELINE_SOURCE == "push"'

test:integration:
  stage: test
  script:
    - bun install --frozen-lockfile
    - bun run test:int
  rules:
    - if: '$CI_COMMIT_BRANCH == "develop"'
    - if: '$CI_COMMIT_BRANCH == "main"'

# ─── Build ───

docker:gateway:
  stage: build
  image: docker:27
  services:
    - docker:27-dind
  variables:
    DOCKER_TLS_CERTDIR: "/certs"
  before_script:
    - docker login -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD $CI_REGISTRY
  script:
    - |
      TAG=$CI_COMMIT_SHORT_SHA
      if [ "$CI_COMMIT_BRANCH" = "main" ]; then
        EXTRA_TAGS="-t $CI_REGISTRY_IMAGE/gateway:production -t $CI_REGISTRY_IMAGE/gateway:latest"
      elif [ "$CI_COMMIT_BRANCH" = "develop" ]; then
        EXTRA_TAGS="-t $CI_REGISTRY_IMAGE/gateway:develop"
      else
        EXTRA_TAGS=""
      fi
      docker build \
        -f gateway/Dockerfile \
        -t $CI_REGISTRY_IMAGE/gateway:$TAG \
        $EXTRA_TAGS \
        .
      docker push $CI_REGISTRY_IMAGE/gateway:$TAG
      [ -n "$EXTRA_TAGS" ] && docker push --all-tags $CI_REGISTRY_IMAGE/gateway || true
  rules:
    - if: '$CI_COMMIT_BRANCH == "develop"'
    - if: '$CI_COMMIT_BRANCH == "main"'
```

- [ ] **Step 2: Commit**

```bash
git add .gitlab-ci.yml
git commit -m "ci: GitLab pipeline with lint, typecheck, tests, docker build"
```

---

## Task 16: Install Dependencies and Verify

- [ ] **Step 1: Install all dependencies**

Run: `cd /Users/kevinye/Development/sentient && bun install`

Expected: Dependencies install successfully. `bun.lockb` created.

- [ ] **Step 2: Run lint**

Run: `bun run lint`

Expected: No lint errors.

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`

Expected: No type errors.

- [ ] **Step 4: Run tests**

Run: `bun run test:unit`

Expected: All tests pass (~35 tests across gateway, web, shared/protocol, shared/config).

- [ ] **Step 5: Run full CI check**

Run: `bun run ci`

Expected: lint + typecheck + test all pass.

- [ ] **Step 6: Verify Docker build**

Run: `cd /Users/kevinye/Development/sentient && docker compose -f deploy/docker/docker-compose.yml build`

Expected: Both gateway and web images build successfully.

- [ ] **Step 7: Verify health endpoint via Docker**

Run:
```bash
docker compose -f deploy/docker/docker-compose.yml up -d gateway
sleep 2
curl http://localhost:3000/health
docker compose -f deploy/docker/docker-compose.yml down
```

Expected: `{"status":"ok"}`

- [ ] **Step 8: Commit lockfile**

```bash
git add bun.lockb
git commit -m "chore: lock dependencies"
```

- [ ] **Step 9: Final commit — Phase 0 complete**

```bash
git add -A
git status  # verify nothing unexpected
git commit -m "feat: Phase 0 complete — foundation scaffold with quality gates"
```

---

## Post-Phase 0: Manual Steps for User

After all tasks are committed to main:

1. **Create GitLab project** — private, under your group
2. **Push** — `git remote add origin <url> && git push -u origin main`
3. **Protect branches:**
   - `main`: merge=Maintainers, push=No one
   - `develop`: merge=Developers+, push=No one
4. **Create `develop` branch** — `git checkout -b develop && git push -u origin develop`
5. **Add CI/CD variables** (Settings > CI/CD > Variables, all Protected+Masked):
   - `DEEPGRAM_API_KEY`
   - `OPENROUTER_API_KEY`
   - `FISH_AUDIO_API_KEY`
   - `PASETO_SECRET_KEY` (generate: `openssl rand -hex 32`)
6. **Create deploy token** — Name: `pi-deploy`, scope: `read_registry`
7. **Verify CI** — push a test feature branch, confirm pipeline runs
8. **Setup Pi** — run `deploy/pi/setup.sh`

---

Plan complete and saved to `docs/superpowers/plans/2026-04-04-phase0-foundation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
