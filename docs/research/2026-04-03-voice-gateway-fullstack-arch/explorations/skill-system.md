# Skill System Architecture

## Decision Area
Hot-reloadable, composable, sandboxed skill system using markdown-defined workflows.

## Key Questions
- Skill file format: what does a `.md` skill definition look like?
  - Triggers (wake phrases, intent patterns)
  - Steps (sequential, conditional, loop)
  - Tool references (declared dependencies)
  - Parameters (typed inputs/outputs)
  - Compose calls (skill A invokes skill B)
- Hot-reload: file watcher (chokidar/fs.watch) → parse → validate → register
- Skill execution engine: how the gateway interprets and runs a skill workflow
- Sandboxing: skills can only access declared tools, no ambient authority
- Cycle detection for composable skills (A→B→A)
- Error handling: malformed skills fail gracefully, don't crash gateway
- Skill validation on load: schema check, tool existence check, cycle check
- How skills interact with classifier triggers and tool router

## Prior Research
- Claude Code SKILL.md pattern: YAML frontmatter (name, description, allowed-tools) + markdown body with workflow steps. Description is the primary trigger mechanism — LLM matches user intent to skill description. Skills reference bundled assets in subdirectories.
- Home Assistant intent patterns: YAML sentence templates with slots/lists/expansion rules. Intent files named `<domain>_<intent>.yaml`. Pattern matching with extracted parameters.
- OpenWorkflow (TS): durable workflow framework for Node+Bun with step-based execution.
- ts-edge: lightweight type-safe TS workflow engine.
- Chokidar v5: ESM-only, Node 20+ file watcher. Bun has built-in `--hot` and `--watch` flags.
- Classifier exploration (Approach A) concluded: skills registered as individual tools in the tool registry, each with its own description and parameter schema. LLM decides when to invoke a skill via standard tool calling.
- EmDash sandboxing pattern: capability manifest declares exactly what tools/APIs a skill needs; no implicit access; enforced at runtime.

## Approaches

### Approach A: Markdown with YAML Frontmatter (LLM-Interpreted)

**Description:** Skills are markdown files with YAML frontmatter for metadata (name, description, allowed-tools, parameters) and a markdown body containing natural-language workflow instructions. The LLM interprets the workflow body at runtime — the gateway doesn't parse steps into a DAG. Each skill is registered as a tool in the tool registry; when the LLM invokes a skill, the skill's markdown body is injected into the LLM context as instructions, and the LLM executes the steps by making tool calls within its ReAct loop.

**Skill file format:**

```markdown
---
name: morning-briefing
description: >
  Deliver a personalized morning briefing. Use when the user asks for their
  morning update, daily briefing, news summary, or says "good morning, what's
  happening today".
allowed-tools:
  - weather
  - calendar
  - news
  - shopping_list
parameters:
  location:
    type: string
    description: City for weather (defaults to user's home)
    required: false
roles:
  - adult
  - child
compose:
  - shopping_list_summary
---

# Morning Briefing

You are delivering a personalized morning briefing. Follow these steps:

1. Get today's weather for the user's location using the `weather` tool
2. Fetch today's calendar events using the `calendar` tool
3. Get top 3 news headlines using the `news` tool
4. If there are items on the shopping list, get a summary using the `shopping_list_summary` skill
5. Compose a cheerful, concise briefing combining all results:
   - Lead with weather and what to wear
   - Mention calendar events with times
   - Share news headlines briefly
   - Mention shopping list items if any
6. Keep the total response under 30 seconds of speech
```

**Another example — a simpler skill:**

```markdown
---
name: set-reminder
description: >
  Set a reminder for a future time. Use when the user wants to be reminded
  about something, asks to "remind me", or wants to schedule a notification.
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
    description: When to remind (natural language, e.g. "in 30 minutes", "tomorrow at 9am")
    required: true
roles:
  - adult
  - child
---

# Set Reminder

1. Parse the requested time using the `clock` tool to resolve natural language to a timestamp
2. Create the reminder using `reminder_create` with the message and resolved timestamp
3. Confirm to the user: what you'll remind them about, and when
```

**Execution flow:**

```
User: "Give me my morning briefing"
      ↓
Classifier → identifies intent → skill:morning-briefing
      ↓
Tool Router → invokes skill_morning_briefing tool
      ↓
Skill Engine:
  1. Load morning-briefing.md
  2. Validate allowed-tools against user's role
  3. Inject skill body into LLM context as system instructions
  4. Enter ReAct loop with only the skill's allowed-tools available
  5. LLM follows the markdown steps, calling tools as described
  6. Final text response → TTS
```

**Implementation:**

```typescript
interface SkillDefinition {
  name: string;
  description: string;
  allowedTools: string[];
  parameters: Record<string, ParameterDef>;
  roles: Role[];
  compose: string[];           // Other skills this skill can invoke
  body: string;                // Raw markdown workflow instructions
  filePath: string;            // For hot-reload tracking
  loadedAt: number;            // Timestamp
}

interface ParameterDef {
  type: "string" | "number" | "boolean";
  description: string;
  required: boolean;
  default?: unknown;
}

class SkillEngine {
  private skills = new Map<string, SkillDefinition>();
  private toolRegistry: ToolRegistry;

  async execute(
    skillName: string,
    params: Record<string, unknown>,
    session: Session,
  ): Promise<ToolResult> {
    const skill = this.skills.get(skillName);
    if (!skill) {
      return { success: false, output: `Skill '${skillName}' not found.` };
    }

    // Role check
    if (!skill.roles.includes(session.role)) {
      return { success: false, output: `Skill '${skillName}' not available for ${session.role} role.` };
    }

    // Build scoped tool list: only allowed-tools + composed skills
    const scopedTools = this.toolRegistry.getToolSchemas(session.role)
      .filter(t => skill.allowedTools.includes(t.function.name));

    // Add composed skills as callable tools
    for (const composeName of skill.compose) {
      const composed = this.skills.get(composeName);
      if (composed && composed.roles.includes(session.role)) {
        scopedTools.push({
          type: "function",
          function: {
            name: `skill_${composeName}`,
            description: composed.description,
            parameters: buildParamSchema(composed.parameters),
          },
        });
      }
    }

    // Inject skill body as instructions for the LLM
    const skillContext: Message[] = [
      {
        role: "system",
        content: `You are executing the "${skill.name}" skill. Follow these instructions precisely:\n\n${skill.body}\n\nParameters provided: ${JSON.stringify(params)}`,
      },
    ];

    // Run a scoped ReAct loop with only the skill's tools
    const result = await executeReActLoop({
      session,
      messages: [...session.contextMessages, ...skillContext],
      toolRegistry: this.toolRegistry,
      scopedToolNames: new Set(skill.allowedTools),
      abortSignal: session.abortController.signal,
    });

    return { success: true, output: result };
  }
}
```

**Sandboxing enforcement:**

```typescript
// In the ReAct loop's tool execution step:
async function executeSingleTool(
  toolCall: ToolCall,
  ctx: ReActContext,
): Promise<ToolResult> {
  const { name } = toolCall.function;

  // If we're inside a skill execution, enforce scoped tools
  if (ctx.scopedToolNames && !ctx.scopedToolNames.has(name)) {
    return {
      success: false,
      output: `Tool '${name}' is not authorized for this skill. Declared tools: ${[...ctx.scopedToolNames].join(", ")}`,
    };
  }

  // ... rest of tool execution (impact tier check, audit log, etc.)
}
```

**Hot-reload implementation:**

```typescript
import { watch } from "fs";       // Node
// OR: Bun.file watcher is built-in via Bun.serve({ watch: true })

class SkillLoader {
  private skillDir: string;
  private engine: SkillEngine;
  private watcher: FSWatcher | null = null;

  async loadAll(): Promise<void> {
    const files = await readdir(this.skillDir);
    for (const file of files) {
      if (file.endsWith(".md")) {
        await this.loadSkill(join(this.skillDir, file));
      }
    }
    // After all loaded, run cycle detection
    this.detectCycles();
  }

  async loadSkill(filePath: string): Promise<void> {
    const content = await readFile(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);

    // Validate
    const errors = this.validate(frontmatter, body);
    if (errors.length > 0) {
      console.error(`Skill ${filePath} failed validation:`, errors);
      return; // Keep old version if exists
    }

    const skill: SkillDefinition = {
      name: frontmatter.name,
      description: frontmatter.description,
      allowedTools: frontmatter["allowed-tools"] ?? [],
      parameters: frontmatter.parameters ?? {},
      roles: frontmatter.roles ?? ["adult", "child", "guest"],
      compose: frontmatter.compose ?? [],
      body,
      filePath,
      loadedAt: Date.now(),
    };

    this.engine.register(skill);
    console.log(`Loaded skill: ${skill.name} (${skill.allowedTools.length} tools, ${skill.compose.length} composed)`);
  }

  validate(frontmatter: Record<string, unknown>, body: string): string[] {
    const errors: string[] = [];

    if (!frontmatter.name || typeof frontmatter.name !== "string") {
      errors.push("Missing or invalid 'name' in frontmatter");
    }
    if (!frontmatter.description || typeof frontmatter.description !== "string") {
      errors.push("Missing or invalid 'description' in frontmatter");
    }
    if (typeof frontmatter.name === "string" && frontmatter.name.length > 64) {
      errors.push("Skill name must be ≤ 64 characters");
    }
    if (typeof frontmatter.name === "string" && !/^[a-z0-9-]+$/.test(frontmatter.name)) {
      errors.push("Skill name must be lowercase alphanumeric with hyphens only");
    }

    // Check allowed-tools exist in registry
    const tools = (frontmatter["allowed-tools"] as string[]) ?? [];
    for (const tool of tools) {
      if (!this.engine.toolRegistry.has(tool)) {
        errors.push(`Declared tool '${tool}' not found in tool registry`);
      }
    }

    // Check composed skills exist (soft check — they may load later)
    // Full cycle detection runs after all skills loaded

    if (body.trim().length === 0) {
      errors.push("Skill body (workflow instructions) is empty");
    }

    return errors;
  }

  startWatching(): void {
    // chokidar for Node, fs.watch for Bun
    this.watcher = watch(this.skillDir, { recursive: false }, async (event, filename) => {
      if (!filename?.endsWith(".md")) return;
      const filePath = join(this.skillDir, filename);

      if (event === "rename") {
        // File may have been deleted
        try {
          await access(filePath);
          await this.loadSkill(filePath);
        } catch {
          // File deleted — unregister skill
          this.engine.unregisterByPath(filePath);
        }
      } else {
        await this.loadSkill(filePath);
      }

      // Re-run cycle detection after any change
      this.detectCycles();
    });
  }

  detectCycles(): void {
    const graph = new Map<string, string[]>();
    for (const [name, skill] of this.engine.skills) {
      graph.set(name, skill.compose);
    }

    // Topological sort — detect cycles
    const visited = new Set<string>();
    const inStack = new Set<string>();

    const dfs = (node: string, path: string[]): string[] | null => {
      if (inStack.has(node)) {
        return [...path, node]; // Cycle found
      }
      if (visited.has(node)) return null;

      visited.add(node);
      inStack.add(node);

      for (const dep of graph.get(node) ?? []) {
        const cycle = dfs(dep, [...path, node]);
        if (cycle) return cycle;
      }

      inStack.delete(node);
      return null;
    };

    for (const name of graph.keys()) {
      const cycle = dfs(name, []);
      if (cycle) {
        console.error(`Cycle detected in skill composition: ${cycle.join(" → ")}`);
        // Disable the last-loaded skill in the cycle
        const lastLoaded = cycle
          .map(n => this.engine.skills.get(n))
          .filter(Boolean)
          .sort((a, b) => b!.loadedAt - a!.loadedAt)[0];
        if (lastLoaded) {
          this.engine.unregister(lastLoaded.name);
          console.error(`Disabled skill '${lastLoaded.name}' to break cycle`);
        }
      }
    }
  }
}
```

**Composition depth limit:**

```typescript
const MAX_COMPOSITION_DEPTH = 3;

async execute(skillName: string, params: Record<string, unknown>, session: Session, depth = 0): Promise<ToolResult> {
  if (depth >= MAX_COMPOSITION_DEPTH) {
    return { success: false, output: `Skill composition depth limit (${MAX_COMPOSITION_DEPTH}) exceeded.` };
  }
  // ... rest of execution, passing depth + 1 to composed skill calls
}
```

**Pros:**
- **Most natural format** — markdown is readable by humans, editable in any text editor, natural for non-programmer family members to read/understand
- **LLM-native execution** — the LLM interprets natural-language steps, handling ambiguity and edge cases gracefully. No brittle step parser needed.
- **Flexible workflows** — conditional logic, error recovery, and adaptation are handled by the LLM's reasoning, not a rigid execution engine
- **Simple implementation** — no DAG executor, no step parser, no AST. The "execution engine" is the LLM itself.
- **Hot-reload is trivial** — reload = re-read file, re-parse frontmatter, re-register. No compilation step.
- **Strong sandboxing** — scoped tool list enforced at the ReAct loop level. Skill literally cannot call undeclared tools.
- **Composition is natural** — composed skills are just additional tools available in the scoped set
- **Description-driven triggers** — the LLM matches user intent to skill description via standard tool calling (already designed in classifier exploration)
- **Aligns with Claude Code pattern** — proven pattern at scale

**Cons:**
- **LLM cost per skill execution** — every skill invocation requires an LLM call (the scoped ReAct loop). Simple skills like "set a timer" still need an LLM to interpret the markdown steps.
- **Non-deterministic execution** — LLM may interpret steps differently each time. "Follow these steps precisely" is a suggestion, not a guarantee.
- **Latency** — skill execution adds 500-2000ms for the LLM to read instructions and decide on tool calls, on top of tool execution time
- **Debugging is harder** — when a skill misbehaves, it's because the LLM misinterpreted instructions, not a code bug. Harder to reproduce and fix.
- **Context budget pressure** — skill body + scoped tool schemas consume context tokens on every skill invocation
- **No offline skill execution** — requires LLM for every skill, even simple deterministic ones

**Risk factors:**
- LLM misinterpreting steps in complex multi-tool workflows
- Skill body length inflating context and slowing response
- Composed skill depth compounding latency (each level adds an LLM call)

---

### Approach B: Structured YAML Skill Definitions (Gateway-Interpreted)

**Description:** Skills are defined in pure YAML with structured step definitions. The gateway has a built-in step interpreter that executes steps deterministically — no LLM needed for simple skills. Complex steps can optionally delegate to the LLM. This gives deterministic execution for simple workflows and LLM intelligence for complex ones.

**Skill file format:**

```yaml
name: morning-briefing
description: >
  Deliver a personalized morning briefing. Use when the user asks for their
  morning update, daily briefing, or says "good morning, what's happening today".
allowed-tools:
  - weather
  - calendar
  - news
  - shopping_list
parameters:
  location:
    type: string
    description: City for weather
    default: "$user.home_city"
roles: [adult, child]
compose: [shopping-list-summary]

steps:
  - id: get_weather
    tool: weather
    params:
      location: "$params.location"
    output: weather_data

  - id: get_calendar
    tool: calendar
    params:
      date: today
    output: calendar_events

  - id: get_news
    tool: news
    params:
      count: 3
    output: news_headlines

  - id: check_shopping
    condition: "$session.has_shopping_list"
    skill: shopping-list-summary
    output: shopping_summary

  - id: compose_briefing
    type: llm
    prompt: |
      Compose a cheerful morning briefing from this data:
      Weather: $weather_data
      Calendar: $calendar_events
      News: $news_headlines
      Shopping: $shopping_summary
      Keep it under 30 seconds of speech.
    output: final_response
```

**Step types:**

```typescript
type StepType =
  | "tool"        // Call a registered tool
  | "skill"       // Invoke a composed skill
  | "llm"         // Delegate to LLM for text generation
  | "condition"   // Branch based on a condition
  | "transform"   // Simple data transformation (template string)
  ;

interface ToolStep {
  id: string;
  tool: string;
  params: Record<string, string>;  // Values can reference $variables
  output: string;
  condition?: string;              // Skip if condition is false
}

interface SkillStep {
  id: string;
  skill: string;
  params?: Record<string, string>;
  output: string;
  condition?: string;
}

interface LLMStep {
  id: string;
  type: "llm";
  prompt: string;                  // Template with $variable references
  output: string;
}

interface TransformStep {
  id: string;
  type: "transform";
  template: string;                // "Weather: $weather_data, Events: $calendar_events"
  output: string;
}
```

**Execution engine:**

```typescript
class StructuredSkillEngine {
  async execute(
    skill: StructuredSkillDefinition,
    params: Record<string, unknown>,
    session: Session,
  ): Promise<ToolResult> {
    const context: Record<string, unknown> = {
      params,
      user: session.userProfile,
      session: session.metadata,
    };

    for (const step of skill.steps) {
      // Check condition
      if (step.condition && !evaluateCondition(step.condition, context)) {
        continue;
      }

      let result: unknown;

      switch (step.type ?? "tool") {
        case "tool":
          const resolvedParams = resolveVariables(step.params, context);
          const tool = this.toolRegistry.getTool(step.tool, session.role);
          if (!tool || !skill.allowedTools.includes(step.tool)) {
            return { success: false, output: `Tool '${step.tool}' not authorized for skill '${skill.name}'` };
          }
          result = await tool.handler(resolvedParams, session);
          break;

        case "skill":
          result = await this.execute(
            this.skills.get(step.skill)!,
            resolveVariables(step.params ?? {}, context),
            session,
          );
          break;

        case "llm":
          const prompt = resolveTemplate(step.prompt, context);
          result = await this.llmCall(prompt, session);
          break;

        case "transform":
          result = resolveTemplate(step.template, context);
          break;
      }

      context[step.output] = result;
    }

    // Return last step's output
    const lastStep = skill.steps[skill.steps.length - 1];
    return {
      success: true,
      output: String(context[lastStep.output] ?? ""),
    };
  }

  private resolveVariables(
    params: Record<string, string>,
    context: Record<string, unknown>,
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string" && value.startsWith("$")) {
        resolved[key] = getNestedValue(context, value.slice(1));
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }
}
```

**Pros:**
- **Deterministic execution for simple skills** — tool steps execute exactly as defined, no LLM interpretation variance
- **Lower cost for simple skills** — "set a timer" skill calls the tool directly, no LLM call needed
- **Lower latency for deterministic steps** — tool calls happen immediately, no 500ms+ LLM overhead
- **Explicit data flow** — `$variable` references make data flow between steps visible and debuggable
- **Structured validation** — step schema can be fully validated at load time (tool existence, param types, variable references)
- **Offline-capable for deterministic skills** — skills with only tool steps work without LLM access
- **Type: "llm" steps** give escape hatch for complex logic that needs LLM intelligence

**Cons:**
- **Rigid format** — adding new step types requires engine changes. Every new pattern (loops, parallel steps, error recovery) must be designed into the engine.
- **Variable resolution complexity** — `$params.location`, `$weather_data.temperature`, `$session.has_shopping_list` need a mini expression evaluator. Nested access, type coercion, missing values — all edge cases.
- **YAML authoring burden** — writing YAML step definitions is harder than writing natural-language markdown. More syntax to get wrong.
- **Condition evaluation** — `condition: "$session.has_shopping_list"` needs a condition evaluator. Simple truthy checks? Comparisons? Boolean logic? Scope creep.
- **Error recovery is brittle** — if step 2 fails, the engine must decide: skip? retry? abort? This is built-in logic, not LLM reasoning.
- **Less readable** — YAML with `$variable` references is harder to scan than natural-language workflow descriptions
- **Two execution paths** — deterministic steps vs `type: llm` steps have different behaviors, testing, and failure modes
- **Hot-reload is more complex** — need to re-validate step schemas, variable references, and re-check composed skill availability

**Risk factors:**
- Variable resolution bugs (wrong type, missing value, circular reference)
- Condition evaluation becoming a mini programming language over time
- Complex skills needing `type: llm` for every interesting step, negating the determinism benefit
- YAML syntax errors harder to debug than markdown formatting issues

---

### Approach C: TypeScript Skill Modules

**Description:** Skills are TypeScript files that export a standard interface. Each skill is a module with typed inputs/outputs, explicit tool dependencies, and imperative execution logic. Hot-reload via dynamic `import()` with module cache invalidation.

**Skill file format:**

```typescript
// skills/morning-briefing.ts
import { defineSkill } from "../skill-sdk";

export default defineSkill({
  name: "morning-briefing",
  description: "Deliver a personalized morning briefing...",
  allowedTools: ["weather", "calendar", "news", "shopping_list"],
  parameters: {
    location: { type: "string", description: "City for weather", required: false },
  },
  roles: ["adult", "child"],
  compose: ["shopping-list-summary"],

  async execute({ params, tools, session, compose }) {
    const [weather, calendar, news] = await Promise.all([
      tools.call("weather", { location: params.location ?? session.user.homeCity }),
      tools.call("calendar", { date: "today" }),
      tools.call("news", { count: 3 }),
    ]);

    let shopping = "";
    if (session.hasShoppingList) {
      shopping = await compose("shopping-list-summary", {});
    }

    // Use LLM to compose the briefing from structured data
    const briefing = await tools.llm(`
      Compose a cheerful morning briefing:
      Weather: ${weather.output}
      Calendar: ${calendar.output}
      News: ${news.output}
      ${shopping ? `Shopping: ${shopping}` : ""}
      Keep under 30 seconds of speech.
    `);

    return { success: true, output: briefing };
  },
});
```

**Execution engine:**

```typescript
class TypeScriptSkillEngine {
  private modules = new Map<string, SkillModule>();

  async loadFromDirectory(dir: string): Promise<void> {
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
      await this.loadModule(join(dir, file));
    }
  }

  async loadModule(filePath: string): Promise<void> {
    // Invalidate module cache for hot-reload
    delete require.cache[filePath]; // Node
    // Bun: use Bun's --hot which handles this automatically

    const mod = await import(filePath + `?t=${Date.now()}`); // Cache-bust
    const skill = mod.default as SkillModule;

    // Validate
    if (!skill.name || !skill.execute) {
      console.error(`Invalid skill module: ${filePath}`);
      return;
    }

    // Verify allowed-tools exist
    for (const tool of skill.allowedTools) {
      if (!this.toolRegistry.has(tool)) {
        console.error(`Skill '${skill.name}' declares unknown tool '${tool}'`);
        return;
      }
    }

    this.modules.set(skill.name, skill);
  }

  async execute(skillName: string, params: Record<string, unknown>, session: Session): Promise<ToolResult> {
    const skill = this.modules.get(skillName);
    if (!skill) return { success: false, output: `Skill '${skillName}' not found` };

    // Build scoped tool caller that enforces allowed-tools
    const scopedTools = {
      call: async (toolName: string, toolParams: unknown): Promise<ToolResult> => {
        if (!skill.allowedTools.includes(toolName)) {
          throw new Error(`Tool '${toolName}' not in skill's allowed-tools`);
        }
        const tool = this.toolRegistry.getTool(toolName, session.role);
        if (!tool) throw new Error(`Tool '${toolName}' not available for role ${session.role}`);
        return tool.handler(toolParams, session);
      },
      llm: async (prompt: string): Promise<string> => {
        return this.llmCall(prompt, session);
      },
    };

    const composeFn = async (name: string, p: Record<string, unknown>) => {
      if (!skill.compose.includes(name)) {
        throw new Error(`Skill '${name}' not in compose list`);
      }
      const result = await this.execute(name, p, session);
      return result.output;
    };

    return skill.execute({ params, tools: scopedTools, session, compose: composeFn });
  }
}
```

**Pros:**
- **Maximum power and flexibility** — full TypeScript: parallel execution, error handling, conditional logic, loops, try/catch — anything
- **Type safety** — compile-time checks on parameters, tool calls, return types
- **Parallel tool calls** — `Promise.all` for independent steps (morning-briefing gets weather, calendar, news in parallel)
- **Best performance** — deterministic steps execute instantly, no LLM overhead, no YAML parsing
- **IDE support** — autocomplete, type checking, refactoring, go-to-definition
- **Testable** — unit test skills like any other TypeScript module
- **Sandboxing via scoped API** — `tools.call()` enforces allowed-tools at runtime

**Cons:**
- **Not accessible to non-developers** — writing TypeScript requires programming knowledge. Family members can't author skills.
- **Hot-reload is fragile** — dynamic `import()` with cache invalidation has edge cases: stale closures, memory leaks, module resolution issues. Bun `--hot` helps but is not bulletproof.
- **Security risk** — TypeScript skills are arbitrary code execution. A malformed skill could crash the gateway, leak memory, or access Node APIs directly (fs, net, process).
- **No true sandboxing** — the `scopedTools` API is a gentleman's agreement. The skill module has full access to Node/Bun APIs (`import fs`, `process.exit()`, `fetch()`). Real sandboxing requires V8 isolates or vm2 — heavy.
- **Build step may be needed** — if using TypeScript, need compilation or a runtime that handles TS natively (Bun does, Node needs tsx/ts-node)
- **Overkill for simple skills** — "set a timer" doesn't benefit from TypeScript's power
- **All tools first-party** constraint is harder to enforce — TypeScript skills could import arbitrary npm packages

**Risk factors:**
- Skill code with `import { readFileSync } from "fs"` bypassing sandboxing entirely
- Memory leaks from hot-reloaded modules not being garbage collected
- A skill crash taking down the gateway process
- Difficult to audit skill behavior (must read code vs reading markdown)

---

## Analysis

### Approach comparison

| Dimension | A: Markdown+LLM | B: Structured YAML | C: TypeScript Modules |
|---|---|---|---|
| Authoring ease | Easy — natural language | Medium — structured YAML | Hard — requires TS knowledge |
| Readability | Best — readable prose | Good — explicit structure | Medium — code |
| Execution model | LLM interprets steps | Gateway engine executes | Direct code execution |
| Determinism | Low — LLM variance | High for tool steps | Highest — code is exact |
| Latency (simple skill) | 500-2000ms (LLM call) | <100ms (direct tool call) | <100ms (direct tool call) |
| Latency (complex skill) | 500-2000ms per step | Similar + LLM steps | Similar + LLM steps |
| Cost per invocation | ~$0.005-0.02 (LLM call) | ~$0 for tool steps | ~$0 for tool steps |
| Sandboxing strength | Strong — LLM only sees scoped tools | Strong — engine enforces | Weak — code can escape |
| Hot-reload reliability | Simple — re-read file | Medium — re-validate schema | Fragile — module cache issues |
| Parallel execution | LLM can't parallelize | Need explicit parallel steps | Native Promise.all |
| Error handling | LLM adapts gracefully | Rigid — engine decides | Full try/catch control |
| Composition | Natural — skill as tool | Explicit step type | Function call |
| Validation at load | Frontmatter only | Full step validation | Type checking |
| Offline capability | No — needs LLM | Partial — deterministic steps | Full for non-LLM steps |
| Debugging | Hard — LLM interpretation | Medium — step-by-step trace | Easy — standard debugging |
| Aligns with project | Best — all first-party, accessible | Good — structured | Poor — security risks |

### Key trade-off: LLM cost vs determinism

The central tension is between Approach A's simplicity (LLM does all the work) and Approach B/C's efficiency (deterministic execution for simple skills).

**Cost analysis for Approach A:**

At ~15-20 skills invoked ~50 times/day:
- Input: ~1000 tokens (skill body 400 + tool schemas 300 + context 300)
- Output: ~300 tokens (tool calls + final response)
- Using Sonnet: ~$0.005 input + $0.0045 output ≈ $0.01/skill invocation
- 50 invocations/day × $0.01 = $0.50/day ≈ **$15/month for skill execution alone**

Using Haiku for simple skills (set-reminder, clock, etc.):
- ~$0.002/invocation for simple skills (70% of invocations)
- ~$0.01/invocation for complex skills (30%)
- Blended: $0.0044/invocation × 50/day = $0.22/day ≈ **$6.60/month**

**Cost for Approach B/C:**
- Deterministic steps: $0 (direct tool calls)
- LLM steps only when needed: ~$0.005/invocation × 15 complex invocations/day = **$2.25/month**

The cost difference ($6.60 vs $2.25/month) is meaningful but not decisive for a personal project. The simplicity and flexibility of Approach A likely outweigh $4/month in savings.

### Why Approach A wins for this project

1. **"The most novel area"** — the skill system should be explored, not over-engineered. Markdown + LLM interpretation is the simplest architecture that works. If it proves too slow or expensive, Approach B can be added later for specific skills.

2. **Sandboxing is strongest** — the LLM literally cannot access tools outside the scoped set. With TypeScript (Approach C), a skill can `import fs` and read any file. With YAML (Approach B), the engine is the sandbox but must be carefully implemented.

3. **Composition is natural** — composed skills are just additional tools in the scoped set. The LLM decides when to invoke them based on context. No explicit step type or function call needed.

4. **Hot-reload is trivial** — re-read the markdown file, re-parse frontmatter, re-register the tool. No module cache invalidation, no step schema migration.

5. **Aligns with Claude Code pattern** — proven at scale. SKILL.md with YAML frontmatter + markdown body is an established pattern.

6. **The LLM is already in the loop** — the main response generation uses the LLM anyway. The skill execution is an extension of the ReAct loop with a scoped tool set. It's not a separate system — it's the same system with constraints applied.

7. **Non-determinism is acceptable** — for a family voice assistant, slight variation in how the morning briefing is composed is fine. This isn't a financial trading system.

### Hybrid optimization (for later)

If cost/latency becomes an issue, **specific high-frequency skills can be optimized** with a deterministic fast path:

```typescript
// Skill frontmatter extension:
// fast-path: true
// → Gateway executes tool calls directly without LLM, only uses LLM for the final compose step

// This is Approach A with a per-skill Approach B optimization — not a different architecture
```

This keeps Approach A as the default and allows specific skills to opt into deterministic execution. But this is an optimization, not a starting architecture.

## Recommendation

**Approach A: Markdown with YAML Frontmatter (LLM-Interpreted)** is the strongest choice for the initial architecture.

**Rationale:**

1. **Simplest architecture** — the skill "engine" is the LLM. No step parser, no DAG executor, no variable resolver, no condition evaluator. The implementation is a scoped ReAct loop.

2. **Strongest sandboxing** — enforced at the tool-call level in the ReAct loop. The LLM cannot hallucinate access to undeclared tools because the tool schemas aren't in its context.

3. **Most maintainable** — adding a new skill = writing a markdown file and dropping it in the skills directory. Hot-reload picks it up. No TypeScript compilation, no YAML step schema.

4. **Proven pattern** — Claude Code's SKILL.md format works at production scale. The voice gateway skill format is a direct adaptation.

5. **Cost is acceptable** — ~$6-15/month for skill execution is within the personal project budget, especially given the flexibility and simplicity gains.

6. **Composition and cycle detection are well-defined** — frontmatter `compose` field declares allowed compositions, topological sort detects cycles at load time, depth limit prevents runaway recursion.

**Key implementation decisions:**
- Skill format: Markdown with YAML frontmatter (name, description, allowed-tools, parameters, roles, compose)
- Execution: Scoped ReAct loop — skill body injected as system prompt, only declared tools available
- Sandboxing: Tool scope enforced in ReAct loop's `executeSingleTool` function
- Hot-reload: File watcher on `skills/` directory → parse → validate → register (atomic)
- Cycle detection: Topological sort on composition graph after every reload
- Composition depth limit: 3 levels maximum
- Validation: frontmatter schema + tool existence + cycle check at load time
- Integration: Each skill registered as individual tool in tool registry (per classifier exploration)
- Guest skills: role-filtered at both skill level and tool level

## Open Questions

- Should skill parameters support complex types (arrays, objects) or just primitives?
- How should skill execution timeouts work? Per-skill configurable timeout, or global?
- Should skills have version fields for tracking changes over time?
- How to handle a skill's allowed-tool being unregistered (tool removed but skill still references it)?
- Should there be a "dry-run" mode for testing skills without executing tools?
- How much of the skill body should be included in the tool description for the classifier? Full body is too long; description alone may be insufficient for complex skills.
- Should skills have access to conversation history, or only the current transcript + parameters?
- How to surface skill execution progress to the user in real-time (e.g., "Getting your weather...")?
