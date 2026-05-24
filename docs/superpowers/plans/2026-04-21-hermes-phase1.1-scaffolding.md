# Phase 1.1 — Scaffolding

> **Parent plan:** `2026-04-21-hermes-phase1-overview.md`
> **Previous:** `2026-04-21-hermes-phase1.0-empirical-gates.md` (must be complete)

**Goal:** land the foundation for Hermes integration. No live Hermes calls yet. Specifically:
- A curated slim Hermes Dockerfile at `deploy/docker/hermes/Dockerfile.slim`.
- A dev `docker-compose.yml` that starts gateway + 1 Hermes container (for "alice" profile).
- `HermesClient` interface + skeleton implementation (types + stub `dispatch()` that throws "not implemented yet" — real SSE consumer lands in Phase 1.2).
- `SessionRouter` skeleton with single-user binding (multi-user lands in Phase 1.7).
- Profile template files (`SOUL.md.tmpl`, `hermes-profile.yaml.tmpl`).
- Config schema for new `hermes:` section in `gateway/config.yaml`.

**Builds on:** Phase 1.0 (numeric verdicts used in config defaults).

**Spec reference:** v4 §5.1, §5.2, §5.9, §5.11, §7, Appendix B, Appendix C (but we skip Steward + ESP32 until Phase 1.7).

---

## 1. Context and prerequisites

### Directory layout after this phase

```
gateway/
├── src/
│   ├── cerebrum/
│   │   ├── hermes-client.ts           # NEW: interface + skeleton stub
│   │   ├── hermes-client.test.ts      # NEW
│   │   ├── hermes-event-types.ts      # NEW: HermesEvent union + Zod schemas
│   │   ├── hermes-event-types.test.ts # NEW
│   │   ├── conversation-mirror.ts     # NEW: client-facing feed; small, no LLM state
│   │   ├── conversation-mirror.test.ts
│   │   ├── task-mirror.ts              # NEW: ephemeral tool call table for UI
│   │   ├── task-mirror.test.ts
│   │   └── (existing files unchanged in this phase)
│   ├── session-router.ts               # NEW: user → profile binding
│   └── session-router.test.ts
├── templates/
│   ├── SOUL.md.tmpl                    # NEW: user persona template
│   └── hermes-profile.yaml.tmpl        # NEW: Hermes per-profile config template

deploy/
└── docker/
    ├── hermes/
    │   └── Dockerfile.slim              # NEW: curated slim Hermes image
    └── docker-compose.yml               # MODIFIED: add hermes-alice service + networks

shared/
└── config/
    └── src/
        └── schemas/
            └── hermes-config.ts         # NEW: Zod schema for gateway.config.yaml.hermes section
        └── schemas/
            └── hermes-config.test.ts

.claude/
└── rules/
    └── (no changes)

gateway/
└── config.yaml                          # MODIFIED: add hermes: section under existing yaml
```

### What we WILL NOT do in this phase

- No live SSE consumption.
- No HermesClient actually calling Hermes. The skeleton's `dispatch()` throws.
- No TTS decorator chain refactor (Phase 1.3).
- No MCP tools (Phase 1.4+).
- No deletion of old cerebrum code (Phase 1.9).

---

## Task 1.1.1 — Slim Hermes Dockerfile

**Files:**
- Create: `deploy/docker/hermes/Dockerfile.slim`
- Create: `deploy/docker/hermes/.dockerignore`
- Create: `deploy/docker/hermes/README.md`

### Step 1.1.1a: Write the Dockerfile

- [ ] Create `deploy/docker/hermes/Dockerfile.slim`:

```dockerfile
# Curated slim Hermes Agent image for Sentient gateway.
# See: docs/superpowers/specs/2026-04-21-hermes-cerebrum-integration-design-v4.md §5.1
#
# Intentionally omits:
#   - [voice] (Whisper, Piper — our gateway owns STT/TTS)
#   - [browser] (Playwright — no browser automation in v1)
#   - [vision] (OpenCV — no image analysis in v1)
#   - [messaging] extras beyond core CLI

ARG HERMES_VERSION=<PIN_THIS_VERSION>

FROM python:3.12-slim-bookworm AS base

# Install hermes-agent core + duckduckgo MCP (Phase 1.6 dependency, pre-bundled here)
RUN pip install --no-cache-dir \
      hermes-agent==${HERMES_VERSION} \
      duckduckgo-mcp-server

# Runtime deps for healthcheck
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

# Non-root user. Host profile dir must be chowned to 1000:1000.
RUN groupadd -g 1000 hermes && useradd -u 1000 -g 1000 -m -s /bin/bash hermes
USER 1000:1000

WORKDIR /data
ENV HERMES_HOME=/data
ENV API_SERVER_ENABLED=true
ENV API_SERVER_PORT=8642
EXPOSE 8642

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS -H "Authorization: Bearer $(cat $API_SERVER_KEY_FILE 2>/dev/null || echo missing)" \
        http://localhost:8642/health || exit 1

CMD ["hermes", "gateway", "start", "--api-only"]
```

- [ ] Replace `<PIN_THIS_VERSION>` with the current Hermes version (check https://github.com/NousResearch/hermes-agent/releases). Example: `2026.4.16`.

### Step 1.1.1b: Write .dockerignore

- [ ] Create `deploy/docker/hermes/.dockerignore`:

```
# Don't include this directory's other files in the build context
*.md
README.md
```

### Step 1.1.1c: Write a short README

- [ ] Create `deploy/docker/hermes/README.md`:

```markdown
# Hermes slim image

Curated Hermes Agent image. Strips voice/browser/vision/messaging extras
we don't need (gateway owns those).

Build:
    docker build -f Dockerfile.slim -t sentient-hermes:slim .

Size target: ≤ 500 MiB idle (per Phase 1.0 M-1 measurement).

See: docs/superpowers/specs/2026-04-21-hermes-cerebrum-integration-design-v4.md §5.1
```

### Step 1.1.1d: Verify the build

- [ ] From repo root:

```bash
cd deploy/docker/hermes && docker build -f Dockerfile.slim -t sentient-hermes:slim .
```

Expected: clean build. If Hermes version pin is wrong, pip will complain — update the version and rebuild.

- [ ] Check image size:

```bash
docker image inspect sentient-hermes:slim --format '{{.Size}}' | awk '{printf "%.0f MiB\n", $1/1024/1024}'
```

Record this in a scratch note. It's the COMPRESSED size; RAM footprint differs. Phase 1.0 M-1 is the authoritative RAM number.

### Step 1.1.1e: Commit

- [ ] Stage and commit:

```bash
git add deploy/docker/hermes/
git commit -m "$(cat <<'EOF'
feat(deploy): slim Hermes image curating out voice/browser/vision extras

Our gateway owns STT/TTS/audio/browser automation. Hermes doesn't
need Whisper, Piper, Playwright, or OpenCV. Stripped install targets
≤500 MiB idle per spec §5.1.

Includes duckduckgo-mcp-server for Phase 1.6 web tools.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.1.2 — Config schema for `hermes:` section

**Files:**
- Create: `shared/config/src/schemas/hermes-config.ts`
- Create: `shared/config/src/schemas/hermes-config.test.ts`
- Modify: `shared/config/src/schemas/index.ts` (re-export)
- Modify: `gateway/config.yaml` (add hermes: section)

### Step 1.1.2a: Write the Zod schema

- [ ] Create `shared/config/src/schemas/hermes-config.ts`:

```typescript
import { z } from "zod";

/**
 * Per-user Hermes profile binding.
 * Matches spec v4 §7.
 */
export const hermesProfileSchema = z.object({
  container_name: z.string().min(1),
  port: z.number().int().min(1024).max(65535),
  api_key_env: z.string().min(1),
  url: z.string().url(),
  profile_dir: z.string().min(1),
  role: z.enum(["user", "steward"]),
  enabled: z.boolean().default(true),
});
export type HermesProfile = z.infer<typeof hermesProfileSchema>;

export const hermesResourceManagementSchema = z.object({
  mode: z.enum(["always_on", "on_demand"]).default("always_on"),
  max_concurrent: z.number().int().min(1).default(3),
  idle_pause_after_ms: z.number().int().default(900_000),
  idle_stop_after_ms: z.number().int().default(3_600_000),
  ram_pressure_threshold_pct: z.number().min(0).max(100).default(85),
  cold_start_filler_text: z.string().default("one sec..."),
});

export const hermesWebToolsSchema = z.object({
  provider: z.enum(["duckduckgo", "searxng"]).default("duckduckgo"),
  duckduckgo: z.object({
    enabled: z.boolean().default(true),
  }).default({}),
  searxng: z.object({
    enabled: z.boolean().default(false),
    url: z.string().url().optional(),
  }).default({}),
  voice_wrapper: z.object({
    enabled: z.boolean().default(false),
  }).default({}),
}).default({});

export const hermesHomeAssistantObserverSchema = z.object({
  enabled: z.boolean().default(true),
  url: z.string().url().optional(),
  token_env: z.string().default("HA_OBSERVE_TOKEN"),
  watch_domains: z.array(z.string()).default([
    "binary_sensor", "climate", "alarm_control_panel", "light", "lock", "cover",
  ]),
  watch_entities: z.array(z.string()).default([]),
  ignore_entities: z.array(z.string()).default([]),
  duplicate_state_window_ms: z.number().int().default(10_000),
}).default({});

export const hermesMcpHostSchema = z.object({
  transport: z.enum(["unix_socket", "http"]).default("unix_socket"),
  socket_path: z.string().default("/run/sentient/mcp.sock"),
});

export const hermesAmbientSchema = z.object({
  event_log: z.object({
    enabled: z.boolean().default(true),
    retention_count: z.number().int().default(10_000),
    persist_path: z.string().default("./data/ambient-events.db"),
  }).default({}),
  dispatch: z.object({
    steward_enabled: z.boolean().default(false), // v1.5+
    accumulation_window_ms: z.number().int().default(2000),
  }).default({}),
}).default({});

/**
 * Full hermes: section.
 */
export const hermesConfigSchema = z.object({
  profiles: z.record(z.string(), hermesProfileSchema),
  defaults: z.object({
    max_output_tokens: z.number().int().default(512),
    request_timeout_ms: z.number().int().default(60_000),
    idempotency_window_s: z.number().int().default(300),
  }).default({}),
  resource_management: hermesResourceManagementSchema.default({}),
  web_tools: hermesWebToolsSchema,
  home_assistant_observer: hermesHomeAssistantObserverSchema,
  mcp_host: hermesMcpHostSchema.default({}),
  ambient: hermesAmbientSchema,
  tts: z.object({
    markdown_stripping_enabled: z.boolean().default(true),
    emoji_stripping_enabled: z.boolean().default(true),
  }).default({}),
});
export type HermesConfig = z.infer<typeof hermesConfigSchema>;
```

### Step 1.1.2b: Add a test

- [ ] Create `shared/config/src/schemas/hermes-config.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { hermesConfigSchema } from "./hermes-config";

describe("hermesConfigSchema", () => {
  it("accepts a minimal valid config with one profile", () => {
    const input = {
      profiles: {
        alice: {
          container_name: "hermes-alice",
          port: 8643,
          api_key_env: "HERMES_API_KEY_ALICE",
          url: "http://hermes-alice:8643",
          profile_dir: "./profiles/alice",
          role: "user",
        },
      },
    };
    const result = hermesConfigSchema.parse(input);
    expect(result.profiles.alice.enabled).toBe(true); // default
    expect(result.defaults.max_output_tokens).toBe(512);
    expect(result.web_tools.provider).toBe("duckduckgo");
    expect(result.home_assistant_observer.enabled).toBe(true);
    expect(result.ambient.dispatch.steward_enabled).toBe(false);
  });

  it("rejects invalid port", () => {
    const input = {
      profiles: {
        alice: {
          container_name: "x",
          port: 80, // reserved
          api_key_env: "X",
          url: "http://x:80",
          profile_dir: "./x",
          role: "user",
        },
      },
    };
    expect(() => hermesConfigSchema.parse(input)).toThrow();
  });

  it("accepts steward profile role", () => {
    const input = {
      profiles: {
        _steward: {
          container_name: "hermes-steward",
          port: 8649,
          api_key_env: "HERMES_API_KEY_STEWARD",
          url: "http://hermes-steward:8649",
          profile_dir: "./profiles/_steward",
          role: "steward",
          enabled: false, // v1 disabled
        },
      },
    };
    const result = hermesConfigSchema.parse(input);
    expect(result.profiles._steward.role).toBe("steward");
    expect(result.profiles._steward.enabled).toBe(false);
  });
});
```

### Step 1.1.2c: Re-export from index

- [ ] Find `shared/config/src/schemas/index.ts` (create if absent) and add:

```typescript
export * from "./hermes-config";
```

- [ ] Verify:

```bash
source scripts/env.sh && bun run --filter @sentient/config typecheck
```

### Step 1.1.2d: Add hermes: section to gateway/config.yaml

- [ ] Open `gateway/config.yaml`. Append at the bottom (after `cerebrum:`):

```yaml
# Hermes Agent integration. See spec §5, §7.
# Feature-flagged: set cerebrum.provider to "hermes" to use.
hermes:
  # Per-user profile bindings. Keys are userIds.
  profiles:
    alice:
      container_name: hermes-alice   # docker-compose service name
      port: 8643                      # internal-network port
      api_key_env: HERMES_API_KEY_ALICE  # env var name holding bearer key
      url: "http://hermes-alice:8643"
      profile_dir: "./profiles/alice"
      role: user
      enabled: true

  defaults:
    max_output_tokens: 512            # per-turn token cap
    request_timeout_ms: 60000         # Hermes call deadline
    idempotency_window_s: 300         # Hermes de-dup window

  resource_management:
    mode: always_on                    # or "on_demand" per spec §5.11
    max_concurrent: 3
    idle_pause_after_ms: 900000        # 15 min
    idle_stop_after_ms: 3600000        # 60 min
    ram_pressure_threshold_pct: 85
    cold_start_filler_text: "one sec..."

  web_tools:
    provider: duckduckgo               # or "searxng" post-Phase-3
    duckduckgo:
      enabled: true

  home_assistant_observer:
    enabled: true
    url: "ws://homeassistant.local:8123/api/websocket"
    token_env: HA_OBSERVE_TOKEN
    watch_domains: [binary_sensor, climate, alarm_control_panel, light, lock, cover]

  mcp_host:
    transport: unix_socket
    socket_path: "/run/sentient/mcp.sock"

  ambient:
    event_log:
      enabled: true
      retention_count: 10000
      persist_path: "./data/ambient-events.db"
    dispatch:
      steward_enabled: false           # v1.5+

  tts:
    markdown_stripping_enabled: true
    emoji_stripping_enabled: true
```

- [ ] Also add to the `cerebrum:` section (or add if missing) a provider selector:

```yaml
cerebrum:
  # Existing keys preserved.
  provider: in-process       # v1 default; flip to "hermes" in Phase 1.2+ under feature flag
  # ... existing cerebrum.* keys ...
```

### Step 1.1.2e: Wire config schema into gateway loader

- [ ] Find `gateway/src/config/` (or wherever existing config loading happens). Add hermes schema to the root config union. If the file is `gateway/src/config/config-schema.ts`:

```typescript
import { hermesConfigSchema } from "@sentient/config/schemas";
// ...
export const appConfigSchema = z.object({
  // ...existing top-level fields...
  hermes: hermesConfigSchema.optional(), // optional while feature-flagged
  cerebrum: z.object({
    // ...existing cerebrum fields...
    provider: z.enum(["in-process", "hermes"]).default("in-process"),
  }),
});
```

If the existing structure differs, adapt — the pattern is: add a new optional `hermes` field and extend `cerebrum.provider` with `"hermes"`.

### Step 1.1.2f: Verify + commit

- [ ] `source scripts/env.sh && bun run ci`

If typecheck fails in the gateway, trace the config resolver and fix imports. Do NOT disable typecheck.

- [ ] Commit:

```bash
git add shared/config/src/schemas/hermes-config.ts shared/config/src/schemas/hermes-config.test.ts shared/config/src/schemas/index.ts gateway/config.yaml gateway/src/config/
git commit -m "$(cat <<'EOF'
feat(config): hermes integration config schema

Adds per-user profile bindings, resource management, web tools provider
selection, HA observer filters, MCP host transport, ambient event log,
and TTS options. Feature-flagged via cerebrum.provider until Phase 1.2+.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.1.3 — `HermesClient` interface + skeleton

**Files:**
- Create: `gateway/src/cerebrum/hermes-event-types.ts`
- Create: `gateway/src/cerebrum/hermes-event-types.test.ts`
- Create: `gateway/src/cerebrum/hermes-client.ts`
- Create: `gateway/src/cerebrum/hermes-client.test.ts`

### Step 1.1.3a: Define event types

- [ ] Create `gateway/src/cerebrum/hermes-event-types.ts`:

```typescript
import { z } from "zod";

/**
 * Discriminated union of all events the HermesClient emits
 * to its caller (i.e., to AttentionGate / AttentionGate's subscribers).
 *
 * These are OUR gateway-internal shape; they correspond to Hermes SSE events
 * but are type-friendly and stable for our gateway's consumers.
 *
 * See spec v4 Appendix A for the SSE → wire mapping. This type sits BETWEEN
 * SSE parse and wire emission.
 */
export const hermesEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("created"),
    responseId: z.string(),
    conversationId: z.string(),
  }),
  z.object({
    type: z.literal("text.delta"),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("tool.started"),
    callId: z.string(),
    toolName: z.string(),
    argsPreview: z.string(),
  }),
  // conditional on Phase 1.0 M-3; stub kept regardless
  z.object({
    type: z.literal("tool.args.delta"),
    callId: z.string(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("tool.finished"),
    callId: z.string(),
    status: z.enum(["ok", "failed"]),
    summary: z.string(),
  }),
  z.object({
    type: z.literal("completed"),
    usage: z.object({
      inputTokens: z.number().int(),
      outputTokens: z.number().int(),
    }),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
  }),
]);
export type HermesEvent = z.infer<typeof hermesEventSchema>;

export interface HermesTurnInput {
  /** Profile id (userId). */
  userId: string;
  /** Our gateway-assigned cycle id. Becomes idempotency key. */
  cycleId: string;
  /**
   * Fully assembled user message including any labeled-prefix
   * situation awareness (per spec D-6).
   */
  userMessage: string;
  /** Hermes conversation id. null = first cycle of session. */
  conversationId: string | null;
  /** Token cap for this turn. */
  maxOutputTokens: number;
}

/**
 * Mutable flag queried per text-delta to decide whether to fork into TTS.
 */
export interface DispatchMode {
  bargedIn(): boolean;
}
```

### Step 1.1.3b: Test event schemas

- [ ] Create `gateway/src/cerebrum/hermes-event-types.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { hermesEventSchema } from "./hermes-event-types";

describe("hermesEventSchema", () => {
  it("parses created event", () => {
    const e = hermesEventSchema.parse({
      type: "created",
      responseId: "resp_abc",
      conversationId: "conv_xyz",
    });
    expect(e.type).toBe("created");
  });

  it("parses text.delta with empty string", () => {
    const e = hermesEventSchema.parse({ type: "text.delta", delta: "" });
    expect(e.type).toBe("text.delta");
  });

  it("parses tool.finished with ok status", () => {
    const e = hermesEventSchema.parse({
      type: "tool.finished",
      callId: "call_1",
      status: "ok",
      summary: "Done",
    });
    expect(e.type).toBe("tool.finished");
  });

  it("rejects tool.finished with invalid status", () => {
    expect(() =>
      hermesEventSchema.parse({
        type: "tool.finished",
        callId: "call_1",
        status: "unknown",
        summary: "",
      }),
    ).toThrow();
  });

  it("discriminated union rejects unknown type", () => {
    expect(() => hermesEventSchema.parse({ type: "weird", delta: "x" })).toThrow();
  });
});
```

### Step 1.1.3c: HermesClient skeleton

- [ ] Create `gateway/src/cerebrum/hermes-client.ts`:

```typescript
import { createLogger } from "@sentient/logging"; // adapt import if different
import type {
  DispatchMode,
  HermesEvent,
  HermesTurnInput,
} from "./hermes-event-types";

const log = createLogger(["sentient.gateway.cerebrum", "hermes-client"]);

/**
 * Binding for a single Hermes container: its URL, bearer key, and conversation id.
 * Owned by SessionRouter.
 */
export interface HermesProfileBinding {
  userId: string;
  url: string;
  apiKey: string;
  /** Mutable — SessionRouter updates when session starts/resets. */
  conversationId: string | null;
}

export interface HermesClient {
  /**
   * Dispatch ONE turn to the bound Hermes profile.
   *
   * Yields a stream of HermesEvent until the run completes or is aborted.
   * AbortSignal aborts the SSE connection (Hermes cancels server-side per PR #3427).
   * DispatchMode.bargedIn() is queried per text-delta to decide TTS fork.
   */
  dispatch(
    input: HermesTurnInput,
    signal: AbortSignal,
    mode: DispatchMode,
  ): AsyncGenerator<HermesEvent>;
}

/**
 * Skeleton implementation — Phase 1.1.
 *
 * Throws "not implemented yet" from dispatch(). Real SSE consumer in Phase 1.2.
 * Shipped now so SessionRouter (Task 1.1.4) + feature flag can compile.
 */
export class HttpHermesClient implements HermesClient {
  constructor(private readonly binding: HermesProfileBinding) {
    log.debug("construct", {
      userId: binding.userId,
      url: binding.url,
      hasConversation: binding.conversationId !== null,
    });
  }

  async *dispatch(
    input: HermesTurnInput,
    _signal: AbortSignal,
    _mode: DispatchMode,
  ): AsyncGenerator<HermesEvent> {
    log.debug("dispatch.skeleton", {
      userId: input.userId,
      cycleId: input.cycleId,
      conversationId: input.conversationId,
    });
    throw new Error(
      `HttpHermesClient.dispatch() not implemented until Phase 1.2 (cycleId=${input.cycleId})`,
    );
    // biome-ignore lint/correctness/useYield: placeholder for async generator
    yield { type: "error", message: "unreachable" };
  }
}
```

### Step 1.1.3d: Skeleton test

- [ ] Create `gateway/src/cerebrum/hermes-client.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { HttpHermesClient, type HermesProfileBinding } from "./hermes-client";

const binding: HermesProfileBinding = {
  userId: "alice",
  url: "http://localhost:8643",
  apiKey: "test-key",
  conversationId: null,
};

describe("HttpHermesClient (skeleton)", () => {
  it("instantiates without error", () => {
    const client = new HttpHermesClient(binding);
    expect(client).toBeDefined();
  });

  it("throws from dispatch until Phase 1.2", async () => {
    const client = new HttpHermesClient(binding);
    const ctrl = new AbortController();
    const mode = { bargedIn: () => false };
    const gen = client.dispatch(
      {
        userId: "alice",
        cycleId: "cycle-1",
        userMessage: "hi",
        conversationId: null,
        maxOutputTokens: 128,
      },
      ctrl.signal,
      mode,
    );
    await expect(gen.next()).rejects.toThrow(/not implemented until Phase 1.2/);
  });
});
```

### Step 1.1.3e: Verify + commit

- [ ] `source scripts/env.sh && bun run --filter @sentient/gateway typecheck`
- [ ] `source scripts/env.sh && bun run --filter @sentient/gateway test:unit -- hermes`
- [ ] Expected: the 2 tests pass, no lint errors.
- [ ] Commit:

```bash
git add gateway/src/cerebrum/hermes-event-types.ts gateway/src/cerebrum/hermes-event-types.test.ts gateway/src/cerebrum/hermes-client.ts gateway/src/cerebrum/hermes-client.test.ts
git commit -m "$(cat <<'EOF'
feat(cerebrum): HermesClient interface + skeleton stub

Ships typed HermesEvent discriminated union (Zod-backed) and the
HermesClient interface. HttpHermesClient.dispatch() throws until Phase
1.2 wires the real SSE consumer. Exists now so SessionRouter and the
cerebrum.provider feature flag compile.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.1.4 — `SessionRouter` skeleton (single-user)

**Files:**
- Create: `gateway/src/session-router.ts`
- Create: `gateway/src/session-router.test.ts`

### Step 1.1.4a: Write SessionRouter with one-user stub

- [ ] Create `gateway/src/session-router.ts`:

```typescript
import { createLogger } from "@sentient/logging";
import type { HermesProfileBinding } from "./cerebrum/hermes-client";
import type { HermesConfig } from "@sentient/config/schemas";

const log = createLogger(["sentient.gateway", "session-router"]);

/**
 * Maps a session (sessionId) to a HermesProfileBinding (port, bearer, conversation).
 *
 * Phase 1.1 — single-user stub: resolves every session to the first profile
 * in config (typically "alice"). Real multi-user binding lands in Phase 1.7.
 */
export interface SessionRouter {
  /** Bind a session to a user's Hermes profile. */
  bind(sessionId: string, userId: string | null): HermesProfileBinding;
  /** Release a session binding when WS closes. */
  release(sessionId: string): void;
  /** Rebind a session to a different user (Phase 1.7 `identify_user`). */
  rebind(sessionId: string, newUserId: string): HermesProfileBinding;
  /** Current binding for a session (read-only lookup). */
  get(sessionId: string): HermesProfileBinding | null;
}

interface InternalBinding extends HermesProfileBinding {
  sessionId: string;
  boundAt: number;
}

export function createSessionRouter(
  config: HermesConfig,
  apiKeyResolver: (envVarName: string) => string,
): SessionRouter {
  const bindings = new Map<string, InternalBinding>();

  function resolveProfile(userId: string | null): HermesProfileBinding {
    // Phase 1.1: ignore userId, return first enabled profile.
    // Phase 1.7 wires real multi-user lookup.
    const first = Object.entries(config.profiles)
      .map(([id, p]) => ({ id, ...p }))
      .filter((p) => p.enabled && p.role === "user")
      .at(0);
    if (!first) {
      throw new Error("no enabled user profile in hermes.profiles");
    }
    return {
      userId: first.id,
      url: first.url,
      apiKey: apiKeyResolver(first.api_key_env),
      conversationId: null,
    };
  }

  return {
    bind(sessionId, userId) {
      log.debug("bind", { sessionId, userId });
      const b = resolveProfile(userId);
      const rec: InternalBinding = {
        ...b,
        sessionId,
        boundAt: Date.now(),
      };
      bindings.set(sessionId, rec);
      return b;
    },
    release(sessionId) {
      log.debug("release", { sessionId });
      bindings.delete(sessionId);
    },
    rebind(sessionId, newUserId) {
      log.debug("rebind", { sessionId, newUserId });
      const prev = bindings.get(sessionId);
      if (!prev) throw new Error(`rebind: unknown session ${sessionId}`);
      const b = resolveProfile(newUserId);
      const rec: InternalBinding = {
        ...b,
        sessionId,
        boundAt: Date.now(),
      };
      bindings.set(sessionId, rec);
      return b;
    },
    get(sessionId) {
      const b = bindings.get(sessionId) ?? null;
      return b === null
        ? null
        : {
            userId: b.userId,
            url: b.url,
            apiKey: b.apiKey,
            conversationId: b.conversationId,
          };
    },
  };
}
```

### Step 1.1.4b: Write tests

- [ ] Create `gateway/src/session-router.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createSessionRouter } from "./session-router";
import type { HermesConfig } from "@sentient/config/schemas";

const baseConfig: HermesConfig = {
  profiles: {
    alice: {
      container_name: "hermes-alice",
      port: 8643,
      api_key_env: "HERMES_API_KEY_ALICE",
      url: "http://hermes-alice:8643",
      profile_dir: "./profiles/alice",
      role: "user",
      enabled: true,
    },
  },
  defaults: { max_output_tokens: 512, request_timeout_ms: 60000, idempotency_window_s: 300 },
  resource_management: {
    mode: "always_on",
    max_concurrent: 3,
    idle_pause_after_ms: 900000,
    idle_stop_after_ms: 3_600_000,
    ram_pressure_threshold_pct: 85,
    cold_start_filler_text: "one sec...",
  },
  web_tools: { provider: "duckduckgo", duckduckgo: { enabled: true }, searxng: { enabled: false }, voice_wrapper: { enabled: false } },
  home_assistant_observer: {
    enabled: false,
    token_env: "HA_OBSERVE_TOKEN",
    watch_domains: [],
    watch_entities: [],
    ignore_entities: [],
    duplicate_state_window_ms: 10000,
  },
  mcp_host: { transport: "unix_socket", socket_path: "/run/sentient/mcp.sock" },
  ambient: {
    event_log: { enabled: true, retention_count: 10000, persist_path: "./data/ambient-events.db" },
    dispatch: { steward_enabled: false, accumulation_window_ms: 2000 },
  },
  tts: { markdown_stripping_enabled: true, emoji_stripping_enabled: true },
};

const fakeResolver = (name: string) => `fake-key-for-${name}`;

describe("SessionRouter (skeleton)", () => {
  it("binds a session to the first user profile", () => {
    const router = createSessionRouter(baseConfig, fakeResolver);
    const b = router.bind("sess-1", "alice");
    expect(b.userId).toBe("alice");
    expect(b.url).toBe("http://hermes-alice:8643");
    expect(b.apiKey).toBe("fake-key-for-HERMES_API_KEY_ALICE");
    expect(b.conversationId).toBeNull();
  });

  it("releases a binding", () => {
    const router = createSessionRouter(baseConfig, fakeResolver);
    router.bind("sess-1", "alice");
    expect(router.get("sess-1")).not.toBeNull();
    router.release("sess-1");
    expect(router.get("sess-1")).toBeNull();
  });

  it("rebind returns fresh binding", () => {
    const router = createSessionRouter(baseConfig, fakeResolver);
    router.bind("sess-1", "alice");
    const after = router.rebind("sess-1", "alice"); // single-user stub always returns alice
    expect(after.userId).toBe("alice");
    expect(after.conversationId).toBeNull();
  });

  it("throws on rebind of unknown session", () => {
    const router = createSessionRouter(baseConfig, fakeResolver);
    expect(() => router.rebind("missing", "alice")).toThrow();
  });

  it("throws if no enabled user profile", () => {
    const noProfilesConfig = {
      ...baseConfig,
      profiles: {
        alice: { ...baseConfig.profiles.alice, enabled: false },
      },
    };
    const router = createSessionRouter(noProfilesConfig, fakeResolver);
    expect(() => router.bind("sess-1", "alice")).toThrow(/no enabled user profile/);
  });
});
```

### Step 1.1.4c: Verify + commit

- [ ] `source scripts/env.sh && bun run --filter @sentient/gateway test:unit -- session-router`
- [ ] Commit:

```bash
git add gateway/src/session-router.ts gateway/src/session-router.test.ts
git commit -m "$(cat <<'EOF'
feat(gateway): SessionRouter single-user skeleton

Skeleton routes every session to first enabled user profile. Multi-user
binding, container supervisor, and identify_user rebind land in Phase 1.7.
Tests cover bind/release/rebind and missing-profile error.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.1.5 — `ConversationMirror` + `TaskMirror` (UI feed stubs)

**Files:**
- Create: `gateway/src/cerebrum/conversation-mirror.ts`
- Create: `gateway/src/cerebrum/conversation-mirror.test.ts`
- Create: `gateway/src/cerebrum/task-mirror.ts`
- Create: `gateway/src/cerebrum/task-mirror.test.ts`

### Step 1.1.5a: ConversationMirror

Per spec v3/v4 §5.9, this is a thin append-only log mirroring what the client sees. NOT an LLM context store.

- [ ] Create `gateway/src/cerebrum/conversation-mirror.ts`:

```typescript
import { createLogger } from "@sentient/logging";

const log = createLogger(["sentient.gateway.cerebrum", "conversation-mirror"]);

export type MirrorEntry =
  | { kind: "user"; ts: number; channel: "text" | "speech"; content: string }
  | {
      kind: "assistant";
      ts: number;
      content: string;
      cutoff?:
        | { kind: "barge-in" }
        | { kind: "interrupt"; cancelledTaskIds: string[] }
        | { kind: "length-cap" };
    }
  | {
      kind: "tool";
      ts: number;
      toolName: string;
      status: "finished" | "cancelled" | "failed";
      summary: string;
    }
  | { kind: "trigger"; ts: number; source: string; summary: string };

export interface ConversationMirror {
  append(entry: MirrorEntry): void;
  snapshot(): readonly MirrorEntry[];
  clear(): void;
}

/**
 * Bounded FIFO. Default cap 500; override via config in Phase 1.7+.
 */
export function createConversationMirror(
  capacity: number = 500,
): ConversationMirror {
  const buffer: MirrorEntry[] = [];
  return {
    append(entry) {
      log.debug("append", { kind: entry.kind, size: buffer.length });
      buffer.push(entry);
      if (buffer.length > capacity) buffer.shift();
    },
    snapshot() {
      return [...buffer];
    },
    clear() {
      log.debug("clear", { size: buffer.length });
      buffer.length = 0;
    },
  };
}
```

### Step 1.1.5b: Tests for ConversationMirror

- [ ] Create `gateway/src/cerebrum/conversation-mirror.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createConversationMirror } from "./conversation-mirror";

describe("ConversationMirror", () => {
  it("appends and snapshots", () => {
    const m = createConversationMirror();
    m.append({ kind: "user", ts: 1, channel: "speech", content: "hi" });
    m.append({ kind: "assistant", ts: 2, content: "hello" });
    expect(m.snapshot()).toHaveLength(2);
  });

  it("caps at capacity", () => {
    const m = createConversationMirror(3);
    for (let i = 0; i < 5; i++) {
      m.append({ kind: "user", ts: i, channel: "text", content: String(i) });
    }
    const s = m.snapshot();
    expect(s).toHaveLength(3);
    expect((s[0] as { content: string }).content).toBe("2");
  });

  it("clears", () => {
    const m = createConversationMirror();
    m.append({ kind: "user", ts: 1, channel: "text", content: "x" });
    m.clear();
    expect(m.snapshot()).toEqual([]);
  });

  it("accepts assistant entry with cutoff", () => {
    const m = createConversationMirror();
    m.append({
      kind: "assistant",
      ts: 1,
      content: "half a reply",
      cutoff: { kind: "barge-in" },
    });
    const s = m.snapshot();
    const first = s[0] as Extract<(typeof s)[number], { kind: "assistant" }>;
    expect(first.cutoff?.kind).toBe("barge-in");
  });
});
```

### Step 1.1.5c: TaskMirror

Per spec v3/v4 §5.7. Ephemeral live-table of tool calls for UI `task.update`.

- [ ] Create `gateway/src/cerebrum/task-mirror.ts`:

```typescript
import { createLogger } from "@sentient/logging";

const log = createLogger(["sentient.gateway.cerebrum", "task-mirror"]);

export interface TaskRecord {
  taskId: string;
  toolName: string;
  cycleId: string;
  status: "running" | "finished" | "cancelled" | "failed";
  argsPreview: string;
  startedAtMs: number;
  endedAtMs?: number;
}

export interface TaskMirror {
  start(record: Omit<TaskRecord, "status" | "startedAtMs" | "endedAtMs">): TaskRecord;
  finish(taskId: string, status: "finished" | "failed", endedAtMs?: number): TaskRecord | null;
  cancel(taskId: string, endedAtMs?: number): TaskRecord | null;
  snapshot(): readonly TaskRecord[];
  clearCycle(cycleId: string): void;
}

export function createTaskMirror(): TaskMirror {
  const records = new Map<string, TaskRecord>();

  return {
    start(input) {
      const r: TaskRecord = {
        ...input,
        status: "running",
        startedAtMs: Date.now(),
      };
      log.debug("start", { taskId: r.taskId, toolName: r.toolName });
      records.set(r.taskId, r);
      return r;
    },
    finish(taskId, status, endedAtMs = Date.now()) {
      const r = records.get(taskId);
      if (!r) {
        log.debug("finish.unknown", { taskId });
        return null;
      }
      r.status = status;
      r.endedAtMs = endedAtMs;
      log.debug("finish", { taskId, status });
      return r;
    },
    cancel(taskId, endedAtMs = Date.now()) {
      const r = records.get(taskId);
      if (!r) return null;
      r.status = "cancelled";
      r.endedAtMs = endedAtMs;
      log.debug("cancel", { taskId });
      return r;
    },
    snapshot() {
      return [...records.values()];
    },
    clearCycle(cycleId) {
      for (const [id, r] of records) {
        if (r.cycleId === cycleId && r.status === "running") {
          r.status = "cancelled";
          r.endedAtMs = Date.now();
        }
      }
      log.debug("clearCycle", { cycleId });
    },
  };
}
```

### Step 1.1.5d: Tests for TaskMirror

- [ ] Create `gateway/src/cerebrum/task-mirror.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createTaskMirror } from "./task-mirror";

describe("TaskMirror", () => {
  it("starts a task with running status", () => {
    const m = createTaskMirror();
    const r = m.start({
      taskId: "t1",
      toolName: "search",
      cycleId: "c1",
      argsPreview: "{}",
    });
    expect(r.status).toBe("running");
    expect(r.startedAtMs).toBeGreaterThan(0);
  });

  it("finishes a task", () => {
    const m = createTaskMirror();
    m.start({ taskId: "t1", toolName: "x", cycleId: "c1", argsPreview: "" });
    const r = m.finish("t1", "finished");
    expect(r?.status).toBe("finished");
    expect(r?.endedAtMs).toBeGreaterThan(0);
  });

  it("returns null for finish of unknown task", () => {
    const m = createTaskMirror();
    expect(m.finish("nope", "finished")).toBeNull();
  });

  it("clearCycle cancels running tasks for that cycle only", () => {
    const m = createTaskMirror();
    m.start({ taskId: "t1", toolName: "x", cycleId: "c1", argsPreview: "" });
    m.start({ taskId: "t2", toolName: "y", cycleId: "c2", argsPreview: "" });
    m.clearCycle("c1");
    const snap = m.snapshot();
    expect(snap.find((r) => r.taskId === "t1")?.status).toBe("cancelled");
    expect(snap.find((r) => r.taskId === "t2")?.status).toBe("running");
  });
});
```

### Step 1.1.5e: Verify + commit

- [ ] `source scripts/env.sh && bun run --filter @sentient/gateway test:unit -- mirror`
- [ ] Commit:

```bash
git add gateway/src/cerebrum/conversation-mirror.ts gateway/src/cerebrum/conversation-mirror.test.ts gateway/src/cerebrum/task-mirror.ts gateway/src/cerebrum/task-mirror.test.ts
git commit -m "$(cat <<'EOF'
feat(cerebrum): ConversationMirror + TaskMirror (UI feed + live tasks)

ConversationMirror: bounded FIFO mirroring what the client sees; NOT an
LLM context store (Hermes owns that). Cap default 500, configurable.
TaskMirror: ephemeral live table of tool calls per cycle for task.update
wire messages and sidebar UI.

Both are pure in-memory stubs in Phase 1.1; Phase 1.2 wires them into
the HermesClient event translator.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.1.6 — Profile templates

**Files:**
- Create: `gateway/templates/SOUL.md.tmpl`
- Create: `gateway/templates/hermes-profile.yaml.tmpl`

### Step 1.1.6a: Write SOUL.md template

- [ ] Create `gateway/templates/SOUL.md.tmpl`:

```markdown
# SOUL

You are a family voice assistant. You live on a small device in the home of {{USER_NAME}}.

## Voice-first behavior
- Your responses are primarily spoken out loud.
- Keep replies conversational — 1 to 3 sentences for casual questions; longer when the user asks for an explanation or the topic warrants it.
- Rich formatting in your reply is fine; it renders in the user's visible chat and is stripped cleanly before speech.

## Home control
- You can control Home Assistant devices through the tools provided.
- Anything the household has explicitly exposed in Home Assistant is available.
- For actions that change state (locks, alarms, large groups of lights), the system may ask the user to confirm — that is expected and safe.

## Web search
- You have `search` and `fetch_content` tools for current information.
- Lead with the direct answer; cite the source by name ("according to Wikipedia…") when useful.

## Identity
- You belong to {{USER_NAME}}. Their preferences, their memory.
- If {{USER_NAME}} says "I am X" where X is a known household member, call the `identify_user` tool with that name — this hands the session to that person's assistant.
- If X is unknown, ask for clarification rather than guessing.

## Quiet defaults
- You are a household assistant, not an encyclopedia. Prefer brief, helpful responses.
- If the user didn't ask a question, you don't need to say anything.

---
Last rendered: {{RENDERED_AT}}
```

### Step 1.1.6b: Write Hermes profile config template

- [ ] Create `gateway/templates/hermes-profile.yaml.tmpl`:

```yaml
# Auto-generated from gateway/templates/hermes-profile.yaml.tmpl at {{RENDERED_AT}}
# User: {{USER_NAME}}

model:
  provider: openrouter
  model: google/gemini-2.5-flash

providers:
  openrouter:
    base_url: http://egress-proxy:3128/openrouter
    api_key_env: OPENROUTER_API_KEY

agent:
  max_turns: 6
  reasoning_effort: medium

memory:
  memory_enabled: true
  user_profile_enabled: true
  char_limits:
    memory: 20000
    user_profile: 8000

compression:
  enabled: true
  flush_per_turn: true

approvals:
  mode: smart
  timeout_seconds: 60
  fail_closed: true

terminal:
  backend: local

# Disable broad toolsets we don't want the agent to have
disabled_toolsets:
  - shell
  - file_write
  - file_edit
  - code_execute
  - web_extract     # we don't install [browser]
  - skill_create    # user profiles don't auto-create skills in v1

security:
  redact_secrets: true
  tirith:
    enabled: true

privacy:
  redact_pii: false

platforms:
  homeassistant:
    enabled: false   # we observe HA ourselves via gateway

mcp_servers:
  home_assistant:
    url: http://homeassistant.local:8123/mcp_server/sse
    headers:
      Authorization: "Bearer ${HA_MCP_TOKEN}"
    timeout: 15
    connect_timeout: 5
    # NOTE: no tools.exclude per spec D-19 — HA Expose UI is the allowlist.

  duckduckgo:
    command: duckduckgo-mcp-server
    timeout: 30
    connect_timeout: 10

  gateway:
    command: nc
    args: ["-U", "/run/sentient/mcp.sock"]
    tools:
      include:
        - identify_user
        - pause_audio
        - resume_audio
        - set_channel

display:
  tool_progress: true
  streaming: true
  show_reasoning: false
  personality: minimal
```

### Step 1.1.6c: Commit

- [ ] `git add gateway/templates/`
- [ ] Commit:

```bash
git commit -m "$(cat <<'EOF'
feat(templates): SOUL.md + Hermes profile config templates

Rendered per user at profile bootstrap (Phase 1.7). Templates embed
the trust-the-pipeline prompt philosophy from spec §5.16.5: markdown
is fine, length is what matters. Tool list matches Phase 1 roster
(HA full exposure, DDG web tools, gateway-hosted MCP).

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.1.7 — Dev `docker-compose.yml` with alice profile

**Files:**
- Modify: `deploy/docker/docker-compose.yml` (add `hermes-alice` service, internal network, secret)
- Create: `deploy/docker/secrets/hermes_api_key_alice.example` (template, NOT a real secret)
- Create: `deploy/docker/secrets/.gitignore` (ignore real secret files)
- Create: `profiles/alice/config.yaml` (rendered from template; committed for dev)
- Create: `profiles/alice/SOUL.md` (rendered from template; committed for dev)
- Create: `profiles/alice/.env.example`

### Step 1.1.7a: Author the dev alice profile

- [ ] First, render the template manually into `profiles/alice/config.yaml`:

```bash
# from repo root
mkdir -p profiles/alice
# Render: substitute {{USER_NAME}} → alice, {{RENDERED_AT}} → ISO timestamp
sed -e "s/{{USER_NAME}}/alice/g" \
    -e "s/{{RENDERED_AT}}/$(date -u +%Y-%m-%dT%H:%M:%SZ)/g" \
    gateway/templates/hermes-profile.yaml.tmpl \
    > profiles/alice/config.yaml

sed -e "s/{{USER_NAME}}/Alice/g" \
    -e "s/{{RENDERED_AT}}/$(date -u +%Y-%m-%dT%H:%M:%SZ)/g" \
    gateway/templates/SOUL.md.tmpl \
    > profiles/alice/SOUL.md
```

- [ ] Create `profiles/alice/.env.example`:

```bash
# Copy to .env and fill in real secrets.
# .env MUST NOT be committed.
OPENROUTER_API_KEY=sk-or-v1-REPLACE
HA_MCP_TOKEN=REPLACE_WITH_HA_LLAT
# Hermes API server auth
# Set in the mounted Docker secret, not .env
```

### Step 1.1.7b: Set up secrets dir

- [ ] Create `deploy/docker/secrets/.gitignore`:

```
# Never commit real secrets
*
!.gitignore
!*.example
```

- [ ] Create `deploy/docker/secrets/hermes_api_key_alice.example`:

```
# Copy this to hermes_api_key_alice (no extension) and replace with a real key.
# chmod 600 hermes_api_key_alice
# The gateway reads this via Docker secret mount; Hermes container reads it
# from /run/secrets/hermes_api_key_alice.
#
# Generate: openssl rand -hex 32
REPLACE_WITH_HEX_32
```

- [ ] Add profiles/ to .gitignore too if not already — we WILL commit alice's config.yaml + SOUL.md for dev convenience but NOT .env. Check `.gitignore`:

```bash
grep -q "profiles/\*/\.env$" .gitignore || echo "profiles/*/.env" >> .gitignore
```

### Step 1.1.7c: Extend docker-compose.yml

- [ ] Open `deploy/docker/docker-compose.yml`. Add networks section (if not present):

```yaml
networks:
  sentient-internal:
    driver: bridge
    internal: true
  sentient-external:
    driver: bridge
```

- [ ] Add secrets section:

```yaml
secrets:
  hermes_api_key_alice:
    file: ./secrets/hermes_api_key_alice
```

- [ ] Add the hermes-alice service:

```yaml
services:
  # ... existing services (gateway, stt-service, etc.) ...

  hermes-alice:
    build:
      context: ./hermes
      dockerfile: Dockerfile.slim
    image: sentient-hermes:slim
    user: "1000:1000"
    read_only: true
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
    pids_limit: 256
    tmpfs:
      - /tmp:size=256M,nosuid
      - /var/tmp:size=128M,noexec,nosuid
      - /run:size=64M,noexec,nosuid
    volumes:
      - type: bind
        source: ../../profiles/alice
        target: /data
    environment:
      HERMES_HOME: /data
      API_SERVER_ENABLED: "true"
      API_SERVER_PORT: "8643"
      API_SERVER_KEY_FILE: /run/secrets/hermes_api_key_alice
    env_file:
      - ../../profiles/alice/.env
    secrets:
      - hermes_api_key_alice
    networks: [sentient-internal]
    # Port NOT exposed to host — only gateway container dials via service name.
    mem_limit: 768m
    cpus: "1.0"
    restart: on-failure
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS -H \"Authorization: Bearer $$(cat $$API_SERVER_KEY_FILE)\" http://localhost:8643/health || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
```

- [ ] Ensure the `gateway` service joins both networks:

```yaml
  gateway:
    # ... existing config ...
    networks: [sentient-internal, sentient-external]
```

### Step 1.1.7d: Smoke test the compose

- [ ] Generate a real dev bearer key locally (not committed):

```bash
openssl rand -hex 32 > deploy/docker/secrets/hermes_api_key_alice
chmod 600 deploy/docker/secrets/hermes_api_key_alice
```

- [ ] Create `profiles/alice/.env` (not committed):

```bash
cp profiles/alice/.env.example profiles/alice/.env
# Edit profiles/alice/.env with real OPENROUTER_API_KEY and HA_MCP_TOKEN
```

- [ ] Boot compose:

```bash
cd deploy/docker && docker compose up -d hermes-alice && sleep 5 && docker compose ps hermes-alice
```

- [ ] Expected: `hermes-alice` is healthy (status: `healthy` after ~30 s).
- [ ] Tear down:

```bash
docker compose down
```

### Step 1.1.7e: Commit

- [ ] Verify .gitignore is right — `profiles/alice/.env` should NOT be tracked:

```bash
git status
```

If `profiles/alice/.env` appears in untracked, you forgot the .gitignore. Fix before committing.

- [ ] Commit the config + SOUL + templates + compose + secrets stubs:

```bash
git add profiles/alice/config.yaml profiles/alice/SOUL.md profiles/alice/.env.example \
        deploy/docker/docker-compose.yml deploy/docker/secrets/.gitignore \
        deploy/docker/secrets/hermes_api_key_alice.example \
        .gitignore
git commit -m "$(cat <<'EOF'
feat(deploy): dev docker-compose with hermes-alice profile

Spawns a single Hermes container for user "alice" on internal network.
Rendered profile config + SOUL.md committed for dev convenience;
.env stays gitignored. Healthcheck via /health endpoint; container
starts in 30s budget per spec §5.1.

Co-Authored-By: <your-model-id>
EOF
)"
```

---

## Task 1.1.8 — Quality gate

- [ ] Check no containers are on the ports tests use:

```bash
docker ps --format "table {{.Names}}\t{{.Ports}}"
```

Stop anything on 8888 (gateway) before tests.

- [ ] Run full CI:

```bash
source scripts/env.sh && bun run ci
```

Expected: green. If fails, fix before merging to develop.

- [ ] Confirm commit log:

```bash
git log --oneline develop..HEAD
```

Expected: ~5–7 commits landing this phase's deliverables.

---

## Done

Phase 1.1 complete when all tasks checked off + CI green. Deliverables on branch:

- [ ] `deploy/docker/hermes/Dockerfile.slim` + .dockerignore + README
- [ ] `shared/config/src/schemas/hermes-config.ts` (+ test)
- [ ] `gateway/config.yaml` with `hermes:` section and `cerebrum.provider`
- [ ] `gateway/src/cerebrum/hermes-event-types.ts` (+ test)
- [ ] `gateway/src/cerebrum/hermes-client.ts` skeleton (+ test)
- [ ] `gateway/src/session-router.ts` skeleton (+ test)
- [ ] `gateway/src/cerebrum/conversation-mirror.ts` (+ test)
- [ ] `gateway/src/cerebrum/task-mirror.ts` (+ test)
- [ ] `gateway/templates/SOUL.md.tmpl` + `hermes-profile.yaml.tmpl`
- [ ] `profiles/alice/{config.yaml,SOUL.md,.env.example}` committed; `.env` gitignored
- [ ] `deploy/docker/docker-compose.yml` with `hermes-alice` service + internal network
- [ ] `deploy/docker/secrets/` with `.gitignore` + example

**Proceed to** `2026-04-21-hermes-phase1.2-wire-parity.md` to wire the real SSE consumer.
