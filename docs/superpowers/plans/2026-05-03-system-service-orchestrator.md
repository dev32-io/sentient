# System Service Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the gateway full ownership of every shared service container in the deployment via a system-level orchestrator, so the setup wizard can drive a race-free first bring-up and Settings can drive secret-rotation restarts through a single apply path.

**Architecture:** Two orchestrators (per-user, system) share a single `POST /api/v1/apply` router. The router does auth + RBAC + diff splitting; per-user diffs route to the existing supervisord-based orchestrator, system-level diffs route to a new dockerode-based orchestrator. Service templates are baked into the gateway image and gated by a config-driven policy layer in `gateway/config.yaml#managed_services`. A new wizard step `step-bringup` polls orchestrator state between secret submission and first-admin creation. Reference design: `docs/superpowers/specs/2026-05-03-system-service-orchestrator-design.md`.

**Tech Stack:** Bun + TypeScript (strict), zod for validation, dockerode for docker socket I/O, yaml package for template parsing, Preact + Vite for the wizard, vitest for integration tests. Tests use `bun test` for unit (colocated `*.test.ts`), vitest for `*.integration.test.ts`.

---

## Conventions

- **Source of truth for paths:** absolute repo-relative.
- **Test runner:** `cd gateway/src && bun test <file>` for unit, `cd gateway && bun run test:int <file>` for integration. Webui uses vitest in `gateway/webui/`.
- **Logging:** every new `.ts` imports `getLog` from `gateway/src/logging/logger.js`. Never bare `console`.
- **Result type:** all failable functions return `Result<T, E>` from `@sentient/protocol`.
- **Canonical service-name set:** `egress-proxy`, `sentient-hermes`, `stt-service`, `ddg-mcp`, `ha-mcp`, `ma-mcp`. Required: first four. Optional: `ha-mcp`, `ma-mcp`.
- **Container labels:** every managed container carries `sentient.managed=true` and `sentient.service=<name>`.

---

### Task 0: Re-add `profile-defaults.ts`

The previous refactor (commit `47a113e`) deleted `gateway/src/profile-store/profile-defaults.ts` and left wizard-built profiles with empty `tools.enabled` + `tools.toolsets`. New users currently come up with no MCP servers and no built-in toolsets. This task is independent of the orchestrator work but blocks usable smoke testing, so it ships first.

**Files:**
- Create: `gateway/src/profile-store/profile-defaults.ts`
- Modify: `gateway/src/api/handlers/admin.ts` (POST /admin/users — merge defaults into incoming partial profile)
- Modify: `gateway/src/api/handlers/auth.ts` (first-admin creation — same merge)
- Test: `gateway/src/profile-store/profile-defaults.test.ts`

- [ ] **Step 1: Write the failing test**

Create `gateway/src/profile-store/profile-defaults.test.ts`:
```ts
import { test, expect } from "bun:test";
import { applyProfileDefaults } from "./profile-defaults.js";

test("applyProfileDefaults seeds tools.enabled and tools.toolsets when caller omits them", () => {
  const partial = {
    schemaVersion: 1 as const,
    userId: "u_test",
    model: { provider: "openrouter" as const, id: "google/gemini-2.5-flash" },
    voice: { provider: "fish-audio" as const, id: "abc" },
    persona: { template: "default", overrides: "" },
    tools: { enabled: {}, toolsets: [] },
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024 },
  };

  const out = applyProfileDefaults(partial);

  expect(out.tools.enabled).toEqual({
    home_assistant: [],
    gateway: [],
    music_assistant: [],
    duckduckgo: [],
  });
  expect(out.tools.toolsets).toEqual([
    "memory", "todo", "clarify", "skills", "session_search", "messaging",
  ]);
});

test("applyProfileDefaults preserves caller-provided tools.enabled overrides", () => {
  const partial = {
    schemaVersion: 1 as const,
    userId: "u_test",
    model: { provider: "openrouter" as const, id: "x" },
    voice: { provider: "fish-audio" as const, id: "y" },
    persona: { template: "default", overrides: "" },
    tools: { enabled: { duckduckgo: ["search"] }, toolsets: ["memory"] },
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024 },
  };
  const out = applyProfileDefaults(partial);
  expect(out.tools.enabled).toEqual({ duckduckgo: ["search"] });
  expect(out.tools.toolsets).toEqual(["memory"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway/src && bun test profile-store/profile-defaults.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `profile-defaults.ts`**

Create `gateway/src/profile-store/profile-defaults.ts`:
```ts
import type { ProfileV1 } from "./profile-types.js";

const DEFAULT_TOOLS_ENABLED: Record<string, string[]> = {
  home_assistant: [],
  gateway: [],
  music_assistant: [],
  duckduckgo: [],
};

const DEFAULT_TOOLSETS = [
  "memory",
  "todo",
  "clarify",
  "skills",
  "session_search",
  "messaging",
];

/**
 * Returns a profile with default tools.enabled / tools.toolsets seeded when
 * the caller didn't supply any. Used by the wizard and admin user creation
 * to give every new user the curated MCP/toolset starter set.
 *
 * Caller-provided enabled or toolsets are preserved as-is (any non-empty
 * value wins), so settings rotation and explicit zeros are respected.
 */
export function applyProfileDefaults(p: ProfileV1): ProfileV1 {
  const enabledIsEmpty = Object.keys(p.tools.enabled).length === 0;
  const toolsetsIsEmpty = p.tools.toolsets.length === 0;
  return {
    ...p,
    tools: {
      enabled: enabledIsEmpty ? { ...DEFAULT_TOOLS_ENABLED } : p.tools.enabled,
      toolsets: toolsetsIsEmpty ? [...DEFAULT_TOOLSETS] : p.tools.toolsets,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway/src && bun test profile-store/profile-defaults.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 5: Wire into admin user creation**

Modify `gateway/src/api/handlers/admin.ts` around line 109. Find `const profile = { ...parsed.data.profile, schemaVersion: PROFILE_SCHEMA_VERSION as 1, userId: "" };` and replace with:
```ts
import { applyProfileDefaults } from "../../profile-store/profile-defaults.js";
// ...
const rawProfile = { ...parsed.data.profile, schemaVersion: PROFILE_SCHEMA_VERSION as 1, userId: "" };
const profile = applyProfileDefaults(rawProfile);
```

- [ ] **Step 6: Wire into first-admin creation**

Modify `gateway/src/api/handlers/auth.ts` around line 100. Find `const profile = { ...data.profile, schemaVersion: PROFILE_SCHEMA_VERSION as 1, userId: "" };` and replace with:
```ts
import { applyProfileDefaults } from "../../profile-store/profile-defaults.js";
// ...
const rawProfile = { ...data.profile, schemaVersion: PROFILE_SCHEMA_VERSION as 1, userId: "" };
const profile = applyProfileDefaults(rawProfile);
```

- [ ] **Step 7: Run typecheck**

Run: `cd gateway && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add gateway/src/profile-store/profile-defaults.ts \
        gateway/src/profile-store/profile-defaults.test.ts \
        gateway/src/api/handlers/admin.ts \
        gateway/src/api/handlers/auth.ts
git commit -m "feat(profile): re-add profile-defaults; restore curated MCP/toolset defaults

Wizard-built profiles were going through with empty tools.enabled and
tools.toolsets after the buildDefaultProfile drop. New users came up
with no MCP servers and no built-in toolsets. applyProfileDefaults()
seeds the same curated set buildDefaultProfile used to apply, called
at admin and first-admin creation."
```

---

### Task 1: Add `dockerode` dependency

The system orchestrator dials the docker daemon over the unix socket via dockerode. This task is just the dep add + a smoke import to verify it loads under bun.

**Files:**
- Modify: `gateway/package.json`
- Test: `gateway/src/system-orchestrator/dockerode-import.test.ts`

- [ ] **Step 1: Add the dep**

Run from repo root:
```bash
cd gateway && bun add dockerode @types/dockerode
```

- [ ] **Step 2: Write the failing test**

Create `gateway/src/system-orchestrator/dockerode-import.test.ts`:
```ts
import { test, expect } from "bun:test";

test("dockerode imports cleanly under bun", async () => {
  const Dockerode = (await import("dockerode")).default;
  expect(typeof Dockerode).toBe("function");
});
```

- [ ] **Step 3: Run test**

Run: `cd gateway/src && bun test system-orchestrator/dockerode-import.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add gateway/package.json gateway/bun.lock \
        gateway/src/system-orchestrator/dockerode-import.test.ts
git commit -m "build(gateway): add dockerode for system orchestrator"
```

---

### Task 2: System orchestrator types

Defines the canonical type shape consumed by every other system-orchestrator file. Pure types + zod schemas; no runtime behavior beyond schema construction.

**Files:**
- Create: `gateway/src/system-orchestrator/types.ts`
- Test: `gateway/src/system-orchestrator/types.test.ts`

- [ ] **Step 1: Write the failing test**

Create `gateway/src/system-orchestrator/types.test.ts`:
```ts
import { test, expect } from "bun:test";
import { ManagedServiceConfigSchema, ServiceTemplateSchema } from "./types.js";

test("ManagedServiceConfigSchema parses a valid entry", () => {
  const r = ManagedServiceConfigSchema.safeParse({
    template: "ha-mcp.yaml",
    allowed_images: ["ghcr.io/homeassistant-ai/ha-mcp:stable"],
    networks: ["sentient-internal"],
    secrets: { HOMEASSISTANT_TOKEN: "home_assistant.mcp_server_token" },
    healthcheck: { url: "http://ha-mcp:8086/health", timeout_ms: 30000 },
    depends_on: ["egress-proxy"],
    optional: true,
  });
  expect(r.success).toBe(true);
});

test("ManagedServiceConfigSchema rejects empty allowed_images", () => {
  const r = ManagedServiceConfigSchema.safeParse({
    template: "x.yaml",
    allowed_images: [],
    networks: ["sentient-internal"],
    healthcheck: { url: "http://x/health", timeout_ms: 1000 },
  });
  expect(r.success).toBe(false);
});

test("ServiceTemplateSchema parses a minimal spec", () => {
  const r = ServiceTemplateSchema.safeParse({
    image: "alpine:latest",
    container_name: "test",
    networks: ["sentient-internal"],
    env: { FOO: "bar" },
  });
  expect(r.success).toBe(true);
});

test("ServiceTemplateSchema rejects port bindings", () => {
  const r = ServiceTemplateSchema.safeParse({
    image: "alpine:latest",
    container_name: "test",
    networks: ["sentient-internal"],
    ports: ["80:80"],
  });
  expect(r.success).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway/src && bun test system-orchestrator/types.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement types**

Create `gateway/src/system-orchestrator/types.ts`:
```ts
import { z } from "zod";

export const ServiceNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
export type ServiceName = z.infer<typeof ServiceNameSchema>;

export const HealthCheckSchema = z.union([
  z.object({ url: z.string().url(), timeout_ms: z.number().int().positive() }),
  z.object({ tcp: z.string(), timeout_ms: z.number().int().positive() }),
  z.object({ exec: z.array(z.string()).nonempty(), timeout_ms: z.number().int().positive() }),
]);
export type HealthCheck = z.infer<typeof HealthCheckSchema>;

export const ManagedServiceConfigSchema = z.object({
  template: z.string().min(1),
  allowed_images: z.array(z.string().min(1)).nonempty(),
  networks: z.array(z.string().min(1)).nonempty(),
  secrets: z.record(z.string(), z.string()).optional().default({}),
  healthcheck: HealthCheckSchema,
  depends_on: z.array(ServiceNameSchema).optional().default([]),
  optional: z.boolean().optional().default(false),
});
export type ManagedServiceConfig = z.infer<typeof ManagedServiceConfigSchema>;

/** Parsed YAML template body. The orchestrator forbids `ports`. Any volume
 *  must be bind-mountable from a path the gateway controls. */
export const ServiceTemplateSchema = z.object({
  image: z.string().min(1),
  container_name: z.string().min(1),
  networks: z.array(z.string().min(1)).nonempty(),
  env: z.record(z.string(), z.string()).optional().default({}),
  volumes: z.array(z.string()).optional().default([]),
  command: z.array(z.string()).optional(),
  extra_hosts: z.array(z.string()).optional().default([]),
  mem_limit_bytes: z.number().int().positive().optional(),
  cpus: z.number().positive().optional(),
  group_add: z.array(z.string()).optional().default([]),
  // The presence of `ports` (host port mapping) is a policy violation.
  ports: z.never().optional(),
});
export type ServiceTemplate = z.infer<typeof ServiceTemplateSchema>;

/** State exposed for UI + apply-bar consumption. */
export type ServiceState =
  | "pending"
  | "starting"
  | "health-checking"
  | "ready"
  | "degraded"
  | "failed"
  | "blocked-by-dep"
  | "pending-secrets";

export interface ServiceStatus {
  name: ServiceName;
  state: ServiceState;
  optional: boolean;
  version: string | null;
  lastError: string | null;
}

export interface OrchestratorStatus {
  state: "idle" | "planning" | "applying" | "ready" | "failed";
  services: ServiceStatus[];
  startedAt: number | null;
  finishedAt: number | null;
}

export type ManagedService = {
  name: ServiceName;
  config: ManagedServiceConfig;
  template: ServiceTemplate;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway/src && bun test system-orchestrator/types.test.ts`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/system-orchestrator/types.ts \
        gateway/src/system-orchestrator/types.test.ts
git commit -m "feat(system-orch): types + zod schemas for managed services"
```

---

### Task 3: Template loader

Reads `gateway/templates/services/<name>.yaml`, parses YAML, substitutes `${SECRET}` placeholders from a callable secrets accessor, and validates the result. Returns a typed `ServiceTemplate` or a typed error.

**Files:**
- Create: `gateway/src/system-orchestrator/template-loader.ts`
- Test: `gateway/src/system-orchestrator/template-loader.test.ts`

- [ ] **Step 1: Write the failing test**

Create `gateway/src/system-orchestrator/template-loader.test.ts`:
```ts
import { test, expect } from "bun:test";
import { loadServiceTemplate, type SecretAccessor } from "./template-loader.js";

const yaml = `
image: ghcr.io/homeassistant-ai/ha-mcp:stable
container_name: sentient-ha-mcp
networks: [sentient-internal]
env:
  HOMEASSISTANT_TOKEN: \${HOMEASSISTANT_TOKEN}
  HOMEASSISTANT_URL: \${HOMEASSISTANT_URL}
`;

const secretsMap: Record<string, string | null> = {
  "home_assistant.mcp_server_token": "tok_abc",
  "home_assistant.url": "http://ha:8123",
};

const accessor: SecretAccessor = {
  resolve: (path) => secretsMap[path] ?? null,
};

test("substitutes env vars from secret bindings", async () => {
  const r = await loadServiceTemplate({
    yamlBody: yaml,
    secretBindings: {
      HOMEASSISTANT_TOKEN: "home_assistant.mcp_server_token",
      HOMEASSISTANT_URL: "home_assistant.url",
    },
    secrets: accessor,
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.env.HOMEASSISTANT_TOKEN).toBe("tok_abc");
  expect(r.value.env.HOMEASSISTANT_URL).toBe("http://ha:8123");
});

test("returns missing-secret error when a binding has no value", async () => {
  const r = await loadServiceTemplate({
    yamlBody: yaml,
    secretBindings: {
      HOMEASSISTANT_TOKEN: "home_assistant.mcp_server_token",
      HOMEASSISTANT_URL: "home_assistant.url",
    },
    secrets: { resolve: () => null },
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("missing-secret");
});

test("returns parse-error for bad yaml", async () => {
  const r = await loadServiceTemplate({
    yamlBody: "image: [unterminated",
    secretBindings: {},
    secrets: accessor,
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("parse-error");
});

test("returns policy-violation when template carries ports", async () => {
  const r = await loadServiceTemplate({
    yamlBody: `image: alpine\ncontainer_name: x\nnetworks: [sentient-internal]\nports: ["80:80"]\n`,
    secretBindings: {},
    secrets: accessor,
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("policy-violation");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway/src && bun test system-orchestrator/template-loader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement template-loader**

Create `gateway/src/system-orchestrator/template-loader.ts`:
```ts
import { parse as parseYaml } from "yaml";
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import { ServiceTemplateSchema, type ServiceTemplate } from "./types.js";

const log = getLog(["sentient", "system-orch", "template-loader"]);

export interface SecretAccessor {
  /** Returns the secret value for a dotted path like
   *  `home_assistant.mcp_server_token`, or null if missing. */
  resolve(path: string): string | null;
}

export type TemplateError =
  | { kind: "parse-error"; reason: string }
  | { kind: "schema-error"; reason: string }
  | { kind: "policy-violation"; reason: string }
  | { kind: "missing-secret"; envVar: string; path: string };

export interface LoadTemplateInput {
  yamlBody: string;
  /** env-var name → dotted secret path. */
  secretBindings: Record<string, string>;
  secrets: SecretAccessor;
}

const PLACEHOLDER_RE = /\$\{([A-Z][A-Z0-9_]*)\}/g;

export async function loadServiceTemplate(
  input: LoadTemplateInput,
): Promise<Result<ServiceTemplate, TemplateError>> {
  // Substitute first so an unresolved ${SECRET} surfaces as missing-secret
  // before zod ever sees the body.
  const substituted = substituteEnvPlaceholders(
    input.yamlBody,
    input.secretBindings,
    input.secrets,
  );
  if (!substituted.ok) return substituted;

  let parsed: unknown;
  try {
    parsed = parseYaml(substituted.value);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn("template.parse-error", { reason });
    return { ok: false, error: { kind: "parse-error", reason } };
  }

  // Reject port-binding shapes BEFORE schema parse so the error is specific.
  if (parsed && typeof parsed === "object" && "ports" in (parsed as Record<string, unknown>)) {
    return {
      ok: false,
      error: { kind: "policy-violation", reason: "ports field is forbidden" },
    };
  }

  const result = ServiceTemplateSchema.safeParse(parsed);
  if (!result.success) {
    const reason = result.error.message;
    log.warn("template.schema-error", { reason });
    return { ok: false, error: { kind: "schema-error", reason } };
  }
  return { ok: true, value: result.data };
}

function substituteEnvPlaceholders(
  body: string,
  bindings: Record<string, string>,
  secrets: SecretAccessor,
): Result<string, TemplateError> {
  let firstError: TemplateError | null = null;
  const out = body.replace(PLACEHOLDER_RE, (whole, envVar: string) => {
    const path = bindings[envVar];
    if (path === undefined) {
      // Placeholder for a var with no binding stays literal — operator probably
      // needs it from the container's own runtime env (rare); leave unchanged.
      return whole;
    }
    const value = secrets.resolve(path);
    if (value === null) {
      firstError ??= { kind: "missing-secret", envVar, path };
      return whole;
    }
    return value;
  });
  if (firstError) return { ok: false, error: firstError };
  return { ok: true, value: out };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway/src && bun test system-orchestrator/template-loader.test.ts`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/system-orchestrator/template-loader.ts \
        gateway/src/system-orchestrator/template-loader.test.ts
git commit -m "feat(system-orch): template loader with secret substitution + policy gate"
```

---

### Task 4: Service registry

Loads the `managed_services` map from `gateway/config.yaml`, resolves each entry's template via the template-loader, validates against allowlists, and returns a typed `Map<ServiceName, ManagedService>`.

**Files:**
- Create: `gateway/src/system-orchestrator/service-registry.ts`
- Test: `gateway/src/system-orchestrator/service-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `gateway/src/system-orchestrator/service-registry.test.ts`:
```ts
import { test, expect } from "bun:test";
import { buildServiceRegistry } from "./service-registry.js";
import type { SecretAccessor } from "./template-loader.js";

const cfg = {
  "ha-mcp": {
    template: "ha-mcp.yaml",
    allowed_images: ["ghcr.io/homeassistant-ai/ha-mcp:stable"],
    networks: ["sentient-internal"],
    secrets: { HOMEASSISTANT_TOKEN: "home_assistant.mcp_server_token" },
    healthcheck: { url: "http://ha-mcp:8086/health", timeout_ms: 30000 },
    depends_on: ["egress-proxy"],
    optional: true,
  },
  "egress-proxy": {
    template: "egress-proxy.yaml",
    allowed_images: ["kalaksi/tinyproxy:latest"],
    networks: ["sentient-internal", "sentient-external"],
    healthcheck: { tcp: "egress-proxy:3128", timeout_ms: 5000 },
    depends_on: [],
    optional: false,
  },
};

const templates: Record<string, string> = {
  "ha-mcp.yaml":
    "image: ghcr.io/homeassistant-ai/ha-mcp:stable\ncontainer_name: sentient-ha-mcp\nnetworks: [sentient-internal]\nenv:\n  HOMEASSISTANT_TOKEN: ${HOMEASSISTANT_TOKEN}\n",
  "egress-proxy.yaml":
    "image: kalaksi/tinyproxy:latest\ncontainer_name: sentient-egress-proxy\nnetworks: [sentient-internal, sentient-external]\n",
};

const secrets: SecretAccessor = { resolve: () => "tok" };
const readTemplate = async (name: string) => templates[name] ?? "";

test("buildServiceRegistry returns one ManagedService per config entry", async () => {
  const r = await buildServiceRegistry({ config: cfg, readTemplate, secrets });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.size).toBe(2);
  expect(r.value.get("ha-mcp")?.template.image).toBe("ghcr.io/homeassistant-ai/ha-mcp:stable");
});

test("rejects entry whose template image is not in allowed_images", async () => {
  const bad = {
    "x": {
      ...cfg["ha-mcp"],
      allowed_images: ["different/image:v1"],
    },
  };
  const r = await buildServiceRegistry({ config: bad, readTemplate, secrets });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("policy-violation");
});

test("rejects entry whose template uses a network not in config.networks", async () => {
  const bad = {
    "x": {
      ...cfg["ha-mcp"],
      networks: ["sentient-external"], // template uses sentient-internal
    },
  };
  const r = await buildServiceRegistry({ config: bad, readTemplate, secrets });
  expect(r.ok).toBe(false);
});

test("rejects unknown depends_on target", async () => {
  const bad = {
    "ha-mcp": { ...cfg["ha-mcp"], depends_on: ["does-not-exist"] },
  };
  const r = await buildServiceRegistry({ config: bad, readTemplate, secrets });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("invalid-dependency");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway/src && bun test system-orchestrator/service-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement service-registry**

Create `gateway/src/system-orchestrator/service-registry.ts`:
```ts
import { z } from "zod";
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import { loadServiceTemplate, type SecretAccessor, type TemplateError } from "./template-loader.js";
import {
  ManagedServiceConfigSchema,
  ServiceNameSchema,
  type ManagedService,
  type ManagedServiceConfig,
  type ServiceName,
} from "./types.js";

const log = getLog(["sentient", "system-orch", "service-registry"]);

export type RegistryError =
  | { kind: "config-schema-error"; reason: string }
  | { kind: "template-error"; service: ServiceName; cause: TemplateError }
  | { kind: "policy-violation"; service: ServiceName; reason: string }
  | { kind: "invalid-dependency"; service: ServiceName; missing: ServiceName };

export interface BuildRegistryInput {
  config: Record<string, unknown>;
  readTemplate: (name: string) => Promise<string>;
  secrets: SecretAccessor;
}

const ConfigMapSchema = z.record(ServiceNameSchema, ManagedServiceConfigSchema);

export async function buildServiceRegistry(
  input: BuildRegistryInput,
): Promise<Result<Map<ServiceName, ManagedService>, RegistryError>> {
  const cfgParse = ConfigMapSchema.safeParse(input.config);
  if (!cfgParse.success) {
    return { ok: false, error: { kind: "config-schema-error", reason: cfgParse.error.message } };
  }

  const out = new Map<ServiceName, ManagedService>();
  for (const [name, cfg] of Object.entries(cfgParse.data)) {
    const tplResult = await loadOneTemplate(name, cfg as ManagedServiceConfig, input);
    if (!tplResult.ok) return tplResult;
    out.set(name, tplResult.value);
  }

  // depends_on validation needs the full set in hand.
  for (const ms of out.values()) {
    for (const dep of ms.config.depends_on) {
      if (!out.has(dep)) {
        return { ok: false, error: { kind: "invalid-dependency", service: ms.name, missing: dep } };
      }
    }
  }

  log.info("registry.built", { count: out.size, services: Array.from(out.keys()) });
  return { ok: true, value: out };
}

async function loadOneTemplate(
  name: ServiceName,
  cfg: ManagedServiceConfig,
  input: BuildRegistryInput,
): Promise<Result<ManagedService, RegistryError>> {
  const yamlBody = await input.readTemplate(cfg.template);
  const tplResult = await loadServiceTemplate({
    yamlBody,
    secretBindings: cfg.secrets,
    secrets: input.secrets,
  });
  if (!tplResult.ok) {
    return { ok: false, error: { kind: "template-error", service: name, cause: tplResult.error } };
  }
  const tpl = tplResult.value;

  if (!cfg.allowed_images.includes(tpl.image)) {
    return {
      ok: false,
      error: { kind: "policy-violation", service: name, reason: `image ${tpl.image} not in allowed_images` },
    };
  }
  for (const net of tpl.networks) {
    if (!cfg.networks.includes(net)) {
      return {
        ok: false,
        error: { kind: "policy-violation", service: name, reason: `template network ${net} not in config.networks` },
      };
    }
  }
  return { ok: true, value: { name, config: cfg, template: tpl } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway/src && bun test system-orchestrator/service-registry.test.ts`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/system-orchestrator/service-registry.ts \
        gateway/src/system-orchestrator/service-registry.test.ts
git commit -m "feat(system-orch): service registry with allowlist + dep validation"
```

---

### Task 5: Dependency graph

Topological sort over `depends_on`, with cycle detection and "blocked by failed dep" propagation.

**Files:**
- Create: `gateway/src/system-orchestrator/dep-graph.ts`
- Test: `gateway/src/system-orchestrator/dep-graph.test.ts`

- [ ] **Step 1: Write the failing test**

Create `gateway/src/system-orchestrator/dep-graph.test.ts`:
```ts
import { test, expect } from "bun:test";
import { topoOrder, blockedByFailedDeps } from "./dep-graph.js";

test("topoOrder returns deps before dependents", () => {
  const r = topoOrder({
    a: [],
    b: ["a"],
    c: ["a", "b"],
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.indexOf("a")).toBeLessThan(r.value.indexOf("b"));
  expect(r.value.indexOf("b")).toBeLessThan(r.value.indexOf("c"));
});

test("topoOrder detects cycles", () => {
  const r = topoOrder({
    a: ["b"],
    b: ["a"],
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("cycle");
});

test("topoOrder rejects unknown dependency targets", () => {
  const r = topoOrder({ a: ["ghost"] });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("unknown-dependency");
});

test("blockedByFailedDeps returns transitive set", () => {
  const out = blockedByFailedDeps(
    { a: [], b: ["a"], c: ["b"], d: [] },
    new Set(["a"]),
  );
  expect(out).toEqual(new Set(["b", "c"]));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway/src && bun test system-orchestrator/dep-graph.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement dep-graph**

Create `gateway/src/system-orchestrator/dep-graph.ts`:
```ts
import type { Result } from "@sentient/protocol";

export type DepGraphError =
  | { kind: "cycle"; nodes: string[] }
  | { kind: "unknown-dependency"; from: string; to: string };

export type DepMap = Record<string, ReadonlyArray<string>>;

/** Returns a topological ordering: every dependency precedes its dependents.
 *  Detects cycles + unknown targets. */
export function topoOrder(deps: DepMap): Result<string[], DepGraphError> {
  for (const [node, edges] of Object.entries(deps)) {
    for (const e of edges) {
      if (!(e in deps)) return { ok: false, error: { kind: "unknown-dependency", from: node, to: e } };
    }
  }

  const visited = new Set<string>();
  const stack = new Set<string>();
  const order: string[] = [];

  function visit(node: string, path: string[]): DepGraphError | null {
    if (stack.has(node)) {
      return { kind: "cycle", nodes: [...path, node] };
    }
    if (visited.has(node)) return null;
    stack.add(node);
    for (const dep of deps[node] ?? []) {
      const err = visit(dep, [...path, node]);
      if (err) return err;
    }
    stack.delete(node);
    visited.add(node);
    order.push(node);
    return null;
  }

  for (const node of Object.keys(deps)) {
    const err = visit(node, []);
    if (err) return { ok: false, error: err };
  }
  return { ok: true, value: order };
}

/** Returns the transitive set of nodes whose dependency set intersects
 *  `failed`. Used to mark services as `blocked-by-dep` once an upstream
 *  fails. Does not include the failed nodes themselves. */
export function blockedByFailedDeps(deps: DepMap, failed: ReadonlySet<string>): Set<string> {
  const blocked = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [node, edges] of Object.entries(deps)) {
      if (failed.has(node) || blocked.has(node)) continue;
      for (const e of edges) {
        if (failed.has(e) || blocked.has(e)) {
          blocked.add(node);
          changed = true;
          break;
        }
      }
    }
  }
  return blocked;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway/src && bun test system-orchestrator/dep-graph.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/system-orchestrator/dep-graph.ts \
        gateway/src/system-orchestrator/dep-graph.test.ts
git commit -m "feat(system-orch): dep graph with cycle detection + failed-dep propagation"
```

---

### Task 6: Secret binding

Maps a changed secret-kind (e.g. `home_assistant.mcp_server_token`) to the set of services that need to be recreated. Pure lookup over the registry's `secrets` field.

**Files:**
- Create: `gateway/src/system-orchestrator/secret-binding.ts`
- Test: `gateway/src/system-orchestrator/secret-binding.test.ts`

- [ ] **Step 1: Write the failing test**

Create `gateway/src/system-orchestrator/secret-binding.test.ts`:
```ts
import { test, expect } from "bun:test";
import { affectedServicesFor } from "./secret-binding.js";
import type { ManagedService } from "./types.js";

const fakeService = (name: string, secrets: Record<string, string>): ManagedService => ({
  name,
  config: {
    template: "x",
    allowed_images: ["x"],
    networks: ["sentient-internal"],
    secrets,
    healthcheck: { url: "http://x/health", timeout_ms: 1000 },
    depends_on: [],
    optional: false,
  },
  template: { image: "x", container_name: "x", networks: ["sentient-internal"], env: {}, volumes: [], extra_hosts: [], group_add: [] },
});

const registry = new Map<string, ManagedService>([
  ["ha-mcp", fakeService("ha-mcp", { HOMEASSISTANT_TOKEN: "home_assistant.mcp_server_token", HOMEASSISTANT_URL: "home_assistant.url" })],
  ["ma-mcp", fakeService("ma-mcp", { MUSIC_ASSISTANT_TOKEN: "music_assistant.token" })],
  ["ddg-mcp", fakeService("ddg-mcp", {})],
]);

test("returns services bound to the given secret path", () => {
  expect(affectedServicesFor(registry, ["home_assistant.mcp_server_token"])).toEqual(new Set(["ha-mcp"]));
});

test("collapses multiple secret changes into a unique service set", () => {
  expect(
    affectedServicesFor(registry, ["home_assistant.mcp_server_token", "home_assistant.url", "music_assistant.token"]),
  ).toEqual(new Set(["ha-mcp", "ma-mcp"]));
});

test("returns empty set when no service binds the path (e.g. tts.fish_audio)", () => {
  expect(affectedServicesFor(registry, ["tts.fish_audio.api_key"])).toEqual(new Set());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway/src && bun test system-orchestrator/secret-binding.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement secret-binding**

Create `gateway/src/system-orchestrator/secret-binding.ts`:
```ts
import type { ManagedService, ServiceName } from "./types.js";

export function affectedServicesFor(
  registry: Map<ServiceName, ManagedService>,
  changedPaths: ReadonlyArray<string>,
): Set<ServiceName> {
  const out = new Set<ServiceName>();
  const want = new Set(changedPaths);
  for (const ms of registry.values()) {
    for (const path of Object.values(ms.config.secrets)) {
      if (want.has(path)) {
        out.add(ms.name);
        break;
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway/src && bun test system-orchestrator/secret-binding.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/system-orchestrator/secret-binding.ts \
        gateway/src/system-orchestrator/secret-binding.test.ts
git commit -m "feat(system-orch): secret-path → affected-services mapping"
```

---

### Task 7: Health probe

Polls a service's `healthcheck` config (URL/TCP/exec) until success or timeout. Pure (callbacks injected for I/O), so it tests without docker.

**Files:**
- Create: `gateway/src/system-orchestrator/health.ts`
- Test: `gateway/src/system-orchestrator/health.test.ts`

- [ ] **Step 1: Write the failing test**

Create `gateway/src/system-orchestrator/health.test.ts`:
```ts
import { test, expect } from "bun:test";
import { pollHealthy, type HealthIO } from "./health.js";

const fakeIO = (responses: Array<boolean | "error">): HealthIO => {
  let i = 0;
  return {
    fetch: async () => {
      const r = responses[i++];
      if (r === undefined) return { ok: false };
      if (r === "error") throw new Error("boom");
      return { ok: r };
    },
    tcpProbe: async () => responses[i++] === true,
    execProbe: async () => (responses[i++] === true ? 0 : 1),
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 100); })(),
  };
};

test("pollHealthy returns ready on first ok response", async () => {
  const r = await pollHealthy({
    healthcheck: { url: "http://x/health", timeout_ms: 1000 },
    pollIntervalMs: 50,
    io: fakeIO([true]),
  });
  expect(r.ok).toBe(true);
});

test("pollHealthy keeps polling until timeout when never healthy", async () => {
  const r = await pollHealthy({
    healthcheck: { url: "http://x/health", timeout_ms: 200 },
    pollIntervalMs: 50,
    io: fakeIO([false, false, false, false, false]),
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("timeout");
});

test("pollHealthy returns timeout (with last error captured) on persistent fetch failure", async () => {
  const r = await pollHealthy({
    healthcheck: { url: "http://x/health", timeout_ms: 200 },
    pollIntervalMs: 50,
    io: fakeIO(["error", "error", "error", "error"]),
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("timeout");
  expect(r.error.lastError).toContain("boom");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway/src && bun test system-orchestrator/health.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement health**

Create `gateway/src/system-orchestrator/health.ts`:
```ts
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { HealthCheck } from "./types.js";

const log = getLog(["sentient", "system-orch", "health"]);

export type HealthError = { kind: "timeout"; lastError: string | null };

export interface HealthIO {
  fetch(url: string, timeoutMs: number): Promise<{ ok: boolean }>;
  tcpProbe(target: string, timeoutMs: number): Promise<boolean>;
  execProbe(cmd: string[], timeoutMs: number): Promise<number>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface PollHealthyInput {
  healthcheck: HealthCheck;
  pollIntervalMs: number;
  io: HealthIO;
}

export async function pollHealthy(input: PollHealthyInput): Promise<Result<undefined, HealthError>> {
  const { healthcheck, pollIntervalMs, io } = input;
  const deadline = io.now() + healthcheck.timeout_ms;
  let lastError: string | null = null;

  while (io.now() < deadline) {
    try {
      const ok = await runProbe(healthcheck, io);
      if (ok) return { ok: true, value: undefined };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.debug("health.probe-error", { lastError });
    }
    await io.sleep(pollIntervalMs);
  }
  return { ok: false, error: { kind: "timeout", lastError } };
}

async function runProbe(hc: HealthCheck, io: HealthIO): Promise<boolean> {
  if ("url" in hc) {
    const r = await io.fetch(hc.url, Math.min(hc.timeout_ms, 3000));
    return r.ok;
  }
  if ("tcp" in hc) {
    return io.tcpProbe(hc.tcp, Math.min(hc.timeout_ms, 3000));
  }
  const exit = await io.execProbe(hc.exec, Math.min(hc.timeout_ms, 3000));
  return exit === 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway/src && bun test system-orchestrator/health.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/system-orchestrator/health.ts \
        gateway/src/system-orchestrator/health.test.ts
git commit -m "feat(system-orch): health probe with HTTP/TCP/exec + timeout"
```

---

### Task 8: Docker driver

Thin dockerode wrapper. Methods: `inspect`, `recreate`, `start`, `stop`, `remove`, `listManaged`, `pullImage`. Enforces label `sentient.managed=true` + `sentient.service=<name>` on every create. Validates spec before sending — rejects port bindings + non-allowlisted networks + non-allowlisted images. Tests use a stubbed dockerode client.

**Files:**
- Create: `gateway/src/system-orchestrator/docker-driver.ts`
- Test: `gateway/src/system-orchestrator/docker-driver.test.ts`

- [ ] **Step 1: Write the failing test**

Create `gateway/src/system-orchestrator/docker-driver.test.ts`:
```ts
import { test, expect, mock } from "bun:test";
import { createDockerDriver, type DockerodeLike } from "./docker-driver.js";
import type { ManagedService } from "./types.js";

const ms: ManagedService = {
  name: "ha-mcp",
  config: {
    template: "x",
    allowed_images: ["ghcr.io/homeassistant-ai/ha-mcp:stable"],
    networks: ["sentient-internal"],
    secrets: {},
    healthcheck: { url: "http://ha-mcp:8086/health", timeout_ms: 1000 },
    depends_on: [],
    optional: true,
  },
  template: {
    image: "ghcr.io/homeassistant-ai/ha-mcp:stable",
    container_name: "sentient-ha-mcp",
    networks: ["sentient-internal"],
    env: { HOMEASSISTANT_TOKEN: "tok" },
    volumes: [],
    extra_hosts: [],
    group_add: [],
  },
};

function makeStub(): { stub: DockerodeLike; calls: { create: unknown[]; remove: unknown[]; start: unknown[] } } {
  const calls = { create: [] as unknown[], remove: [] as unknown[], start: [] as unknown[] };
  return {
    calls,
    stub: {
      listContainers: async () => [],
      getContainer: () => ({
        inspect: async () => { throw Object.assign(new Error("not found"), { statusCode: 404 }); },
        remove: async (opts: unknown) => { calls.remove.push(opts); },
        start: async () => { calls.start.push({}); },
        stop: async () => {},
      }),
      createContainer: async (spec: unknown) => {
        calls.create.push(spec);
        return { id: "abc", start: async () => { calls.start.push({}); } };
      },
      pull: async () => {},
    },
  };
}

test("recreate sends spec with sentient.managed label", async () => {
  const { stub, calls } = makeStub();
  const drv = createDockerDriver({ docker: stub });
  const r = await drv.recreate(ms);
  expect(r.ok).toBe(true);
  expect((calls.create[0] as { Labels?: Record<string, string> }).Labels?.["sentient.managed"]).toBe("true");
  expect((calls.create[0] as { Labels?: Record<string, string> }).Labels?.["sentient.service"]).toBe("ha-mcp");
});

test("recreate rejects template whose image is not in allowed_images", async () => {
  const bad: ManagedService = { ...ms, template: { ...ms.template, image: "evil/image:v1" } };
  const { stub } = makeStub();
  const drv = createDockerDriver({ docker: stub });
  const r = await drv.recreate(bad);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("policy-violation");
});

test("listManaged returns only containers with sentient.managed=true label", async () => {
  const stub: DockerodeLike = {
    listContainers: async () => [
      { Id: "1", Labels: { "sentient.managed": "true", "sentient.service": "x" }, Names: ["/x"], State: "running" },
      { Id: "2", Labels: {}, Names: ["/other"], State: "running" },
    ],
    getContainer: () => ({ inspect: async () => ({}), remove: async () => {}, start: async () => {}, stop: async () => {} }),
    createContainer: async () => ({ id: "x", start: async () => {} }),
    pull: async () => {},
  };
  const drv = createDockerDriver({ docker: stub });
  const r = await drv.listManaged();
  expect(r.length).toBe(1);
  expect(r[0]!.service).toBe("x");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway/src && bun test system-orchestrator/docker-driver.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement docker-driver**

Create `gateway/src/system-orchestrator/docker-driver.ts`:
```ts
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { ManagedService, ServiceName } from "./types.js";

const log = getLog(["sentient", "system-orch", "docker-driver"]);

const LABEL_MANAGED = "sentient.managed";
const LABEL_SERVICE = "sentient.service";

export type DockerError =
  | { kind: "policy-violation"; reason: string }
  | { kind: "create-failed"; reason: string }
  | { kind: "remove-failed"; reason: string }
  | { kind: "start-failed"; reason: string }
  | { kind: "pull-failed"; reason: string };

export interface ManagedContainerInfo {
  id: string;
  service: ServiceName;
  state: string;
}

/** Narrow surface we need from dockerode — keeps tests free of any real socket. */
export interface DockerodeLike {
  listContainers(opts?: { all?: boolean; filters?: string }): Promise<Array<{
    Id: string;
    Labels: Record<string, string>;
    Names: string[];
    State: string;
  }>>;
  getContainer(id: string): {
    inspect(): Promise<unknown>;
    remove(opts?: { force?: boolean }): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
  };
  createContainer(spec: Record<string, unknown>): Promise<{ id: string; start(): Promise<void> }>;
  pull(image: string): Promise<void>;
}

export interface DockerDriver {
  recreate(ms: ManagedService): Promise<Result<undefined, DockerError>>;
  start(name: string): Promise<Result<undefined, DockerError>>;
  stop(name: string): Promise<Result<undefined, DockerError>>;
  remove(name: string): Promise<Result<undefined, DockerError>>;
  pullImage(image: string): Promise<Result<undefined, DockerError>>;
  listManaged(): Promise<ManagedContainerInfo[]>;
}

export interface DockerDriverDeps {
  docker: DockerodeLike;
}

export function createDockerDriver(deps: DockerDriverDeps): DockerDriver {
  return {
    recreate: (ms) => recreate(deps.docker, ms),
    start: async (name) => {
      try {
        await deps.docker.getContainer(name).start();
        return { ok: true, value: undefined };
      } catch (err) {
        return { ok: false, error: { kind: "start-failed", reason: errMsg(err) } };
      }
    },
    stop: async (name) => {
      try {
        await deps.docker.getContainer(name).stop();
        return { ok: true, value: undefined };
      } catch (err) {
        return { ok: false, error: { kind: "remove-failed", reason: errMsg(err) } };
      }
    },
    remove: async (name) => {
      try {
        await deps.docker.getContainer(name).remove({ force: true });
        return { ok: true, value: undefined };
      } catch (err) {
        return { ok: false, error: { kind: "remove-failed", reason: errMsg(err) } };
      }
    },
    pullImage: async (image) => {
      try {
        await deps.docker.pull(image);
        return { ok: true, value: undefined };
      } catch (err) {
        return { ok: false, error: { kind: "pull-failed", reason: errMsg(err) } };
      }
    },
    listManaged: async () => listManaged(deps.docker),
  };
}

async function recreate(docker: DockerodeLike, ms: ManagedService): Promise<Result<undefined, DockerError>> {
  const policy = enforcePolicy(ms);
  if (!policy.ok) return policy;

  // Best-effort remove: tolerate 404, surface other errors.
  try {
    await docker.getContainer(ms.template.container_name).remove({ force: true });
  } catch (err) {
    const e = err as { statusCode?: number };
    if (e.statusCode !== 404) {
      return { ok: false, error: { kind: "remove-failed", reason: errMsg(err) } };
    }
  }

  const spec = buildCreateSpec(ms);
  let created: { id: string; start: () => Promise<void> };
  try {
    created = await docker.createContainer(spec);
  } catch (err) {
    return { ok: false, error: { kind: "create-failed", reason: errMsg(err) } };
  }
  try {
    await created.start();
  } catch (err) {
    return { ok: false, error: { kind: "start-failed", reason: errMsg(err) } };
  }
  log.info("driver.recreated", { service: ms.name, id: created.id });
  return { ok: true, value: undefined };
}

function enforcePolicy(ms: ManagedService): Result<undefined, DockerError> {
  if (!ms.config.allowed_images.includes(ms.template.image)) {
    return { ok: false, error: { kind: "policy-violation", reason: `image ${ms.template.image} not allowed` } };
  }
  for (const net of ms.template.networks) {
    if (!ms.config.networks.includes(net)) {
      return { ok: false, error: { kind: "policy-violation", reason: `network ${net} not allowed` } };
    }
  }
  return { ok: true, value: undefined };
}

function buildCreateSpec(ms: ManagedService): Record<string, unknown> {
  const env = Object.entries(ms.template.env).map(([k, v]) => `${k}=${v}`);
  const primaryNet = ms.template.networks[0]!;
  const otherNets = ms.template.networks.slice(1);
  return {
    name: ms.template.container_name,
    Image: ms.template.image,
    Cmd: ms.template.command,
    Env: env,
    Labels: {
      [LABEL_MANAGED]: "true",
      [LABEL_SERVICE]: ms.name,
    },
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      NetworkMode: primaryNet,
      Binds: ms.template.volumes,
      ExtraHosts: ms.template.extra_hosts,
      Memory: ms.template.mem_limit_bytes ?? 0,
      NanoCpus: ms.template.cpus ? Math.floor(ms.template.cpus * 1_000_000_000) : 0,
      GroupAdd: ms.template.group_add,
      // Explicit empty PortBindings — defense in depth against accidental
      // host-port exposure.
      PortBindings: {},
    },
    NetworkingConfig: otherNets.length
      ? { EndpointsConfig: Object.fromEntries(otherNets.map((n) => [n, {}])) }
      : undefined,
  };
}

async function listManaged(docker: DockerodeLike): Promise<ManagedContainerInfo[]> {
  const filters = JSON.stringify({ label: [`${LABEL_MANAGED}=true`] });
  const list = await docker.listContainers({ all: true, filters });
  return list
    .filter((c) => c.Labels?.[LABEL_MANAGED] === "true")
    .map((c) => ({
      id: c.Id,
      service: c.Labels[LABEL_SERVICE] ?? "unknown",
      state: c.State,
    }));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway/src && bun test system-orchestrator/docker-driver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/system-orchestrator/docker-driver.ts \
        gateway/src/system-orchestrator/docker-driver.test.ts
git commit -m "feat(system-orch): docker driver with label + policy enforcement"
```

---

### Task 9: Orchestrator state machine

Drives the multi-service apply: per-service substate updates, parallel-where-deps-allow execution, blocked-by-dep propagation, partial-success surfacing. Pure FSM (driver + health probe injected).

**Files:**
- Create: `gateway/src/system-orchestrator/orchestrator.ts`
- Test: `gateway/src/system-orchestrator/orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

Create `gateway/src/system-orchestrator/orchestrator.test.ts`:
```ts
import { test, expect } from "bun:test";
import { createSystemOrchestrator } from "./orchestrator.js";
import type { ManagedService } from "./types.js";
import type { DockerDriver } from "./docker-driver.js";
import type { HealthIO } from "./health.js";

const ok = { ok: true, value: undefined } as const;
function svc(name: string, deps: string[] = [], optional = false): ManagedService {
  return {
    name,
    config: {
      template: "x",
      allowed_images: ["x"],
      networks: ["sentient-internal"],
      secrets: {},
      healthcheck: { url: `http://${name}/health`, timeout_ms: 200 },
      depends_on: deps,
      optional,
    },
    template: { image: "x", container_name: name, networks: ["sentient-internal"], env: {}, volumes: [], extra_hosts: [], group_add: [] },
  };
}

const happyDriver: DockerDriver = {
  recreate: async () => ok,
  start: async () => ok,
  stop: async () => ok,
  remove: async () => ok,
  pullImage: async () => ok,
  listManaged: async () => [],
};

const healthyIO: HealthIO = {
  fetch: async () => ({ ok: true }),
  tcpProbe: async () => true,
  execProbe: async () => 0,
  sleep: async () => {},
  now: () => 0,
};

test("orchestrator brings all services to ready when everything is healthy", async () => {
  const reg = new Map([["a", svc("a")], ["b", svc("b", ["a"])]]);
  const orch = createSystemOrchestrator({ registry: reg, driver: happyDriver, healthIO: healthyIO, pollIntervalMs: 1, applyTimeoutMs: 10000 });
  const r = await orch.applyAll();
  expect(r.state).toBe("ready");
  expect(r.services.find((s) => s.name === "a")?.state).toBe("ready");
});

test("optional service health failure leaves orchestrator ready, marks degraded", async () => {
  const reg = new Map([["req", svc("req")], ["opt", svc("opt", [], true)]]);
  const sometimesHealthy: HealthIO = {
    ...healthyIO,
    fetch: async (url) => ({ ok: !url.includes("opt") }),
    now: (() => { let t = 0; return () => (t += 100); })(),
  };
  const orch = createSystemOrchestrator({ registry: reg, driver: happyDriver, healthIO: sometimesHealthy, pollIntervalMs: 1, applyTimeoutMs: 500 });
  const r = await orch.applyAll();
  expect(r.state).toBe("ready");
  expect(r.services.find((s) => s.name === "opt")?.state).toBe("degraded");
});

test("required service failure leaves orchestrator failed", async () => {
  const reg = new Map([["req", svc("req")]]);
  const failingDriver: DockerDriver = { ...happyDriver, recreate: async () => ({ ok: false, error: { kind: "create-failed", reason: "boom" } }) };
  const orch = createSystemOrchestrator({ registry: reg, driver: failingDriver, healthIO: healthyIO, pollIntervalMs: 1, applyTimeoutMs: 100 });
  const r = await orch.applyAll();
  expect(r.state).toBe("failed");
});

test("downstream of a failed required service is marked blocked-by-dep", async () => {
  const reg = new Map([["a", svc("a")], ["b", svc("b", ["a"])]]);
  const failOnA: DockerDriver = {
    ...happyDriver,
    recreate: async (ms) => ms.name === "a" ? { ok: false, error: { kind: "create-failed", reason: "x" } } : ok,
  };
  const orch = createSystemOrchestrator({ registry: reg, driver: failOnA, healthIO: healthyIO, pollIntervalMs: 1, applyTimeoutMs: 100 });
  const r = await orch.applyAll();
  expect(r.services.find((s) => s.name === "b")?.state).toBe("blocked-by-dep");
});

test("applySubset only touches the requested services", async () => {
  const reg = new Map([["a", svc("a")], ["b", svc("b")]]);
  const seen: string[] = [];
  const tracking: DockerDriver = { ...happyDriver, recreate: async (ms) => { seen.push(ms.name); return ok; } };
  const orch = createSystemOrchestrator({ registry: reg, driver: tracking, healthIO: healthyIO, pollIntervalMs: 1, applyTimeoutMs: 100 });
  await orch.applySubset(new Set(["b"]));
  expect(seen).toEqual(["b"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway/src && bun test system-orchestrator/orchestrator.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement orchestrator**

Create `gateway/src/system-orchestrator/orchestrator.ts`:
```ts
import { getLog } from "../logging/logger.js";
import { topoOrder, blockedByFailedDeps, type DepMap } from "./dep-graph.js";
import type { DockerDriver } from "./docker-driver.js";
import { pollHealthy, type HealthIO } from "./health.js";
import type { ManagedService, OrchestratorStatus, ServiceName, ServiceState, ServiceStatus } from "./types.js";

const log = getLog(["sentient", "system-orch", "orchestrator"]);

export interface SystemOrchestratorDeps {
  registry: Map<ServiceName, ManagedService>;
  driver: DockerDriver;
  healthIO: HealthIO;
  pollIntervalMs: number;
  applyTimeoutMs: number;
}

export interface SystemOrchestrator {
  applyAll(): Promise<OrchestratorStatus>;
  applySubset(names: ReadonlySet<ServiceName>): Promise<OrchestratorStatus>;
  getStatus(): OrchestratorStatus;
}

export function createSystemOrchestrator(deps: SystemOrchestratorDeps): SystemOrchestrator {
  let current: OrchestratorStatus = idleStatus(deps.registry);

  return {
    applyAll: () => runApply(deps, Array.from(deps.registry.keys()), (s) => { current = s; }),
    applySubset: (names) => runApply(deps, Array.from(names), (s) => { current = s; }),
    getStatus: () => current,
  };
}

function idleStatus(reg: Map<ServiceName, ManagedService>): OrchestratorStatus {
  return {
    state: "idle",
    services: Array.from(reg.values()).map((ms) => ({
      name: ms.name,
      state: "pending",
      optional: ms.config.optional,
      version: null,
      lastError: null,
    })),
    startedAt: null,
    finishedAt: null,
  };
}

async function runApply(
  deps: SystemOrchestratorDeps,
  targets: ServiceName[],
  emit: (s: OrchestratorStatus) => void,
): Promise<OrchestratorStatus> {
  const startedAt = Date.now();
  const statuses = new Map<ServiceName, ServiceStatus>();
  for (const ms of deps.registry.values()) {
    statuses.set(ms.name, { name: ms.name, state: "pending", optional: ms.config.optional, version: null, lastError: null });
  }
  const targetSet = new Set(targets);

  const depMap: DepMap = {};
  for (const ms of deps.registry.values()) depMap[ms.name] = ms.config.depends_on;
  const order = topoOrder(depMap);
  if (!order.ok) {
    log.error("apply.dep-graph-error", { error: order.error });
    return finalize(statuses, "failed", startedAt);
  }

  const failedRequired = new Set<ServiceName>();

  for (const name of order.value) {
    if (!targetSet.has(name)) continue;
    const ms = deps.registry.get(name)!;

    const blocked = blockedByFailedDeps(depMap, failedRequired);
    if (blocked.has(name)) {
      mark(statuses, name, "blocked-by-dep");
      emit(snapshot(statuses, "applying", startedAt));
      continue;
    }

    mark(statuses, name, "starting");
    emit(snapshot(statuses, "applying", startedAt));

    const recr = await deps.driver.recreate(ms);
    if (!recr.ok) {
      const newState: ServiceState = ms.config.optional ? "degraded" : "failed";
      mark(statuses, name, newState, recr.error.reason);
      if (!ms.config.optional) failedRequired.add(name);
      emit(snapshot(statuses, "applying", startedAt));
      continue;
    }

    mark(statuses, name, "health-checking");
    emit(snapshot(statuses, "applying", startedAt));

    const health = await pollHealthy({
      healthcheck: ms.config.healthcheck,
      pollIntervalMs: deps.pollIntervalMs,
      io: deps.healthIO,
    });
    if (!health.ok) {
      const newState: ServiceState = ms.config.optional ? "degraded" : "failed";
      mark(statuses, name, newState, health.error.lastError ?? "health-timeout");
      if (!ms.config.optional) failedRequired.add(name);
      emit(snapshot(statuses, "applying", startedAt));
      continue;
    }

    mark(statuses, name, "ready");
    emit(snapshot(statuses, "applying", startedAt));
  }

  const finalState = failedRequired.size > 0 ? "failed" : "ready";
  return finalize(statuses, finalState, startedAt);
}

function mark(
  m: Map<ServiceName, ServiceStatus>,
  name: ServiceName,
  state: ServiceState,
  lastError: string | null = null,
): void {
  const cur = m.get(name)!;
  m.set(name, { ...cur, state, lastError });
}

function snapshot(
  m: Map<ServiceName, ServiceStatus>,
  state: OrchestratorStatus["state"],
  startedAt: number,
): OrchestratorStatus {
  return { state, services: Array.from(m.values()), startedAt, finishedAt: null };
}

function finalize(
  m: Map<ServiceName, ServiceStatus>,
  state: OrchestratorStatus["state"],
  startedAt: number,
): OrchestratorStatus {
  return { state, services: Array.from(m.values()), startedAt, finishedAt: Date.now() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway/src && bun test system-orchestrator/orchestrator.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/system-orchestrator/orchestrator.ts \
        gateway/src/system-orchestrator/orchestrator.test.ts
git commit -m "feat(system-orch): orchestrator FSM with parallel + blocked-by-dep semantics"
```

---

### Task 10: Boot reconciler

On gateway start: list `sentient.managed=true` containers, kill orphans not in registry, then run `applyAll` to bring missing/unhealthy services up.

**Files:**
- Create: `gateway/src/system-orchestrator/boot-reconciler.ts`
- Test: `gateway/src/system-orchestrator/boot-reconciler.test.ts`

- [ ] **Step 1: Write the failing test**

Create `gateway/src/system-orchestrator/boot-reconciler.test.ts`:
```ts
import { test, expect } from "bun:test";
import { reconcileOnBoot } from "./boot-reconciler.js";
import type { DockerDriver, ManagedContainerInfo } from "./docker-driver.js";
import type { ManagedService, OrchestratorStatus } from "./types.js";

const ok = { ok: true, value: undefined } as const;

const ms = (name: string): ManagedService => ({
  name,
  config: { template: "x", allowed_images: ["x"], networks: ["sentient-internal"], secrets: {}, healthcheck: { url: "http://x/health", timeout_ms: 1000 }, depends_on: [], optional: false },
  template: { image: "x", container_name: `sentient-${name}`, networks: ["sentient-internal"], env: {}, volumes: [], extra_hosts: [], group_add: [] },
});

function makeOrch(): { applyAllCalls: number; orch: { applyAll: () => Promise<OrchestratorStatus> } } {
  const state = { applyAllCalls: 0 };
  return {
    applyAllCalls: state.applyAllCalls,
    orch: {
      applyAll: async () => {
        state.applyAllCalls++;
        return { state: "ready", services: [], startedAt: 0, finishedAt: 1 };
      },
    },
  };
}

test("orphan containers (managed but not in registry) are removed", async () => {
  const removeCalls: string[] = [];
  const driver: DockerDriver = {
    recreate: async () => ok,
    start: async () => ok,
    stop: async () => ok,
    remove: async (name) => { removeCalls.push(name); return ok; },
    pullImage: async () => ok,
    listManaged: async (): Promise<ManagedContainerInfo[]> => [
      { id: "1", service: "ha-mcp", state: "running" },
      { id: "2", service: "fake-service", state: "running" },
    ],
  };
  const reg = new Map([["ha-mcp", ms("ha-mcp")]]);
  const orch = { applyAll: async (): Promise<OrchestratorStatus> => ({ state: "ready", services: [], startedAt: 0, finishedAt: 1 }) };
  await reconcileOnBoot({ driver, registry: reg, orchestrator: orch });
  expect(removeCalls.some((s) => s.includes("fake-service") || s === "2")).toBe(true);
});

test("calls applyAll after orphan reap to bring up registry services", async () => {
  let applyCount = 0;
  const driver: DockerDriver = {
    recreate: async () => ok, start: async () => ok, stop: async () => ok, remove: async () => ok, pullImage: async () => ok,
    listManaged: async () => [],
  };
  const reg = new Map([["ha-mcp", ms("ha-mcp")]]);
  const orch = {
    applyAll: async (): Promise<OrchestratorStatus> => {
      applyCount++;
      return { state: "ready", services: [], startedAt: 0, finishedAt: 1 };
    },
  };
  await reconcileOnBoot({ driver, registry: reg, orchestrator: orch });
  expect(applyCount).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway/src && bun test system-orchestrator/boot-reconciler.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement boot-reconciler**

Create `gateway/src/system-orchestrator/boot-reconciler.ts`:
```ts
import { getLog } from "../logging/logger.js";
import type { DockerDriver } from "./docker-driver.js";
import type { ManagedService, OrchestratorStatus, ServiceName } from "./types.js";

const log = getLog(["sentient", "system-orch", "boot-reconciler"]);

export interface ReconcileDeps {
  driver: DockerDriver;
  registry: Map<ServiceName, ManagedService>;
  orchestrator: { applyAll(): Promise<OrchestratorStatus> };
}

export async function reconcileOnBoot(deps: ReconcileDeps): Promise<OrchestratorStatus> {
  const known = new Set(deps.registry.keys());
  const live = await deps.driver.listManaged();
  for (const c of live) {
    if (!known.has(c.service)) {
      log.warn("reconcile.orphan-reap", { id: c.id, service: c.service });
      const r = await deps.driver.remove(c.id);
      if (!r.ok) log.warn("reconcile.orphan-remove-failed", { id: c.id, reason: r.error.reason });
    }
  }
  log.info("reconcile.applying", { count: deps.registry.size });
  return deps.orchestrator.applyAll();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway/src && bun test system-orchestrator/boot-reconciler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/system-orchestrator/boot-reconciler.ts \
        gateway/src/system-orchestrator/boot-reconciler.test.ts
git commit -m "feat(system-orch): boot reconciler reaps orphans + drives initial apply"
```

---

### Task 11: Apply router

Single endpoint that receives a config blob, splits it into user-level + system-level diffs, RBAC-gates the system-level fields, and dispatches each to its orchestrator. The user-level part of the API is left as a stub call to the existing per-user `runApply` for now (existing handlers continue to use it directly until Task 19).

**Files:**
- Create: `gateway/src/apply/router.ts`
- Test: `gateway/src/apply/router.test.ts`

- [ ] **Step 1: Write the failing test**

Create `gateway/src/apply/router.test.ts`:
```ts
import { test, expect } from "bun:test";
import { splitApplyDiff, runApplyRouted, type RouterDeps } from "./router.js";

const sysSnapshot = { state: "ready", services: [], startedAt: 0, finishedAt: 1 } as const;

const baseDeps: RouterDeps = {
  isAdmin: async () => true,
  diffSecrets: async () => ["home_assistant.mcp_server_token"],
  perUserApply: async () => ({ ok: true, value: { state: "ready", elapsedMs: 1 } }),
  systemOrchestrator: { applySubset: async () => ({ ...sysSnapshot, state: "ready" }) },
  registry: new Map(),
};

test("splitApplyDiff partitions blob into user-level + system-level keys", () => {
  const r = splitApplyDiff({
    profile: { model: { provider: "openrouter", id: "x" } },
    secrets: { home_assistant: { mcp_server_token: "tok" } },
  });
  expect(r.userLevel).not.toBe(null);
  expect(r.systemLevel).not.toBe(null);
});

test("runApplyRouted returns 403 when non-admin submits system-level changes", async () => {
  const r = await runApplyRouted(
    { profile: null, secrets: { home_assistant: { mcp_server_token: "tok" } } },
    { ...baseDeps, isAdmin: async () => false },
    "u_1",
  );
  expect(r.status).toBe(403);
});

test("runApplyRouted runs both orchestrators when admin submits both", async () => {
  let perUserCalled = false;
  let sysCalled = false;
  const r = await runApplyRouted(
    { profile: { model: { provider: "openrouter", id: "x" } }, secrets: { home_assistant: { mcp_server_token: "tok" } } },
    {
      ...baseDeps,
      perUserApply: async () => { perUserCalled = true; return { ok: true, value: { state: "ready", elapsedMs: 1 } }; },
      systemOrchestrator: { applySubset: async () => { sysCalled = true; return sysSnapshot; } },
    },
    "u_1",
  );
  expect(perUserCalled).toBe(true);
  expect(sysCalled).toBe(true);
  expect(r.status).toBe(200);
});

test("runApplyRouted is a no-op (200) when blob is empty", async () => {
  const r = await runApplyRouted({ profile: null, secrets: null }, baseDeps, "u_1");
  expect(r.status).toBe(200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway/src && bun test apply/router.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement router**

Create `gateway/src/apply/router.ts`:
```ts
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import type { ManagedService, OrchestratorStatus, ServiceName } from "../system-orchestrator/types.js";

const log = getLog(["sentient", "apply", "router"]);

export interface ApplyBody {
  profile: Record<string, unknown> | null;
  secrets: Record<string, Record<string, unknown>> | null;
}

export interface RouterDeps {
  isAdmin(userId: string): Promise<boolean>;
  /** Returns the dotted-path list of secrets that changed vs the stored
   *  values, given the inbound `secrets` partial. Empty array on no change. */
  diffSecrets(secrets: ApplyBody["secrets"]): Promise<string[]>;
  perUserApply(userId: string, profile: ApplyBody["profile"]): Promise<Result<{ state: string; elapsedMs: number }, { kind: string; reason?: string }>>;
  systemOrchestrator: { applySubset(names: ReadonlySet<ServiceName>): Promise<OrchestratorStatus> };
  registry: Map<ServiceName, ManagedService>;
}

export interface ApplyRouterResult {
  status: number;
  body: { error?: string; perUser?: unknown; system?: OrchestratorStatus | null };
}

export interface ApplyDiff {
  userLevel: ApplyBody["profile"];
  systemLevel: ApplyBody["secrets"];
}

export function splitApplyDiff(body: ApplyBody): ApplyDiff {
  return { userLevel: body.profile ?? null, systemLevel: body.secrets ?? null };
}

export async function runApplyRouted(
  body: ApplyBody,
  deps: RouterDeps,
  userId: string,
): Promise<ApplyRouterResult> {
  const diff = splitApplyDiff(body);
  const hasUser = diff.userLevel !== null;
  const hasSystem = diff.systemLevel !== null;
  if (!hasUser && !hasSystem) {
    return { status: 200, body: { perUser: null, system: null } };
  }

  if (hasSystem) {
    const admin = await deps.isAdmin(userId);
    if (!admin) {
      log.warn("router.rbac-denied", { userId });
      return { status: 403, body: { error: "admin role required" } };
    }
  }

  const out: ApplyRouterResult["body"] = { perUser: null, system: null };

  if (hasUser) {
    const userResult = await deps.perUserApply(userId, diff.userLevel);
    out.perUser = userResult;
  }

  if (hasSystem) {
    const changedPaths = await deps.diffSecrets(diff.systemLevel);
    const targets = collectTargets(deps.registry, changedPaths);
    out.system = targets.size === 0
      ? null
      : await deps.systemOrchestrator.applySubset(targets);
  }

  return { status: 200, body: out };
}

function collectTargets(reg: Map<ServiceName, ManagedService>, changed: ReadonlyArray<string>): Set<ServiceName> {
  const out = new Set<ServiceName>();
  const want = new Set(changed);
  for (const ms of reg.values()) {
    for (const path of Object.values(ms.config.secrets)) {
      if (want.has(path)) out.add(ms.name);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway/src && bun test apply/router.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/apply/router.ts gateway/src/apply/router.test.ts
git commit -m "feat(apply): router splits + RBAC-gates apply blob across orchestrators"
```

---

### Task 12: Author managed_services config block + service templates

Create the six template files and the `managed_services` block in `gateway/config.yaml`. Templates baked into the gateway image at build time.

**Files:**
- Create: `gateway/templates/services/egress-proxy.yaml`
- Create: `gateway/templates/services/sentient-hermes.yaml`
- Create: `gateway/templates/services/stt-service.yaml`
- Create: `gateway/templates/services/ddg-mcp.yaml`
- Create: `gateway/templates/services/ha-mcp.yaml`
- Create: `gateway/templates/services/ma-mcp.yaml`
- Modify: `gateway/config.yaml` (add `managed_services:` block at end)

- [ ] **Step 1: Author template files**

Create `gateway/templates/services/egress-proxy.yaml`:
```yaml
image: kalaksi/tinyproxy:latest
container_name: sentient-egress-proxy
networks: [sentient-internal, sentient-external]
volumes:
  - ${HOST_CONFIG_DIR}/egress-proxy/tinyproxy.conf:/etc/tinyproxy/tinyproxy.conf:ro
  - ${HOST_CONFIG_DIR}/egress-proxy/filter.txt:/etc/tinyproxy/filter.txt:ro
extra_hosts:
  - mass.local:${MASS_LOCAL_IP}
mem_limit_bytes: 67108864
cpus: 0.25
```

Create `gateway/templates/services/sentient-hermes.yaml`:
```yaml
image: sentient/hermes:local
container_name: sentient-hermes
networks: [sentient-internal]
extra_hosts:
  - host.docker.internal:host-gateway
env:
  TZ: ${TZ}
  HTTP_PROXY: http://egress-proxy:3128
  HTTPS_PROXY: http://egress-proxy:3128
  NO_PROXY: localhost,127.0.0.1,sentient-gateway,ha-mcp,stt-service,host.docker.internal
volumes:
  - sentient-supervisor:/data/supervisor
  - ${HOST_HOME}/.sentient/gateway/data:${HOST_HOME}/.sentient/gateway/data
  - /var/run/docker.sock:/var/run/docker.sock
  - ${HOST_HOME}/.sentient/run/sentient:/run/sentient
group_add:
  - ${HOST_DOCKER_GID}
```

Create `gateway/templates/services/stt-service.yaml`:
```yaml
image: sentient/stt-service:local
container_name: sentient-stt-service
networks: [sentient-internal]
volumes:
  - ${HOST_HOME}/.sentient/stt-service/logs:/app/logs
  - ${HOST_HOME}/.sentient/stt-service/data/recordings:/app/data/recordings
```

Create `gateway/templates/services/ddg-mcp.yaml`:
```yaml
image: sentient/ddg-mcp:local
container_name: sentient-ddg-mcp
networks: [sentient-internal]
env:
  HTTP_PROXY: http://egress-proxy:3128
  HTTPS_PROXY: http://egress-proxy:3128
  NO_PROXY: localhost,127.0.0.1
mem_limit_bytes: 268435456
cpus: 0.5
```

Create `gateway/templates/services/ha-mcp.yaml`:
```yaml
image: ghcr.io/homeassistant-ai/ha-mcp:stable
container_name: sentient-ha-mcp
networks: [sentient-internal]
command: [ha-mcp-web]
env:
  HOMEASSISTANT_URL: ${HOMEASSISTANT_URL}
  HOMEASSISTANT_TOKEN: ${HOMEASSISTANT_TOKEN}
```

Create `gateway/templates/services/ma-mcp.yaml`:
```yaml
image: sentient/ma-mcp:local
container_name: sentient-ma-mcp
networks: [sentient-internal, sentient-external]
extra_hosts:
  - mass.local:${MASS_LOCAL_IP}
env:
  MUSIC_ASSISTANT_URL: ${MUSIC_ASSISTANT_URL}
  MUSIC_ASSISTANT_TOKEN: ${MUSIC_ASSISTANT_TOKEN}
mem_limit_bytes: 268435456
cpus: 0.5
```

- [ ] **Step 2: Append managed_services block to gateway/config.yaml**

Append to `gateway/config.yaml`:
```yaml
# ─────────────────────────────────────────────────────────────────────────
# managed_services
# ─────────────────────────────────────────────────────────────────────────
# Policy layer for the system service orchestrator. Each entry binds a
# baked template under gateway/templates/services/<name>.yaml to a strict
# policy: image allowlist, networks, secret bindings, healthcheck. The
# orchestrator refuses to operate on any container whose runtime spec
# violates these constraints.
managed_services:
  egress-proxy:
    template: egress-proxy.yaml
    allowed_images: ["kalaksi/tinyproxy:latest"]
    networks: ["sentient-internal", "sentient-external"]
    healthcheck:
      tcp: "egress-proxy:3128"
      timeout_ms: 5000
    depends_on: []
    optional: false

  sentient-hermes:
    template: sentient-hermes.yaml
    allowed_images: ["sentient/hermes:local"]
    networks: ["sentient-internal"]
    healthcheck:
      tcp: "sentient-hermes:1"  # supervisord readiness; specific port set
      timeout_ms: 30000
    depends_on: ["egress-proxy"]
    optional: false

  stt-service:
    template: stt-service.yaml
    allowed_images: ["sentient/stt-service:local"]
    networks: ["sentient-internal"]
    healthcheck:
      url: "http://stt-service:8767/health"
      timeout_ms: 60000
    depends_on: []
    optional: false

  ddg-mcp:
    template: ddg-mcp.yaml
    allowed_images: ["sentient/ddg-mcp:local"]
    networks: ["sentient-internal"]
    healthcheck:
      tcp: "ddg-mcp:8000"
      timeout_ms: 30000
    depends_on: ["egress-proxy"]
    optional: false

  ha-mcp:
    template: ha-mcp.yaml
    allowed_images: ["ghcr.io/homeassistant-ai/ha-mcp:stable"]
    networks: ["sentient-internal"]
    secrets:
      HOMEASSISTANT_URL: home_assistant.url
      HOMEASSISTANT_TOKEN: home_assistant.mcp_server_token
    healthcheck:
      url: "http://ha-mcp:8086/health"
      timeout_ms: 30000
    depends_on: ["egress-proxy"]
    optional: true

  ma-mcp:
    template: ma-mcp.yaml
    allowed_images: ["sentient/ma-mcp:local"]
    networks: ["sentient-internal", "sentient-external"]
    secrets:
      MUSIC_ASSISTANT_URL: music_assistant.url
      MUSIC_ASSISTANT_TOKEN: music_assistant.token
    healthcheck:
      tcp: "ma-mcp:8095"
      timeout_ms: 30000
    depends_on: []
    optional: true
```

- [ ] **Step 3: Verify templates load against the schema**

Run: `cd gateway/src && bun test system-orchestrator/template-loader.test.ts`
Expected: PASS (existing tests; this is a sanity check).

- [ ] **Step 4: Commit**

```bash
git add gateway/templates/services/ gateway/config.yaml
git commit -m "feat(system-orch): author baked service templates + managed_services config"
```

---

### Task 13: Extend secrets-store with ha/ma URL fields

Today the secrets-store stores HA tokens (`observe_token`, `mcp_server_token`) and the MA token. It does not store the HA URL or MA URL — those live in compose env vars today. The new orchestrator reads these as secret-bound env vars, so the store needs a string field per URL.

**Files:**
- Modify: `gateway/src/admin/secrets-store-schema.ts`
- Modify: `gateway/src/admin/secrets-store.ts`
- Modify: `gateway/src/api/handlers/secrets.ts` (new endpoints `/secrets/home_assistant/url` and `/secrets/music_assistant/url`)
- Test: `gateway/src/admin/secrets-store.test.ts` (add new cases)

- [ ] **Step 1: Read existing schema**

Run: `cat gateway/src/admin/secrets-store-schema.ts | head -40`
Expected: see `home_assistant: { observe_token, mcp_server_token }` and `music_assistant: { token }` shape.

- [ ] **Step 2: Add a failing test**

Append to `gateway/src/admin/secrets-store.test.ts`:
```ts
test("setHomeAssistantUrl persists and is readable via load()", async () => {
  const store = await mkStore();
  await store.setHomeAssistantUrl("https://home.example.com:8123");
  const keys = await store.load();
  expect(keys.home_assistant.url).toBe("https://home.example.com:8123");
});

test("setMusicAssistantUrl persists and is readable via load()", async () => {
  const store = await mkStore();
  await store.setMusicAssistantUrl("http://mass.local:8095");
  const keys = await store.load();
  expect(keys.music_assistant.url).toBe("http://mass.local:8095");
});
```

(`mkStore()` is the existing helper in this test file.)

- [ ] **Step 3: Run the test**

Run: `cd gateway/src && bun test admin/secrets-store.test.ts`
Expected: FAIL — `url` does not exist on the schema.

- [ ] **Step 4: Extend the schema**

Modify `gateway/src/admin/secrets-store-schema.ts` to add `url: z.string().nullable().default(null)` under both `home_assistant` and `music_assistant`. Mirror the existing field shapes.

- [ ] **Step 5: Add the setters**

Modify `gateway/src/admin/secrets-store.ts` to add `setHomeAssistantUrl(value: string | null)` and `setMusicAssistantUrl(value: string | null)`. Follow the existing pattern of the token setters: persist via the same atomic write helper.

- [ ] **Step 6: Add HTTP routes**

In `gateway/src/api/handlers/secrets.ts`, add:
```ts
const PATH_HA_URL = "/api/v1/admin/secrets/home_assistant/url";
const PATH_MA_URL = "/api/v1/admin/secrets/music_assistant/url";
// ... in the route dispatch:
if (path === PATH_HA_URL && method === "PUT") return handlePutHaUrl(deps, req);
if (path === PATH_MA_URL && method === "PUT") return handlePutMaUrl(deps, req);
// ... handler functions follow the pattern of handlePutFishKey above.
```

Mirror `handlePutFishKey` exactly — same `SecretValueSchema` parse, same write call, same response shape.

In `handleGetSecrets`, extend the response body so each block includes its URL:
```ts
home_assistant: {
  url: keys.home_assistant.url,
  observe_token: { has_token: keys.home_assistant.observe_token !== null },
  mcp_server_token: { has_token: keys.home_assistant.mcp_server_token !== null },
},
music_assistant: { url: keys.music_assistant.url, has_token: keys.music_assistant.token !== null },
```

URLs are NOT secrets in the credential sense — they are addressable hosts the operator chose. Returning them is intentional; only the token fields stay boolean-only.

- [ ] **Step 7: Run tests**

Run: `cd gateway/src && bun test admin/secrets-store.test.ts`
Expected: PASS.

Run: `cd gateway && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add gateway/src/admin/secrets-store-schema.ts \
        gateway/src/admin/secrets-store.ts \
        gateway/src/api/handlers/secrets.ts \
        gateway/src/admin/secrets-store.test.ts
git commit -m "feat(secrets): add HA URL + MA URL fields and setters"
```

---

### Task 14: System orchestrator wiring at gateway boot

Wire the registry, driver, orchestrator, and boot reconciler into `create-gateway-services.ts`. Expose the orchestrator as a service for downstream handlers (apply router, version handler, status endpoint).

**Files:**
- Modify: `gateway/src/bootstrap/create-gateway-services.ts`
- Create: `gateway/src/system-orchestrator/index.ts` (factory entry point)
- Test: smoke via existing typecheck.

- [ ] **Step 1: Create factory**

Create `gateway/src/system-orchestrator/index.ts`:
```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Dockerode from "dockerode";
import { createDockerDriver, type DockerodeLike } from "./docker-driver.js";
import { createSystemOrchestrator } from "./orchestrator.js";
import { buildServiceRegistry } from "./service-registry.js";
import { reconcileOnBoot } from "./boot-reconciler.js";
import type { SecretAccessor } from "./template-loader.js";
import type { ManagedService, ServiceName } from "./types.js";
import type { HealthIO } from "./health.js";

export interface SystemOrchestratorService {
  registry: Map<ServiceName, ManagedService>;
  applyAll: () => ReturnType<ReturnType<typeof createSystemOrchestrator>["applyAll"]>;
  applySubset: ReturnType<typeof createSystemOrchestrator>["applySubset"];
  getStatus: ReturnType<typeof createSystemOrchestrator>["getStatus"];
  reconcile: () => ReturnType<typeof reconcileOnBoot>;
}

export interface FactoryDeps {
  managedServicesConfig: Record<string, unknown>;
  templateDir: string;
  secrets: SecretAccessor;
  healthIO: HealthIO;
  pollIntervalMs: number;
  applyTimeoutMs: number;
}

export async function createSystemOrchestratorService(deps: FactoryDeps): Promise<SystemOrchestratorService | null> {
  const readTemplate = async (filename: string) => readFile(join(deps.templateDir, filename), "utf8");
  const reg = await buildServiceRegistry({ config: deps.managedServicesConfig, readTemplate, secrets: deps.secrets });
  if (!reg.ok) {
    return null;
  }
  // Dockerode default-connects to /var/run/docker.sock.
  const docker = new Dockerode() as unknown as DockerodeLike;
  const driver = createDockerDriver({ docker });
  const orch = createSystemOrchestrator({
    registry: reg.value,
    driver,
    healthIO: deps.healthIO,
    pollIntervalMs: deps.pollIntervalMs,
    applyTimeoutMs: deps.applyTimeoutMs,
  });
  return {
    registry: reg.value,
    applyAll: () => orch.applyAll(),
    applySubset: (names) => orch.applySubset(names),
    getStatus: () => orch.getStatus(),
    reconcile: () => reconcileOnBoot({ driver, registry: reg.value, orchestrator: { applyAll: () => orch.applyAll() } }),
  };
}
```

- [ ] **Step 2: Wire into bootstrap**

Modify `gateway/src/bootstrap/create-gateway-services.ts`. Add an import:
```ts
import { createSystemOrchestratorService } from "../system-orchestrator/index.js";
```

In the body of `createGatewayServices`, after the existing supervisord setup, add:
```ts
const systemOrchestrator = cfg.managed_services
  ? await createSystemOrchestratorService({
      managedServicesConfig: cfg.managed_services as Record<string, unknown>,
      templateDir: join(GATEWAY_RUNTIME_DIR, "templates", "services"),
      secrets: makeSecretAccessor(secretsStore),
      healthIO: defaultHealthIO,
      pollIntervalMs: 1000,
      applyTimeoutMs: 5 * 60 * 1000,
    })
  : null;
```

Where `makeSecretAccessor` is a small adapter near the top of the file:
```ts
function makeSecretAccessor(store: SecretsStore | null): SecretAccessor {
  return {
    resolve(path: string): string | null {
      if (!store) return null;
      // Dotted path lookup over the loaded snapshot.
      const parts = path.split(".");
      let cur: unknown = store.loadSync();
      for (const p of parts) {
        if (cur === null || typeof cur !== "object") return null;
        cur = (cur as Record<string, unknown>)[p];
      }
      return typeof cur === "string" ? cur : null;
    },
  };
}
```

(`loadSync()` is added in Step 3.)

- [ ] **Step 3: Add `loadSync()` to SecretsStore**

In `gateway/src/admin/secrets-store.ts`, add a synchronous accessor that returns the in-memory snapshot. Most secret operations already cache the loaded shape; expose it. If your implementation does not cache, do a one-time load on first call and memoize.

- [ ] **Step 4: Add `defaultHealthIO`**

Create `gateway/src/system-orchestrator/health-io.ts`:
```ts
import { connect } from "node:net";
import { spawn } from "node:child_process";
import type { HealthIO } from "./health.js";

export const defaultHealthIO: HealthIO = {
  fetch: async (url, timeoutMs) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await globalThis.fetch(url, { signal: ctl.signal });
      return { ok: r.ok };
    } finally { clearTimeout(t); }
  },
  tcpProbe: (target, timeoutMs) => new Promise<boolean>((resolve) => {
    const [host, port] = target.split(":");
    const sock = connect({ host, port: Number(port) });
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.once("connect", () => { clearTimeout(timer); sock.destroy(); resolve(true); });
    sock.once("error", () => { clearTimeout(timer); resolve(false); });
  }),
  execProbe: (cmd, timeoutMs) => new Promise<number>((resolve) => {
    const child = spawn(cmd[0]!, cmd.slice(1));
    const timer = setTimeout(() => { child.kill(); resolve(-1); }, timeoutMs);
    child.on("exit", (code) => { clearTimeout(timer); resolve(code ?? -1); });
    child.on("error", () => { clearTimeout(timer); resolve(-1); });
  }),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};
```

Import this in `index.ts` and pass it through `createSystemOrchestratorService`.

- [ ] **Step 5: Wire into config schema**

In `@sentient/config` (the workspace package), extend the gateway config schema with an optional `managed_services: z.record(z.string(), z.unknown()).optional()` field. Inspect the current schema file and follow its pattern.

- [ ] **Step 6: Run typecheck**

Run: `cd gateway && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add gateway/src/system-orchestrator/index.ts \
        gateway/src/system-orchestrator/health-io.ts \
        gateway/src/bootstrap/create-gateway-services.ts \
        gateway/src/admin/secrets-store.ts \
        shared/config/
git commit -m "feat(system-orch): wire orchestrator into gateway bootstrap"
```

---

### Task 15: GET /api/v1/system/apply-status endpoint

Wizard step-bringup polls this endpoint to render per-service progress.

**Files:**
- Create: `gateway/src/api/handlers/system-status.ts`
- Modify: `gateway/src/api/server.ts` (route registration; check actual file name in your tree)
- Test: `gateway/src/api/handlers/system-status.test.ts`

- [ ] **Step 1: Confirm router registration file**

Run: `grep -rn 'createSecretsHandler\|/api/v1/admin/secrets' gateway/src --include='*.ts' | grep -v test | head`
Expected: surfaces the file that mounts handler routes (likely `gateway/src/main.ts` or `gateway/src/api/router.ts`). Use that file in step 4.

- [ ] **Step 2: Write the failing test**

Create `gateway/src/api/handlers/system-status.test.ts`:
```ts
import { test, expect } from "bun:test";
import { createSystemStatusHandler } from "./system-status.js";

const fakeOrch = { getStatus: () => ({ state: "ready" as const, services: [], startedAt: 1, finishedAt: 2 }) };

test("GET returns the current orchestrator status", async () => {
  const h = createSystemStatusHandler({ systemOrchestrator: fakeOrch });
  const res = await h(new Request("http://localhost/api/v1/system/apply-status"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.state).toBe("ready");
});

test("returns 503 when orchestrator is unavailable (no docker socket / not booted)", async () => {
  const h = createSystemStatusHandler({ systemOrchestrator: null });
  const res = await h(new Request("http://localhost/api/v1/system/apply-status"));
  expect(res.status).toBe(503);
});
```

- [ ] **Step 3: Implement handler**

Create `gateway/src/api/handlers/system-status.ts`:
```ts
import type { OrchestratorStatus } from "../../system-orchestrator/types.js";

export interface SystemStatusDeps {
  systemOrchestrator: { getStatus(): OrchestratorStatus } | null;
}

export function createSystemStatusHandler(deps: SystemStatusDeps): (req: Request) => Promise<Response> {
  return async (_req) => {
    if (!deps.systemOrchestrator) {
      return Response.json({ error: "orchestrator-unavailable" }, { status: 503 });
    }
    return Response.json(deps.systemOrchestrator.getStatus(), { status: 200 });
  };
}
```

- [ ] **Step 4: Mount route**

In the router file from Step 1, add:
```ts
if (url.pathname === "/api/v1/system/apply-status" && req.method === "GET") {
  return systemStatusHandler(req);
}
```

Pass the orchestrator service into the handler factory at server bootstrap.

- [ ] **Step 5: Run tests**

Run: `cd gateway/src && bun test api/handlers/system-status.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add gateway/src/api/handlers/system-status.ts \
        gateway/src/api/handlers/system-status.test.ts \
        <router-file>
git commit -m "feat(api): GET /api/v1/system/apply-status for wizard step-bringup"
```

---

### Task 16: First-apply trigger on /wizard/finish

When the wizard's existing `/api/v1/wizard/finish` is POSTed, the gateway must (in addition to flipping `bootstrap_complete`): call `systemOrchestrator.applyAll()` in the background and advance `wizard_cursor` to a new state `bringup`.

**Files:**
- Modify: `gateway/src/admin/install-state.ts` (add `"bringup"` to `WizardCursor`)
- Modify: the wizard handler (find via grep below)

- [ ] **Step 1: Locate wizard handler**

Run: `grep -rn '/wizard/finish\|wizard.finish' gateway/src --include='*.ts' | grep -v test | head`
Expected: surfaces `gateway/src/api/handlers/wizard.ts` (or similar). Open it.

- [ ] **Step 2: Extend WizardCursor**

In `gateway/src/admin/install-state.ts`, change:
```ts
export type WizardCursor = "provider" | "voice" | "complete";
```
to:
```ts
export type WizardCursor = "provider" | "voice" | "secrets" | "bringup" | "complete";
```

Update the transition table (the function that validates `from → to` moves) to add the rows:
- `voice → secrets` (allowed)
- `secrets → bringup` (allowed; entered by `/wizard/finish`)
- `bringup → complete` (allowed; entered by a new endpoint Step 4 below)

- [ ] **Step 3: Modify finish handler**

In the wizard handler, locate the line that flips `bootstrap_complete=true` and replace its surrounding block so that:

1. It first transitions cursor `secrets → bringup` (NOT to `complete` directly).
2. It does NOT yet flip `bootstrap_complete` to true.
3. It kicks off `systemOrchestrator.applyAll()` in the background (`void` call, no await).
4. Returns `{ ok: true, cursor: "bringup" }`.

Pseudocode:
```ts
const transitionResult = await deps.installState.transition("secrets", "bringup");
if (!transitionResult.ok) return jsonError(409, "transition", transitionResult.error.kind);
void deps.systemOrchestrator.applyAll().catch((err) => log.error("first-apply.crashed", { reason: String(err) }));
return Response.json({ ok: true, cursor: "bringup" }, { status: 200 });
```

- [ ] **Step 4: Add complete-bringup endpoint**

In the same wizard handler, add `POST /api/v1/wizard/complete-bringup`. Body: empty. Behavior:

1. Read orchestrator status. If `state !== "ready"`, return 412 with the current status.
2. Otherwise, transition cursor `bringup → complete`, flip `bootstrap_complete=true`, return `{ ok: true, cursor: "complete" }`.

Code:
```ts
if (path === "/api/v1/wizard/complete-bringup" && method === "POST") {
  const status = deps.systemOrchestrator?.getStatus();
  if (!status || status.state !== "ready") {
    return Response.json({ error: "not-ready", status }, { status: 412 });
  }
  const t = await deps.installState.transition("bringup", "complete");
  if (!t.ok) return jsonError(409, "transition", t.error.kind);
  await deps.installState.markBootstrapComplete();
  return Response.json({ ok: true, cursor: "complete" }, { status: 200 });
}
```

- [ ] **Step 5: Run typecheck + tests**

Run:
```bash
cd gateway && bun run typecheck
cd gateway/src && bun test admin/install-state.test.ts
```
Expected: PASS. Some existing install-state tests may need updating to reflect the new cursor states; modify those tests to add the new transitions, do not weaken assertions.

- [ ] **Step 6: Commit**

```bash
git add gateway/src/admin/install-state.ts \
        gateway/src/api/handlers/wizard.ts \
        gateway/src/admin/install-state.test.ts
git commit -m "feat(wizard): cursor states 'secrets' + 'bringup'; finish triggers system apply"
```

---

### Task 17: step-secrets.tsx (HA URL/tokens, MA URL/token)

Wizard step that collects HA/MA URLs and tokens. All optional. PUTs each field to its existing secrets endpoint as the user advances.

**Files:**
- Create: `gateway/webui/src/components/wizard/steps/step-secrets.tsx`
- Modify: `gateway/webui/src/components/wizard/wizard-shell.tsx`

- [ ] **Step 1: Implement step-secrets**

Create `gateway/webui/src/components/wizard/steps/step-secrets.tsx`:
```tsx
import { useState } from "preact/hooks";
import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";

const log = createLogger(["sentient", "webui", "wizard", "step-secrets"]);

export interface StepSecretsProps { onAdvance: () => Promise<void>; }

export function StepSecrets({ onAdvance }: StepSecretsProps): JSX.Element {
  const [haUrl, setHaUrl] = useState("");
  const [haObserve, setHaObserve] = useState("");
  const [haMcp, setHaMcp] = useState("");
  const [maUrl, setMaUrl] = useState("");
  const [maToken, setMaToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function put(path: string, value: string): Promise<boolean> {
    if (value === "") return true;
    const r = await fetch(`/api/v1/admin/secrets/${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
    return r.ok;
  }

  async function next() {
    setBusy(true);
    setErr(null);
    try {
      const all = await Promise.all([
        put("home_assistant/url", haUrl),
        put("home_assistant/observe_token", haObserve),
        put("home_assistant/mcp_server_token", haMcp),
        put("music_assistant/url", maUrl),
        put("music_assistant", maToken),
      ]);
      if (!all.every(Boolean)) { setErr("One or more secret writes failed."); return; }

      const cursor = await fetch("/api/v1/wizard/cursor", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "secrets", to: "bringup" }),
      });
      if (!cursor.ok) { setErr("Could not advance to bringup."); return; }

      // /wizard/finish kicks off the first apply.
      const finish = await fetch("/api/v1/wizard/finish", { method: "POST" });
      if (!finish.ok) { setErr("Failed to start services."); return; }
      log.info("step-secrets.advance");
      await onAdvance();
    } finally { setBusy(false); }
  }

  return (
    <section class="aw-step">
      <header class="aw-step-head">
        <h2 class="aw-step__title">Connect smart-home services (optional)</h2>
        <p class="aw-step__sub">If you use Home Assistant or Music Assistant, give Sentient access here. Skip any field you don't use.</p>
      </header>

      <div class="aw-fields">
        <p class="aw-fields__label">Home Assistant</p>
        <div class="aw-field-group">
          <label class="aw-label" htmlFor="ha-url">URL</label>
          <input id="ha-url" class="aw-input" type="text" placeholder="https://homeassistant.local:8123" value={haUrl} onInput={(e) => setHaUrl((e.target as HTMLInputElement).value)} />
        </div>
        <div class="aw-field-group">
          <label class="aw-label" htmlFor="ha-observe">Observer token <span class="aw-label-hint">(read-only)</span></label>
          <input id="ha-observe" class="aw-input" type="password" value={haObserve} onInput={(e) => setHaObserve((e.target as HTMLInputElement).value)} />
        </div>
        <div class="aw-field-group">
          <label class="aw-label" htmlFor="ha-mcp">MCP token <span class="aw-label-hint">(write access for tools)</span></label>
          <input id="ha-mcp" class="aw-input" type="password" value={haMcp} onInput={(e) => setHaMcp((e.target as HTMLInputElement).value)} />
        </div>

        <p class="aw-fields__label">Music Assistant</p>
        <div class="aw-field-group">
          <label class="aw-label" htmlFor="ma-url">URL</label>
          <input id="ma-url" class="aw-input" type="text" placeholder="http://mass.local:8095" value={maUrl} onInput={(e) => setMaUrl((e.target as HTMLInputElement).value)} />
        </div>
        <div class="aw-field-group">
          <label class="aw-label" htmlFor="ma-token">Token</label>
          <input id="ma-token" class="aw-input" type="password" value={maToken} onInput={(e) => setMaToken((e.target as HTMLInputElement).value)} />
        </div>
      </div>

      {err && <div class="aw-error-banner">{err}</div>}

      <footer class="aw-footer">
        <span class="aw-footer__spacer" />
        <button class="btn b-primary" type="button" disabled={busy} onClick={next}>
          {busy ? "Saving…" : "Continue"}
        </button>
      </footer>
    </section>
  );
}
```

- [ ] **Step 2: Add cursor PUT route**

Add a small endpoint `PUT /api/v1/wizard/cursor` at the wizard handler that accepts `{ from, to }` and calls `installState.transition`. This avoids the wizard calling `/finish` to advance the cursor through `secrets → bringup`. Implementation mirrors the existing transition helper.

- [ ] **Step 3: Add to WizardShell**

Modify `gateway/webui/src/components/wizard/wizard-shell.tsx` so it renders `StepSecrets` when `state.wizard_cursor === "secrets"`, and renders the bringup step (added in Task 18) when cursor is `"bringup"`.

In the component body, add the imports and the conditional render branches:
```tsx
import { StepSecrets } from "./steps/step-secrets.tsx";
import { StepBringup } from "./steps/step-bringup.tsx";
// ...
{state.wizard_cursor === "secrets" && <StepSecrets onAdvance={onChange} />}
{state.wizard_cursor === "bringup" && <StepBringup onAdvance={onChange} />}
```

Also update `WizardStepper` to render the two new pips: extend its `current` union and the rendered list.

- [ ] **Step 4: Run typecheck**

Run: `cd gateway/webui && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/webui/src/components/wizard/steps/step-secrets.tsx \
        gateway/webui/src/components/wizard/wizard-shell.tsx \
        gateway/webui/src/components/wizard/wizard-stepper.tsx \
        gateway/src/api/handlers/wizard.ts
git commit -m "feat(wizard): step-secrets collects HA/MA URLs + tokens"
```

---

### Task 18: step-bringup.tsx (poll + auto-advance)

Wizard step that polls `/api/v1/system/apply-status` every 1 s. Renders per-service rows. On `state === "ready"`, posts `/api/v1/wizard/complete-bringup` and advances. On any required service `failed`, shows a Retry button that re-POSTs `/api/v1/wizard/finish`.

**Files:**
- Create: `gateway/webui/src/components/wizard/steps/step-bringup.tsx`

- [ ] **Step 1: Implement step-bringup**

Create `gateway/webui/src/components/wizard/steps/step-bringup.tsx`:
```tsx
import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";

const log = createLogger(["sentient", "webui", "wizard", "step-bringup"]);

interface ServiceRow {
  name: string;
  state: "pending" | "starting" | "health-checking" | "ready" | "degraded" | "failed" | "blocked-by-dep" | "pending-secrets";
  optional: boolean;
  lastError: string | null;
}
interface Status {
  state: "idle" | "planning" | "applying" | "ready" | "failed";
  services: ServiceRow[];
}

const POLL_MS = 1000;

export interface StepBringupProps { onAdvance: () => Promise<void>; }

export function StepBringup({ onAdvance }: StepBringupProps): JSX.Element {
  const [status, setStatus] = useState<Status | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let active = true;
    async function poll() {
      while (active) {
        try {
          const r = await fetch("/api/v1/system/apply-status");
          if (r.ok) {
            const s = (await r.json()) as Status;
            setStatus(s);
            if (s.state === "ready") {
              const finish = await fetch("/api/v1/wizard/complete-bringup", { method: "POST" });
              if (finish.ok) { log.info("step-bringup.complete"); await onAdvance(); active = false; return; }
            }
          }
        } catch (err) { log.warn("step-bringup.poll-error", { err: String(err) }); }
        await new Promise((res) => setTimeout(res, POLL_MS));
      }
    }
    void poll();
    return () => { active = false; };
  }, [onAdvance]);

  async function retry() {
    setRetrying(true);
    try {
      await fetch("/api/v1/wizard/finish", { method: "POST" });
    } finally { setRetrying(false); }
  }

  const requiredFailed = status?.services.some((s) => !s.optional && s.state === "failed") ?? false;

  return (
    <section class="aw-step">
      <header class="aw-step-head">
        <h2 class="aw-step__title">Starting up services…</h2>
        <p class="aw-step__sub">This will only take a moment. We're bringing the assistant's services online.</p>
      </header>

      <ul class="aw-fields">
        {(status?.services ?? []).map((s) => (
          <li key={s.name} class="aw-field-group">
            <span class="aw-label">{s.name}{s.optional ? " (optional)" : ""}</span>
            <span class="aw-field-hint">{labelForState(s.state)}</span>
            {s.lastError && <span class="aw-field-hint aw-muted">{s.lastError}</span>}
          </li>
        ))}
      </ul>

      <footer class="aw-footer">
        <span class="aw-footer__spacer" />
        {requiredFailed && (
          <button class="btn b-primary" type="button" disabled={retrying} onClick={retry}>
            {retrying ? "Retrying…" : "Retry"}
          </button>
        )}
      </footer>
    </section>
  );
}

function labelForState(s: ServiceRow["state"]): string {
  switch (s) {
    case "pending": return "Queued";
    case "starting": return "Starting…";
    case "health-checking": return "Checking health…";
    case "ready": return "Ready ✓";
    case "degraded": return "Degraded — will continue without this";
    case "failed": return "Failed";
    case "blocked-by-dep": return "Waiting on dependency";
    case "pending-secrets": return "Skipped — no credentials provided";
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd gateway/webui && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add gateway/webui/src/components/wizard/steps/step-bringup.tsx
git commit -m "feat(wizard): step-bringup polls system apply, advances on ready"
```

---

### Task 19: Wire system orchestrator into version handler; delete lazy resolver

The system orchestrator is now the single source of truth for required-service health + version. `gateway/src/services/version-resolver.ts` (introduced last round) is replaced.

**Files:**
- Modify: `gateway/src/api/handlers/version.ts`
- Delete: `gateway/src/services/version-resolver.ts` and its test
- Modify: `gateway/src/bootstrap/create-gateway-services.ts` (remove resolver wiring)

- [ ] **Step 1: Locate version handler**

Run: `cat gateway/src/api/handlers/version.ts`
Expected: it consumes the version-resolver. Remember its current shape.

- [ ] **Step 2: Add `getRequiredServicesStatus` to orchestrator service**

Modify `gateway/src/system-orchestrator/index.ts`. Append a method:
```ts
getRequiredServicesStatus(gatewayVersion: string, hermesVersionPath: string): Promise<Array<{ name: string; version: string; healthy: boolean }>>;
```

Implementation reads `getStatus()`, filters to required (non-optional) services, attaches versions:
- `gateway` row: hardcoded name + injected gatewayVersion + healthy=true (if we're alive to answer, we're healthy).
- `sentient-hermes` row: read `/data/supervisor/.versions/hermes` (the path written by the hermes container at boot, which already exists per Task A from the previous round).
- `stt-service` row: probe `http://stt-service:8767/health` and read the `version` field.

For now, derive these inline in the factory (do NOT cache; the orchestrator fires apply on changes so calls are infrequent). If perf becomes a concern, add caching later.

- [ ] **Step 3: Rewrite version handler**

Rewrite `gateway/src/api/handlers/version.ts` to call `systemOrchestrator.getRequiredServicesStatus(...)` and return the array directly. Drop the dependency on the lazy resolver.

- [ ] **Step 4: Remove version-resolver wiring**

In `gateway/src/bootstrap/create-gateway-services.ts`, delete the block that creates `versionResolver` and any `services.versionResolver = …` plumbing.

- [ ] **Step 5: Delete the resolver files**

```bash
git rm gateway/src/services/version-resolver.ts
git rm gateway/src/services/version-resolver.test.ts 2>/dev/null || true
```

- [ ] **Step 6: Run typecheck + tests**

Run:
```bash
cd gateway && bun run typecheck
cd gateway/src && bun test api/handlers
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A gateway/src/api/handlers/version.ts \
          gateway/src/bootstrap/create-gateway-services.ts \
          gateway/src/system-orchestrator/index.ts \
          gateway/src/services/
git commit -m "refactor(version): orchestrator is single source of truth; drop lazy resolver"
```

---

### Task 20: Wire apply router into existing apply handler

The existing per-user apply HTTP path stays (back-compat for current settings UI), but a new unified handler at `POST /api/v1/apply` is also exposed and will become the canonical surface. This task adds the unified handler. Webui will migrate over in a follow-up.

**Files:**
- Create: `gateway/src/api/handlers/apply.ts`
- Modify: API router file (use grep result from Task 15 step 1)
- Test: covered by `apply/router.test.ts`

- [ ] **Step 1: Implement handler**

Create `gateway/src/api/handlers/apply.ts`:
```ts
import { z } from "zod";
import { runApplyRouted, type RouterDeps } from "../../apply/router.js";
import { getLog } from "../../logging/logger.js";

const log = getLog(["sentient", "api", "apply"]);

const ApplyBodySchema = z.object({
  profile: z.record(z.string(), z.unknown()).nullable().default(null),
  secrets: z.record(z.string(), z.record(z.string(), z.unknown())).nullable().default(null),
});

export interface ApplyHandlerDeps {
  routerDeps: RouterDeps;
  authenticate(req: Request): Promise<{ ok: true; userId: string } | { ok: false }>;
}

export function createApplyHandler(deps: ApplyHandlerDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== "POST") return Response.json({ error: "method-not-allowed" }, { status: 405 });
    const auth = await deps.authenticate(req);
    if (!auth.ok) return Response.json({ error: "unauthorized" }, { status: 401 });

    let raw: unknown;
    try { raw = await req.json(); } catch { return Response.json({ error: "bad-json" }, { status: 400 }); }
    const parsed = ApplyBodySchema.safeParse(raw);
    if (!parsed.success) return Response.json({ error: "schema", detail: parsed.error.message }, { status: 422 });

    const result = await runApplyRouted(parsed.data, deps.routerDeps, auth.userId);
    log.info("apply.routed", { userId: auth.userId, status: result.status });
    return Response.json(result.body, { status: result.status });
  };
}
```

- [ ] **Step 2: Mount route**

Add `POST /api/v1/apply` to the API router. Pass in the router deps, including:
- `isAdmin: (uid) => userStore.isAdmin(uid)` (or whatever existing admin check helper looks like)
- `diffSecrets: secretsStore.diffPaths` (add a small `diffPaths(partial)` helper to secrets-store that returns the dotted-paths whose new value differs from the stored one)
- `perUserApply: (uid, profile) => runApply(applyDeps, uid)` (existing per-user path, with the inbound `profile` written into the profile-store beforehand if non-null)
- `systemOrchestrator: { applySubset: orchestrator.applySubset }`
- `registry: orchestrator.registry`

- [ ] **Step 3: Add `diffPaths` to secrets-store**

Implementation: load current snapshot, walk the inbound partial, return the dotted-paths whose values differ.

- [ ] **Step 4: Run tests**

Run: `cd gateway/src && bun test apply/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/api/handlers/apply.ts \
        gateway/src/admin/secrets-store.ts \
        <router-file>
git commit -m "feat(api): unified POST /api/v1/apply with RBAC"
```

---

### Task 21: Shrink docker-compose.yml

Now that the gateway owns the lifecycle of the other services, compose only brings up `gateway` + networks + named volumes.

**Files:**
- Modify: `deploy/docker/docker-compose.yml`

- [ ] **Step 1: Read current compose**

Run: `wc -l deploy/docker/docker-compose.yml`
Expected: ~400 lines.

- [ ] **Step 2: Rewrite compose**

Replace `deploy/docker/docker-compose.yml` with this complete file (keep the gateway service block intact from the existing file — copy the `gateway:` service exactly as-is, only remove `depends_on:` references to non-existent-anymore services):

```yaml
# Sentient — single-service compose. Gateway owns lifecycle of all
# dependent services via dockerode (mounted /var/run/docker.sock).
# See docs/superpowers/specs/2026-05-03-system-service-orchestrator-design.md.
version: "3.9"

services:
  # ── Existing gateway service block goes here, unchanged except depends_on ──
  gateway:
    # ... (preserve build, container_name, environment, volumes, healthcheck,
    #      ports, networks from the original file. The only change is
    #      removing any `depends_on:` entries — gateway no longer waits on
    #      sibling compose services because they no longer exist as compose
    #      services. Keep `restart: unless-stopped`.)

networks:
  sentient-internal:
    internal: true
  sentient-external: {}

volumes:
  sentient-supervisor: {}
```

- [ ] **Step 3: Verify the gateway image still has docker socket access**

In the gateway `volumes:` list, confirm `- /var/run/docker.sock:/var/run/docker.sock` is present (Task 14 added it via the bootstrap factory; here we ensure compose mounts it). Add it if missing.

Also confirm: gateway has `group_add: ["${HOST_DOCKER_GID:?HOST_DOCKER_GID required}"]` (mirror what the hermes service has today).

- [ ] **Step 4: Commit**

```bash
git add deploy/docker/docker-compose.yml
git commit -m "refactor(deploy): compose has only gateway; orchestrator owns the rest"
```

---

### Task 22: Browser smoke procedures

Document the end-to-end smoke flow in `agents/docs/testing-knowledge.md`. No code changes; updates the manual test playbook.

**Files:**
- Modify: `agents/docs/testing-knowledge.md`

- [ ] **Step 1: Append section**

Append:

```markdown
## System orchestrator (Phase 6 setup wizard)

### Cold-path smoke

1. Tear down: `docker compose down -v && rm -rf ~/.sentient`
2. Bring up: `docker compose up -d`
3. Open `https://localhost:8888`. Wizard renders.
4. Walk: unlock → provider (LLM key) → voice (Fish key) → secrets (HA URL+tokens, MA URL+token; or skip).
5. Click Continue on the secrets step. Page transitions to "Starting up services…".
6. Per-service rows tick from "Queued" → "Starting…" → "Checking health…" → "Ready ✓" in dependency order. Required first; optional services last.
7. When all required are Ready, page auto-advances to step-admin (account creation). Continue through admin → "All set" → reload into chat.

### Warm restart

1. With a bootstrapped deployment, run `docker compose down && docker compose up -d`.
2. Reload the webui. No wizard appears. Sidebar shows "All services online". No re-bringup screen.

### Settings rotation (admin)

1. Log in as admin. Settings → Smart-home → rotate the HA token.
2. Apply bar shows `ha-mcp` going through `recreating` → `health-checking` → `ready`.
3. Other services are not touched.

### RBAC

1. Log in as a non-admin user.
2. From the browser console, POST to `/api/v1/apply` with `{ "secrets": { "home_assistant": { "mcp_server_token": "x" } } }`.
3. Response is 403, no orchestrator activity in logs.

### Power-loss recovery

1. With a healthy deployment running, `docker kill sentient-ha-mcp`.
2. Restart the gateway: `docker restart sentient-gateway`.
3. Boot reconciler logs `reconcile.applying`, then `applyAll` brings ha-mcp back to ready (assuming HA is still reachable).

### Orphan reap

1. `docker run -d --label sentient.managed=true --label sentient.service=fake nginx`
2. Restart the gateway: `docker restart sentient-gateway`.
3. The fake container is gone. Logs include `reconcile.orphan-reap` for `sentient.service=fake`.
```

- [ ] **Step 2: Commit**

```bash
git add agents/docs/testing-knowledge.md
git commit -m "docs(testing): smoke procedures for system orchestrator"
```

---

### Task 23: Integration test — docker driver

Validates the docker driver against a real docker daemon. Skipped unless `RUN_LIVE=1`.

**Files:**
- Create: `gateway/src/system-orchestrator/docker-driver.integration.test.ts`

- [ ] **Step 1: Author the test**

Create `gateway/src/system-orchestrator/docker-driver.integration.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import Dockerode from "dockerode";
import { createDockerDriver, type DockerodeLike } from "./docker-driver.js";
import type { ManagedService } from "./types.js";

const RUN_LIVE = process.env.RUN_LIVE === "1";
const d = (RUN_LIVE ? describe : describe.skip);

d("[live] dockerDriver against real daemon", () => {
  const docker = new Dockerode() as unknown as DockerodeLike;
  const driver = createDockerDriver({ docker });

  const ms: ManagedService = {
    name: "smoke-noop",
    config: {
      template: "x",
      allowed_images: ["alpine:3.20"],
      networks: ["bridge"],
      secrets: {},
      healthcheck: { tcp: "smoke-noop:1", timeout_ms: 1000 },
      depends_on: [],
      optional: true,
    },
    template: {
      image: "alpine:3.20",
      container_name: "sentient-smoke-noop",
      networks: ["bridge"],
      env: {},
      volumes: [],
      command: ["sleep", "60"],
      extra_hosts: [],
      group_add: [],
    },
  };

  it("recreates a container with the sentient.managed label", async () => {
    const r = await driver.recreate(ms);
    expect(r.ok).toBe(true);
    const live = await driver.listManaged();
    expect(live.find((c) => c.service === "smoke-noop")).toBeTruthy();

    // cleanup
    await driver.remove("sentient-smoke-noop");
  }, 30_000);

  it("rejects a spec whose image is not in allowed_images", async () => {
    const bad = { ...ms, template: { ...ms.template, image: "evil/image:v1" } };
    const r = await driver.recreate(bad);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run with live flag**

Run: `cd gateway && RUN_LIVE=1 bun run test:int system-orchestrator/docker-driver.integration.test.ts`
Expected: PASS — container created, listed, removed.

- [ ] **Step 3: Commit**

```bash
git add gateway/src/system-orchestrator/docker-driver.integration.test.ts
git commit -m "test(system-orch): @live integration test for docker driver"
```

---

### Task 24: Final wire-up smoke + commit

Run the full wizard end-to-end against a fresh deployment, verify all the smoke procedures from Task 22 pass.

**Files:** none (manual verification + final cleanup commit).

- [ ] **Step 1: Tear down and restart**

```bash
docker compose down -v && rm -rf ~/.sentient
docker compose up -d
```

- [ ] **Step 2: Run the cold-path smoke**

Follow the steps under "Cold-path smoke" in `agents/docs/testing-knowledge.md`. Confirm:
- Wizard reaches `step-bringup`.
- All required services report Ready within ~1 minute (STT model load may take 30 s+).
- Optional services either Ready or "Skipped — no credentials provided" depending on whether HA/MA tokens were entered.
- Auto-advances to step-admin.
- Account creation works; chat works end-to-end.

- [ ] **Step 3: Run the warm-restart smoke**

`docker restart sentient-gateway`. Confirm sidebar still shows "All services online" within ~10 s.

- [ ] **Step 4: Run RBAC + orphan reap smokes**

Both procedures from Task 22.

- [ ] **Step 5: Final docs commit (if anything updated during smoke)**

```bash
git add -A
git commit -m "chore: smoke-verified system orchestrator end-to-end"  # only if there are diffs
```

---

## Self-review summary

**Spec coverage check** (each spec section maps to a task):

| Spec section | Task |
|--------------|------|
| Architecture (two orchestrators + apply router) | 9 (orch), 11 (router), 14 (wiring) |
| Compose footprint shrink | 21 |
| `service-registry.ts` | 4 |
| `template-loader.ts` | 3 |
| `docker-driver.ts` | 8 |
| `dep-graph.ts` | 5 |
| `orchestrator.ts` | 9 |
| `boot-reconciler.ts` | 10 |
| `secret-binding.ts` | 6 |
| `health.ts` | 7 |
| `gateway/src/apply/router.ts` | 11 |
| `gateway/templates/services/*.yaml` (6 files) | 12 |
| `gateway/config.yaml#managed_services` | 12 |
| `gateway/src/api/handlers/version.ts` refactor | 19 |
| `gateway/webui/src/components/wizard/steps/step-secrets.tsx` | 17 |
| `gateway/webui/src/components/wizard/steps/step-bringup.tsx` | 18 |
| `gateway/src/profile-store/profile-defaults.ts` re-add | 0 |
| Setup wizard sequence + cursor states | 16, 17, 18 |
| Boot path (cold + warm) | 14, 16, 22, 24 |
| Apply path (settings change) | 11, 20 |
| Version + health endpoint | 19 |
| Failure semantics | 9 (orch), 22 (smoke) |
| Security model (templates baked, policy gate, RBAC, label requirement) | 3, 4, 8, 11 |
| Unit tests (8 listed) | 0–11 (each task ships its tests) |
| Integration test for docker driver | 23 |
| Browser smoke procedures | 22 |
| HA/MA URL fields in secrets-store | 13 |

No spec section is unmapped.

**Type consistency check:** `ManagedService`, `ServiceName`, `OrchestratorStatus`, `HealthCheck`, `ServiceTemplate`, `ManagedServiceConfig` are all defined in Task 2 and reused unchanged through Task 24.

**Placeholder scan:** No "TBD"/"TODO"/"add appropriate error handling" patterns. Tasks 13, 15, 16, 19, 20 reference existing files via grep — explicitly call those grep commands as plan steps so the engineer locates the correct line by command, not by guess.
