# Classifier & Tool Routing

## Decision Area
Intent classification after STT and tool dispatch via ReAct loop.

## Key Questions
- Hybrid classifier design: regex fast-path (<5ms) + LLM fallback (<400ms)?
- What regex patterns reliably catch tool intents? What falls through to LLM?
- ReAct loop: max 5 iterations, how to handle tool failures mid-loop?
- Tool registry format: JSON schema? TypeScript interfaces? Auto-discovery?
- Impact tiers per tool: how does the classifier know which tier?
- Classifier → skill system interaction: how are skill triggers distinguished from tool triggers?
- ~70% of queries are direct LLM (no tools) — classifier must be fast for the common case

## Prior Research
- Python iteration explored hybrid regex + LLM classifier with ReAct loop
- ReAct paper (Yao et al. 2022): Thought-Action-Observation loop — reasoning traces interleaved with actions
- Martin Fowler function-calling architecture: declaration, dispatch loop, explicit routing (not dynamic invocation) for security
- OpenRouter tool calling: standard OpenAI-compatible `tools` array, `tool_calls` response, iterative loop until no more tool calls
- 98x faster LLM routing paper: prompt compression to ~512 tokens achieves ~19ms classifier latency — but requires a trained model, overkill for family scale

## Approaches

### Approach A: Hybrid Regex Fast-Path + LLM Classification

**Description:** A two-tier classifier. Tier 1 is a set of regex/keyword patterns that instantly identify obvious tool intents or confirm conversational queries. Tier 2 is an LLM call (via OpenRouter) that classifies ambiguous inputs. The LLM-based classifier uses structured output (JSON) to return intent + confidence + extracted parameters.

**Architecture:**
```
STT transcript
      ↓
┌─────────────────────────────┐
│  Tier 1: Regex/Keyword      │  <1ms
│  ─────────────────────────  │
│  MATCH → tool/skill intent  │──→ Tool Router
│  NEGATIVE → conversational  │──→ Direct LLM
│  AMBIGUOUS → fall through   │
└─────────────┬───────────────┘
              ↓
┌─────────────────────────────┐
│  Tier 2: LLM Classification │  200-500ms
│  ─────────────────────────  │
│  Structured output:         │
│  { intent, confidence,      │
│    tool_or_skill, params }  │
└─────────────┬───────────────┘
              ↓
         Tool Router / Direct LLM
```

**Tier 1 regex patterns — what works reliably:**

```typescript
interface ClassifierResult {
  intent: "tool" | "skill" | "conversation";
  confidence: number;       // 0-1
  target?: string;          // tool or skill name
  params?: Record<string, unknown>;
}

// POSITIVE matches (→ tool/skill)
const TOOL_TRIGGERS: Array<{ pattern: RegExp; tool: string; extract?: (m: RegExpMatchArray) => Record<string, unknown> }> = [
  // Time/date — always a tool call
  { pattern: /\b(?:what(?:'s| is) the (?:time|date)|what time is it)\b/i, tool: "clock" },
  // Weather — always a tool call
  { pattern: /\b(?:weather|temperature|forecast)\b.*\b(?:today|tomorrow|this week|outside)\b/i, tool: "weather" },
  // Timers and reminders — explicit action verbs
  { pattern: /\b(?:set|start|create)\s+(?:a\s+)?(?:timer|alarm|reminder)\b/i, tool: "timer",
    extract: (m) => ({ raw: m[0] }) },
  // Smart home — explicit device commands
  { pattern: /\b(?:turn|switch|dim|set)\s+(?:on|off|up|down)?\s*(?:the\s+)?(?:lights?|lamp|fan|thermostat|AC)\b/i, tool: "home_control" },
  // Music/media — play commands
  { pattern: /\b(?:play|pause|stop|skip|next|previous)\s+(?:the\s+)?(?:music|song|playlist|album)\b/i, tool: "media_control" },
  // Shopping list
  { pattern: /\b(?:add|put)\b.+\b(?:to|on)\s+(?:the\s+)?(?:shopping|grocery)\s+list\b/i, tool: "shopping_list" },
  // Skill invocation — explicit "run/execute/do the X"
  { pattern: /\b(?:run|execute|do)\s+(?:the\s+)?(\w[\w\s-]+?)\s+(?:skill|routine|workflow)\b/i, tool: "skill",
    extract: (m) => ({ skillName: m[1].trim() }) },
];

// NEGATIVE matches (→ definitely conversational, skip LLM classifier)
const CONVERSATION_SIGNALS = [
  /^(?:hi|hello|hey|good (?:morning|afternoon|evening)|thanks?|thank you|bye|goodbye)\b/i,
  /\b(?:what do you think|tell me about|explain|who (?:is|was)|what (?:is|are)|how does|why (?:is|do))\b/i,
  /\b(?:can you help|I (?:need|want) (?:help|advice)|what should I)\b/i,
];

function classifyTier1(transcript: string): ClassifierResult | "ambiguous" {
  // Check positive tool triggers
  for (const trigger of TOOL_TRIGGERS) {
    const match = transcript.match(trigger.pattern);
    if (match) {
      return {
        intent: trigger.tool === "skill" ? "skill" : "tool",
        confidence: 0.95,
        target: trigger.tool,
        params: trigger.extract?.(match),
      };
    }
  }

  // Check negative conversational signals
  for (const signal of CONVERSATION_SIGNALS) {
    if (signal.test(transcript)) {
      return { intent: "conversation", confidence: 0.9 };
    }
  }

  return "ambiguous";
}
```

**What falls through to LLM (~15-25% of queries):**
- Implicit tool intents: "I'm cold" (→ thermostat?), "it's dark in here" (→ lights?)
- Multi-intent: "turn off the lights and tell me a bedtime story" (→ tool + conversation)
- Ambiguous phrasing: "what's the weather like for a picnic tomorrow?" (tool + opinion)
- Context-dependent: "add eggs" (shopping list? cooking step? depends on conversation history)
- Skill triggers by description rather than name: "do the morning routine thing"

**Tier 2 LLM classifier prompt:**

```typescript
const CLASSIFIER_SYSTEM_PROMPT = `You are an intent classifier for a family voice assistant.
Classify the user's transcript into one of:
- "conversation": general chat, questions, advice (no tool or skill needed)
- "tool": requires calling a specific tool (time, weather, timer, home control, etc.)
- "skill": requires running a multi-step skill/workflow

Respond with JSON only:
{
  "intent": "conversation" | "tool" | "skill",
  "confidence": 0.0-1.0,
  "target": "tool_name or skill_name (null if conversation)",
  "params": { extracted parameters },
  "reasoning": "one sentence why"
}

Available tools: ${toolRegistry.listNames().join(", ")}
Available skills: ${skillRegistry.listNames().join(", ")}`;

async function classifyTier2(
  transcript: string,
  conversationHistory: Message[],
  toolRegistry: ToolRegistry,
  skillRegistry: SkillRegistry,
): Promise<ClassifierResult> {
  const response = await openrouter.chat({
    model: "anthropic/claude-haiku-4-5-20251001", // Fastest, cheapest model for classification
    messages: [
      { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
      // Last 2-3 turns for context (keeps prompt small → fast)
      ...conversationHistory.slice(-3),
      { role: "user", content: transcript },
    ],
    response_format: { type: "json_object" },
    max_tokens: 150,
    temperature: 0,
  });
  return parseClassifierResponse(response);
}
```

**Model choice for Tier 2:** Claude Haiku 4.5 via OpenRouter — $0.80/$4.00 per 1M tokens. At ~200 tokens/classification, cost is ~$0.0002/call. Even at 50 ambiguous classifications/day = $0.01/day ≈ $0.30/month. Negligible.

**Latency budget:**
- Tier 1 regex: <1ms (measured — regex on short transcripts is instant)
- Tier 2 LLM: 200-500ms (Haiku is fast, small prompt, JSON output)
- Expected split: ~65% conversation (Tier 1), ~10% tool (Tier 1), ~25% ambiguous (Tier 2)
- Weighted average: 0.75 × 1ms + 0.25 × 350ms = **~88ms average**

**Pros:**
- **Sub-millisecond for 75% of requests** — conversation and obvious tools resolved instantly
- **Cost-effective** — LLM only called for ambiguous ~25%, using cheapest model
- **Extensible** — new regex patterns for new tools, LLM handles edge cases naturally
- **Context-aware** — Tier 2 LLM sees conversation history for context-dependent intents
- **Type-safe** — Zod schema validates LLM output, structured response format
- **No training data needed** — regex is hand-authored, LLM generalizes from prompt
- **Graceful degradation** — if LLM classifier fails, default to conversation (safe fallback)

**Cons:**
- **Regex maintenance burden** — patterns accumulate, overlap, and become brittle over time
- **False negatives in Tier 1** — novel phrasings of tool intents fall through to slower Tier 2
- **200-500ms penalty for ambiguous queries** — noticeable in voice conversation flow
- **Two code paths** — regex logic + LLM prompt, both must stay in sync with tool/skill registry
- **Regex can't handle multi-intent** — "turn off lights and play music" needs LLM
- **Language-dependent** — regex patterns are English-specific; multilingual needs LLM

**Risk factors:**
- Regex false positives: "Can you explain how weather forecasting works?" matches weather tool
- LLM hallucinating tool names not in the registry
- Maintaining regex/LLM sync as tools are added/removed

---

### Approach B: LLM-Only Classification

**Description:** Every transcript goes through an LLM classifier. No regex tier. Uses the cheapest/fastest model (Haiku) with structured output. Simpler architecture, consistent latency.

**Architecture:**
```
STT transcript
      ↓
┌─────────────────────────────┐
│  LLM Classification         │  200-500ms (every request)
│  ─────────────────────────  │
│  System prompt with tools   │
│  + skill registry           │
│  + last 2-3 turns context   │
│  → Structured JSON output   │
└─────────────┬───────────────┘
              ↓
         Tool Router / Direct LLM
```

**Classifier is the same Tier 2 from Approach A**, but runs on every request.

**Latency:** 200-500ms on every request. For a voice assistant, this adds perceptible delay.

**Cost:** ~200 tokens/call × $0.80/1M = $0.00016/call. At 200 queries/day = $0.032/day ≈ $1/month. Still negligible.

**Optimization — streaming classification:**
Could start LLM response generation speculatively while classifier runs, but this wastes tokens if tools are needed (must discard speculative response). Not worth the complexity.

**Optimization — parallel classification + response:**
```typescript
// Fire classifier and begin response generation in parallel
const [classification, speculativeResponse] = await Promise.allSettled([
  classifyWithLLM(transcript, history),
  generateResponse(transcript, history), // speculative
]);

if (classification.intent === "conversation") {
  // Use the speculative response (already started!)
  return speculativeResponse;
} else {
  // Discard speculative response, route to tools
  return routeToTools(classification);
}
```
This cuts perceived latency for the 70% conversation case but doubles LLM cost. At family scale, cost is still under $2/month — could be worth it.

**Pros:**
- **Simplest architecture** — one classification path, no regex maintenance
- **Handles all edge cases** — implicit intents, multi-intent, context-dependent, multilingual
- **Naturally evolves** — as models improve, classification improves without code changes
- **Always context-aware** — sees conversation history on every call
- **No false positives from brittle regex** — LLM understands nuance

**Cons:**
- **200-500ms latency on EVERY request** — including "hi" and "what time is it"
- **Network dependency for classification** — if OpenRouter is down, can't even classify
- **Overkill for obvious intents** — paying LLM to classify "set a timer for 5 minutes"
- **Slightly higher cost** (~$1/mo vs ~$0.30/mo) — trivial but wasteful
- **No offline capability** — classification requires internet (couples with STT cloud dependency)

**Risk factors:**
- OpenRouter latency spikes (cold starts, rate limits) add unpredictable delay
- Model changes on OpenRouter could alter classification behavior
- Double LLM cost if using parallel speculative approach

---

### Approach C: Tool-Calling-As-Classification (No Separate Classifier)

**Description:** Skip the classifier entirely. Send every transcript directly to the main LLM with tools declared. The LLM decides whether to call tools or respond directly — tool calling IS the classification. This is how most production LLM agents work (ChatGPT, Claude, etc.).

**Architecture:**
```
STT transcript
      ↓
┌─────────────────────────────┐
│  Main LLM (Sonnet/Opus)     │  500-2000ms
│  ─────────────────────────  │
│  System: persona + memory   │
│  Tools: all registered tools│
│  + conversation history     │
│  → Response OR tool_calls   │
└─────────────┬───────────────┘
              ↓
    ┌─────────┴──────────┐
    │                    │
  text response     tool_calls
    ↓                    ↓
   TTS              Execute tools
                         ↓
                    Feed results back
                    to LLM (ReAct loop)
```

**This eliminates the classifier entirely.** The main LLM (Sonnet 4.6 via OpenRouter at $3/$15 per 1M tokens) receives the full context (persona, memory, history, tools) and decides whether to respond or call tools.

**Implementation:**
```typescript
async function processTranscript(
  transcript: string,
  session: Session,
): Promise<void> {
  const messages = buildContext(session); // persona + memory + history
  messages.push({ role: "user", content: transcript });

  const tools = toolRegistry.getToolSchemas(session.role); // role-filtered
  let iterations = 0;

  while (iterations < MAX_REACT_ITERATIONS) {
    const response = await openrouter.chat({
      model: "anthropic/claude-sonnet-4-6",
      messages,
      tools: tools.length > 0 ? tools : undefined,
      stream: true,
    });

    if (response.tool_calls) {
      // Execute tools, add results to messages
      const results = await executeToolCalls(response.tool_calls, session);
      messages.push({ role: "assistant", content: null, tool_calls: response.tool_calls });
      for (const result of results) {
        messages.push({ role: "tool", tool_call_id: result.id, content: result.output });
      }
      iterations++;
    } else {
      // No tool calls — stream text response to TTS
      await streamToTTS(response, session);
      break;
    }
  }

  if (iterations >= MAX_REACT_ITERATIONS) {
    await streamToTTS("I wasn't able to complete that action. Can you try rephrasing?", session);
  }
}
```

**Latency analysis:**
- Conversation (no tools): 500-1500ms for first token (Sonnet, full context) → but TTS streaming starts on first sentence
- Tool call: 500-1500ms classification + tool execution + 500-1500ms response = 1-3s total
- No separate classifier overhead — classification is free within the main LLM call

**Cost analysis:**
- Every request uses Sonnet ($3/$15 per 1M tokens) instead of Haiku ($0.80/$4)
- Average input: ~1500 tokens (persona 500 + memory 300 + history 500 + transcript 50 + tools 150)
- Average output: ~200 tokens
- Per request: ~$0.0075 input + ~$0.003 output = ~$0.01
- 200 queries/day = $2/day = **~$60/month** ← significantly more expensive
- But if using Sonnet for response generation anyway, the classification is essentially free

**Key insight:** If the main response LLM is Sonnet anyway, then a separate Haiku classifier saves nothing — the Sonnet call happens regardless. The classifier only saves money if it can **skip the Sonnet call entirely for conversation** and use a cheaper model. But a separate "conversation response" model would be a different quality tier — user would notice.

**Actually: the classifier IS useful** because it allows:
1. Conversation → Haiku/Sonnet for response (no tools in prompt = smaller context = faster)
2. Tool intent → Sonnet with tools (full context)
This saves ~200ms and reduces cost by routing simple conversations to a lighter path.

**Pros:**
- **Simplest possible architecture** — no classifier at all, tool calling is built-in
- **Best classification accuracy** — main LLM with full context makes the best tool decisions
- **No sync issues** — tool registry is the single source of truth
- **Handles multi-intent naturally** — LLM can call multiple tools and compose a response
- **Standard pattern** — how ChatGPT, Claude, and every production agent works
- **Streaming works naturally** — first token starts generating immediately

**Cons:**
- **Slowest first-token for conversation** — 500-1500ms even for "hi" (full context loaded)
- **Most expensive** — ~$60/month if every request hits Sonnet with full context
- **Tools always in context** — wastes tokens on tool schemas for pure conversation (~70%)
- **No fast path** — trivial queries get the same heavy treatment as complex ones
- **Harder to optimize** — can't route simple queries to a cheaper/faster model

**Risk factors:**
- Cost scales linearly with usage — heavy day costs more
- Latency variability from OpenRouter (model cold starts, queue depth)
- Full context on every call means persona+memory+tools compete for context budget

---

## Tool Router & ReAct Loop Design

Regardless of classifier approach, the tool routing layer is the same. Based on OpenRouter's tool calling API and the ReAct pattern:

### Tool Registry

```typescript
// Tool impact tiers (from security-guest-mode)
type ImpactTier = "read" | "write" | "confirm" | "admin";

// Tool roles that can access
type Role = "adult" | "child" | "guest";

interface ToolDefinition {
  name: string;
  description: string;            // For LLM tool schema
  parameters: JSONSchema;         // JSON Schema for params
  impactTier: ImpactTier;
  allowedRoles: Role[];
  handler: (params: unknown, session: Session) => Promise<ToolResult>;
}

interface ToolResult {
  success: boolean;
  output: string;               // Returned to LLM as tool result
  sideEffects?: string[];       // For audit log
}

class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  // Auto-discovery from tools/ directory
  async loadFromDirectory(dir: string): Promise<void> {
    // Each file exports a ToolDefinition
    for (const file of await readdir(dir)) {
      const mod = await import(join(dir, file));
      this.register(mod.default as ToolDefinition);
    }
  }

  // Get tool schemas filtered by user role
  getToolSchemas(role: Role): OpenAIToolSchema[] {
    return [...this.tools.values()]
      .filter(t => t.allowedRoles.includes(role))
      .map(t => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
  }

  // Get tool by name, verify role access
  getTool(name: string, role: Role): ToolDefinition | null {
    const tool = this.tools.get(name);
    if (!tool || !tool.allowedRoles.includes(role)) return null;
    return tool;
  }

  listNames(): string[] {
    return [...this.tools.keys()];
  }
}
```

### ReAct Loop Implementation

```typescript
const MAX_REACT_ITERATIONS = 5;

interface ReActContext {
  session: Session;
  messages: Message[];
  toolRegistry: ToolRegistry;
  skillEngine: SkillEngine;
  abortSignal: AbortSignal;       // Barge-in cancel
}

async function executeReActLoop(ctx: ReActContext): Promise<string> {
  let iterations = 0;

  while (iterations < MAX_REACT_ITERATIONS) {
    // Check barge-in cancellation
    if (ctx.abortSignal.aborted) {
      throw new Error("cancelled");
    }

    const response = await openrouter.chat({
      model: "anthropic/claude-sonnet-4-6",
      messages: ctx.messages,
      tools: ctx.toolRegistry.getToolSchemas(ctx.session.role),
      stream: false,  // Non-streaming within ReAct loop (need full tool_calls)
    });

    const choice = response.choices[0].message;

    if (!choice.tool_calls || choice.tool_calls.length === 0) {
      // LLM decided it has enough info — return final text
      return choice.content ?? "";
    }

    // Process tool calls (potentially parallel)
    ctx.messages.push({
      role: "assistant",
      content: choice.content,
      tool_calls: choice.tool_calls,
    });

    const results = await Promise.allSettled(
      choice.tool_calls.map(tc => executeSingleTool(tc, ctx))
    );

    for (let i = 0; i < choice.tool_calls.length; i++) {
      const tc = choice.tool_calls[i];
      const result = results[i];
      ctx.messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result.status === "fulfilled"
          ? result.value.output
          : `Error: ${(result as PromiseRejectedResult).reason.message}`,
      });
    }

    iterations++;
  }

  // Max iterations reached
  return "I wasn't able to complete that action after several attempts.";
}

async function executeSingleTool(
  toolCall: ToolCall,
  ctx: ReActContext,
): Promise<ToolResult> {
  const { name, arguments: argsJson } = toolCall.function;
  const args = JSON.parse(argsJson);

  // Check if it's a skill invocation
  if (name === "run_skill") {
    return ctx.skillEngine.execute(args.skillName, args.params, ctx.session);
  }

  const tool = ctx.toolRegistry.getTool(name, ctx.session.role);
  if (!tool) {
    return { success: false, output: `Tool '${name}' not found or not authorized for your role.` };
  }

  // Impact tier check — confirm tier requires user approval
  if (tool.impactTier === "confirm") {
    const approved = await requestUserConfirmation(ctx.session, name, args);
    if (!approved) {
      return { success: false, output: `User declined to authorize '${name}'.` };
    }
  }

  // Admin tier — only adults
  if (tool.impactTier === "admin" && ctx.session.role !== "adult") {
    return { success: false, output: `Tool '${name}' requires adult authorization.` };
  }

  // Execute with timeout
  const result = await Promise.race([
    tool.handler(args, ctx.session),
    timeout(10_000).then(() => ({
      success: false,
      output: `Tool '${name}' timed out after 10 seconds.`,
    })),
  ]);

  // Audit log
  auditLog.record({
    user: ctx.session.userId,
    tool: name,
    args,
    result: result.success ? "success" : "failure",
    timestamp: Date.now(),
  });

  return result;
}
```

### Tool Failure Handling in ReAct Loop

| Failure mode | Handling | Rationale |
|---|---|---|
| Tool not found | Return error string to LLM | LLM can suggest alternative or inform user |
| Tool timeout (10s) | Return timeout error to LLM | LLM can retry or apologize |
| Tool throws exception | Catch, return error string | Don't crash the loop |
| User declines confirm | Return declined message to LLM | LLM explains to user |
| Role unauthorized | Return auth error to LLM | LLM can explain the restriction |
| Max iterations (5) | Return fallback message | Prevent infinite loops |
| Barge-in (AbortSignal) | Throw, cancel entire loop | User interrupted — stop everything |

### Skill vs Tool Distinction

Skills and tools are surfaced to the LLM identically — both as tools. A skill is exposed as a meta-tool called `run_skill`:

```typescript
const RUN_SKILL_TOOL: ToolDefinition = {
  name: "run_skill",
  description: "Execute a multi-step skill/workflow. Available skills: " +
    skillRegistry.listNames().join(", "),
  parameters: {
    type: "object",
    properties: {
      skillName: { type: "string", description: "Name of the skill to run" },
      params: { type: "object", description: "Parameters for the skill" },
    },
    required: ["skillName"],
  },
  impactTier: "read", // Skill's own tools determine actual impact
  allowedRoles: ["adult", "child", "guest"], // Skill access is role-filtered internally
  handler: async (params, session) => skillEngine.execute(params.skillName, params.params, session),
};
```

Alternatively, each skill could be registered as its own tool (one entry per skill). This gives the LLM more direct information:

```typescript
// Option B: Each skill as its own tool
for (const skill of skillRegistry.getAll()) {
  toolRegistry.register({
    name: `skill_${skill.name}`,
    description: skill.description,
    parameters: skill.parameterSchema,
    impactTier: skill.maxImpactTier,
    allowedRoles: skill.allowedRoles,
    handler: async (params, session) => skillEngine.execute(skill.name, params, session),
  });
}
```

**Recommendation: Option B (individual skill tools).** Each skill gets its own tool entry with specific description and parameters. The LLM can make more informed decisions about which skill to invoke. The `run_skill` meta-tool forces the LLM to know skill names, which is less natural.

---

## Classifier → Tool Router → Response Pipeline

The full pipeline, combining classifier with ReAct loop and streaming response:

```
┌──────────────────────────────────────────────────────────────┐
│                    INTELLIGENCE PIPELINE                     │
│                                                              │
│  transcript ──→ Tier 1 Regex ──→ MATCH: tool/skill intent   │
│                      │                    │                  │
│                      │ AMBIGUOUS          │                  │
│                      ↓                    │                  │
│               Tier 2 LLM ────→ tool/skill │                  │
│                      │              │     │                  │
│                      │ conversation │     │                  │
│                      ↓              ↓     ↓                  │
│              ┌───────────┐   ┌──────────────┐                │
│              │ Direct LLM│   │  ReAct Loop  │                │
│              │ (stream)  │   │  (max 5 iter)│                │
│              │           │   │  ┌─────────┐ │                │
│              │ persona+  │   │  │ LLM call│ │                │
│              │ memory+   │   │  │ ↓       │ │                │
│              │ history   │   │  │ tool/   │ │                │
│              │           │   │  │ skill   │ │                │
│              │           │   │  │ exec    │ │                │
│              │           │   │  │ ↓       │ │                │
│              │           │   │  │ result  │ │                │
│              │           │   │  │ → LLM   │ │                │
│              │           │   │  └─────────┘ │                │
│              └─────┬─────┘   └──────┬───────┘                │
│                    │                │                         │
│                    ↓                ↓                         │
│              Text response (streamed)                        │
│                    │                                         │
│                    ↓                                         │
│              Sentence splitter → TTS (streaming overlap)     │
└──────────────────────────────────────────────────────────────┘
```

### Streaming Overlap Strategy

For **conversation** responses (70%): Stream LLM output, split on sentence boundaries, start TTS on first complete sentence while LLM continues generating. This is the critical latency optimization.

For **tool** responses (30%): The ReAct loop runs non-streaming (needs complete tool_calls). After all tool iterations complete, the final LLM response IS streamed to TTS with the same sentence-boundary overlap.

```typescript
async function handleClassified(
  classification: ClassifierResult,
  transcript: string,
  session: Session,
): Promise<void> {
  if (classification.intent === "conversation") {
    // Fast path: stream directly with sentence-boundary TTS overlap
    const context = buildContext(session); // persona + memory + history
    context.push({ role: "user", content: transcript });

    const stream = await openrouter.chat({
      model: selectModel(session), // Could use cheaper model for simple chat
      messages: context,
      stream: true,
      // No tools — conversation path has no tool schemas (faster, cheaper)
    });

    await streamWithTTSOverlap(stream, session);
  } else {
    // Tool/skill path: ReAct loop then stream final response
    const context = buildContext(session);
    context.push({ role: "user", content: transcript });

    const finalText = await executeReActLoop({
      session,
      messages: context,
      toolRegistry,
      skillEngine,
      abortSignal: session.abortController.signal,
    });

    // Stream the final response text to TTS
    await streamTextToTTS(finalText, session);
  }
}
```

---

## Analysis

### Classifier approach comparison

| Dimension | A: Hybrid Regex+LLM | B: LLM-Only | C: No Classifier |
|---|---|---|---|
| Latency (conversation, 70%) | <1ms | 200-500ms | 500-1500ms |
| Latency (tool, obvious) | <1ms | 200-500ms | 500-1500ms |
| Latency (ambiguous, ~25%) | 200-500ms | 200-500ms | 500-1500ms |
| Monthly cost (classifier) | ~$0.30 | ~$1.00 | $0 (bundled) |
| Monthly cost (total LLM) | Varies by response model | Same | ~$60 |
| Classification accuracy | Good (regex) + Great (LLM) | Great | Best (full context) |
| Multi-intent handling | LLM only (Tier 2) | Yes | Yes |
| Context-awareness | Tier 2 only | Yes | Yes |
| Architecture complexity | Medium-High | Low | Lowest |
| Regex maintenance | Yes (ongoing) | None | None |
| Offline classification | Tier 1 only | No | No |
| Conversation model flexibility | Can use cheaper model | Can use cheaper model | Locked to one model |

### Why the classifier matters for this project

The classifier isn't just about classification accuracy — it enables **model routing**:

1. **Conversation (70%):** Can use a cheaper/faster model (Haiku at $0.80/$4) since no tools needed
2. **Tool intents (30%):** Must use a capable model (Sonnet at $3/$15) for tool calling
3. **Without classifier:** Every request uses Sonnet with full tool context = ~$60/month
4. **With classifier:** ~$15-20/month (70% Haiku + 30% Sonnet)

The classifier saves **$40+/month** by enabling model routing. This is the real value, not the <1ms regex speed.

### ReAct loop design: settled

The ReAct loop design is standard and approach-independent:
- OpenRouter tool_calls API (OpenAI-compatible format)
- Max 5 iterations with AbortSignal cancel
- Parallel tool execution within a single iteration
- Error strings fed back to LLM (not thrown)
- Tool results in conversation history for multi-step reasoning
- Impact tier enforcement before execution
- Audit logging on every tool execution

### Tool registry: settled

- TypeScript `ToolDefinition` interface with JSON Schema parameters
- Auto-discovery from `tools/` directory (each file exports default ToolDefinition)
- Role-filtered tool schemas (guests see fewer tools)
- Impact tiers: read (auto), write (auto), confirm (user approval), admin (adult-only)
- Skills registered as individual tools (one per skill, not meta-tool)

## Recommendation

**Approach A: Hybrid Regex Fast-Path + LLM Classification** is the strongest choice.

**Rationale:**

1. **Model routing is the killer feature.** The classifier enables sending 70% of requests to a cheaper/faster model, saving ~$40/month and reducing latency. This alone justifies the classifier's existence.

2. **Sub-millisecond fast path for obvious intents.** "What time is it?" and "hi there" shouldn't wait 200-500ms for classification. The regex tier handles these instantly.

3. **LLM fallback handles edge cases.** Implicit intents, multi-intent, context-dependent queries — the 25% that needs LLM classification gets it. Haiku at $0.30/month is negligible.

4. **Regex maintenance is bounded.** This is a family assistant with ~15-20 tools, not a general-purpose platform. The regex patterns are stable once authored. New tools = new patterns, but the tool set changes slowly.

5. **Graceful degradation.** If OpenRouter is down: Tier 1 regex still works for obvious tool intents, conversation falls back to cached/offline mode. Approach B and C are completely dead without internet.

6. **Approach C (no classifier) is architecturally clean but expensive.** $60/month for a personal project is significant. The ~$20/month with model routing is much more aligned with the cost-conscious constraint.

**Key implementation decisions:**
- Tier 1: ~15 regex patterns for known tools + ~5 negative patterns for conversation
- Tier 2: Claude Haiku 4.5 via OpenRouter, structured JSON output, max 150 tokens
- Ambiguous default: conversation (safe — user can rephrase if they wanted a tool)
- ReAct loop: max 5 iterations, AbortSignal, parallel tool execution
- Tool registry: TypeScript auto-discovery from `tools/` directory
- Skills: registered as individual tools in the tool registry
- Model routing: conversation → Haiku/Sonnet-mini, tool intents → Sonnet

## PoC: Regex Validation Results

**Source:** `poc/classifier-regex-validation/`

### Test Corpus
- 78 test cases: 42 true positives, 11 true negatives, 16 false positive traps, 9 ambiguous
- Covers all 15 TOOL_TRIGGERS across clock, weather, timer, home_control, media_control, shopping_list, skill, calendar, notes, volume

### Results
- **Pass rate: 78/78 (100%)**
- **True positives: 42/42 (100%)** — all tool intents correctly identified
- **False positive traps: 16/16 (0% FP rate)** — zero conversational transcripts matched a tool
- **Ambiguous fallthrough: 17/17 (100%)** — implicit/vague intents correctly fall to Tier 2

### Weather Regex Bug — FIXED
- **Old regex:** `/\b(?:weather|temperature|forecast)\b.*\b(?:today|tomorrow|this week|outside)\b/i`
- **Bug:** Matched "I'm studying weather and climate for my class today" as weather tool (false positive)
- **New regex:** `/\b(?:what(?:'s| is) the |how(?:'s| is) the |check(?: the)? |get(?: the)? )(?:weather|temperature|forecast)\b/i`
- **Fix:** Requires question/check framing verb before weather keyword, not just co-occurrence with time word
- Added second pattern for bare "weather tomorrow" standalone queries: `/^(?:weather|temperature|forecast)\s+(?:today|tomorrow|this week|outside|in \w+)\b/i`

### Additional Regex Fixes
- **Timer:** Changed `(?:a\s+)?` to `(?:a\s+|an\s+)?` — was missing "create an alarm"
- **Multi-intent limitation confirmed:** "turn off the lights and tell me a bedtime story" matches first tool (home_control). This is a known Tier 1 limitation — Tier 2 LLM needed for multi-intent splitting

### Latency
- **0.37μs per classification** (50,000 calls in 18.7ms on Bun)
- Confirms sub-millisecond target by 3 orders of magnitude
- 15 regex patterns with extraction have negligible cost

### Key Findings
1. Regex patterns are highly effective for explicit tool intents — 100% TP rate with 0% FP rate
2. The "ambiguous" bucket works correctly — implicit intents ("I'm cold"), context-dependent queries ("add eggs"), and multi-intent all fall through to Tier 2
3. CONVERSATION_SIGNALS catch greetings and knowledge questions, but many conversational transcripts go to "ambiguous" — this is safe since Tier 2 LLM handles them correctly
4. The weather regex rewrite is the most impactful change — pattern now requires explicit question framing
5. Multi-intent is a hard Tier 1 limitation — regex matches first tool, can't split intents

## Open Questions

- Should Tier 1 regex patterns be loaded from a config file (YAML) for easier editing, or hardcoded in TypeScript?
- Exact model selection for conversation vs tool paths — Haiku for chat, Sonnet for tools? Or Sonnet-mini?
- How to handle classifier disagreement (Tier 1 says tool, conversation history suggests otherwise)?
- Should the classifier output be cached for identical/similar transcripts?
- Multi-intent splitting: "turn off lights and tell me a story" — should Tier 2 return multiple intents?
- How does the classifier interact with barge-in? If user interrupts during tool execution, does new transcript go through classifier or auto-cancel?
