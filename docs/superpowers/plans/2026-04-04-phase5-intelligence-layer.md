> **SUPERSEDED BY** `docs/superpowers/specs/2026-04-21-hermes-cerebrum-integration-design-v4.md`
>
> Date superseded: 2026-04-22.
> Reason: Phase 1 (Hermes cerebrum integration) absorbs this scope.
> Kept as historical reference.

---

# Phase 5: Intelligence Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tools, skills, memory, guest mode — real assistant. Family assistant with memory, tools, skills, guest access. Production-ready.

**Architecture:** Tool registry with `@tool` decorator pattern + auto-discovery. ReAct agent loop (max 5 iterations) with parallel tool execution. Skill engine: Markdown + YAML frontmatter, LLM-interpreted, hot-reloadable, scoped tool access. Per-user memory: sectioned Markdown, end-of-session extraction via Haiku, tiered storage. Guest mode: PIN-based ephemeral sessions. Audit logging: structured JSON lines + metrics endpoint.

**Prerequisite:** Phase 4 complete — gateway has full voice pipeline, web client, classifier, security, and production Docker setup.

**Tech Stack:** Bun 1.2+, TypeScript 5.8+ (strict), Vitest, zod, paseto-ts, OpenRouter (Sonnet for tools, Haiku for extraction)

---

## File Structure

```
gateway/
├── src/
│   ├── tools/
│   │   ├── types.ts                   # Tool interfaces, ToolContext, ToolResult, ImpactTier
│   │   ├── types.test.ts
│   │   ├── registry.ts                # ToolRegistry class, @tool decorator, auto-discovery
│   │   ├── registry.test.ts
│   │   ├── react-loop.ts              # ReAct agent loop (max 5 iterations, parallel exec)
│   │   ├── react-loop.test.ts
│   │   ├── confirmation.ts            # Tool confirmation flow (WebSocket confirm/deny)
│   │   ├── confirmation.test.ts
│   │   ├── context.ts                 # ToolContext factory (scoped secrets, HTTP, audit)
│   │   ├── context.test.ts
│   │   ├── builtin/
│   │   │   ├── clock.ts               # Time/date tool
│   │   │   ├── clock.test.ts
│   │   │   ├── weather.ts             # Weather HTTP API tool
│   │   │   ├── weather.test.ts
│   │   │   ├── timer.ts               # Timer/reminder in-memory scheduler
│   │   │   ├── timer.test.ts
│   │   │   ├── remember.ts            # Explicit "remember this" tool
│   │   │   └── remember.test.ts
│   │   └── index.ts                   # Re-exports
│   ├── skills/
│   │   ├── types.ts                   # SkillDefinition, ParameterDef interfaces
│   │   ├── types.test.ts
│   │   ├── engine.ts                  # SkillEngine — execute skills via scoped ReAct loop
│   │   ├── engine.test.ts
│   │   ├── loader.ts                  # SkillLoader — file watcher, parse, validate, register
│   │   ├── loader.test.ts
│   │   ├── frontmatter.ts             # YAML frontmatter parser
│   │   ├── frontmatter.test.ts
│   │   ├── cycle-detector.ts          # DFS cycle detection on composition graph
│   │   ├── cycle-detector.test.ts
│   │   └── index.ts
│   ├── memory/
│   │   ├── types.ts                   # MemorySection, MemoryOp interfaces
│   │   ├── types.test.ts
│   │   ├── manager.ts                 # MemoryManager — load, update, extract, reconcile
│   │   ├── manager.test.ts
│   │   ├── extractor.ts               # Fact extraction via LLM
│   │   ├── extractor.test.ts
│   │   ├── reconciler.ts              # ADD/UPDATE/DELETE/NONE reconciliation
│   │   ├── reconciler.test.ts
│   │   ├── context-assembler.ts       # Context assembly with token budgets
│   │   ├── context-assembler.test.ts
│   │   ├── token-estimator.ts         # chars/4 with safety buffer
│   │   ├── token-estimator.test.ts
│   │   └── index.ts
│   ├── guest/
│   │   ├── types.ts                   # GuestSession, GuestInvite interfaces
│   │   ├── types.test.ts
│   │   ├── invite-manager.ts          # PIN generation, validation, claiming
│   │   ├── invite-manager.test.ts
│   │   ├── session.ts                 # Ephemeral guest session (in-memory Map)
│   │   ├── session.test.ts
│   │   └── index.ts
│   ├── audit/
│   │   ├── types.ts                   # AuditEntry, MetricsSnapshot interfaces
│   │   ├── types.test.ts
│   │   ├── logger.ts                  # Structured JSON lines logger with rotation
│   │   ├── logger.test.ts
│   │   ├── metrics.ts                 # In-memory metrics collector + /metrics endpoint
│   │   ├── metrics.test.ts
│   │   └── index.ts
│   └── ...existing Phase 1-4 code...
├── skills/                            # Skill markdown files (hot-reloaded)
│   ├── morning-briefing.md
│   └── set-reminder.md
└── memory/                            # Per-user memory files
    └── .gitkeep
```

---

## Task 5.1: Tool Registry + ReAct Loop

**Files:**
- Create: `gateway/src/tools/types.ts`
- Create: `gateway/src/tools/types.test.ts`
- Create: `gateway/src/tools/context.ts`
- Create: `gateway/src/tools/context.test.ts`
- Create: `gateway/src/tools/registry.ts`
- Create: `gateway/src/tools/registry.test.ts`
- Create: `gateway/src/tools/react-loop.ts`
- Create: `gateway/src/tools/react-loop.test.ts`
- Create: `gateway/src/tools/index.ts`

### Part A: Tool Type Definitions (~5 min)

- [ ] **Step 1: Write tests for tool types `gateway/src/tools/types.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import {
  type ToolDefinition,
  type ToolResult,
  type ToolContext,
  type ImpactTier,
  IMPACT_TIERS,
  toolDefinitionSchema,
} from "./types.ts";

describe("tool types", () => {
  it("defines all four impact tiers", () => {
    expect(IMPACT_TIERS).toEqual(["read", "write", "confirm", "admin"]);
  });

  it("validates a well-formed tool definition schema", () => {
    const valid = {
      name: "weather",
      description: "Get current weather for a location",
      tier: "read",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City name" },
        },
        required: ["location"],
      },
    };

    const result = toolDefinitionSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects tool definition with invalid tier", () => {
    const invalid = {
      name: "weather",
      description: "Get weather",
      tier: "superadmin",
      parameters: { type: "object", properties: {} },
    };

    const result = toolDefinitionSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects tool definition with empty name", () => {
    const invalid = {
      name: "",
      description: "Does nothing",
      tier: "read",
      parameters: { type: "object", properties: {} },
    };

    const result = toolDefinitionSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects tool name with invalid characters", () => {
    const invalid = {
      name: "my tool!",
      description: "Bad name",
      tier: "read",
      parameters: { type: "object", properties: {} },
    };

    const result = toolDefinitionSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});

describe("ToolResult", () => {
  it("represents success with output", () => {
    const result: ToolResult = { success: true, output: "72°F, sunny" };
    expect(result.success).toBe(true);
    expect(result.output).toBe("72°F, sunny");
  });

  it("represents failure with error message", () => {
    const result: ToolResult = { success: false, output: "API timeout after 5000ms" };
    expect(result.success).toBe(false);
    expect(result.output).toContain("timeout");
  });
});
```

- [ ] **Step 2: Implement tool types `gateway/src/tools/types.ts`**

```typescript
import { z } from "zod";

export const IMPACT_TIERS = ["read", "write", "confirm", "admin"] as const;
export type ImpactTier = (typeof IMPACT_TIERS)[number];

export type Role = "adult" | "child" | "guest";

export interface ToolResult {
  success: boolean;
  output: string;
}

export interface ToolContext {
  sessionId: string;
  userId: string;
  role: Role;
  signal: AbortSignal;
  getSecret: (key: string) => string;
  httpClient: typeof fetch;
  audit: (action: string, detail: Record<string, unknown>) => void;
}

export type ToolHandler = (
  params: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult>;

export interface ToolDefinition {
  name: string;
  description: string;
  tier: ImpactTier;
  parameters: ToolParameterSchema;
  handler: ToolHandler;
}

export interface ToolParameterSchema {
  type: "object";
  properties: Record<string, ToolPropertySchema>;
  required?: string[];
}

export interface ToolPropertySchema {
  type: "string" | "number" | "boolean";
  description: string;
  enum?: string[];
  default?: unknown;
}

export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export const toolDefinitionSchema = z.object({
  name: z.string().min(1).regex(TOOL_NAME_PATTERN, "Tool name must be lowercase alphanumeric with hyphens/underscores"),
  description: z.string().min(1).max(500),
  tier: z.enum(IMPACT_TIERS),
  parameters: z.object({
    type: z.literal("object"),
    properties: z.record(z.object({
      type: z.enum(["string", "number", "boolean"]),
      description: z.string(),
      enum: z.array(z.string()).optional(),
      default: z.unknown().optional(),
    })),
    required: z.array(z.string()).optional(),
  }),
});

/** Decorator-style tool registration helper */
export interface ToolRegistrationOptions {
  name: string;
  description: string;
  tier: ImpactTier;
  parameters: ToolParameterSchema;
}

export function defineTool(
  options: ToolRegistrationOptions,
  handler: ToolHandler,
): ToolDefinition {
  return { ...options, handler };
}
```

- [ ] **Step 3: Run tests**

Run: `cd gateway && bun test src/tools/types.test.ts`

Expected: All tests pass.

### Part B: Tool Context (~4 min)

- [ ] **Step 4: Write tests for ToolContext factory `gateway/src/tools/context.test.ts`**

```typescript
import { describe, it, expect, vi } from "vitest";
import { createToolContext } from "./context.ts";
import type { Role } from "./types.ts";

describe("createToolContext", () => {
  const mockAuditFn = vi.fn();
  const mockSecrets = new Map([
    ["WEATHER_API_KEY", "test-key-123"],
    ["OPENROUTER_API_KEY", "sk-or-test"],
  ]);

  function buildContext(overrides?: { role?: Role; allowedSecrets?: string[] }) {
    return createToolContext({
      sessionId: "sess-1",
      userId: "kevin",
      role: overrides?.role ?? "adult",
      signal: new AbortController().signal,
      secrets: mockSecrets,
      allowedSecrets: overrides?.allowedSecrets ?? ["WEATHER_API_KEY"],
      auditFn: mockAuditFn,
    });
  }

  it("provides session metadata", () => {
    const ctx = buildContext();
    expect(ctx.sessionId).toBe("sess-1");
    expect(ctx.userId).toBe("kevin");
    expect(ctx.role).toBe("adult");
  });

  it("returns allowed secrets", () => {
    const ctx = buildContext({ allowedSecrets: ["WEATHER_API_KEY"] });
    expect(ctx.getSecret("WEATHER_API_KEY")).toBe("test-key-123");
  });

  it("throws for non-allowed secrets", () => {
    const ctx = buildContext({ allowedSecrets: ["WEATHER_API_KEY"] });
    expect(() => ctx.getSecret("OPENROUTER_API_KEY")).toThrow(
      "Secret 'OPENROUTER_API_KEY' not in allowed scope",
    );
  });

  it("throws for non-existent secrets", () => {
    const ctx = buildContext({ allowedSecrets: ["NONEXISTENT"] });
    expect(() => ctx.getSecret("NONEXISTENT")).toThrow(
      "Secret 'NONEXISTENT' not found",
    );
  });

  it("provides HTTP client", () => {
    const ctx = buildContext();
    expect(typeof ctx.httpClient).toBe("function");
  });

  it("provides audit function that delegates to auditFn", () => {
    const ctx = buildContext();
    ctx.audit("tool_call", { toolName: "weather" });
    expect(mockAuditFn).toHaveBeenCalledWith("tool_call", {
      toolName: "weather",
      sessionId: "sess-1",
      userId: "kevin",
      role: "adult",
    });
  });

  it("passes AbortSignal through", () => {
    const controller = new AbortController();
    const ctx = createToolContext({
      sessionId: "sess-2",
      userId: "kevin",
      role: "adult",
      signal: controller.signal,
      secrets: mockSecrets,
      allowedSecrets: [],
      auditFn: mockAuditFn,
    });
    expect(ctx.signal.aborted).toBe(false);
    controller.abort();
    expect(ctx.signal.aborted).toBe(true);
  });
});
```

- [ ] **Step 5: Implement ToolContext factory `gateway/src/tools/context.ts`**

```typescript
import type { ToolContext, Role } from "./types.ts";

export interface CreateToolContextOptions {
  sessionId: string;
  userId: string;
  role: Role;
  signal: AbortSignal;
  secrets: Map<string, string>;
  allowedSecrets: string[];
  auditFn: (action: string, detail: Record<string, unknown>) => void;
}

export function createToolContext(options: CreateToolContextOptions): ToolContext {
  const allowedSet = new Set(options.allowedSecrets);

  return {
    sessionId: options.sessionId,
    userId: options.userId,
    role: options.role,
    signal: options.signal,

    getSecret(key: string): string {
      if (!allowedSet.has(key)) {
        throw new Error(`Secret '${key}' not in allowed scope`);
      }
      const value = options.secrets.get(key);
      if (value === undefined) {
        throw new Error(`Secret '${key}' not found`);
      }
      return value;
    },

    httpClient: fetch,

    audit(action: string, detail: Record<string, unknown>): void {
      options.auditFn(action, {
        ...detail,
        sessionId: options.sessionId,
        userId: options.userId,
        role: options.role,
      });
    },
  };
}
```

- [ ] **Step 6: Run tests**

Run: `cd gateway && bun test src/tools/context.test.ts`

Expected: All tests pass.

### Part C: Tool Registry (~5 min)

- [ ] **Step 7: Write tests for ToolRegistry `gateway/src/tools/registry.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "./registry.ts";
import { defineTool } from "./types.ts";
import type { ToolDefinition, ToolContext } from "./types.ts";

const mockHandler = async () => ({ success: true, output: "ok" });

function makeTool(overrides?: Partial<ToolDefinition>): ToolDefinition {
  return defineTool(
    {
      name: overrides?.name ?? "test-tool",
      description: overrides?.description ?? "A test tool",
      tier: overrides?.tier ?? "read",
      parameters: overrides?.parameters ?? {
        type: "object",
        properties: {},
      },
    },
    overrides?.handler ?? mockHandler,
  );
}

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("registers and retrieves a tool", () => {
    const tool = makeTool({ name: "weather" });
    registry.register(tool);

    expect(registry.get("weather")).toBe(tool);
  });

  it("returns undefined for unregistered tool", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("has() returns true for registered tools", () => {
    registry.register(makeTool({ name: "clock" }));
    expect(registry.has("clock")).toBe(true);
    expect(registry.has("missing")).toBe(false);
  });

  it("lists all registered tool names", () => {
    registry.register(makeTool({ name: "weather" }));
    registry.register(makeTool({ name: "clock" }));
    registry.register(makeTool({ name: "timer" }));

    expect(registry.listNames()).toEqual(["clock", "timer", "weather"]);
  });

  it("throws on duplicate tool name", () => {
    registry.register(makeTool({ name: "weather" }));

    expect(() => registry.register(makeTool({ name: "weather" }))).toThrow(
      "Tool 'weather' is already registered",
    );
  });

  it("unregisters a tool by name", () => {
    registry.register(makeTool({ name: "weather" }));
    registry.unregister("weather");

    expect(registry.has("weather")).toBe(false);
  });

  it("ignores unregister for non-existent tool", () => {
    expect(() => registry.unregister("missing")).not.toThrow();
  });

  it("returns tool schemas for OpenAI-compatible format", () => {
    registry.register(makeTool({
      name: "weather",
      description: "Get weather",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City" },
        },
        required: ["location"],
      },
    }));

    const schemas = registry.getToolSchemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0]).toEqual({
      type: "function",
      function: {
        name: "weather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: {
            location: { type: "string", description: "City" },
          },
          required: ["location"],
        },
      },
    });
  });

  it("filters tool schemas by role (guest sees only read-tier)", () => {
    registry.register(makeTool({ name: "weather", tier: "read" }));
    registry.register(makeTool({ name: "reminder", tier: "write" }));
    registry.register(makeTool({ name: "home-control", tier: "confirm" }));
    registry.register(makeTool({ name: "user-mgmt", tier: "admin" }));

    const guestSchemas = registry.getToolSchemas("guest");
    expect(guestSchemas.map(s => s.function.name)).toEqual(["weather"]);

    const childSchemas = registry.getToolSchemas("child");
    expect(childSchemas.map(s => s.function.name)).toEqual(["reminder", "weather"]);

    const adultSchemas = registry.getToolSchemas("adult");
    expect(adultSchemas.map(s => s.function.name)).toEqual([
      "home-control", "reminder", "user-mgmt", "weather",
    ]);
  });

  it("returns tool count", () => {
    registry.register(makeTool({ name: "a" }));
    registry.register(makeTool({ name: "b" }));
    expect(registry.size).toBe(2);
  });

  it("clears all tools", () => {
    registry.register(makeTool({ name: "a" }));
    registry.register(makeTool({ name: "b" }));
    registry.clear();
    expect(registry.size).toBe(0);
  });

  it("validates tool definition at registration", () => {
    const invalid = {
      name: "",
      description: "bad",
      tier: "read" as const,
      parameters: { type: "object" as const, properties: {} },
      handler: mockHandler,
    };

    expect(() => registry.register(invalid)).toThrow();
  });
});
```

- [ ] **Step 8: Implement ToolRegistry `gateway/src/tools/registry.ts`**

```typescript
import type { ToolDefinition, Role, ImpactTier } from "./types.ts";
import { toolDefinitionSchema } from "./types.ts";

interface OpenAIToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolDefinition["parameters"];
  };
}

const ROLE_TIER_ACCESS: Record<Role, Set<ImpactTier>> = {
  adult: new Set(["read", "write", "confirm", "admin"]),
  child: new Set(["read", "write"]),
  guest: new Set(["read"]),
};

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    const validation = toolDefinitionSchema.safeParse(tool);
    if (!validation.success) {
      throw new Error(
        `Invalid tool definition for '${tool.name}': ${validation.error.message}`,
      );
    }

    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`);
    }

    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  listNames(): string[] {
    return [...this.tools.keys()].sort();
  }

  get size(): number {
    return this.tools.size;
  }

  clear(): void {
    this.tools.clear();
  }

  getToolSchemas(role?: Role): OpenAIToolSchema[] {
    const allowedTiers = role ? ROLE_TIER_ACCESS[role] : undefined;

    return this.listNames()
      .map(name => this.tools.get(name)!)
      .filter(tool => !allowedTiers || allowedTiers.has(tool.tier))
      .map(tool => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
  }
}
```

- [ ] **Step 9: Run tests**

Run: `cd gateway && bun test src/tools/registry.test.ts`

Expected: All tests pass.

### Part D: ReAct Agent Loop (~5 min)

- [ ] **Step 10: Write tests for ReAct loop `gateway/src/tools/react-loop.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeReActLoop } from "./react-loop.ts";
import { ToolRegistry } from "./registry.ts";
import { defineTool } from "./types.ts";
import type { ToolResult, Role } from "./types.ts";

function createMockLLM(responses: Array<{
  content?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}>) {
  let callIndex = 0;
  return vi.fn(async () => {
    const response = responses[callIndex++];
    if (!response) throw new Error("No more mock LLM responses");
    return response;
  });
}

function createTestRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(defineTool(
    {
      name: "clock",
      description: "Get current time",
      tier: "read",
      parameters: { type: "object", properties: {} },
    },
    async () => ({ success: true, output: "2026-04-04T10:30:00Z" }),
  ));

  registry.register(defineTool(
    {
      name: "weather",
      description: "Get weather",
      tier: "read",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City" },
        },
        required: ["location"],
      },
    },
    async (_params) => ({ success: true, output: "72°F, sunny in Portland" }),
  ));

  return registry;
}

describe("executeReActLoop", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = createTestRegistry();
  });

  it("returns direct response when LLM makes no tool calls", async () => {
    const mockLLM = createMockLLM([
      { content: "Hello! How can I help you?" },
    ]);

    const result = await executeReActLoop({
      messages: [{ role: "user", content: "Hi there" }],
      toolRegistry: registry,
      role: "adult",
      llmCall: mockLLM,
      signal: new AbortController().signal,
    });

    expect(result.response).toBe("Hello! How can I help you?");
    expect(result.toolCalls).toHaveLength(0);
    expect(mockLLM).toHaveBeenCalledTimes(1);
  });

  it("executes single tool call and returns final response", async () => {
    const mockLLM = createMockLLM([
      {
        tool_calls: [{
          id: "call-1",
          function: { name: "clock", arguments: "{}" },
        }],
      },
      { content: "The current time is 10:30 AM UTC." },
    ]);

    const result = await executeReActLoop({
      messages: [{ role: "user", content: "What time is it?" }],
      toolRegistry: registry,
      role: "adult",
      llmCall: mockLLM,
      signal: new AbortController().signal,
    });

    expect(result.response).toBe("The current time is 10:30 AM UTC.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("clock");
    expect(result.toolCalls[0].result.success).toBe(true);
  });

  it("executes parallel tool calls via Promise.all", async () => {
    const mockLLM = createMockLLM([
      {
        tool_calls: [
          { id: "call-1", function: { name: "clock", arguments: "{}" } },
          { id: "call-2", function: { name: "weather", arguments: '{"location":"Portland"}' } },
        ],
      },
      { content: "It's 10:30 AM and 72°F in Portland." },
    ]);

    const result = await executeReActLoop({
      messages: [{ role: "user", content: "Time and weather?" }],
      toolRegistry: registry,
      role: "adult",
      llmCall: mockLLM,
      signal: new AbortController().signal,
    });

    expect(result.response).toBe("It's 10:30 AM and 72°F in Portland.");
    expect(result.toolCalls).toHaveLength(2);
  });

  it("respects max iteration limit (5)", async () => {
    const infiniteToolCalls = Array.from({ length: 6 }, (_, i) => ({
      tool_calls: [{
        id: `call-${i}`,
        function: { name: "clock", arguments: "{}" },
      }],
    }));

    const mockLLM = createMockLLM(infiniteToolCalls);

    const result = await executeReActLoop({
      messages: [{ role: "user", content: "loop forever" }],
      toolRegistry: registry,
      role: "adult",
      llmCall: mockLLM,
      signal: new AbortController().signal,
      maxIterations: 5,
    });

    expect(result.response).toContain("maximum iterations");
    expect(mockLLM).toHaveBeenCalledTimes(5);
  });

  it("feeds tool error back to LLM as observation", async () => {
    const failingRegistry = new ToolRegistry();
    failingRegistry.register(defineTool(
      {
        name: "broken-tool",
        description: "Always fails",
        tier: "read",
        parameters: { type: "object", properties: {} },
      },
      async () => ({ success: false, output: "Network timeout after 5000ms" }),
    ));

    const mockLLM = createMockLLM([
      {
        tool_calls: [{
          id: "call-1",
          function: { name: "broken-tool", arguments: "{}" },
        }],
      },
      { content: "Sorry, the tool encountered an error. Let me try another approach." },
    ]);

    const result = await executeReActLoop({
      messages: [{ role: "user", content: "use broken tool" }],
      toolRegistry: failingRegistry,
      role: "adult",
      llmCall: mockLLM,
      signal: new AbortController().signal,
    });

    expect(result.response).toContain("error");
    // Verify the LLM was called a second time with the error observation
    expect(mockLLM).toHaveBeenCalledTimes(2);
  });

  it("returns error for hallucinated tool name", async () => {
    const mockLLM = createMockLLM([
      {
        tool_calls: [{
          id: "call-1",
          function: { name: "nonexistent_tool", arguments: "{}" },
        }],
      },
      { content: "I apologize, that tool is not available." },
    ]);

    const result = await executeReActLoop({
      messages: [{ role: "user", content: "use magic tool" }],
      toolRegistry: registry,
      role: "adult",
      llmCall: mockLLM,
      signal: new AbortController().signal,
    });

    // The loop should feed back an error observation and the LLM should respond
    expect(mockLLM).toHaveBeenCalledTimes(2);
  });

  it("cancels on AbortSignal", async () => {
    const controller = new AbortController();
    const slowLLM = vi.fn(async () => {
      controller.abort();
      return { content: "response" };
    });

    const result = await executeReActLoop({
      messages: [{ role: "user", content: "test" }],
      toolRegistry: registry,
      role: "adult",
      llmCall: slowLLM,
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
  });

  it("filters tools by role for guest", async () => {
    registry.register(defineTool(
      {
        name: "admin-tool",
        description: "Admin only",
        tier: "admin",
        parameters: { type: "object", properties: {} },
      },
      async () => ({ success: true, output: "admin result" }),
    ));

    const mockLLM = createMockLLM([
      {
        tool_calls: [{
          id: "call-1",
          function: { name: "admin-tool", arguments: "{}" },
        }],
      },
      { content: "That tool is not available for guests." },
    ]);

    const result = await executeReActLoop({
      messages: [{ role: "user", content: "admin stuff" }],
      toolRegistry: registry,
      role: "guest",
      llmCall: mockLLM,
      signal: new AbortController().signal,
    });

    // admin-tool should not be accessible for guest
    expect(mockLLM).toHaveBeenCalledTimes(2);
  });

  it("passes scoped tool names when provided", async () => {
    const mockLLM = createMockLLM([
      {
        tool_calls: [{
          id: "call-1",
          function: { name: "weather", arguments: '{"location":"NYC"}' },
        }],
      },
      { content: "Weather in NYC: 72°F" },
    ]);

    const result = await executeReActLoop({
      messages: [{ role: "user", content: "weather?" }],
      toolRegistry: registry,
      role: "adult",
      llmCall: mockLLM,
      signal: new AbortController().signal,
      scopedToolNames: new Set(["weather"]),
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("weather");
  });

  it("blocks tool outside scoped set", async () => {
    const mockLLM = createMockLLM([
      {
        tool_calls: [{
          id: "call-1",
          function: { name: "clock", arguments: "{}" },
        }],
      },
      { content: "Clock is not available in this scope." },
    ]);

    const result = await executeReActLoop({
      messages: [{ role: "user", content: "time?" }],
      toolRegistry: registry,
      role: "adult",
      llmCall: mockLLM,
      signal: new AbortController().signal,
      scopedToolNames: new Set(["weather"]),
    });

    // clock should be blocked — only weather is in scope
    expect(mockLLM).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 11: Implement ReAct loop `gateway/src/tools/react-loop.ts`**

```typescript
import type { ToolRegistry } from "./registry.ts";
import type { ToolResult, Role } from "./types.ts";

const DEFAULT_MAX_ITERATIONS = 5;

interface LLMToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface LLMResponse {
  content?: string;
  tool_calls?: LLMToolCall[];
}

interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: LLMToolCall[];
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: ToolResult;
  durationMs: number;
}

export interface ReActResult {
  response: string;
  toolCalls: ToolCallRecord[];
  iterations: number;
  cancelled: boolean;
}

export interface ReActOptions {
  messages: Message[];
  toolRegistry: ToolRegistry;
  role: Role;
  llmCall: (messages: Message[], tools: unknown[]) => Promise<LLMResponse>;
  signal: AbortSignal;
  maxIterations?: number;
  scopedToolNames?: Set<string>;
  onToolCall?: (record: ToolCallRecord) => void;
}

export async function executeReActLoop(options: ReActOptions): Promise<ReActResult> {
  const {
    toolRegistry,
    role,
    llmCall,
    signal,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    scopedToolNames,
    onToolCall,
  } = options;

  const messages: Message[] = [...options.messages];
  const toolCallRecords: ToolCallRecord[] = [];

  const toolSchemas = scopedToolNames
    ? toolRegistry.getToolSchemas(role).filter(s => scopedToolNames.has(s.function.name))
    : toolRegistry.getToolSchemas(role);

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (signal.aborted) {
      return { response: "", toolCalls: toolCallRecords, iterations: iteration, cancelled: true };
    }

    const llmResponse = await llmCall(messages, toolSchemas);

    if (signal.aborted) {
      return { response: "", toolCalls: toolCallRecords, iterations: iteration + 1, cancelled: true };
    }

    // No tool calls — LLM is done, return final response
    if (!llmResponse.tool_calls || llmResponse.tool_calls.length === 0) {
      return {
        response: llmResponse.content ?? "",
        toolCalls: toolCallRecords,
        iterations: iteration + 1,
        cancelled: false,
      };
    }

    // Add assistant message with tool calls to history
    messages.push({
      role: "assistant",
      content: llmResponse.content ?? "",
      tool_calls: llmResponse.tool_calls,
    });

    // Execute all tool calls in parallel
    const toolResults = await Promise.all(
      llmResponse.tool_calls.map(async (toolCall): Promise<{ id: string; record: ToolCallRecord }> => {
        const startTime = performance.now();
        const { name } = toolCall.function;

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          const record: ToolCallRecord = {
            name,
            args: {},
            result: { success: false, output: `Invalid JSON arguments: ${toolCall.function.arguments}` },
            durationMs: performance.now() - startTime,
          };
          return { id: toolCall.id, record };
        }

        // Check if tool is in scoped set
        if (scopedToolNames && !scopedToolNames.has(name)) {
          const record: ToolCallRecord = {
            name,
            args,
            result: {
              success: false,
              output: `Tool '${name}' is not authorized in this scope. Available: ${[...scopedToolNames].join(", ")}`,
            },
            durationMs: performance.now() - startTime,
          };
          return { id: toolCall.id, record };
        }

        const tool = toolRegistry.get(name);
        if (!tool) {
          const record: ToolCallRecord = {
            name,
            args,
            result: {
              success: false,
              output: `Tool '${name}' does not exist. Available tools: ${toolRegistry.listNames().join(", ")}`,
            },
            durationMs: performance.now() - startTime,
          };
          return { id: toolCall.id, record };
        }

        let result: ToolResult;
        try {
          result = await tool.handler(args, {} as any); // ToolContext injected at integration layer
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          result = { success: false, output: `Tool execution error: ${message}` };
        }

        const record: ToolCallRecord = {
          name,
          args,
          result,
          durationMs: performance.now() - startTime,
        };

        onToolCall?.(record);
        return { id: toolCall.id, record };
      }),
    );

    // Add tool results to message history and collect records
    for (const { id, record } of toolResults) {
      toolCallRecords.push(record);
      messages.push({
        role: "tool",
        tool_call_id: id,
        content: record.result.output,
      });
    }
  }

  // Hit max iterations without a final response
  return {
    response: `I reached the maximum iterations (${maxIterations}) while processing your request. Here's what I found so far based on the tool results.`,
    toolCalls: toolCallRecords,
    iterations: maxIterations,
    cancelled: false,
  };
}
```

- [ ] **Step 12: Run tests**

Run: `cd gateway && bun test src/tools/react-loop.test.ts`

Expected: All tests pass.

- [ ] **Step 13: Create index re-exports `gateway/src/tools/index.ts`**

```typescript
export { type ToolDefinition, type ToolResult, type ToolContext, type ImpactTier, type Role, type ToolHandler, defineTool, IMPACT_TIERS, TOOL_NAME_PATTERN, toolDefinitionSchema } from "./types.ts";
export { ToolRegistry } from "./registry.ts";
export { executeReActLoop, type ReActOptions, type ReActResult, type ToolCallRecord } from "./react-loop.ts";
export { createToolContext, type CreateToolContextOptions } from "./context.ts";
```

- [ ] **Step 14: Run all tool tests together**

Run: `cd gateway && bun test src/tools/`

Expected: ~30 tests pass.

- [ ] **Step 15: Commit**

```bash
git add gateway/src/tools/
git commit -m "feat(gateway): tool registry, ReAct agent loop, and ToolContext"
```

---

## Task 5.2: Tool Confirmation Flow

**Files:**
- Create: `gateway/src/tools/confirmation.ts`
- Create: `gateway/src/tools/confirmation.test.ts`

- [ ] **Step 1: Write tests for confirmation flow `gateway/src/tools/confirmation.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolConfirmationManager, type ConfirmationRequest } from "./confirmation.ts";

function createMockWsSend() {
  return vi.fn<(data: string) => void>();
}

describe("ToolConfirmationManager", () => {
  let manager: ToolConfirmationManager;

  beforeEach(() => {
    manager = new ToolConfirmationManager();
  });

  it("sends confirmation request to client via WebSocket", async () => {
    const wsSend = createMockWsSend();
    const confirmPromise = manager.requestConfirmation({
      sessionId: "sess-1",
      toolName: "home-control",
      description: "Turn off living room lights",
      args: { device: "living-room-light", action: "off" },
      wsSend,
      timeoutMs: 5000,
    });

    expect(wsSend).toHaveBeenCalledTimes(1);
    const sentMessage = JSON.parse(wsSend.mock.calls[0][0]);
    expect(sentMessage.type).toBe("tool.confirm_request");
    expect(sentMessage.toolName).toBe("home-control");
    expect(sentMessage.description).toBe("Turn off living room lights");
    expect(sentMessage.requestId).toBeDefined();

    // Simulate user confirming
    manager.handleResponse(sentMessage.requestId, true);
    const result = await confirmPromise;
    expect(result.confirmed).toBe(true);
  });

  it("resolves denied when user rejects", async () => {
    const wsSend = createMockWsSend();
    const confirmPromise = manager.requestConfirmation({
      sessionId: "sess-1",
      toolName: "purchase",
      description: "Buy item for $29.99",
      args: {},
      wsSend,
      timeoutMs: 5000,
    });

    const sentMessage = JSON.parse(wsSend.mock.calls[0][0]);
    manager.handleResponse(sentMessage.requestId, false);

    const result = await confirmPromise;
    expect(result.confirmed).toBe(false);
    expect(result.reason).toBe("denied");
  });

  it("times out after specified duration", async () => {
    vi.useFakeTimers();
    const wsSend = createMockWsSend();
    const confirmPromise = manager.requestConfirmation({
      sessionId: "sess-1",
      toolName: "home-control",
      description: "Turn on AC",
      args: {},
      wsSend,
      timeoutMs: 30_000,
    });

    vi.advanceTimersByTime(30_001);

    const result = await confirmPromise;
    expect(result.confirmed).toBe(false);
    expect(result.reason).toBe("timeout");

    vi.useRealTimers();
  });

  it("cancels pending confirmation", async () => {
    const wsSend = createMockWsSend();
    const confirmPromise = manager.requestConfirmation({
      sessionId: "sess-1",
      toolName: "home-control",
      description: "Dim lights",
      args: {},
      wsSend,
      timeoutMs: 30_000,
    });

    const sentMessage = JSON.parse(wsSend.mock.calls[0][0]);
    manager.cancel(sentMessage.requestId);

    const result = await confirmPromise;
    expect(result.confirmed).toBe(false);
    expect(result.reason).toBe("cancelled");
  });

  it("cancels all pending confirmations for a session", async () => {
    const wsSend = createMockWsSend();

    const promise1 = manager.requestConfirmation({
      sessionId: "sess-1",
      toolName: "tool-a",
      description: "Action A",
      args: {},
      wsSend,
      timeoutMs: 30_000,
    });

    const promise2 = manager.requestConfirmation({
      sessionId: "sess-1",
      toolName: "tool-b",
      description: "Action B",
      args: {},
      wsSend,
      timeoutMs: 30_000,
    });

    manager.cancelSession("sess-1");

    const [result1, result2] = await Promise.all([promise1, promise2]);
    expect(result1.confirmed).toBe(false);
    expect(result2.confirmed).toBe(false);
  });

  it("ignores response for unknown request ID", () => {
    expect(() => manager.handleResponse("unknown-id", true)).not.toThrow();
  });

  it("counts pending confirmations", () => {
    const wsSend = createMockWsSend();
    manager.requestConfirmation({
      sessionId: "sess-1", toolName: "a", description: "A", args: {}, wsSend, timeoutMs: 5000,
    });
    manager.requestConfirmation({
      sessionId: "sess-1", toolName: "b", description: "B", args: {}, wsSend, timeoutMs: 5000,
    });

    expect(manager.pendingCount).toBe(2);
  });
});
```

- [ ] **Step 2: Implement confirmation manager `gateway/src/tools/confirmation.ts`**

```typescript
export interface ConfirmationRequest {
  sessionId: string;
  toolName: string;
  description: string;
  args: Record<string, unknown>;
  wsSend: (data: string) => void;
  timeoutMs: number;
}

export interface ConfirmationResult {
  confirmed: boolean;
  reason?: "denied" | "timeout" | "cancelled";
}

interface PendingConfirmation {
  sessionId: string;
  resolve: (result: ConfirmationResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ToolConfirmationManager {
  private pending = new Map<string, PendingConfirmation>();

  get pendingCount(): number {
    return this.pending.size;
  }

  async requestConfirmation(request: ConfirmationRequest): Promise<ConfirmationResult> {
    const requestId = crypto.randomUUID();

    const message = JSON.stringify({
      type: "tool.confirm_request",
      requestId,
      toolName: request.toolName,
      description: request.description,
      timeoutMs: request.timeoutMs,
    });

    request.wsSend(message);

    return new Promise<ConfirmationResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ confirmed: false, reason: "timeout" });
      }, request.timeoutMs);

      this.pending.set(requestId, {
        sessionId: request.sessionId,
        resolve,
        timer,
      });
    });
  }

  handleResponse(requestId: string, confirmed: boolean): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(requestId);

    entry.resolve(
      confirmed
        ? { confirmed: true }
        : { confirmed: false, reason: "denied" },
    );
  }

  cancel(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve({ confirmed: false, reason: "cancelled" });
  }

  cancelSession(sessionId: string): void {
    for (const [requestId, entry] of this.pending) {
      if (entry.sessionId === sessionId) {
        clearTimeout(entry.timer);
        this.pending.delete(requestId);
        entry.resolve({ confirmed: false, reason: "cancelled" });
      }
    }
  }
}
```

- [ ] **Step 3: Run tests**

Run: `cd gateway && bun test src/tools/confirmation.test.ts`

Expected: ~8 tests pass.

- [ ] **Step 4: Update `gateway/src/tools/index.ts` to export confirmation module**

Add to `gateway/src/tools/index.ts`:

```typescript
export { ToolConfirmationManager, type ConfirmationRequest, type ConfirmationResult } from "./confirmation.ts";
```

- [ ] **Step 5: Commit**

```bash
git add gateway/src/tools/confirmation.ts gateway/src/tools/confirmation.test.ts gateway/src/tools/index.ts
git commit -m "feat(gateway): tool confirmation flow with WebSocket confirm/deny"
```

---

## Task 5.3: Built-in Tools (Weather, Time, Reminders)

**Files:**
- Create: `gateway/src/tools/builtin/clock.ts`
- Create: `gateway/src/tools/builtin/clock.test.ts`
- Create: `gateway/src/tools/builtin/weather.ts`
- Create: `gateway/src/tools/builtin/weather.test.ts`
- Create: `gateway/src/tools/builtin/timer.ts`
- Create: `gateway/src/tools/builtin/timer.test.ts`
- Create: `gateway/src/tools/builtin/remember.ts`
- Create: `gateway/src/tools/builtin/remember.test.ts`

### Part A: Clock Tool (~3 min)

- [ ] **Step 1: Write tests for clock tool `gateway/src/tools/builtin/clock.test.ts`**

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { clockTool } from "./clock.ts";

describe("clockTool", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("has correct metadata", () => {
    expect(clockTool.name).toBe("clock");
    expect(clockTool.tier).toBe("read");
    expect(clockTool.description).toContain("time");
  });

  it("returns current time in ISO format", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T10:30:00Z"));

    const result = await clockTool.handler({}, {} as any);
    expect(result.success).toBe(true);
    expect(result.output).toContain("2026-04-04");
    expect(result.output).toContain("10:30");

    vi.useRealTimers();
  });

  it("returns time for specified timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T10:30:00Z"));

    const result = await clockTool.handler({ timezone: "America/New_York" }, {} as any);
    expect(result.success).toBe(true);
    expect(result.output).toContain("America/New_York");

    vi.useRealTimers();
  });

  it("returns date info when asked for date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T10:30:00Z"));

    const result = await clockTool.handler({ format: "date" }, {} as any);
    expect(result.success).toBe(true);
    expect(result.output).toContain("2026-04-04");
    expect(result.output).toContain("Saturday");

    vi.useRealTimers();
  });

  it("returns error for invalid timezone", async () => {
    const result = await clockTool.handler({ timezone: "Invalid/Zone" }, {} as any);
    expect(result.success).toBe(false);
    expect(result.output).toContain("Invalid timezone");
  });
});
```

- [ ] **Step 2: Implement clock tool `gateway/src/tools/builtin/clock.ts`**

```typescript
import { defineTool } from "../types.ts";

export const clockTool = defineTool(
  {
    name: "clock",
    description: "Get the current time and date. Use when the user asks what time it is, what day it is, or needs the current date.",
    tier: "read",
    parameters: {
      type: "object",
      properties: {
        timezone: {
          type: "string",
          description: "IANA timezone (e.g. America/New_York). Defaults to system timezone.",
        },
        format: {
          type: "string",
          description: "Output format: 'time' for time only, 'date' for date only, 'full' for both. Default: full.",
          enum: ["time", "date", "full"],
        },
      },
    },
  },
  async (params) => {
    const timezone = (params.timezone as string | undefined) ?? undefined;
    const format = (params.format as string | undefined) ?? "full";

    try {
      const now = new Date();
      const options: Intl.DateTimeFormatOptions = { timeZone: timezone };

      if (format === "time" || format === "full") {
        options.hour = "2-digit";
        options.minute = "2-digit";
        options.second = "2-digit";
        options.hour12 = true;
      }

      if (format === "date" || format === "full") {
        options.weekday = "long";
        options.year = "numeric";
        options.month = "long";
        options.day = "numeric";
      }

      // Validate timezone by attempting to format
      const formatted = new Intl.DateTimeFormat("en-US", options).format(now);
      const iso = now.toISOString();
      const tzLabel = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

      return {
        success: true,
        output: `Current ${format}: ${formatted} (${tzLabel}). ISO: ${iso}`,
      };
    } catch (error: unknown) {
      if (error instanceof RangeError) {
        return { success: false, output: `Invalid timezone: '${timezone}'` };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Clock error: ${message}` };
    }
  },
);
```

- [ ] **Step 3: Run tests**

Run: `cd gateway && bun test src/tools/builtin/clock.test.ts`

Expected: All tests pass.

### Part B: Weather Tool (~4 min)

- [ ] **Step 4: Write tests for weather tool `gateway/src/tools/builtin/weather.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { weatherTool } from "./weather.ts";
import type { ToolContext } from "../types.ts";

function createMockContext(fetchMock: typeof fetch): ToolContext {
  return {
    sessionId: "sess-1",
    userId: "kevin",
    role: "adult",
    signal: new AbortController().signal,
    getSecret: (key: string) => {
      if (key === "WEATHER_API_KEY") return "test-weather-key";
      throw new Error(`Secret '${key}' not found`);
    },
    httpClient: fetchMock,
    audit: vi.fn(),
  };
}

describe("weatherTool", () => {
  it("has correct metadata", () => {
    expect(weatherTool.name).toBe("weather");
    expect(weatherTool.tier).toBe("read");
  });

  it("returns weather data for a valid location", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        current: {
          temperature_2m: 72,
          weathercode: 0,
          windspeed_10m: 8,
          relative_humidity_2m: 45,
        },
        current_units: {
          temperature_2m: "°F",
          windspeed_10m: "mp/h",
        },
      }),
    });

    const ctx = createMockContext(mockFetch as any);
    const result = await weatherTool.handler({ location: "Portland, OR" }, ctx);

    expect(result.success).toBe(true);
    expect(result.output).toContain("72");
    expect(result.output).toContain("Portland");
  });

  it("returns error for missing location parameter", async () => {
    const ctx = createMockContext(vi.fn());
    const result = await weatherTool.handler({}, ctx);

    expect(result.success).toBe(false);
    expect(result.output).toContain("location");
  });

  it("returns error when API call fails", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });

    const ctx = createMockContext(mockFetch as any);
    const result = await weatherTool.handler({ location: "Portland" }, ctx);

    expect(result.success).toBe(false);
    expect(result.output).toContain("error");
  });

  it("handles network timeout", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("AbortError: signal timed out"));

    const ctx = createMockContext(mockFetch as any);
    const result = await weatherTool.handler({ location: "Portland" }, ctx);

    expect(result.success).toBe(false);
    expect(result.output).toContain("error");
  });

  it("maps weather codes to descriptions", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        current: {
          temperature_2m: 55,
          weathercode: 61,
          windspeed_10m: 12,
          relative_humidity_2m: 80,
        },
        current_units: {
          temperature_2m: "°F",
          windspeed_10m: "mp/h",
        },
      }),
    });

    const ctx = createMockContext(mockFetch as any);
    const result = await weatherTool.handler({ location: "Seattle" }, ctx);

    expect(result.success).toBe(true);
    expect(result.output).toContain("rain");
  });
});
```

- [ ] **Step 5: Implement weather tool `gateway/src/tools/builtin/weather.ts`**

```typescript
import { defineTool } from "../types.ts";
import type { ToolContext } from "../types.ts";

const WEATHER_CODES: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "foggy",
  48: "depositing rime fog",
  51: "light drizzle",
  53: "moderate drizzle",
  55: "dense drizzle",
  61: "slight rain",
  63: "moderate rain",
  65: "heavy rain",
  71: "slight snow",
  73: "moderate snow",
  75: "heavy snow",
  80: "slight rain showers",
  81: "moderate rain showers",
  82: "violent rain showers",
  85: "slight snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with slight hail",
  99: "thunderstorm with heavy hail",
};

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const REQUEST_TIMEOUT_MS = 5_000;

export const weatherTool = defineTool(
  {
    name: "weather",
    description: "Get current weather conditions for a location. Use when the user asks about weather, temperature, or forecast.",
    tier: "read",
    parameters: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "City name (e.g. 'Portland, OR', 'London')",
        },
      },
      required: ["location"],
    },
  },
  async (params, ctx: ToolContext) => {
    const location = params.location as string | undefined;
    if (!location) {
      return { success: false, output: "Missing required parameter: location" };
    }

    try {
      // Step 1: Geocode location
      const geoUrl = `${GEOCODING_URL}?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
      const geoResponse = await ctx.httpClient(geoUrl, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!geoResponse.ok) {
        return { success: false, output: `Geocoding error: ${geoResponse.status} ${geoResponse.statusText}` };
      }

      const geoData = await geoResponse.json() as { results?: Array<{ latitude: number; longitude: number; name: string; country: string }> };
      const place = geoData.results?.[0];
      if (!place) {
        return { success: false, output: `Location not found: '${location}'` };
      }

      // Step 2: Fetch weather
      const weatherUrl = `${WEATHER_URL}?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,weathercode,windspeed_10m,relative_humidity_2m&temperature_unit=fahrenheit&windspeed_unit=mph`;
      const weatherResponse = await ctx.httpClient(weatherUrl, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!weatherResponse.ok) {
        return { success: false, output: `Weather API error: ${weatherResponse.status} ${weatherResponse.statusText}` };
      }

      const weatherData = await weatherResponse.json() as {
        current: {
          temperature_2m: number;
          weathercode: number;
          windspeed_10m: number;
          relative_humidity_2m: number;
        };
      };

      const { temperature_2m, weathercode, windspeed_10m, relative_humidity_2m } = weatherData.current;
      const condition = WEATHER_CODES[weathercode] ?? `unknown (code ${weathercode})`;

      const output = [
        `Weather for ${place.name}, ${place.country}:`,
        `Temperature: ${temperature_2m}°F`,
        `Conditions: ${condition}`,
        `Wind: ${windspeed_10m} mph`,
        `Humidity: ${relative_humidity_2m}%`,
      ].join("\n");

      ctx.audit("tool_call", { toolName: "weather", location, temperature: temperature_2m });
      return { success: true, output };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Weather fetch error: ${message}` };
    }
  },
);
```

- [ ] **Step 6: Run tests**

Run: `cd gateway && bun test src/tools/builtin/weather.test.ts`

Expected: All tests pass.

### Part C: Timer/Reminder Tool (~4 min)

- [ ] **Step 7: Write tests for timer tool `gateway/src/tools/builtin/timer.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { timerTool, reminderTool, TimerScheduler } from "./timer.ts";

describe("TimerScheduler", () => {
  let scheduler: TimerScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new TimerScheduler();
  });

  afterEach(() => {
    scheduler.clearAll();
    vi.useRealTimers();
  });

  it("creates a timer that fires after duration", () => {
    const callback = vi.fn();
    scheduler.createTimer({ durationMs: 5000, label: "eggs", callback });

    expect(scheduler.activeCount).toBe(1);
    vi.advanceTimersByTime(5000);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(scheduler.activeCount).toBe(0);
  });

  it("creates a reminder for a future timestamp", () => {
    const callback = vi.fn();
    const futureMs = Date.now() + 60_000;
    scheduler.createReminder({ targetMs: futureMs, message: "Call dentist", userId: "kevin", callback });

    expect(scheduler.activeCount).toBe(1);
    vi.advanceTimersByTime(60_000);

    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ message: "Call dentist" }));
    expect(scheduler.activeCount).toBe(0);
  });

  it("cancels a timer by ID", () => {
    const callback = vi.fn();
    const id = scheduler.createTimer({ durationMs: 5000, label: "test", callback });

    scheduler.cancel(id);
    vi.advanceTimersByTime(5000);

    expect(callback).not.toHaveBeenCalled();
    expect(scheduler.activeCount).toBe(0);
  });

  it("lists active timers", () => {
    scheduler.createTimer({ durationMs: 5000, label: "timer-1", callback: vi.fn() });
    scheduler.createTimer({ durationMs: 10000, label: "timer-2", callback: vi.fn() });

    const active = scheduler.listActive();
    expect(active).toHaveLength(2);
    expect(active[0].label).toBe("timer-1");
    expect(active[1].label).toBe("timer-2");
  });

  it("clears all timers", () => {
    scheduler.createTimer({ durationMs: 5000, label: "a", callback: vi.fn() });
    scheduler.createTimer({ durationMs: 10000, label: "b", callback: vi.fn() });

    scheduler.clearAll();
    expect(scheduler.activeCount).toBe(0);
  });

  it("returns error for negative duration", () => {
    expect(() =>
      scheduler.createTimer({ durationMs: -1000, label: "bad", callback: vi.fn() }),
    ).toThrow("Duration must be positive");
  });

  it("returns error for past reminder time", () => {
    expect(() =>
      scheduler.createReminder({
        targetMs: Date.now() - 1000,
        message: "past",
        userId: "kevin",
        callback: vi.fn(),
      }),
    ).toThrow("Target time is in the past");
  });
});

describe("timerTool", () => {
  it("has correct metadata", () => {
    expect(timerTool.name).toBe("timer");
    expect(timerTool.tier).toBe("write");
  });
});

describe("reminderTool", () => {
  it("has correct metadata", () => {
    expect(reminderTool.name).toBe("reminder_create");
    expect(reminderTool.tier).toBe("write");
  });
});
```

- [ ] **Step 8: Implement timer/reminder tool `gateway/src/tools/builtin/timer.ts`**

```typescript
import { defineTool } from "../types.ts";

interface TimerEntry {
  id: string;
  label: string;
  createdAt: number;
  firesAt: number;
  handle: ReturnType<typeof setTimeout>;
}

interface ReminderEntry extends TimerEntry {
  message: string;
  userId: string;
}

interface CreateTimerOptions {
  durationMs: number;
  label: string;
  callback: (entry: TimerEntry) => void;
}

interface CreateReminderOptions {
  targetMs: number;
  message: string;
  userId: string;
  callback: (entry: ReminderEntry) => void;
}

export class TimerScheduler {
  private entries = new Map<string, TimerEntry>();

  get activeCount(): number {
    return this.entries.size;
  }

  createTimer(options: CreateTimerOptions): string {
    if (options.durationMs <= 0) {
      throw new Error("Duration must be positive");
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const entry: TimerEntry = {
      id,
      label: options.label,
      createdAt: now,
      firesAt: now + options.durationMs,
      handle: setTimeout(() => {
        this.entries.delete(id);
        options.callback(entry);
      }, options.durationMs),
    };

    this.entries.set(id, entry);
    return id;
  }

  createReminder(options: CreateReminderOptions): string {
    const now = Date.now();
    const delayMs = options.targetMs - now;

    if (delayMs <= 0) {
      throw new Error("Target time is in the past");
    }

    const id = crypto.randomUUID();
    const entry: ReminderEntry = {
      id,
      label: options.message,
      message: options.message,
      userId: options.userId,
      createdAt: now,
      firesAt: options.targetMs,
      handle: setTimeout(() => {
        this.entries.delete(id);
        options.callback(entry);
      }, delayMs),
    };

    this.entries.set(id, entry);
    return id;
  }

  cancel(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;

    clearTimeout(entry.handle);
    this.entries.delete(id);
    return true;
  }

  listActive(): Array<{ id: string; label: string; firesAt: number }> {
    return [...this.entries.values()]
      .sort((a, b) => a.firesAt - b.firesAt)
      .map(({ id, label, firesAt }) => ({ id, label, firesAt }));
  }

  clearAll(): void {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.handle);
    }
    this.entries.clear();
  }
}

// Singleton scheduler instance — shared across tool invocations
const scheduler = new TimerScheduler();

export const timerTool = defineTool(
  {
    name: "timer",
    description: "Set a countdown timer. Use when the user asks to set a timer for a duration (e.g. '5 minutes', '30 seconds').",
    tier: "write",
    parameters: {
      type: "object",
      properties: {
        duration_seconds: {
          type: "number",
          description: "Timer duration in seconds",
        },
        label: {
          type: "string",
          description: "Optional label for the timer (e.g. 'eggs', 'laundry')",
        },
      },
      required: ["duration_seconds"],
    },
  },
  async (params) => {
    const durationSec = params.duration_seconds as number | undefined;
    if (!durationSec || durationSec <= 0) {
      return { success: false, output: "Duration must be a positive number of seconds" };
    }

    const label = (params.label as string | undefined) ?? "timer";
    const durationMs = durationSec * 1000;

    try {
      const id = scheduler.createTimer({
        durationMs,
        label,
        callback: () => {
          // In integration, this triggers a WebSocket notification to the client
        },
      });

      const minutes = Math.floor(durationSec / 60);
      const seconds = durationSec % 60;
      const durationStr = minutes > 0
        ? `${minutes} minute${minutes > 1 ? "s" : ""}${seconds > 0 ? ` ${seconds} seconds` : ""}`
        : `${seconds} seconds`;

      return {
        success: true,
        output: `Timer set for ${durationStr} (label: "${label}", id: ${id}). I'll notify you when it's done.`,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Timer error: ${message}` };
    }
  },
);

export const reminderTool = defineTool(
  {
    name: "reminder_create",
    description: "Create a reminder for a specific future time. Use when the user asks to be reminded about something.",
    tier: "write",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "What to remind about",
        },
        timestamp_iso: {
          type: "string",
          description: "When to remind, as ISO 8601 datetime string (e.g. '2026-04-04T15:00:00Z')",
        },
      },
      required: ["message", "timestamp_iso"],
    },
  },
  async (params, ctx) => {
    const message = params.message as string | undefined;
    const timestampIso = params.timestamp_iso as string | undefined;

    if (!message) {
      return { success: false, output: "Missing required parameter: message" };
    }
    if (!timestampIso) {
      return { success: false, output: "Missing required parameter: timestamp_iso" };
    }

    const targetMs = new Date(timestampIso).getTime();
    if (Number.isNaN(targetMs)) {
      return { success: false, output: `Invalid timestamp: '${timestampIso}'` };
    }

    try {
      const id = scheduler.createReminder({
        targetMs,
        message,
        userId: ctx.userId,
        callback: () => {
          // In integration, this triggers a WebSocket notification to the client
        },
      });

      const targetDate = new Date(targetMs);
      return {
        success: true,
        output: `Reminder set: "${message}" at ${targetDate.toLocaleString("en-US")} (id: ${id})`,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Reminder error: ${msg}` };
    }
  },
);

export { scheduler };
```

- [ ] **Step 9: Run tests**

Run: `cd gateway && bun test src/tools/builtin/timer.test.ts`

Expected: All tests pass.

### Part D: Remember Tool (~3 min)

- [ ] **Step 10: Write tests for remember tool `gateway/src/tools/builtin/remember.test.ts`**

```typescript
import { describe, it, expect, vi } from "vitest";
import { rememberTool } from "./remember.ts";
import type { ToolContext } from "../types.ts";

describe("rememberTool", () => {
  it("has correct metadata", () => {
    expect(rememberTool.name).toBe("remember");
    expect(rememberTool.tier).toBe("write");
    expect(rememberTool.description).toContain("remember");
  });

  it("returns success with the fact to remember", async () => {
    const ctx = {
      userId: "kevin",
      role: "adult",
      audit: vi.fn(),
    } as unknown as ToolContext;

    const result = await rememberTool.handler(
      { fact: "I'm allergic to shellfish" },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("allergic to shellfish");
    expect(result.output).toContain("remembered");
  });

  it("returns error for missing fact parameter", async () => {
    const ctx = { userId: "kevin", role: "adult", audit: vi.fn() } as unknown as ToolContext;
    const result = await rememberTool.handler({}, ctx);

    expect(result.success).toBe(false);
    expect(result.output).toContain("fact");
  });

  it("returns error for empty fact", async () => {
    const ctx = { userId: "kevin", role: "adult", audit: vi.fn() } as unknown as ToolContext;
    const result = await rememberTool.handler({ fact: "" }, ctx);

    expect(result.success).toBe(false);
  });

  it("blocks guest users from using remember", async () => {
    const ctx = { userId: "guest_abc", role: "guest", audit: vi.fn() } as unknown as ToolContext;
    const result = await rememberTool.handler({ fact: "something" }, ctx);

    expect(result.success).toBe(false);
    expect(result.output).toContain("guest");
  });
});
```

- [ ] **Step 11: Implement remember tool `gateway/src/tools/builtin/remember.ts`**

```typescript
import { defineTool } from "../types.ts";
import type { ToolContext } from "../types.ts";

export const rememberTool = defineTool(
  {
    name: "remember",
    description: "Explicitly save a fact to the user's memory. Use when the user says 'remember this', 'save this', or explicitly asks you to remember something.",
    tier: "write",
    parameters: {
      type: "object",
      properties: {
        fact: {
          type: "string",
          description: "The fact or information to remember about the user",
        },
      },
      required: ["fact"],
    },
  },
  async (params, ctx: ToolContext) => {
    if (ctx.role === "guest") {
      return { success: false, output: "Memory is not available for guest users. Guest sessions are ephemeral." };
    }

    const fact = params.fact as string | undefined;
    if (!fact || fact.trim().length === 0) {
      return { success: false, output: "Missing or empty required parameter: fact" };
    }

    // The actual memory write is handled by the MemoryManager at the integration layer.
    // This tool returns the fact so the integration layer can pass it to MemoryManager.addExplicitFact().
    ctx.audit("memory_explicit_save", { fact: fact.slice(0, 100) });

    return {
      success: true,
      output: `Noted and remembered: "${fact}". This has been saved to your memory.`,
    };
  },
);
```

- [ ] **Step 12: Run all builtin tests**

Run: `cd gateway && bun test src/tools/builtin/`

Expected: ~20 tests pass.

- [ ] **Step 13: Commit**

```bash
git add gateway/src/tools/builtin/
git commit -m "feat(gateway): built-in tools — clock, weather, timer, reminder, remember"
```

---

## Task 5.4: Skill Engine (YAML+MD, Hot-Reload, Scoped)

**Files:**
- Create: `gateway/src/skills/types.ts`
- Create: `gateway/src/skills/types.test.ts`
- Create: `gateway/src/skills/frontmatter.ts`
- Create: `gateway/src/skills/frontmatter.test.ts`
- Create: `gateway/src/skills/cycle-detector.ts`
- Create: `gateway/src/skills/cycle-detector.test.ts`
- Create: `gateway/src/skills/engine.ts`
- Create: `gateway/src/skills/engine.test.ts`
- Create: `gateway/src/skills/loader.ts`
- Create: `gateway/src/skills/loader.test.ts`
- Create: `gateway/src/skills/index.ts`
- Create: `gateway/skills/morning-briefing.md`
- Create: `gateway/skills/set-reminder.md`

### Part A: Skill Types + Frontmatter Parser (~5 min)

- [ ] **Step 1: Write tests for skill types `gateway/src/skills/types.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { skillDefinitionSchema, SKILL_NAME_PATTERN } from "./types.ts";

describe("skill types", () => {
  it("validates a well-formed skill definition", () => {
    const valid = {
      name: "morning-briefing",
      description: "Deliver a morning briefing",
      allowedTools: ["weather", "calendar"],
      parameters: {},
      roles: ["adult", "child"],
      compose: [],
      body: "# Morning Briefing\n\n1. Get weather...",
      filePath: "/skills/morning-briefing.md",
      loadedAt: Date.now(),
    };

    const result = skillDefinitionSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects skill with invalid name characters", () => {
    const invalid = {
      name: "Morning Briefing!",
      description: "test",
      allowedTools: [],
      parameters: {},
      roles: ["adult"],
      compose: [],
      body: "body",
      filePath: "/test.md",
      loadedAt: 0,
    };

    const result = skillDefinitionSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects skill with empty body", () => {
    const invalid = {
      name: "test",
      description: "test",
      allowedTools: [],
      parameters: {},
      roles: ["adult"],
      compose: [],
      body: "",
      filePath: "/test.md",
      loadedAt: 0,
    };

    const result = skillDefinitionSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("accepts valid skill name patterns", () => {
    expect(SKILL_NAME_PATTERN.test("morning-briefing")).toBe(true);
    expect(SKILL_NAME_PATTERN.test("set-reminder")).toBe(true);
    expect(SKILL_NAME_PATTERN.test("weather")).toBe(true);
    expect(SKILL_NAME_PATTERN.test("a")).toBe(true);
  });

  it("rejects invalid skill name patterns", () => {
    expect(SKILL_NAME_PATTERN.test("")).toBe(false);
    expect(SKILL_NAME_PATTERN.test("Hello World")).toBe(false);
    expect(SKILL_NAME_PATTERN.test("UPPERCASE")).toBe(false);
    expect(SKILL_NAME_PATTERN.test("-starts-with-dash")).toBe(false);
  });
});
```

- [ ] **Step 2: Implement skill types `gateway/src/skills/types.ts`**

```typescript
import { z } from "zod";

export const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_COMPOSITION_DEPTH = 3;

export interface ParameterDef {
  type: "string" | "number" | "boolean";
  description: string;
  required: boolean;
  default?: unknown;
}

export interface SkillDefinition {
  name: string;
  description: string;
  allowedTools: string[];
  parameters: Record<string, ParameterDef>;
  roles: Array<"adult" | "child" | "guest">;
  compose: string[];
  body: string;
  filePath: string;
  loadedAt: number;
}

export const skillDefinitionSchema = z.object({
  name: z.string().min(1).regex(SKILL_NAME_PATTERN, "Skill name must be lowercase alphanumeric with hyphens"),
  description: z.string().min(1).max(1000),
  allowedTools: z.array(z.string()),
  parameters: z.record(z.object({
    type: z.enum(["string", "number", "boolean"]),
    description: z.string(),
    required: z.boolean(),
    default: z.unknown().optional(),
  })).or(z.object({})),
  roles: z.array(z.enum(["adult", "child", "guest"])).min(1),
  compose: z.array(z.string()),
  body: z.string().min(1, "Skill body must not be empty"),
  filePath: z.string(),
  loadedAt: z.number(),
});

export { MAX_COMPOSITION_DEPTH };
```

- [ ] **Step 3: Write tests for frontmatter parser `gateway/src/skills/frontmatter.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "./frontmatter.ts";

describe("parseFrontmatter", () => {
  it("parses valid YAML frontmatter and body", () => {
    const content = `---
name: morning-briefing
description: Deliver a morning briefing
allowed-tools:
  - weather
  - calendar
parameters:
  location:
    type: string
    description: City for weather
    required: false
roles:
  - adult
  - child
compose:
  - shopping-list-summary
---

# Morning Briefing

1. Get weather
2. Get calendar events`;

    const result = parseFrontmatter(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.frontmatter.name).toBe("morning-briefing");
    expect(result.value.frontmatter.description).toBe("Deliver a morning briefing");
    expect(result.value.frontmatter["allowed-tools"]).toEqual(["weather", "calendar"]);
    expect(result.value.frontmatter.roles).toEqual(["adult", "child"]);
    expect(result.value.frontmatter.compose).toEqual(["shopping-list-summary"]);
    expect(result.value.body).toContain("# Morning Briefing");
    expect(result.value.body).toContain("Get weather");
  });

  it("returns error for content without frontmatter", () => {
    const content = "# Just a markdown file\n\nNo frontmatter here.";
    const result = parseFrontmatter(content);
    expect(result.ok).toBe(false);
  });

  it("returns error for malformed YAML", () => {
    const content = `---
name: [invalid yaml
  that: is broken
---

# Body`;
    const result = parseFrontmatter(content);
    expect(result.ok).toBe(false);
  });

  it("handles empty compose and parameters", () => {
    const content = `---
name: simple-skill
description: A simple skill
allowed-tools: []
parameters: {}
roles:
  - adult
compose: []
---

# Simple skill body`;

    const result = parseFrontmatter(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.frontmatter["allowed-tools"]).toEqual([]);
    expect(result.value.frontmatter.compose).toEqual([]);
  });

  it("handles multiline description", () => {
    const content = `---
name: test-skill
description: >
  This is a long description
  that spans multiple lines
allowed-tools: []
parameters: {}
roles:
  - adult
compose: []
---

Body.`;

    const result = parseFrontmatter(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.frontmatter.description).toContain("long description");
  });

  it("trims leading whitespace from body", () => {
    const content = `---
name: test
description: test
allowed-tools: []
parameters: {}
roles:
  - adult
compose: []
---


# Body with leading whitespace`;

    const result = parseFrontmatter(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.body.startsWith("#")).toBe(true);
  });
});
```

- [ ] **Step 4: Implement frontmatter parser `gateway/src/skills/frontmatter.ts`**

```typescript
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

interface ParsedSkillFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

export function parseFrontmatter(content: string): Result<ParsedSkillFile> {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) {
    return { ok: false, error: "No YAML frontmatter found (expected --- delimiters)" };
  }

  const yamlStr = match[1];
  const body = match[2].trim();

  try {
    const frontmatter = parseSimpleYaml(yamlStr);
    if (typeof frontmatter !== "object" || frontmatter === null) {
      return { ok: false, error: "Frontmatter must be a YAML mapping" };
    }
    return { ok: true, value: { frontmatter: frontmatter as Record<string, unknown>, body } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `YAML parse error: ${message}` };
  }
}

/**
 * Minimal YAML parser for skill frontmatter.
 * Handles: scalars, arrays (- item), nested objects, multiline strings (>).
 * Does NOT handle: flow mappings, anchors/aliases, complex types.
 * For production, consider a full YAML library — this handles the skill format.
 */
function parseSimpleYaml(yaml: string): unknown {
  // Use Bun's built-in or a YAML parser if available.
  // For now, rely on a simple line-by-line parser for the skill frontmatter subset.
  // In production, import yaml from a proper library (e.g., yaml package).

  // Attempt to use structured parsing. Since this is Bun,
  // we can use JSON-compatible approach if the YAML is simple enough,
  // but YAML frontmatter requires a real parser.

  // In practice, the skill loader will use the `yaml` npm package.
  // This function delegates to it.
  try {
    // Dynamic import is used at the integration layer.
    // For the parser module, we implement a simple subset parser.
    return parseYamlSubset(yaml);
  } catch (error) {
    throw error;
  }
}

function parseYamlSubset(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (trimmed === "" || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    // Key-value pair
    const kvMatch = line.match(/^([a-z][\w-]*)\s*:\s*(.*)$/);
    if (!kvMatch) {
      throw new Error(`Unexpected YAML at line ${i + 1}: ${line}`);
    }

    const key = kvMatch[1];
    let value = kvMatch[2].trim();

    if (value === "" || value === ">") {
      // Check if next lines are array items or multiline string
      const nextLine = lines[i + 1];
      if (nextLine && nextLine.trim().startsWith("- ")) {
        // Array
        const arr: unknown[] = [];
        i++;
        while (i < lines.length && lines[i].trim().startsWith("- ")) {
          arr.push(lines[i].trim().slice(2).trim());
          i++;
        }
        result[key] = arr;
        continue;
      } else if (value === ">" || value === "|") {
        // Multiline scalar
        const parts: string[] = [];
        i++;
        while (i < lines.length && (lines[i].startsWith("  ") || lines[i].trim() === "")) {
          parts.push(lines[i].trim());
          i++;
        }
        result[key] = parts.join(" ").trim();
        continue;
      } else if (nextLine && nextLine.match(/^\s+\w/)) {
        // Nested mapping
        const nested: Record<string, unknown> = {};
        i++;
        while (i < lines.length && lines[i].startsWith("  ")) {
          const nestedLine = lines[i].slice(2);
          const nestedKv = nestedLine.match(/^([a-z][\w-]*)\s*:\s*(.*)$/);
          if (nestedKv) {
            const nKey = nestedKv[1];
            const nVal = nestedKv[2].trim();

            if (nVal === "" || nVal === ">") {
              // Sub-nested object or multiline
              const subNested: Record<string, unknown> = {};
              i++;
              while (i < lines.length && lines[i].startsWith("    ")) {
                const subLine = lines[i].slice(4);
                const subKv = subLine.match(/^([a-z][\w-]*)\s*:\s*(.*)$/);
                if (subKv) {
                  subNested[subKv[1]] = coerceValue(subKv[2].trim());
                }
                i++;
              }
              nested[nKey] = subNested;
              continue;
            } else {
              nested[nKey] = coerceValue(nVal);
            }
          }
          i++;
        }
        result[key] = nested;
        continue;
      } else {
        result[key] = null;
        i++;
        continue;
      }
    } else if (value === "[]") {
      result[key] = [];
    } else if (value === "{}") {
      result[key] = {};
    } else {
      result[key] = coerceValue(value);
    }

    i++;
  }

  return result;
}

function coerceValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  // Remove surrounding quotes
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
```

- [ ] **Step 5: Run frontmatter tests**

Run: `cd gateway && bun test src/skills/frontmatter.test.ts`

Expected: All tests pass.

### Part B: Cycle Detector (~4 min)

- [ ] **Step 6: Write tests for cycle detector `gateway/src/skills/cycle-detector.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { detectCycles, type CompositionGraph } from "./cycle-detector.ts";

describe("detectCycles", () => {
  it("returns empty array for acyclic graph", () => {
    const graph: CompositionGraph = new Map([
      ["morning-briefing", ["shopping-list-summary"]],
      ["shopping-list-summary", []],
      ["set-reminder", []],
    ]);

    const cycles = detectCycles(graph);
    expect(cycles).toEqual([]);
  });

  it("detects simple two-node cycle", () => {
    const graph: CompositionGraph = new Map([
      ["skill-a", ["skill-b"]],
      ["skill-b", ["skill-a"]],
    ]);

    const cycles = detectCycles(graph);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0]).toContain("skill-a");
    expect(cycles[0]).toContain("skill-b");
  });

  it("detects self-referencing cycle", () => {
    const graph: CompositionGraph = new Map([
      ["recursive-skill", ["recursive-skill"]],
    ]);

    const cycles = detectCycles(graph);
    expect(cycles.length).toBeGreaterThan(0);
  });

  it("detects three-node cycle", () => {
    const graph: CompositionGraph = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", ["a"]],
    ]);

    const cycles = detectCycles(graph);
    expect(cycles.length).toBeGreaterThan(0);
  });

  it("returns empty for graph with no edges", () => {
    const graph: CompositionGraph = new Map([
      ["a", []],
      ["b", []],
      ["c", []],
    ]);

    const cycles = detectCycles(graph);
    expect(cycles).toEqual([]);
  });

  it("returns empty for empty graph", () => {
    const graph: CompositionGraph = new Map();
    const cycles = detectCycles(graph);
    expect(cycles).toEqual([]);
  });

  it("handles multiple independent cycles", () => {
    const graph: CompositionGraph = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
      ["c", ["d"]],
      ["d", ["c"]],
    ]);

    const cycles = detectCycles(graph);
    expect(cycles.length).toBe(2);
  });

  it("handles nodes with missing compose targets gracefully", () => {
    const graph: CompositionGraph = new Map([
      ["a", ["nonexistent"]],
    ]);

    const cycles = detectCycles(graph);
    expect(cycles).toEqual([]);
  });

  it("performs well with 50 skills (under 1ms)", () => {
    const graph: CompositionGraph = new Map();
    for (let i = 0; i < 50; i++) {
      graph.set(`skill-${i}`, i > 0 ? [`skill-${i - 1}`] : []);
    }

    const start = performance.now();
    const cycles = detectCycles(graph);
    const elapsed = performance.now() - start;

    expect(cycles).toEqual([]);
    expect(elapsed).toBeLessThan(1);
  });
});
```

- [ ] **Step 7: Implement cycle detector `gateway/src/skills/cycle-detector.ts`**

```typescript
export type CompositionGraph = Map<string, string[]>;

/**
 * Detects cycles in the skill composition graph using DFS.
 * Returns an array of cycle paths (each path is an array of skill names forming the cycle).
 */
export function detectCycles(graph: CompositionGraph): string[][] {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const cycles: string[][] = [];

  function dfs(node: string, path: string[]): void {
    if (inStack.has(node)) {
      // Found a cycle — extract the cycle portion of the path
      const cycleStart = path.indexOf(node);
      cycles.push([...path.slice(cycleStart), node]);
      return;
    }

    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);

    const neighbors = graph.get(node) ?? [];
    for (const neighbor of neighbors) {
      // Only traverse if the neighbor exists in the graph
      if (graph.has(neighbor) || inStack.has(neighbor)) {
        dfs(neighbor, [...path, node]);
      }
    }

    inStack.delete(node);
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      dfs(node, []);
    }
  }

  return cycles;
}
```

- [ ] **Step 8: Run cycle detector tests**

Run: `cd gateway && bun test src/skills/cycle-detector.test.ts`

Expected: All tests pass.

### Part C: Skill Engine (~5 min)

- [ ] **Step 9: Write tests for skill engine `gateway/src/skills/engine.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkillEngine } from "./engine.ts";
import { ToolRegistry, defineTool } from "../tools/index.ts";
import type { SkillDefinition } from "./types.ts";

function createTestSkill(overrides?: Partial<SkillDefinition>): SkillDefinition {
  return {
    name: overrides?.name ?? "test-skill",
    description: overrides?.description ?? "A test skill",
    allowedTools: overrides?.allowedTools ?? ["clock"],
    parameters: overrides?.parameters ?? {},
    roles: overrides?.roles ?? ["adult", "child"],
    compose: overrides?.compose ?? [],
    body: overrides?.body ?? "# Test Skill\n\n1. Use the clock tool to get the time\n2. Report the time to the user",
    filePath: overrides?.filePath ?? "/skills/test-skill.md",
    loadedAt: overrides?.loadedAt ?? Date.now(),
  };
}

function createTestRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(defineTool(
    { name: "clock", description: "Get time", tier: "read", parameters: { type: "object", properties: {} } },
    async () => ({ success: true, output: "10:30 AM" }),
  ));
  registry.register(defineTool(
    { name: "weather", description: "Get weather", tier: "read", parameters: { type: "object", properties: { location: { type: "string", description: "City" } }, required: ["location"] } },
    async () => ({ success: true, output: "72°F, sunny" }),
  ));
  return registry;
}

describe("SkillEngine", () => {
  let engine: SkillEngine;
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    toolRegistry = createTestRegistry();
    engine = new SkillEngine(toolRegistry);
  });

  it("registers a skill", () => {
    const skill = createTestSkill();
    engine.register(skill);
    expect(engine.has("test-skill")).toBe(true);
  });

  it("unregisters a skill by name", () => {
    engine.register(createTestSkill());
    engine.unregister("test-skill");
    expect(engine.has("test-skill")).toBe(false);
  });

  it("unregisters a skill by file path", () => {
    engine.register(createTestSkill({ filePath: "/skills/test.md" }));
    engine.unregisterByPath("/skills/test.md");
    expect(engine.has("test-skill")).toBe(false);
  });

  it("lists registered skill names", () => {
    engine.register(createTestSkill({ name: "skill-a" }));
    engine.register(createTestSkill({ name: "skill-b" }));
    expect(engine.listNames()).toEqual(["skill-a", "skill-b"]);
  });

  it("returns skill as OpenAI tool schema", () => {
    engine.register(createTestSkill({ name: "morning-briefing", description: "Morning briefing" }));

    const schemas = engine.getSkillSchemas("adult");
    expect(schemas).toHaveLength(1);
    expect(schemas[0].function.name).toBe("skill_morning-briefing");
    expect(schemas[0].function.description).toBe("Morning briefing");
  });

  it("filters skills by role", () => {
    engine.register(createTestSkill({ name: "adult-only", roles: ["adult"] }));
    engine.register(createTestSkill({ name: "everyone", roles: ["adult", "child", "guest"] }));

    expect(engine.getSkillSchemas("adult")).toHaveLength(2);
    expect(engine.getSkillSchemas("child")).toHaveLength(1);
    expect(engine.getSkillSchemas("guest")).toHaveLength(1);
  });

  it("rejects execution for unauthorized role", async () => {
    engine.register(createTestSkill({ name: "adult-skill", roles: ["adult"] }));

    const result = await engine.execute("adult-skill", {}, {
      role: "child",
      signal: new AbortController().signal,
      llmCall: vi.fn(),
    } as any);

    expect(result.success).toBe(false);
    expect(result.output).toContain("not available");
  });

  it("rejects execution for non-existent skill", async () => {
    const result = await engine.execute("nonexistent", {}, {
      role: "adult",
      signal: new AbortController().signal,
      llmCall: vi.fn(),
    } as any);

    expect(result.success).toBe(false);
    expect(result.output).toContain("not found");
  });

  it("enforces max composition depth", async () => {
    // Create a chain: a -> b -> c -> d (depth 4, exceeds limit of 3)
    engine.register(createTestSkill({ name: "a", compose: ["b"], allowedTools: [] }));
    engine.register(createTestSkill({ name: "b", compose: ["c"], allowedTools: [] }));
    engine.register(createTestSkill({ name: "c", compose: ["d"], allowedTools: [] }));
    engine.register(createTestSkill({ name: "d", compose: [], allowedTools: [] }));

    const result = await engine.execute("a", {}, {
      role: "adult",
      signal: new AbortController().signal,
      llmCall: vi.fn(),
      depth: 3,
    } as any);

    expect(result.success).toBe(false);
    expect(result.output).toContain("depth limit");
  });

  it("returns the composition graph", () => {
    engine.register(createTestSkill({ name: "a", compose: ["b"] }));
    engine.register(createTestSkill({ name: "b", compose: [] }));

    const graph = engine.getCompositionGraph();
    expect(graph.get("a")).toEqual(["b"]);
    expect(graph.get("b")).toEqual([]);
  });
});
```

- [ ] **Step 10: Implement skill engine `gateway/src/skills/engine.ts`**

```typescript
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolResult, Role } from "../tools/types.ts";
import type { SkillDefinition } from "./types.ts";
import { MAX_COMPOSITION_DEPTH } from "./types.ts";
import { executeReActLoop } from "../tools/react-loop.ts";
import type { CompositionGraph } from "./cycle-detector.ts";

interface OpenAIToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface SkillExecutionContext {
  role: Role;
  signal: AbortSignal;
  llmCall: (messages: unknown[], tools: unknown[]) => Promise<unknown>;
  depth?: number;
}

export class SkillEngine {
  private skills = new Map<string, SkillDefinition>();
  private pathIndex = new Map<string, string>(); // filePath -> skillName
  readonly toolRegistry: ToolRegistry;

  constructor(toolRegistry: ToolRegistry) {
    this.toolRegistry = toolRegistry;
  }

  register(skill: SkillDefinition): void {
    // Remove old version if it exists (for hot-reload)
    if (this.skills.has(skill.name)) {
      const old = this.skills.get(skill.name)!;
      this.pathIndex.delete(old.filePath);
    }

    this.skills.set(skill.name, skill);
    this.pathIndex.set(skill.filePath, skill.name);
  }

  unregister(name: string): void {
    const skill = this.skills.get(name);
    if (skill) {
      this.pathIndex.delete(skill.filePath);
    }
    this.skills.delete(name);
  }

  unregisterByPath(filePath: string): void {
    const name = this.pathIndex.get(filePath);
    if (name) {
      this.skills.delete(name);
      this.pathIndex.delete(filePath);
    }
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  has(name: string): boolean {
    return this.skills.has(name);
  }

  listNames(): string[] {
    return [...this.skills.keys()].sort();
  }

  get size(): number {
    return this.skills.size;
  }

  getCompositionGraph(): CompositionGraph {
    const graph: CompositionGraph = new Map();
    for (const [name, skill] of this.skills) {
      graph.set(name, skill.compose);
    }
    return graph;
  }

  getSkillSchemas(role: Role): OpenAIToolSchema[] {
    return this.listNames()
      .map(name => this.skills.get(name)!)
      .filter(skill => skill.roles.includes(role))
      .map(skill => ({
        type: "function" as const,
        function: {
          name: `skill_${skill.name}`,
          description: skill.description,
          parameters: buildParamSchema(skill.parameters),
        },
      }));
  }

  async execute(
    skillName: string,
    params: Record<string, unknown>,
    ctx: SkillExecutionContext,
  ): Promise<ToolResult> {
    const depth = ctx.depth ?? 0;

    if (depth >= MAX_COMPOSITION_DEPTH) {
      return {
        success: false,
        output: `Skill composition depth limit (${MAX_COMPOSITION_DEPTH}) exceeded.`,
      };
    }

    const skill = this.skills.get(skillName);
    if (!skill) {
      return { success: false, output: `Skill '${skillName}' not found.` };
    }

    if (!skill.roles.includes(ctx.role)) {
      return {
        success: false,
        output: `Skill '${skillName}' not available for ${ctx.role} role.`,
      };
    }

    // Build scoped tool set: only the skill's allowed-tools
    const scopedToolNames = new Set(skill.allowedTools);

    // Add composed skills as virtual tools in the scoped set
    for (const composeName of skill.compose) {
      scopedToolNames.add(`skill_${composeName}`);
    }

    // Build system message with skill instructions
    const skillSystemMessage = {
      role: "system" as const,
      content: `You are executing the "${skill.name}" skill. Follow these instructions precisely:\n\n${skill.body}\n\nParameters provided: ${JSON.stringify(params)}`,
    };

    const result = await executeReActLoop({
      messages: [skillSystemMessage],
      toolRegistry: this.toolRegistry,
      role: ctx.role,
      llmCall: ctx.llmCall,
      signal: ctx.signal,
      scopedToolNames,
    });

    return { success: !result.cancelled, output: result.response };
  }
}

function buildParamSchema(
  parameters: Record<string, { type: string; description: string; required: boolean; default?: unknown }>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, param] of Object.entries(parameters)) {
    properties[key] = {
      type: param.type,
      description: param.description,
    };
    if (param.required) {
      required.push(key);
    }
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}
```

- [ ] **Step 11: Run engine tests**

Run: `cd gateway && bun test src/skills/engine.test.ts`

Expected: All tests pass.

### Part D: Skill Loader with Hot-Reload (~5 min)

- [ ] **Step 12: Write tests for skill loader `gateway/src/skills/loader.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkillLoader } from "./loader.ts";
import { SkillEngine } from "./engine.ts";
import { ToolRegistry, defineTool } from "../tools/index.ts";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_SKILL_CONTENT = `---
name: test-skill
description: A test skill
allowed-tools:
  - clock
parameters: {}
roles:
  - adult
  - child
compose: []
---

# Test Skill

1. Use clock to get the time
2. Report the time`;

function createTestToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(defineTool(
    { name: "clock", description: "Get time", tier: "read", parameters: { type: "object", properties: {} } },
    async () => ({ success: true, output: "10:30" }),
  ));
  return registry;
}

describe("SkillLoader", () => {
  let testDir: string;
  let engine: SkillEngine;
  let loader: SkillLoader;

  beforeEach(async () => {
    testDir = join(tmpdir(), `skill-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    const registry = createTestToolRegistry();
    engine = new SkillEngine(registry);
    loader = new SkillLoader(testDir, engine);
  });

  it("loads a valid skill from a markdown file", async () => {
    const filePath = join(testDir, "test-skill.md");
    await writeFile(filePath, TEST_SKILL_CONTENT);

    await loader.loadAll();

    expect(engine.has("test-skill")).toBe(true);
    const skill = engine.get("test-skill");
    expect(skill?.description).toBe("A test skill");
    expect(skill?.allowedTools).toEqual(["clock"]);
  });

  it("skips non-markdown files", async () => {
    await writeFile(join(testDir, "readme.txt"), "not a skill");
    await writeFile(join(testDir, "test-skill.md"), TEST_SKILL_CONTENT);

    await loader.loadAll();

    expect(engine.size).toBe(1);
  });

  it("reports validation errors for malformed skills", async () => {
    const badContent = `---
name: bad skill!
description: Invalid name
allowed-tools: []
parameters: {}
roles:
  - adult
compose: []
---

Body here.`;

    await writeFile(join(testDir, "bad-skill.md"), badContent);

    const errors = await loader.loadAll();
    expect(errors.length).toBeGreaterThan(0);
    expect(engine.has("bad skill!")).toBe(false);
  });

  it("reports error for skill referencing non-existent tool", async () => {
    const content = `---
name: missing-tool-skill
description: Uses a tool that does not exist
allowed-tools:
  - nonexistent_tool
parameters: {}
roles:
  - adult
compose: []
---

Body.`;

    await writeFile(join(testDir, "missing-tool.md"), content);

    const errors = await loader.loadAll();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("nonexistent_tool");
  });

  it("detects cycles after loading all skills", async () => {
    const skillA = `---
name: skill-a
description: Skill A
allowed-tools: []
parameters: {}
roles:
  - adult
compose:
  - skill-b
---

Body A.`;

    const skillB = `---
name: skill-b
description: Skill B
allowed-tools: []
parameters: {}
roles:
  - adult
compose:
  - skill-a
---

Body B.`;

    await writeFile(join(testDir, "skill-a.md"), skillA);
    await writeFile(join(testDir, "skill-b.md"), skillB);

    const errors = await loader.loadAll();
    expect(errors.some(e => e.includes("cycle") || e.includes("Cycle"))).toBe(true);
  });

  it("loads multiple skills", async () => {
    await writeFile(join(testDir, "skill-1.md"), TEST_SKILL_CONTENT);

    const skill2 = TEST_SKILL_CONTENT.replace("test-skill", "skill-two").replace("A test skill", "Second skill");
    await writeFile(join(testDir, "skill-2.md"), skill2);

    await loader.loadAll();
    expect(engine.size).toBe(2);
  });

  it("reloads a single skill file", async () => {
    const filePath = join(testDir, "test-skill.md");
    await writeFile(filePath, TEST_SKILL_CONTENT);
    await loader.loadAll();

    const updated = TEST_SKILL_CONTENT.replace("A test skill", "Updated description");
    await writeFile(filePath, updated);
    await loader.loadSingle(filePath);

    const skill = engine.get("test-skill");
    expect(skill?.description).toBe("Updated description");
  });

  it("removes skill when file is deleted", async () => {
    const filePath = join(testDir, "test-skill.md");
    await writeFile(filePath, TEST_SKILL_CONTENT);
    await loader.loadAll();
    expect(engine.has("test-skill")).toBe(true);

    loader.handleFileRemoved(filePath);
    expect(engine.has("test-skill")).toBe(false);
  });
});
```

- [ ] **Step 13: Implement skill loader `gateway/src/skills/loader.ts`**

```typescript
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { parseFrontmatter } from "./frontmatter.ts";
import { detectCycles } from "./cycle-detector.ts";
import type { SkillEngine } from "./engine.ts";
import type { SkillDefinition, ParameterDef } from "./types.ts";
import { SKILL_NAME_PATTERN } from "./types.ts";

export class SkillLoader {
  private skillDir: string;
  private engine: SkillEngine;
  private watcher: FSWatcher | null = null;

  constructor(skillDir: string, engine: SkillEngine) {
    this.skillDir = skillDir;
    this.engine = engine;
  }

  async loadAll(): Promise<string[]> {
    const errors: string[] = [];

    let files: string[];
    try {
      files = await readdir(this.skillDir);
    } catch {
      errors.push(`Skill directory not found: ${this.skillDir}`);
      return errors;
    }

    for (const file of files) {
      if (!file.endsWith(".md")) continue;

      const filePath = join(this.skillDir, file);
      const fileErrors = await this.loadSingle(filePath);
      errors.push(...fileErrors);
    }

    // Run cycle detection after all skills are loaded
    const cycleErrors = this.checkCycles();
    errors.push(...cycleErrors);

    return errors;
  }

  async loadSingle(filePath: string): Promise<string[]> {
    const errors: string[] = [];

    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`Failed to read ${filePath}: ${msg}`);
      return errors;
    }

    const parsed = parseFrontmatter(content);
    if (!parsed.ok) {
      errors.push(`${filePath}: ${parsed.error}`);
      return errors;
    }

    const { frontmatter, body } = parsed.value;
    const validationErrors = this.validate(frontmatter, body, filePath);
    if (validationErrors.length > 0) {
      errors.push(...validationErrors);
      return errors;
    }

    const skill: SkillDefinition = {
      name: frontmatter.name as string,
      description: (frontmatter.description as string).trim(),
      allowedTools: (frontmatter["allowed-tools"] as string[]) ?? [],
      parameters: normalizeParameters(frontmatter.parameters as Record<string, unknown> | undefined),
      roles: (frontmatter.roles as Array<"adult" | "child" | "guest">) ?? ["adult", "child"],
      compose: (frontmatter.compose as string[]) ?? [],
      body,
      filePath,
      loadedAt: Date.now(),
    };

    this.engine.register(skill);
    return errors;
  }

  handleFileRemoved(filePath: string): void {
    this.engine.unregisterByPath(filePath);
  }

  private validate(frontmatter: Record<string, unknown>, body: string, filePath: string): string[] {
    const errors: string[] = [];
    const prefix = filePath;

    if (!frontmatter.name || typeof frontmatter.name !== "string") {
      errors.push(`${prefix}: Missing or invalid 'name'`);
    } else if (!SKILL_NAME_PATTERN.test(frontmatter.name)) {
      errors.push(`${prefix}: Skill name '${frontmatter.name}' must be lowercase alphanumeric with hyphens`);
    }

    if (!frontmatter.description || typeof frontmatter.description !== "string") {
      errors.push(`${prefix}: Missing or invalid 'description'`);
    }

    if (body.trim().length === 0) {
      errors.push(`${prefix}: Skill body is empty`);
    }

    // Check allowed-tools exist in registry
    const tools = (frontmatter["allowed-tools"] as string[] | undefined) ?? [];
    for (const tool of tools) {
      if (!this.engine.toolRegistry.has(tool)) {
        errors.push(`${prefix}: Declared tool '${tool}' not found in tool registry`);
      }
    }

    return errors;
  }

  private checkCycles(): string[] {
    const graph = this.engine.getCompositionGraph();
    const cycles = detectCycles(graph);
    const errors: string[] = [];

    for (const cycle of cycles) {
      const cyclePath = cycle.join(" -> ");
      errors.push(`Cycle detected in skill composition: ${cyclePath}`);

      // Disable the last-loaded skill in the cycle to break it
      const lastLoaded = cycle
        .slice(0, -1) // Remove the duplicate closing node
        .map(name => this.engine.get(name))
        .filter((s): s is SkillDefinition => s !== undefined)
        .sort((a, b) => b.loadedAt - a.loadedAt)[0];

      if (lastLoaded) {
        this.engine.unregister(lastLoaded.name);
        errors.push(`Disabled skill '${lastLoaded.name}' to break cycle`);
      }
    }

    return errors;
  }

  startWatching(): void {
    this.watcher = watch(this.skillDir, { recursive: false }, async (event, filename) => {
      if (!filename?.endsWith(".md")) return;

      const filePath = join(this.skillDir, filename);

      if (event === "rename") {
        try {
          await readFile(filePath);
          await this.loadSingle(filePath);
        } catch {
          this.handleFileRemoved(filePath);
        }
      } else {
        await this.loadSingle(filePath);
      }

      this.checkCycles();
    });
  }

  stopWatching(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}

function normalizeParameters(
  raw: Record<string, unknown> | undefined,
): Record<string, ParameterDef> {
  if (!raw || typeof raw !== "object") return {};

  const result: Record<string, ParameterDef> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "object" && value !== null) {
      const param = value as Record<string, unknown>;
      result[key] = {
        type: (param.type as "string" | "number" | "boolean") ?? "string",
        description: (param.description as string) ?? "",
        required: (param.required as boolean) ?? false,
        default: param.default,
      };
    }
  }
  return result;
}
```

- [ ] **Step 14: Create sample skill files**

Create `gateway/skills/morning-briefing.md`:

```markdown
---
name: morning-briefing
description: >
  Deliver a personalized morning briefing. Use when the user asks for their
  morning update, daily briefing, news summary, or says good morning what is
  happening today.
allowed-tools:
  - weather
  - clock
parameters:
  location:
    type: string
    description: City for weather (defaults to user home)
    required: false
roles:
  - adult
  - child
compose: []
---

# Morning Briefing

You are delivering a personalized morning briefing. Follow these steps:

1. Get today's date and time using the `clock` tool
2. Get today's weather for the user's location using the `weather` tool
3. Compose a cheerful, concise briefing combining all results:
   - Lead with weather and what to wear
   - Mention the day and date
4. Keep the total response under 30 seconds of speech
```

Create `gateway/skills/set-reminder.md`:

```markdown
---
name: set-reminder
description: >
  Set a reminder for a future time. Use when the user wants to be reminded
  about something, asks to remind me, or wants to schedule a notification.
allowed-tools:
  - reminder_create
  - clock
parameters:
  message:
    type: string
    description: What to remind about
    required: true
  time:
    type: string
    description: When to remind (natural language)
    required: true
roles:
  - adult
  - child
compose: []
---

# Set Reminder

1. Use the `clock` tool to get the current time as reference
2. Parse the requested time relative to now
3. Create the reminder using `reminder_create` with the message and resolved timestamp
4. Confirm to the user: what you will remind them about, and when
```

- [ ] **Step 15: Create index `gateway/src/skills/index.ts`**

```typescript
export type { SkillDefinition, ParameterDef } from "./types.ts";
export { skillDefinitionSchema, SKILL_NAME_PATTERN, MAX_COMPOSITION_DEPTH } from "./types.ts";
export { SkillEngine } from "./engine.ts";
export { SkillLoader } from "./loader.ts";
export { parseFrontmatter } from "./frontmatter.ts";
export { detectCycles, type CompositionGraph } from "./cycle-detector.ts";
```

- [ ] **Step 16: Run all skills tests**

Run: `cd gateway && bun test src/skills/`

Expected: ~30 tests pass.

- [ ] **Step 17: Commit**

```bash
git add gateway/src/skills/ gateway/skills/
git commit -m "feat(gateway): skill engine with YAML+MD, hot-reload, scoped ReAct, cycle detection"
```

---

## Task 5.5: Per-User Memory (Extraction, Tiers, Isolation)

**Files:**
- Create: `gateway/src/memory/types.ts`
- Create: `gateway/src/memory/types.test.ts`
- Create: `gateway/src/memory/token-estimator.ts`
- Create: `gateway/src/memory/token-estimator.test.ts`
- Create: `gateway/src/memory/extractor.ts`
- Create: `gateway/src/memory/extractor.test.ts`
- Create: `gateway/src/memory/reconciler.ts`
- Create: `gateway/src/memory/reconciler.test.ts`
- Create: `gateway/src/memory/manager.ts`
- Create: `gateway/src/memory/manager.test.ts`
- Create: `gateway/src/memory/context-assembler.ts`
- Create: `gateway/src/memory/context-assembler.test.ts`
- Create: `gateway/src/memory/index.ts`
- Create: `gateway/memory/.gitkeep`

### Part A: Token Estimator + Types (~3 min)

- [ ] **Step 1: Write tests for token estimator `gateway/src/memory/token-estimator.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { estimateTokens, isWithinBudget } from "./token-estimator.ts";

describe("estimateTokens", () => {
  it("estimates ~1 token per 4 characters", () => {
    const text = "a".repeat(400);
    expect(estimateTokens(text)).toBe(110); // 400/4 * 1.1 safety buffer
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("rounds up fractional tokens", () => {
    expect(estimateTokens("hi")).toBe(1); // 2/4 * 1.1 = 0.55 → 1
  });

  it("applies 10% safety buffer", () => {
    const text = "a".repeat(40); // 40 chars = 10 tokens raw, +10% = 11
    expect(estimateTokens(text)).toBe(11);
  });
});

describe("isWithinBudget", () => {
  it("returns true when within budget", () => {
    expect(isWithinBudget("short text", 100)).toBe(true);
  });

  it("returns false when exceeding budget", () => {
    const longText = "a".repeat(4000); // ~1100 tokens
    expect(isWithinBudget(longText, 100)).toBe(false);
  });
});
```

- [ ] **Step 2: Implement token estimator `gateway/src/memory/token-estimator.ts`**

```typescript
const CHARS_PER_TOKEN = 4;
const SAFETY_BUFFER = 1.1; // 10% overestimate for safety

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil((text.length / CHARS_PER_TOKEN) * SAFETY_BUFFER);
}

export function isWithinBudget(text: string, maxTokens: number): boolean {
  return estimateTokens(text) <= maxTokens;
}
```

- [ ] **Step 3: Write tests for memory types `gateway/src/memory/types.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { type MemoryOp, type MemorySection, MEMORY_SECTIONS, TOKEN_BUDGETS } from "./types.ts";

describe("memory types", () => {
  it("defines three memory sections", () => {
    expect(MEMORY_SECTIONS).toEqual(["core-profile", "active-context", "conversation-patterns"]);
  });

  it("defines token budgets per section", () => {
    expect(TOKEN_BUDGETS["core-profile"]).toBe(200);
    expect(TOKEN_BUDGETS["active-context"]).toBe(300);
    expect(TOKEN_BUDGETS["conversation-patterns"]).toBe(100);
  });

  it("total token budget is ~600", () => {
    const total = Object.values(TOKEN_BUDGETS).reduce((a, b) => a + b, 0);
    expect(total).toBe(600);
  });

  it("MemoryOp has four valid operations", () => {
    const ops: MemoryOp["operation"][] = ["ADD", "UPDATE", "DELETE", "NONE"];
    expect(ops).toHaveLength(4);
  });
});
```

- [ ] **Step 4: Implement memory types `gateway/src/memory/types.ts`**

```typescript
export const MEMORY_SECTIONS = ["core-profile", "active-context", "conversation-patterns"] as const;
export type MemorySection = (typeof MEMORY_SECTIONS)[number];

export const TOKEN_BUDGETS: Record<MemorySection, number> = {
  "core-profile": 200,
  "active-context": 300,
  "conversation-patterns": 100,
};

export const TOTAL_MEMORY_BUDGET = 600;

export interface MemoryOp {
  operation: "ADD" | "UPDATE" | "DELETE" | "NONE";
  section: MemorySection;
  fact: string;
  existingFact?: string; // For UPDATE/DELETE — the fact being replaced
  reasoning: string;
}

export interface MemoryFile {
  userId: string;
  coreProfile: string;
  activeContext: string;
  conversationPatterns: string;
  rawContent: string;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}
```

- [ ] **Step 5: Run tests**

Run: `cd gateway && bun test src/memory/types.test.ts src/memory/token-estimator.test.ts`

Expected: All tests pass.

### Part B: Fact Extractor (~4 min)

- [ ] **Step 6: Write tests for extractor `gateway/src/memory/extractor.test.ts`**

```typescript
import { describe, it, expect, vi } from "vitest";
import { extractFacts, FACT_EXTRACTION_PROMPT } from "./extractor.ts";
import type { ConversationTurn } from "./types.ts";

describe("extractFacts", () => {
  it("returns extracted facts from LLM response", async () => {
    const mockLLM = vi.fn().mockResolvedValue(
      JSON.stringify({ facts: ["User is allergic to shellfish", "Prefers morning jazz"] }),
    );

    const conversation: ConversationTurn[] = [
      { role: "user", content: "I'm allergic to shellfish, by the way" },
      { role: "assistant", content: "I'll keep that in mind!" },
      { role: "user", content: "Also, I love jazz in the morning" },
    ];

    const facts = await extractFacts(conversation, "kevin", mockLLM);

    expect(facts).toEqual(["User is allergic to shellfish", "Prefers morning jazz"]);
    expect(mockLLM).toHaveBeenCalledTimes(1);
  });

  it("returns empty array when no facts extracted", async () => {
    const mockLLM = vi.fn().mockResolvedValue(JSON.stringify({ facts: [] }));

    const conversation: ConversationTurn[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];

    const facts = await extractFacts(conversation, "kevin", mockLLM);
    expect(facts).toEqual([]);
  });

  it("returns empty array on LLM parse failure", async () => {
    const mockLLM = vi.fn().mockResolvedValue("not valid json");

    const conversation: ConversationTurn[] = [
      { role: "user", content: "Hello" },
    ];

    const facts = await extractFacts(conversation, "kevin", mockLLM);
    expect(facts).toEqual([]);
  });

  it("returns empty array on LLM error", async () => {
    const mockLLM = vi.fn().mockRejectedValue(new Error("API error"));

    const facts = await extractFacts([], "kevin", mockLLM);
    expect(facts).toEqual([]);
  });

  it("includes user name in extraction prompt", async () => {
    const mockLLM = vi.fn().mockResolvedValue(JSON.stringify({ facts: [] }));
    await extractFacts([], "alice", mockLLM);

    const prompt = mockLLM.mock.calls[0][0] as string;
    expect(prompt).toContain("alice");
  });

  it("prompt instructs to only extract facts about current user", () => {
    expect(FACT_EXTRACTION_PROMPT).toContain("Only extract facts about");
    expect(FACT_EXTRACTION_PROMPT).toContain("Do NOT extract");
  });
});
```

- [ ] **Step 7: Implement extractor `gateway/src/memory/extractor.ts`**

```typescript
import type { ConversationTurn } from "./types.ts";

export type LLMCall = (prompt: string) => Promise<string>;

export const FACT_EXTRACTION_PROMPT = `Extract memorable facts from this conversation. Focus on:
- Personal profile (name, age, occupation)
- Food preferences and dietary restrictions
- Daily routines and schedules
- Hobbies and interests
- Important dates (birthdays, appointments)
- Conversation style preferences

Only extract facts about {USER_NAME} (the current user).
Do NOT extract or store:
- Facts about other family members' private preferences
- Health information about other users
- Trivial observations (greetings, transient emotions)

Return JSON only: {"facts": ["fact1", "fact2"]}
If no memorable facts, return {"facts": []}`;

export async function extractFacts(
  conversation: ConversationTurn[],
  userName: string,
  llmCall: LLMCall,
): Promise<string[]> {
  if (conversation.length === 0) {
    try {
      const response = await llmCall(
        FACT_EXTRACTION_PROMPT.replace("{USER_NAME}", userName) +
        "\n\nConversation:\n(empty)",
      );
      return parseFacts(response);
    } catch {
      return [];
    }
  }

  const formatted = conversation
    .map(turn => `${turn.role === "user" ? userName : "Assistant"}: ${turn.content}`)
    .join("\n");

  const prompt = FACT_EXTRACTION_PROMPT.replace("{USER_NAME}", userName) +
    `\n\nConversation:\n${formatted}`;

  try {
    const response = await llmCall(prompt);
    return parseFacts(response);
  } catch {
    return [];
  }
}

function parseFacts(response: string): string[] {
  try {
    const parsed = JSON.parse(response);
    if (parsed && Array.isArray(parsed.facts)) {
      return parsed.facts.filter((f: unknown) => typeof f === "string" && f.length > 0);
    }
    return [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 8: Run tests**

Run: `cd gateway && bun test src/memory/extractor.test.ts`

Expected: All tests pass.

### Part C: Reconciler (~4 min)

- [ ] **Step 9: Write tests for reconciler `gateway/src/memory/reconciler.test.ts`**

```typescript
import { describe, it, expect, vi } from "vitest";
import { reconcileFacts, applyMemoryOps } from "./reconciler.ts";
import type { MemoryOp } from "./types.ts";

describe("reconcileFacts", () => {
  it("returns ADD operations for new facts against empty memory", async () => {
    const mockLLM = vi.fn().mockResolvedValue(JSON.stringify({
      operations: [
        { operation: "ADD", section: "core-profile", fact: "Age: 34", reasoning: "New fact" },
        { operation: "ADD", section: "active-context", fact: "Working on Q2 planning", reasoning: "New context" },
      ],
    }));

    const ops = await reconcileFacts(
      ["Age: 34", "Working on Q2 planning"],
      "",
      mockLLM,
    );

    expect(ops).toHaveLength(2);
    expect(ops[0].operation).toBe("ADD");
    expect(ops[1].operation).toBe("ADD");
  });

  it("returns UPDATE for modified facts", async () => {
    const mockLLM = vi.fn().mockResolvedValue(JSON.stringify({
      operations: [
        { operation: "UPDATE", section: "active-context", fact: "Working on Q3 planning", existingFact: "Working on Q2 planning", reasoning: "Updated context" },
      ],
    }));

    const ops = await reconcileFacts(
      ["Working on Q3 planning"],
      "## Active Context\n- Working on Q2 planning",
      mockLLM,
    );

    expect(ops).toHaveLength(1);
    expect(ops[0].operation).toBe("UPDATE");
    expect(ops[0].existingFact).toBe("Working on Q2 planning");
  });

  it("returns NONE for duplicate facts", async () => {
    const mockLLM = vi.fn().mockResolvedValue(JSON.stringify({
      operations: [
        { operation: "NONE", section: "core-profile", fact: "Allergic to shellfish", reasoning: "Already known" },
      ],
    }));

    const ops = await reconcileFacts(
      ["Allergic to shellfish"],
      "## Core Profile\n- Allergic to shellfish",
      mockLLM,
    );

    expect(ops).toHaveLength(1);
    expect(ops[0].operation).toBe("NONE");
  });

  it("returns empty array on LLM failure", async () => {
    const mockLLM = vi.fn().mockRejectedValue(new Error("API error"));
    const ops = await reconcileFacts([], "", mockLLM);
    expect(ops).toEqual([]);
  });
});

describe("applyMemoryOps", () => {
  it("adds new facts to the correct section", () => {
    const ops: MemoryOp[] = [
      { operation: "ADD", section: "core-profile", fact: "Age: 34", reasoning: "new" },
      { operation: "ADD", section: "active-context", fact: "Planning camping trip", reasoning: "new" },
    ];

    const result = applyMemoryOps("", ops);
    expect(result).toContain("## Core Profile");
    expect(result).toContain("- Age: 34");
    expect(result).toContain("## Active Context");
    expect(result).toContain("- Planning camping trip");
  });

  it("updates existing facts", () => {
    const existing = `# Memory: kevin

## Core Profile
- Age: 33
- Data scientist at Acme Corp

## Active Context
- Working on Q2 planning

## Conversation Patterns
- Prefers concise responses`;

    const ops: MemoryOp[] = [
      { operation: "UPDATE", section: "core-profile", fact: "Age: 34", existingFact: "Age: 33", reasoning: "birthday" },
    ];

    const result = applyMemoryOps(existing, ops);
    expect(result).toContain("- Age: 34");
    expect(result).not.toContain("- Age: 33");
  });

  it("deletes facts", () => {
    const existing = `# Memory: kevin

## Core Profile
- Age: 34
- Allergic to shellfish

## Active Context

## Conversation Patterns`;

    const ops: MemoryOp[] = [
      { operation: "DELETE", section: "core-profile", fact: "Allergic to shellfish", existingFact: "Allergic to shellfish", reasoning: "user corrected" },
    ];

    const result = applyMemoryOps(existing, ops);
    expect(result).not.toContain("shellfish");
    expect(result).toContain("- Age: 34");
  });

  it("ignores NONE operations", () => {
    const existing = "## Core Profile\n- Age: 34";
    const ops: MemoryOp[] = [
      { operation: "NONE", section: "core-profile", fact: "Age: 34", reasoning: "already known" },
    ];

    const result = applyMemoryOps(existing, ops);
    expect(result).toContain("- Age: 34");
  });

  it("creates sections that do not exist yet", () => {
    const ops: MemoryOp[] = [
      { operation: "ADD", section: "conversation-patterns", fact: "Prefers short answers", reasoning: "new" },
    ];

    const result = applyMemoryOps("", ops);
    expect(result).toContain("## Conversation Patterns");
    expect(result).toContain("- Prefers short answers");
  });
});
```

- [ ] **Step 10: Implement reconciler `gateway/src/memory/reconciler.ts`**

```typescript
import type { MemoryOp, MemorySection } from "./types.ts";
import type { LLMCall } from "./extractor.ts";

const RECONCILIATION_PROMPT = `Compare new facts against existing memory and decide for each:
- ADD: Genuinely new information
- UPDATE: More specific/current version of an existing fact
- DELETE: Contradicts an existing fact
- NONE: Already known

For each operation, assign to one section:
- core-profile: Stable facts (name, age, relationships, allergies, strong preferences)
- active-context: Recent/temporary context (ongoing projects, upcoming events)
- conversation-patterns: Communication style preferences

Return JSON only:
{"operations": [{"operation": "ADD|UPDATE|DELETE|NONE", "section": "core-profile|active-context|conversation-patterns", "fact": "the fact", "existingFact": "fact being replaced (for UPDATE/DELETE)", "reasoning": "brief why"}]}`;

export async function reconcileFacts(
  newFacts: string[],
  existingMemory: string,
  llmCall: LLMCall,
): Promise<MemoryOp[]> {
  if (newFacts.length === 0) return [];

  const prompt = `${RECONCILIATION_PROMPT}

Existing memory:
${existingMemory || "(empty)"}

New facts:
${newFacts.map((f, i) => `${i + 1}. ${f}`).join("\n")}`;

  try {
    const response = await llmCall(prompt);
    return parseOps(response);
  } catch {
    return [];
  }
}

function parseOps(response: string): MemoryOp[] {
  try {
    const parsed = JSON.parse(response);
    if (!parsed || !Array.isArray(parsed.operations)) return [];

    return parsed.operations
      .filter((op: unknown) =>
        typeof op === "object" && op !== null &&
        "operation" in op && "section" in op && "fact" in op,
      )
      .map((op: Record<string, unknown>) => ({
        operation: op.operation as MemoryOp["operation"],
        section: op.section as MemorySection,
        fact: op.fact as string,
        existingFact: op.existingFact as string | undefined,
        reasoning: (op.reasoning as string) ?? "",
      }));
  } catch {
    return [];
  }
}

const SECTION_HEADERS: Record<MemorySection, string> = {
  "core-profile": "## Core Profile",
  "active-context": "## Active Context",
  "conversation-patterns": "## Conversation Patterns",
};

export function applyMemoryOps(existing: string, ops: MemoryOp[]): string {
  // Parse existing memory into sections
  const sections: Record<MemorySection, string[]> = {
    "core-profile": [],
    "active-context": [],
    "conversation-patterns": [],
  };

  // Parse existing content into sections
  let currentSection: MemorySection | null = null;
  for (const line of existing.split("\n")) {
    const trimmed = line.trim();

    if (trimmed === "## Core Profile") {
      currentSection = "core-profile";
      continue;
    } else if (trimmed === "## Active Context") {
      currentSection = "active-context";
      continue;
    } else if (trimmed === "## Conversation Patterns") {
      currentSection = "conversation-patterns";
      continue;
    } else if (trimmed.startsWith("# ")) {
      // Top-level header, skip
      continue;
    }

    if (currentSection && trimmed.startsWith("- ")) {
      sections[currentSection].push(trimmed.slice(2));
    }
  }

  // Apply operations
  for (const op of ops) {
    switch (op.operation) {
      case "ADD":
        sections[op.section].push(op.fact);
        break;

      case "UPDATE":
        if (op.existingFact) {
          const index = sections[op.section].findIndex(
            f => f.toLowerCase().includes(op.existingFact!.toLowerCase().slice(0, 20)),
          );
          if (index >= 0) {
            sections[op.section][index] = op.fact;
          } else {
            sections[op.section].push(op.fact);
          }
        }
        break;

      case "DELETE":
        if (op.existingFact) {
          const searchTerm = op.existingFact.toLowerCase().slice(0, 20);
          sections[op.section] = sections[op.section].filter(
            f => !f.toLowerCase().includes(searchTerm),
          );
        }
        break;

      case "NONE":
        // No change
        break;
    }
  }

  // Rebuild markdown
  const parts: string[] = [];

  for (const section of ["core-profile", "active-context", "conversation-patterns"] as MemorySection[]) {
    const items = sections[section];
    parts.push(SECTION_HEADERS[section]);
    if (items.length > 0) {
      parts.push(items.map(item => `- ${item}`).join("\n"));
    }
    parts.push("");
  }

  return parts.join("\n").trim();
}
```

- [ ] **Step 11: Run tests**

Run: `cd gateway && bun test src/memory/reconciler.test.ts`

Expected: All tests pass.

### Part D: Memory Manager (~4 min)

- [ ] **Step 12: Write tests for memory manager `gateway/src/memory/manager.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryManager } from "./manager.ts";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("MemoryManager", () => {
  let memDir: string;
  let manager: MemoryManager;
  const mockLLM = vi.fn();

  beforeEach(async () => {
    memDir = join(tmpdir(), `memory-test-${Date.now()}`);
    await mkdir(memDir, { recursive: true });
    manager = new MemoryManager(memDir, mockLLM);
    mockLLM.mockReset();
  });

  it("loads memory for existing user", async () => {
    const content = `## Core Profile\n- Age: 34\n\n## Active Context\n- Working on Q2\n\n## Conversation Patterns\n- Prefers concise`;
    await writeFile(join(memDir, "kevin.md"), content);

    const memory = await manager.loadMemory("kevin");
    expect(memory).toContain("Age: 34");
    expect(memory).toContain("Working on Q2");
  });

  it("returns empty string for new user", async () => {
    const memory = await manager.loadMemory("newuser");
    expect(memory).toBe("");
  });

  it("blocks path traversal attempts", async () => {
    await expect(manager.loadMemory("../../../etc/passwd")).rejects.toThrow("Invalid user ID");
  });

  it("blocks user IDs with slashes", async () => {
    await expect(manager.loadMemory("user/../../admin")).rejects.toThrow("Invalid user ID");
  });

  it("updates memory via extract-reconcile-apply pipeline", async () => {
    // First call: extract facts
    mockLLM.mockResolvedValueOnce(JSON.stringify({
      facts: ["User is 34 years old", "Works at Acme Corp"],
    }));
    // Second call: reconcile
    mockLLM.mockResolvedValueOnce(JSON.stringify({
      operations: [
        { operation: "ADD", section: "core-profile", fact: "Age: 34", reasoning: "new fact" },
        { operation: "ADD", section: "core-profile", fact: "Works at Acme Corp", reasoning: "new fact" },
      ],
    }));

    await manager.updateMemory("kevin", [
      { role: "user", content: "I'm 34 and work at Acme Corp" },
      { role: "assistant", content: "Nice to know!" },
    ]);

    const saved = await readFile(join(memDir, "kevin.md"), "utf-8");
    expect(saved).toContain("Age: 34");
    expect(saved).toContain("Acme Corp");
  });

  it("does not write file when no facts extracted", async () => {
    mockLLM.mockResolvedValueOnce(JSON.stringify({ facts: [] }));

    await manager.updateMemory("kevin", [
      { role: "user", content: "Hello" },
    ]);

    const exists = await Bun.file(join(memDir, "kevin.md")).exists();
    expect(exists).toBe(false);
  });

  it("adds explicit fact to memory", async () => {
    // Reconcile call
    mockLLM.mockResolvedValueOnce(JSON.stringify({
      operations: [
        { operation: "ADD", section: "core-profile", fact: "Allergic to shellfish", reasoning: "explicit save" },
      ],
    }));

    await manager.addExplicitFact("kevin", "Allergic to shellfish");

    const saved = await readFile(join(memDir, "kevin.md"), "utf-8");
    expect(saved).toContain("Allergic to shellfish");
  });

  it("isolates memory between users", async () => {
    await writeFile(join(memDir, "alice.md"), "## Core Profile\n- Alice's private data");
    await writeFile(join(memDir, "bob.md"), "## Core Profile\n- Bob's private data");

    const aliceMemory = await manager.loadMemory("alice");
    const bobMemory = await manager.loadMemory("bob");

    expect(aliceMemory).toContain("Alice");
    expect(aliceMemory).not.toContain("Bob");
    expect(bobMemory).toContain("Bob");
    expect(bobMemory).not.toContain("Alice");
  });
});
```

- [ ] **Step 13: Implement memory manager `gateway/src/memory/manager.ts`**

```typescript
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, normalize } from "node:path";
import { extractFacts, type LLMCall } from "./extractor.ts";
import { reconcileFacts, applyMemoryOps } from "./reconciler.ts";
import type { ConversationTurn } from "./types.ts";

const USER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export class MemoryManager {
  private memoryDir: string;
  private llmCall: LLMCall;

  constructor(memoryDir: string, llmCall: LLMCall) {
    this.memoryDir = memoryDir;
    this.llmCall = llmCall;
  }

  async loadMemory(userId: string): Promise<string> {
    this.validateUserId(userId);
    const filePath = this.getMemoryPath(userId);

    try {
      return await readFile(filePath, "utf-8");
    } catch {
      return "";
    }
  }

  async updateMemory(userId: string, conversation: ConversationTurn[]): Promise<void> {
    this.validateUserId(userId);

    const facts = await extractFacts(conversation, userId, this.llmCall);
    if (facts.length === 0) return;

    const existing = await this.loadMemory(userId);
    const ops = await reconcileFacts(facts, existing, this.llmCall);

    if (ops.length === 0 || ops.every(op => op.operation === "NONE")) return;

    const updated = applyMemoryOps(existing, ops);
    await this.saveMemory(userId, updated);
  }

  async addExplicitFact(userId: string, fact: string): Promise<void> {
    this.validateUserId(userId);

    const existing = await this.loadMemory(userId);
    const ops = await reconcileFacts([fact], existing, this.llmCall);

    if (ops.length === 0 || ops.every(op => op.operation === "NONE")) return;

    const updated = applyMemoryOps(existing, ops);
    await this.saveMemory(userId, updated);
  }

  private async saveMemory(userId: string, content: string): Promise<void> {
    await mkdir(this.memoryDir, { recursive: true });
    const filePath = this.getMemoryPath(userId);
    await writeFile(filePath, content, "utf-8");
  }

  private getMemoryPath(userId: string): string {
    const filePath = join(this.memoryDir, `${userId}.md`);
    // Verify the resolved path is within the memory directory
    const resolved = resolve(filePath);
    const dirResolved = resolve(this.memoryDir);

    if (!resolved.startsWith(dirResolved)) {
      throw new Error(`Invalid user ID: path traversal detected for '${userId}'`);
    }

    return filePath;
  }

  private validateUserId(userId: string): void {
    if (!USER_ID_PATTERN.test(userId)) {
      throw new Error(`Invalid user ID: '${userId}' must match ${USER_ID_PATTERN}`);
    }
  }
}
```

- [ ] **Step 14: Run tests**

Run: `cd gateway && bun test src/memory/manager.test.ts`

Expected: All tests pass.

### Part E: Context Assembler (~4 min)

- [ ] **Step 15: Write tests for context assembler `gateway/src/memory/context-assembler.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { assembleContext, type ContextAssemblyInput } from "./context-assembler.ts";

describe("assembleContext", () => {
  const baseInput: ContextAssemblyInput = {
    persona: "You are Aria, a warm family assistant.",
    memory: "## Core Profile\n- Age: 34\n- Prefers concise responses",
    conversationHistory: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ],
    maxTokens: 8000,
  };

  it("assembles persona + memory + history", () => {
    const result = assembleContext(baseInput);

    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toContain("Aria");
    expect(result.messages[0].content).toContain("Age: 34");
    expect(result.messages.length).toBeGreaterThan(1);
  });

  it("includes persona before memory (attention pattern priority)", () => {
    const result = assembleContext(baseInput);
    const systemContent = result.messages[0].content;

    const personaIndex = systemContent.indexOf("Aria");
    const memoryIndex = systemContent.indexOf("Age: 34");
    expect(personaIndex).toBeLessThan(memoryIndex);
  });

  it("includes skill context when provided", () => {
    const result = assembleContext({
      ...baseInput,
      skillContext: "You are executing the morning-briefing skill.",
    });

    const systemContent = result.messages[0].content;
    expect(systemContent).toContain("morning-briefing");
  });

  it("truncates conversation history to fit token budget", () => {
    const longHistory = Array.from({ length: 100 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `Message number ${i} with some substantial content to consume tokens. `.repeat(5),
    }));

    const result = assembleContext({
      ...baseInput,
      conversationHistory: longHistory,
      maxTokens: 2000,
    });

    // Should have truncated some history
    expect(result.messages.length).toBeLessThan(102); // system + 100 turns
    expect(result.tokenEstimate).toBeLessThanOrEqual(2000);
    expect(result.truncatedTurns).toBeGreaterThan(0);
  });

  it("always includes at least the last 2 turns", () => {
    const longHistory = Array.from({ length: 50 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: "x".repeat(500),
    }));

    const result = assembleContext({
      ...baseInput,
      conversationHistory: longHistory,
      maxTokens: 500, // Very tight budget
    });

    // Should keep at least the system message and last 2 conversation turns
    expect(result.messages.length).toBeGreaterThanOrEqual(3);
  });

  it("returns token estimate", () => {
    const result = assembleContext(baseInput);
    expect(result.tokenEstimate).toBeGreaterThan(0);
  });

  it("wraps memory in user_context tags", () => {
    const result = assembleContext(baseInput);
    const systemContent = result.messages[0].content;
    expect(systemContent).toContain("<user_context>");
    expect(systemContent).toContain("</user_context>");
  });
});
```

- [ ] **Step 16: Implement context assembler `gateway/src/memory/context-assembler.ts`**

```typescript
import { estimateTokens } from "./token-estimator.ts";

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ContextAssemblyInput {
  persona: string;
  memory: string;
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens: number;
  skillContext?: string;
}

export interface ContextAssemblyResult {
  messages: Message[];
  tokenEstimate: number;
  truncatedTurns: number;
}

const MIN_HISTORY_TURNS = 2;

export function assembleContext(input: ContextAssemblyInput): ContextAssemblyResult {
  const { persona, memory, conversationHistory, maxTokens, skillContext } = input;

  // Build system prompt: persona > memory > skill context
  const systemParts: string[] = [persona];

  if (memory) {
    systemParts.push(`\n<user_context>\n${memory}\n</user_context>`);
  }

  if (skillContext) {
    systemParts.push(`\n<skill_context>\n${skillContext}\n</skill_context>`);
  }

  const systemContent = systemParts.join("\n");
  const systemMessage: Message = { role: "system", content: systemContent };
  const systemTokens = estimateTokens(systemContent);

  // Calculate remaining budget for conversation history
  const remainingBudget = maxTokens - systemTokens;

  // Build conversation messages from most recent, working backwards
  const historyMessages: Message[] = [];
  let historyTokens = 0;
  let truncatedTurns = 0;

  // Always include at least the last MIN_HISTORY_TURNS turns
  const minTurns = Math.min(MIN_HISTORY_TURNS, conversationHistory.length);
  const startIndex = Math.max(0, conversationHistory.length - minTurns);

  // Add minimum turns first
  for (let i = startIndex; i < conversationHistory.length; i++) {
    const turn = conversationHistory[i];
    const msg: Message = { role: turn.role, content: turn.content };
    historyMessages.push(msg);
    historyTokens += estimateTokens(turn.content);
  }

  // Try to add more history within budget (from newest to oldest, prepending)
  for (let i = startIndex - 1; i >= 0; i--) {
    const turn = conversationHistory[i];
    const turnTokens = estimateTokens(turn.content);

    if (historyTokens + turnTokens > remainingBudget) {
      truncatedTurns = i + 1;
      break;
    }

    historyMessages.unshift({ role: turn.role, content: turn.content });
    historyTokens += turnTokens;
  }

  const messages = [systemMessage, ...historyMessages];
  const tokenEstimate = systemTokens + historyTokens;

  return { messages, tokenEstimate, truncatedTurns };
}
```

- [ ] **Step 17: Create index `gateway/src/memory/index.ts`**

```typescript
export { type MemoryOp, type MemorySection, type MemoryFile, type ConversationTurn, MEMORY_SECTIONS, TOKEN_BUDGETS, TOTAL_MEMORY_BUDGET } from "./types.ts";
export { MemoryManager } from "./manager.ts";
export { extractFacts, type LLMCall } from "./extractor.ts";
export { reconcileFacts, applyMemoryOps } from "./reconciler.ts";
export { assembleContext, type ContextAssemblyInput, type ContextAssemblyResult } from "./context-assembler.ts";
export { estimateTokens, isWithinBudget } from "./token-estimator.ts";
```

- [ ] **Step 18: Run all memory tests**

Run: `cd gateway && bun test src/memory/`

Expected: ~30 tests pass.

- [ ] **Step 19: Commit**

```bash
git add gateway/src/memory/ gateway/memory/
git commit -m "feat(gateway): per-user memory with extraction, reconciliation, context assembly"
```

---

## Task 5.6: Guest Mode (PIN, Ephemeral, Restricted)

**Files:**
- Create: `gateway/src/guest/types.ts`
- Create: `gateway/src/guest/types.test.ts`
- Create: `gateway/src/guest/invite-manager.ts`
- Create: `gateway/src/guest/invite-manager.test.ts`
- Create: `gateway/src/guest/session.ts`
- Create: `gateway/src/guest/session.test.ts`
- Create: `gateway/src/guest/index.ts`

### Part A: Guest Types + Invite Manager (~5 min)

- [ ] **Step 1: Write tests for guest types `gateway/src/guest/types.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { GUEST_TOKEN_TTL_MS, INVITE_TTL_MS, PIN_LENGTH } from "./types.ts";

describe("guest types", () => {
  it("defines 4-hour guest token TTL", () => {
    expect(GUEST_TOKEN_TTL_MS).toBe(4 * 60 * 60 * 1000);
  });

  it("defines 1-hour invite TTL", () => {
    expect(INVITE_TTL_MS).toBe(60 * 60 * 1000);
  });

  it("defines 6-digit PIN length", () => {
    expect(PIN_LENGTH).toBe(6);
  });
});
```

- [ ] **Step 2: Implement guest types `gateway/src/guest/types.ts`**

```typescript
export const PIN_LENGTH = 6;
export const INVITE_TTL_MS = 60 * 60 * 1000; // 1 hour to claim
export const GUEST_TOKEN_TTL_MS = 4 * 60 * 60 * 1000; // 4 hour session
export const PIN_MIN = 100_000;
export const PIN_MAX = 999_999;

export interface GuestInvite {
  pin: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
}

export interface GuestSessionData {
  sessionId: string;
  guestId: string;
  createdAt: number;
  expiresAt: number;
  ephemeralMemory: string[];
}
```

- [ ] **Step 3: Write tests for invite manager `gateway/src/guest/invite-manager.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GuestInviteManager } from "./invite-manager.ts";

describe("GuestInviteManager", () => {
  let manager: GuestInviteManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T12:00:00Z"));
    manager = new GuestInviteManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates an invite with a 6-digit PIN", () => {
    const invite = manager.createInvite("kevin");

    expect(invite.pin).toMatch(/^\d{6}$/);
    expect(invite.expiresAt).toBeGreaterThan(Date.now());
  });

  it("invite expires after 1 hour", () => {
    const invite = manager.createInvite("kevin");
    expect(invite.expiresAt).toBe(Date.now() + 60 * 60 * 1000);
  });

  it("claims invite with correct PIN", () => {
    const invite = manager.createInvite("kevin");
    const result = manager.claimInvite(invite.pin);

    expect(result).not.toBeNull();
    expect(result!.guestId).toContain("guest_");
  });

  it("returns null for wrong PIN", () => {
    manager.createInvite("kevin");
    const result = manager.claimInvite("000000");

    expect(result).toBeNull();
  });

  it("returns null for expired invite", () => {
    const invite = manager.createInvite("kevin");

    vi.advanceTimersByTime(61 * 60 * 1000); // 61 minutes

    const result = manager.claimInvite(invite.pin);
    expect(result).toBeNull();
  });

  it("PIN can only be claimed once", () => {
    const invite = manager.createInvite("kevin");

    const first = manager.claimInvite(invite.pin);
    const second = manager.claimInvite(invite.pin);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("cleans up expired invites", () => {
    manager.createInvite("kevin");
    manager.createInvite("kevin");

    vi.advanceTimersByTime(61 * 60 * 1000);

    // Creating a new invite triggers cleanup
    manager.createInvite("kevin");
    expect(manager.pendingCount).toBe(1);
  });

  it("revokes all pending invites", () => {
    manager.createInvite("kevin");
    manager.createInvite("kevin");
    manager.createInvite("kevin");

    manager.revokeAll();
    expect(manager.pendingCount).toBe(0);
  });

  it("generates unique PINs", () => {
    const pins = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const invite = manager.createInvite("kevin");
      pins.add(invite.pin);
    }
    // With 6-digit PINs, collisions in 20 attempts should be extremely rare
    expect(pins.size).toBe(20);
  });

  it("counts pending invites", () => {
    manager.createInvite("kevin");
    manager.createInvite("sarah");
    expect(manager.pendingCount).toBe(2);
  });
});
```

- [ ] **Step 4: Implement invite manager `gateway/src/guest/invite-manager.ts`**

```typescript
import { PIN_MIN, PIN_MAX, INVITE_TTL_MS, GUEST_TOKEN_TTL_MS, type GuestInvite } from "./types.ts";

interface ClaimResult {
  guestId: string;
  expiresAt: number;
}

export class GuestInviteManager {
  private invites = new Map<string, GuestInvite>();

  get pendingCount(): number {
    return this.invites.size;
  }

  createInvite(createdBy: string): { pin: string; expiresAt: number } {
    this.cleanupExpired();

    const pin = this.generatePin();
    const now = Date.now();
    const expiresAt = now + INVITE_TTL_MS;

    this.invites.set(pin, {
      pin,
      createdBy,
      createdAt: now,
      expiresAt,
    });

    return { pin, expiresAt };
  }

  claimInvite(pin: string): ClaimResult | null {
    const invite = this.invites.get(pin);
    if (!invite) return null;

    if (invite.expiresAt < Date.now()) {
      this.invites.delete(pin);
      return null;
    }

    // One-time use
    this.invites.delete(pin);

    const guestId = `guest_${crypto.randomUUID().slice(0, 8)}`;
    const expiresAt = Date.now() + GUEST_TOKEN_TTL_MS;

    return { guestId, expiresAt };
  }

  revokeAll(): void {
    this.invites.clear();
  }

  private generatePin(): string {
    let pin: string;
    do {
      pin = String(crypto.getRandomValues(new Uint32Array(1))[0] % (PIN_MAX - PIN_MIN + 1) + PIN_MIN);
    } while (this.invites.has(pin));
    return pin;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [pin, invite] of this.invites) {
      if (invite.expiresAt < now) {
        this.invites.delete(pin);
      }
    }
  }
}
```

- [ ] **Step 5: Run tests**

Run: `cd gateway && bun test src/guest/invite-manager.test.ts`

Expected: All tests pass.

### Part B: Ephemeral Guest Session (~4 min)

- [ ] **Step 6: Write tests for guest session `gateway/src/guest/session.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GuestSessionStore } from "./session.ts";

describe("GuestSessionStore", () => {
  let store: GuestSessionStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T12:00:00Z"));
    store = new GuestSessionStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates an ephemeral guest session", () => {
    const session = store.create("guest_abc123", Date.now() + 4 * 60 * 60 * 1000);

    expect(session.guestId).toBe("guest_abc123");
    expect(session.sessionId).toBeDefined();
    expect(session.ephemeralMemory).toEqual([]);
  });

  it("stores ephemeral memory items", () => {
    const session = store.create("guest_abc", Date.now() + 4 * 60 * 60 * 1000);
    store.addMemory(session.sessionId, "Guest mentioned they like pizza");
    store.addMemory(session.sessionId, "Guest is visiting from Seattle");

    const memories = store.getMemory(session.sessionId);
    expect(memories).toHaveLength(2);
    expect(memories[0]).toContain("pizza");
  });

  it("returns empty memory for unknown session", () => {
    expect(store.getMemory("unknown")).toEqual([]);
  });

  it("destroys session and clears memory", () => {
    const session = store.create("guest_abc", Date.now() + 4 * 60 * 60 * 1000);
    store.addMemory(session.sessionId, "something");

    store.destroy(session.sessionId);

    expect(store.getMemory(session.sessionId)).toEqual([]);
    expect(store.has(session.sessionId)).toBe(false);
  });

  it("session exists check", () => {
    const session = store.create("guest_abc", Date.now() + 4 * 60 * 60 * 1000);
    expect(store.has(session.sessionId)).toBe(true);
    expect(store.has("nonexistent")).toBe(false);
  });

  it("cleans up expired sessions", () => {
    store.create("guest_1", Date.now() + 1000);
    store.create("guest_2", Date.now() + 4 * 60 * 60 * 1000);

    vi.advanceTimersByTime(2000);
    store.cleanupExpired();

    expect(store.activeCount).toBe(1);
  });

  it("destroys all sessions", () => {
    store.create("guest_1", Date.now() + 4 * 60 * 60 * 1000);
    store.create("guest_2", Date.now() + 4 * 60 * 60 * 1000);
    store.create("guest_3", Date.now() + 4 * 60 * 60 * 1000);

    store.destroyAll();
    expect(store.activeCount).toBe(0);
  });

  it("counts active sessions", () => {
    store.create("guest_1", Date.now() + 4 * 60 * 60 * 1000);
    store.create("guest_2", Date.now() + 4 * 60 * 60 * 1000);
    expect(store.activeCount).toBe(2);
  });

  it("limits ephemeral memory to 50 items", () => {
    const session = store.create("guest_abc", Date.now() + 4 * 60 * 60 * 1000);

    for (let i = 0; i < 60; i++) {
      store.addMemory(session.sessionId, `fact ${i}`);
    }

    expect(store.getMemory(session.sessionId)).toHaveLength(50);
  });
});
```

- [ ] **Step 7: Implement guest session store `gateway/src/guest/session.ts`**

```typescript
import type { GuestSessionData } from "./types.ts";

const MAX_EPHEMERAL_MEMORY = 50;

export class GuestSessionStore {
  private sessions = new Map<string, GuestSessionData>();

  get activeCount(): number {
    return this.sessions.size;
  }

  create(guestId: string, expiresAt: number): GuestSessionData {
    const sessionId = `gsess_${crypto.randomUUID().slice(0, 12)}`;
    const session: GuestSessionData = {
      sessionId,
      guestId,
      createdAt: Date.now(),
      expiresAt,
      ephemeralMemory: [],
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  addMemory(sessionId: string, fact: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.ephemeralMemory.push(fact);

    // Cap ephemeral memory
    if (session.ephemeralMemory.length > MAX_EPHEMERAL_MEMORY) {
      session.ephemeralMemory = session.ephemeralMemory.slice(-MAX_EPHEMERAL_MEMORY);
    }
  }

  getMemory(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    return session ? [...session.ephemeralMemory] : [];
  }

  destroy(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  destroyAll(): void {
    this.sessions.clear();
  }

  cleanupExpired(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt < now) {
        this.sessions.delete(sessionId);
      }
    }
  }
}
```

- [ ] **Step 8: Create index `gateway/src/guest/index.ts`**

```typescript
export { type GuestInvite, type GuestSessionData, PIN_LENGTH, INVITE_TTL_MS, GUEST_TOKEN_TTL_MS } from "./types.ts";
export { GuestInviteManager } from "./invite-manager.ts";
export { GuestSessionStore } from "./session.ts";
```

- [ ] **Step 9: Run all guest tests**

Run: `cd gateway && bun test src/guest/`

Expected: ~25 tests pass.

- [ ] **Step 10: Commit**

```bash
git add gateway/src/guest/
git commit -m "feat(gateway): guest mode with PIN invite, ephemeral sessions, restricted access"
```

---

## Task 5.7: Audit Logging + Metrics Endpoint

**Files:**
- Create: `gateway/src/audit/types.ts`
- Create: `gateway/src/audit/types.test.ts`
- Create: `gateway/src/audit/logger.ts`
- Create: `gateway/src/audit/logger.test.ts`
- Create: `gateway/src/audit/metrics.ts`
- Create: `gateway/src/audit/metrics.test.ts`
- Create: `gateway/src/audit/index.ts`

### Part A: Audit Types + Logger (~4 min)

- [ ] **Step 1: Write tests for audit types `gateway/src/audit/types.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { auditEntrySchema, AUDIT_ACTIONS } from "./types.ts";

describe("audit types", () => {
  it("defines all audit action types", () => {
    expect(AUDIT_ACTIONS).toContain("session_start");
    expect(AUDIT_ACTIONS).toContain("session_end");
    expect(AUDIT_ACTIONS).toContain("tool_call");
    expect(AUDIT_ACTIONS).toContain("skill_invoke");
    expect(AUDIT_ACTIONS).toContain("auth");
    expect(AUDIT_ACTIONS).toContain("injection_flag");
    expect(AUDIT_ACTIONS).toContain("confirm_prompt");
    expect(AUDIT_ACTIONS).toContain("error");
  });

  it("validates a well-formed audit entry", () => {
    const entry = {
      timestamp: new Date().toISOString(),
      userId: "kevin",
      role: "adult",
      sessionId: "sess-1",
      action: "tool_call",
      detail: {
        toolName: "weather",
        result: "success",
        durationMs: 120,
      },
    };

    const result = auditEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Implement audit types `gateway/src/audit/types.ts`**

```typescript
import { z } from "zod";

export const AUDIT_ACTIONS = [
  "session_start",
  "session_end",
  "tool_call",
  "skill_invoke",
  "auth",
  "injection_flag",
  "confirm_prompt",
  "error",
  "memory_update",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  timestamp: string;
  userId: string;
  role: string;
  sessionId: string;
  action: AuditAction;
  detail: Record<string, unknown>;
}

export const auditEntrySchema = z.object({
  timestamp: z.string(),
  userId: z.string(),
  role: z.string(),
  sessionId: z.string(),
  action: z.enum(AUDIT_ACTIONS),
  detail: z.record(z.unknown()),
});

export interface MetricsSnapshot {
  sessionsActive: number;
  requestsTotal: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  errorsTotal: number;
  toolCallsTotal: number;
  uptime: number;
}
```

- [ ] **Step 3: Write tests for audit logger `gateway/src/audit/logger.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AuditLogger } from "./logger.ts";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("AuditLogger", () => {
  let logDir: string;
  let logger: AuditLogger;

  beforeEach(async () => {
    logDir = join(tmpdir(), `audit-test-${Date.now()}`);
    await mkdir(logDir, { recursive: true });
    logger = new AuditLogger(logDir);
  });

  afterEach(async () => {
    await logger.close();
    await rm(logDir, { recursive: true, force: true });
  });

  it("writes a single audit entry as JSON line", async () => {
    await logger.log({
      timestamp: "2026-04-04T12:00:00Z",
      userId: "kevin",
      role: "adult",
      sessionId: "sess-1",
      action: "tool_call",
      detail: { toolName: "weather", result: "success" },
    });

    await logger.flush();

    const content = await readFile(logger.currentPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.action).toBe("tool_call");
    expect(parsed.detail.toolName).toBe("weather");
  });

  it("writes multiple entries as separate lines", async () => {
    for (let i = 0; i < 5; i++) {
      await logger.log({
        timestamp: new Date().toISOString(),
        userId: "kevin",
        role: "adult",
        sessionId: "sess-1",
        action: "tool_call",
        detail: { index: i },
      });
    }

    await logger.flush();

    const content = await readFile(logger.currentPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(5);
  });

  it("sanitizes sensitive data from detail", async () => {
    await logger.log({
      timestamp: new Date().toISOString(),
      userId: "kevin",
      role: "adult",
      sessionId: "sess-1",
      action: "auth",
      detail: { token: "v4.local.secret-value", pin: "123456" },
    });

    await logger.flush();

    const content = await readFile(logger.currentPath, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.detail.token).toBe("[REDACTED]");
    expect(parsed.detail.pin).toBe("[REDACTED]");
  });

  it("counts logged entries", async () => {
    await logger.log({
      timestamp: new Date().toISOString(),
      userId: "kevin",
      role: "adult",
      sessionId: "sess-1",
      action: "session_start",
      detail: {},
    });

    expect(logger.entryCount).toBe(1);
  });
});
```

- [ ] **Step 4: Implement audit logger `gateway/src/audit/logger.ts`**

```typescript
import { appendFile, stat, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AuditEntry } from "./types.ts";

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
const SENSITIVE_KEYS = new Set(["token", "pin", "password", "secret", "key", "apiKey", "api_key"]);

export class AuditLogger {
  private logDir: string;
  private buffer: string[] = [];
  private _entryCount = 0;
  private _currentPath: string;

  constructor(logDir: string) {
    this.logDir = logDir;
    this._currentPath = join(logDir, "audit.jsonl");
  }

  get currentPath(): string {
    return this._currentPath;
  }

  get entryCount(): number {
    return this._entryCount;
  }

  async log(entry: AuditEntry): Promise<void> {
    const sanitized = { ...entry, detail: sanitizeDetail(entry.detail) };
    const line = JSON.stringify(sanitized) + "\n";
    this.buffer.push(line);
    this._entryCount++;

    // Auto-flush every 10 entries
    if (this.buffer.length >= 10) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    await mkdir(this.logDir, { recursive: true });
    const data = this.buffer.join("");
    this.buffer = [];

    await appendFile(this._currentPath, data);
    await this.checkRotation();
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private async checkRotation(): Promise<void> {
    try {
      const stats = await stat(this._currentPath);
      if (stats.size >= MAX_FILE_SIZE_BYTES) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const archivePath = join(this.logDir, `audit-${timestamp}.jsonl`);
        await rename(this._currentPath, archivePath);
      }
    } catch {
      // File may not exist yet
    }
  }
}

function sanitizeDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(detail)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizeDetail(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
```

- [ ] **Step 5: Run logger tests**

Run: `cd gateway && bun test src/audit/logger.test.ts`

Expected: All tests pass.

### Part B: Metrics Collector + Endpoint (~4 min)

- [ ] **Step 6: Write tests for metrics `gateway/src/audit/metrics.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { MetricsCollector } from "./metrics.ts";

describe("MetricsCollector", () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    metrics = new MetricsCollector();
  });

  it("tracks active sessions", () => {
    metrics.sessionStarted();
    metrics.sessionStarted();
    expect(metrics.snapshot().sessionsActive).toBe(2);

    metrics.sessionEnded();
    expect(metrics.snapshot().sessionsActive).toBe(1);
  });

  it("does not go below 0 active sessions", () => {
    metrics.sessionEnded();
    expect(metrics.snapshot().sessionsActive).toBe(0);
  });

  it("counts total requests", () => {
    metrics.requestCompleted(100);
    metrics.requestCompleted(200);
    metrics.requestCompleted(150);

    expect(metrics.snapshot().requestsTotal).toBe(3);
  });

  it("calculates p50 latency", () => {
    for (let i = 1; i <= 100; i++) {
      metrics.requestCompleted(i);
    }

    const snap = metrics.snapshot();
    expect(snap.latencyP50Ms).toBeCloseTo(50, -1);
  });

  it("calculates p95 latency", () => {
    for (let i = 1; i <= 100; i++) {
      metrics.requestCompleted(i);
    }

    const snap = metrics.snapshot();
    expect(snap.latencyP95Ms).toBeCloseTo(95, -1);
  });

  it("returns 0 latency when no requests", () => {
    const snap = metrics.snapshot();
    expect(snap.latencyP50Ms).toBe(0);
    expect(snap.latencyP95Ms).toBe(0);
  });

  it("counts errors", () => {
    metrics.errorOccurred();
    metrics.errorOccurred();

    expect(metrics.snapshot().errorsTotal).toBe(2);
  });

  it("counts tool calls", () => {
    metrics.toolCallCompleted();
    metrics.toolCallCompleted();
    metrics.toolCallCompleted();

    expect(metrics.snapshot().toolCallsTotal).toBe(3);
  });

  it("reports uptime", () => {
    const snap = metrics.snapshot();
    expect(snap.uptime).toBeGreaterThanOrEqual(0);
  });

  it("snapshot returns all fields", () => {
    const snap = metrics.snapshot();
    expect(snap).toHaveProperty("sessionsActive");
    expect(snap).toHaveProperty("requestsTotal");
    expect(snap).toHaveProperty("latencyP50Ms");
    expect(snap).toHaveProperty("latencyP95Ms");
    expect(snap).toHaveProperty("errorsTotal");
    expect(snap).toHaveProperty("toolCallsTotal");
    expect(snap).toHaveProperty("uptime");
  });

  it("resets all counters", () => {
    metrics.sessionStarted();
    metrics.requestCompleted(100);
    metrics.errorOccurred();
    metrics.toolCallCompleted();

    metrics.reset();

    const snap = metrics.snapshot();
    expect(snap.sessionsActive).toBe(0);
    expect(snap.requestsTotal).toBe(0);
    expect(snap.errorsTotal).toBe(0);
    expect(snap.toolCallsTotal).toBe(0);
  });
});
```

- [ ] **Step 7: Implement metrics collector `gateway/src/audit/metrics.ts`**

```typescript
import type { MetricsSnapshot } from "./types.ts";

const MAX_LATENCY_SAMPLES = 1000;

export class MetricsCollector {
  private activeSessions = 0;
  private totalRequests = 0;
  private totalErrors = 0;
  private totalToolCalls = 0;
  private latencySamples: number[] = [];
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  sessionStarted(): void {
    this.activeSessions++;
  }

  sessionEnded(): void {
    this.activeSessions = Math.max(0, this.activeSessions - 1);
  }

  requestCompleted(latencyMs: number): void {
    this.totalRequests++;
    this.latencySamples.push(latencyMs);

    // Keep a rolling window of samples
    if (this.latencySamples.length > MAX_LATENCY_SAMPLES) {
      this.latencySamples = this.latencySamples.slice(-MAX_LATENCY_SAMPLES);
    }
  }

  errorOccurred(): void {
    this.totalErrors++;
  }

  toolCallCompleted(): void {
    this.totalToolCalls++;
  }

  snapshot(): MetricsSnapshot {
    return {
      sessionsActive: this.activeSessions,
      requestsTotal: this.totalRequests,
      latencyP50Ms: this.percentile(50),
      latencyP95Ms: this.percentile(95),
      errorsTotal: this.totalErrors,
      toolCallsTotal: this.totalToolCalls,
      uptime: Date.now() - this.startTime,
    };
  }

  reset(): void {
    this.activeSessions = 0;
    this.totalRequests = 0;
    this.totalErrors = 0;
    this.totalToolCalls = 0;
    this.latencySamples = [];
    this.startTime = Date.now();
  }

  /** Builds the /metrics HTTP response */
  toResponse(): Response {
    return Response.json(this.snapshot());
  }

  private percentile(p: number): number {
    if (this.latencySamples.length === 0) return 0;

    const sorted = [...this.latencySamples].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }
}
```

- [ ] **Step 8: Create index `gateway/src/audit/index.ts`**

```typescript
export { type AuditEntry, type AuditAction, type MetricsSnapshot, AUDIT_ACTIONS, auditEntrySchema } from "./types.ts";
export { AuditLogger } from "./logger.ts";
export { MetricsCollector } from "./metrics.ts";
```

- [ ] **Step 9: Run all audit tests**

Run: `cd gateway && bun test src/audit/`

Expected: ~15 tests pass.

- [ ] **Step 10: Commit**

```bash
git add gateway/src/audit/
git commit -m "feat(gateway): audit logging with rotation + metrics endpoint"
```

---

## Final Verification

- [ ] **Step 1: Run all Phase 5 tests**

Run: `cd gateway && bun test src/tools/ src/skills/ src/memory/ src/guest/ src/audit/`

Expected: ~165 tests pass across all modules.

- [ ] **Step 2: Run full CI suite**

Run: `cd /Users/kevinye/Development/sentient && bun run ci`

Expected: lint, typecheck, and all unit tests pass.

- [ ] **Step 3: Verify tool → skill → memory integration path**

Manual integration check: verify that:
1. ToolRegistry accepts built-in tools (clock, weather, timer, reminder_create, remember)
2. SkillLoader loads `gateway/skills/*.md` and registers them in SkillEngine
3. SkillEngine exposes skills as tool schemas alongside regular tools
4. MemoryManager loads/saves user memory files from `gateway/memory/`
5. ContextAssembler builds persona + memory + history within token budget
6. GuestInviteManager creates PINs, GuestSessionStore creates ephemeral sessions
7. AuditLogger writes structured JSON lines, MetricsCollector tracks stats

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(gateway): Phase 5 Intelligence Layer complete — tools, skills, memory, guest, audit"
```

---

## CHECKPOINT

**Family assistant with memory, tools, skills, guest access. Production-ready.**

Verification criteria:
- [ ] `bun test src/tools/` — ~45 tests pass (registry, ReAct loop, confirmation, built-in tools)
- [ ] `bun test src/skills/` — ~30 tests pass (frontmatter, types, cycle detection, engine, loader)
- [ ] `bun test src/memory/` — ~30 tests pass (token estimator, extractor, reconciler, manager, assembler)
- [ ] `bun test src/guest/` — ~25 tests pass (invite manager, session store)
- [ ] `bun test src/audit/` — ~15 tests pass (logger, metrics)
- [ ] `bun run ci` — full suite green
- [ ] Skills hot-reload: drop a `.md` file in `gateway/skills/` and it registers
- [ ] Memory isolation: each user's memory is path-validated and separate
- [ ] Guest flow: PIN generation → claim → ephemeral session → restricted tools → session destroyed
- [ ] `/metrics` endpoint responds with session/latency/error counts
