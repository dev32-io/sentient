# Classifier-First Tool Routing

## Decision Area
How the gateway determines whether a user request needs tool execution, and how the agent loop operates when tools are needed.

## Key Questions
1. **Classifier implementation**: Small/cheap LLM prompt? Local regex/keyword? Fine-tuned model? Hybrid?
2. **Agent loop pattern**: ReAct (think -> act -> observe) vs Plan-and-Execute for multi-step tool use
3. **Tool registration**: How tools declare themselves -- name, description, parameters, impact tier
4. **Extensibility**: Adding a new tool should be "drop a file, restart" simple
5. **Result integration**: How tool results feed back into the LLM for final response
6. **Latency budget**: Classifier ~200-400ms overhead, agent loop ~500ms-1s per tool call
7. **Security integration**: Classifier must respect tool impact tiers (auto vs confirm)

---

## Workload Profile

Understanding the request distribution is critical for choosing the right classifier approach:

| Request Type | % of Traffic | Tools Needed? | Example |
|-------------|-------------|---------------|---------|
| Casual conversation | ~40% | No | "Tell me a joke", "How are you?" |
| Knowledge questions | ~30% | No | "What's the capital of France?", "Explain photosynthesis" |
| Simple tool calls | ~20% | Yes (single-step) | "Turn on the lights", "What's the weather?" |
| Multi-step tool calls | ~8% | Yes (2-3 steps) | "Check my calendar and set a reminder", "Search the web and summarize" |
| Complex orchestration | ~2% | Yes (3+ steps) | "Plan a dinner party: check calendar, find recipes, add to shopping list" |

**Implication**: ~70% of requests need no tools at all. The classifier's primary job is to fast-path these to a direct LLM response, saving 500ms-1s of agent loop overhead. For the ~20% that need a single tool call, the agent loop is one iteration. Only ~10% need multiple iterations.

---

## Classifier Design

### Approach A: LLM-Based Classifier (Cheap Model via OpenRouter)

Send a short prompt to a fast/cheap model that returns a structured routing decision.

**Classifier prompt** (~200 tokens including tool descriptions):

```
You are a request router. Given the user's message and the available tools below, respond with JSON:
{"needs_tools": true/false, "tool_hints": ["tool_name", ...]}

Available tools:
- lights: Control smart home lights (on/off, brightness, color)
- weather: Get current weather and forecast
- calendar: Read/write calendar events
- web_search: Search the web for information
- send_message: Send a message to a family member
- timer: Set timers and alarms

User message: "{user_input}"
```

**Model candidates (via OpenRouter):**

| Model | Input Cost | Output Cost | TTFT | Quality for Classification |
|-------|-----------|-------------|------|---------------------------|
| Gemini 2.0 Flash Lite | $0.075/1M | $0.30/1M | ~150-300ms | Good -- sufficient for binary/few-class |
| Mistral Small 3.2 (24B) | $0.10/1M | $0.30/1M | ~250-400ms | Very good -- reliable structured output |
| DeepSeek V3 | $0.27/1M | $1.10/1M | ~600-900ms | Excellent -- but too slow for classifier |
| Llama 3.x 8B (free tier) | ~$0.00 | ~$0.00 | ~200-400ms | Adequate for well-prompted binary |

**Cost at ~100 requests/day:**
- Classifier prompt: ~200 input tokens + ~30 output tokens per request
- Gemini Flash Lite: 200 * 100 * 30 / 1M * $0.075 = ~$0.00045/day = **<$0.02/month**
- Cost is negligible regardless of model choice -- optimize for latency

**Recommended classifier model**: Gemini 2.0 Flash Lite -- cheapest, fastest, sufficient quality for this task.

**Pros:**
- Handles nuance ("remind me about that thing mom mentioned" -> needs calendar + memory context)
- Adapts automatically as tools are added (just update the prompt)
- Can return confidence and tool hints to pre-warm the agent loop
- Gracefully handles ambiguous cases

**Cons:**
- 150-400ms latency on every request (even the 70% that don't need tools)
- Depends on cloud API availability (classifier down = gateway down)
- Potential for hallucinated tool names or wrong routing
- JSON parsing failure risk (mitigated by response healing or retry)

### Approach B: Local Keyword/Intent Classifier

Pattern matching + keyword extraction, no LLM call.

**Implementation:**

```python
import re

TOOL_PATTERNS = {
    "lights": [r"\b(turn|switch)\b.*(light|lamp|on|off|bright)", r"\blight"],
    "weather": [r"\bweather\b", r"\bforecast\b", r"\brain\b.*today"],
    "calendar": [r"\b(calendar|schedule|appointment|meeting|remind)\b"],
    "web_search": [r"\b(search|look up|find|google)\b"],
    "send_message": [r"\b(send|text|message)\b.*(to|mom|dad)"],
    "timer": [r"\b(timer|alarm|countdown|set.*minutes)\b"],
}

def classify_local(text: str) -> dict:
    text_lower = text.lower()
    matched_tools = []
    for tool, patterns in TOOL_PATTERNS.items():
        if any(re.search(p, text_lower) for p in patterns):
            matched_tools.append(tool)
    return {"needs_tools": len(matched_tools) > 0, "tool_hints": matched_tools}
```

**Pros:**
- Zero latency (< 1ms)
- Zero cost
- Zero cloud dependency
- Deterministic and auditable

**Cons:**
- Extremely brittle -- "It's cold in here" should trigger lights/thermostat but won't match patterns
- Maintenance nightmare as tools grow -- every new tool needs hand-crafted patterns
- No understanding of context or intent -- "cancel my appointment" matches calendar but "cancel that" doesn't
- High false-negative rate for natural speech (voice input is messy)
- Can't handle negation ("don't turn on the lights" still matches "light" and "on")

### Approach C: Hybrid -- Local Fast-Path + LLM Fallback

Two-stage classifier: local patterns handle obvious cases, LLM handles the rest.

**Flow:**

```
User input
    │
    ▼
[Local classifier] ─── High confidence "no tools" ──> Direct LLM response (0ms overhead)
    │                     (greetings, questions,
    │                      pure conversation)
    │
    ├── High confidence "needs tools" ──────────────> Agent loop (0ms classifier overhead)
    │     (explicit tool keywords)
    │
    └── Ambiguous / low confidence ─────────────────> LLM classifier (200-400ms)
                                                          │
                                                          ├── No tools → Direct LLM
                                                          └── Tools → Agent loop
```

**Local fast-path rules (conservative -- high precision, not high recall):**

```python
NO_TOOLS_PATTERNS = [
    r"^(hi|hello|hey|good morning|good night|thanks|thank you|bye)\b",
    r"^(what|who|where|when|why|how)\b.*\?$",  # Questions without action verbs
    r"^(tell me|explain|describe|define)\b",
]

TOOLS_PATTERNS = {
    "lights": [r"\b(turn|switch)\s+(on|off)\b.*\b(light|lamp)\b"],
    "timer": [r"\b(set|start)\s+(a\s+)?(timer|alarm)\b"],
    # Only highly unambiguous patterns
}

def classify_hybrid(text: str) -> tuple[str, dict]:
    """Returns (confidence, result) where confidence is 'high' or 'low'."""
    text_lower = text.lower().strip()
    
    # Fast-path: obvious no-tool requests
    if any(re.search(p, text_lower) for p in NO_TOOLS_PATTERNS):
        return "high", {"needs_tools": False, "tool_hints": []}
    
    # Fast-path: obvious tool requests
    for tool, patterns in TOOLS_PATTERNS.items():
        if any(re.search(p, text_lower) for p in patterns):
            return "high", {"needs_tools": True, "tool_hints": [tool]}
    
    # Ambiguous: fall through to LLM classifier
    return "low", None
```

**Expected routing at steady state:**
- ~50% fast-pathed to "no tools" (greetings, obvious questions)
- ~10% fast-pathed to "tools" (explicit commands)
- ~40% routed to LLM classifier (ambiguous)

**Pros:**
- Zero overhead for the most common cases (greetings, simple questions)
- LLM handles nuance for ambiguous cases
- Graceful degradation if LLM classifier is down (conservative local classifier still works)
- Can tune the fast-path over time based on logs (move patterns from LLM to local as confidence grows)

**Cons:**
- Two classifiers to maintain (though local one is simple)
- Potential inconsistency (local says "no tools", but in different phrasing LLM would disagree)
- Pattern maintenance burden (mitigated by keeping patterns conservative and few)

---

## Agent Loop Design

Once the classifier determines tools are needed, the agent loop executes tool calls.

### Approach A: ReAct Loop (Recommended for Home Assistant)

Think -> Act -> Observe, repeat until done.

```
┌─────────────────────────────────────────────────────────┐
│                     ReAct Loop                           │
│                                                          │
│  ┌──────┐    ┌──────────┐    ┌─────────┐    ┌────────┐ │
│  │ LLM  │───>│ Parse    │───>│ Execute │───>│ Append │──┤
│  │ Call  │    │ Tool     │    │ Tool    │    │ Result │  │
│  │      │    │ Calls    │    │ Call(s) │    │ to Ctx │  │
│  └──────┘    └──────────┘    └─────────┘    └────────┘  │
│      ▲                                          │        │
│      └──────────────────────────────────────────┘        │
│                    (if more tools needed)                 │
│                                                          │
│  Exit when: LLM returns text response without tool calls │
│  Safety: max 5 iterations (prevent infinite loops)       │
└─────────────────────────────────────────────────────────┘
```

**Implementation sketch:**

```python
async def react_loop(
    messages: list[dict],
    tools: list[ToolDef],
    max_iterations: int = 5,
) -> AsyncIterator[str]:
    """Run ReAct loop, yielding streamed text tokens from final response."""
    
    for i in range(max_iterations):
        response = await llm.chat(
            messages=messages,
            tools=[t.schema for t in tools],
            stream=(i == max_iterations - 1),  # Only stream the final response
        )
        
        if not response.tool_calls:
            # No more tool calls -- this is the final response
            async for token in response.stream():
                yield token
            return
        
        # Execute tool calls (parallel if multiple)
        results = await asyncio.gather(*[
            execute_tool(tc, tools) for tc in response.tool_calls
        ])
        
        # Append tool calls and results to context
        messages.append({"role": "assistant", "tool_calls": response.tool_calls})
        for tc, result in zip(response.tool_calls, results):
            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": result,
            })
    
    # Max iterations reached -- force a text response
    yield "I wasn't able to complete that action. Could you try again?"
```

**Latency profile:**

| Scenario | LLM Calls | Tool Calls | Total Latency |
|----------|----------|------------|---------------|
| Single tool (lights, weather) | 2 (decide + respond) | 1 | ~1-2s |
| Two tools (calendar + reminder) | 2-3 | 2 | ~2-4s |
| Three tools (complex) | 3-4 | 3 | ~3-5s |

**Optimization: streaming the final response.** The last LLM call (the one generating the user-facing response) is streamed, feeding into the SentenceAggregator -> TTS pipeline for streaming overlap. Earlier iterations are non-streamed for simplicity.

**Parallel tool execution:** When the LLM emits multiple tool calls in one turn (e.g., "get weather AND check calendar"), they execute concurrently via `asyncio.gather()`. This is the key optimization for multi-tool requests.

**Pros:**
- Simple to implement and reason about
- Naturally handles single-step (majority) with minimal overhead
- Adaptive -- can recover from tool failures by trying alternatives
- Streams the final response for low perceived latency
- Parallel tool execution reduces multi-step latency

**Cons:**
- Each iteration = one LLM round-trip (~500-1500ms)
- For genuinely multi-step tasks, accumulated latency is noticeable
- No upfront plan means the LLM might take suboptimal paths

### Why Not Plan-and-Execute?

Plan-and-Execute generates a full plan first, then executes each step:

```
[Plan LLM call: ~800-1500ms] -> [Execute step 1] -> [Execute step 2] -> [Respond]
```

**For a home assistant, this is worse because:**
1. **Over-engineers simple tasks** -- "Turn on the lights" still gets a planning phase (~800ms wasted)
2. **Higher minimum latency** -- Even single-tool calls need plan + execute + respond = 3 LLM calls minimum vs ReAct's 2
3. **Replanning on failure** is complex -- if step 2 fails, do you replan from scratch or adapt?
4. **80%+ of tool requests are single-step** -- Plan-and-Execute optimizes for the 2% complex case at the cost of the 98% simple case

**Verdict:** ReAct with parallel tool calls and a max iteration limit. If complex orchestration becomes common in the future, add Plan-and-Execute as an optional path triggered by the classifier.

---

## Tool Registration & Extensibility

### Recommended: Decorator + Directory Scanning

Each tool lives in its own file under `tools/`. A decorator captures metadata. A loader auto-discovers all tools at startup.

**Tool definition example (`tools/weather.py`):**

```python
from gateway.tools import tool, ToolContext

@tool(
    name="weather",
    description="Get current weather and forecast for a location",
    impact_tier="auto",  # auto-execute, no confirmation needed
)
async def weather(location: str, ctx: ToolContext) -> str:
    """
    Args:
        location: City name or 'here' for user's default location
    """
    # Implementation
    api_key = ctx.secrets.get("openweather_api_key")
    data = await ctx.http.get(f"https://api.openweathermap.org/...", params={"q": location})
    return f"Currently {data['temp']}F and {data['description']} in {location}."
```

**Tool with confirmation (`tools/send_message.py`):**

```python
@tool(
    name="send_message",
    description="Send a text message to a family member",
    impact_tier="confirm",  # Requires user confirmation before execution
)
async def send_message(recipient: str, message: str, ctx: ToolContext) -> str:
    """
    Args:
        recipient: Family member's name
        message: The message content to send
    """
    # Gateway will pause here and send tool.confirm_request to client
    # Execution only proceeds if user approves
    ...
```

**The `@tool` decorator:**

```python
from dataclasses import dataclass, field
from typing import Any, Callable
import inspect, json

@dataclass
class ToolDef:
    name: str
    description: str
    impact_tier: str  # "auto" | "confirm"
    parameters: dict  # JSON Schema derived from type hints
    fn: Callable
    
    @property
    def schema(self) -> dict:
        """OpenAI-compatible tool schema for LLM function calling."""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            }
        }

_registry: list[ToolDef] = []

def tool(name: str, description: str, impact_tier: str = "auto"):
    def decorator(fn):
        # Extract JSON Schema from type hints
        hints = fn.__annotations__
        params = {
            "type": "object",
            "properties": {},
            "required": [],
        }
        for param_name, param_type in hints.items():
            if param_name in ("return", "ctx"):
                continue
            params["properties"][param_name] = _type_to_schema(param_type)
            params["required"].append(param_name)
        
        tool_def = ToolDef(
            name=name,
            description=description,
            impact_tier=impact_tier,
            parameters=params,
            fn=fn,
        )
        fn._tool_def = tool_def
        _registry.append(tool_def)
        return fn
    return decorator
```

**Auto-discovery loader (`gateway/tool_loader.py`):**

```python
import importlib, pkgutil, pathlib

def discover_tools(tools_dir: str = "tools") -> list[ToolDef]:
    """Scan tools/ directory and import all modules. Returns registered tools."""
    tools_path = pathlib.Path(tools_dir)
    for finder, name, _ in pkgutil.iter_modules([str(tools_path)]):
        importlib.import_module(f"tools.{name}")
    
    from gateway.tools import _registry
    return list(_registry)
```

**Startup:**

```python
tools = discover_tools("tools/")
print(f"Loaded {len(tools)} tools: {[t.name for t in tools]}")
# Output: Loaded 6 tools: ['lights', 'weather', 'calendar', 'web_search', 'send_message', 'timer']
```

**Adding a new tool:**
1. Create `tools/my_new_tool.py` with `@tool(...)` decorator
2. Restart the gateway
3. The tool is automatically discovered, registered, and available to the classifier + agent loop

**Why this pattern wins:**

| Factor | Decorator + Dir Scan | Manifest (YAML) | Explicit Import |
|--------|:-:|:-:|:-:|
| Drop-in extensibility | Excellent | Good (edit YAML) | Poor (edit imports) |
| Schema from code | Yes (type hints) | Duplicated in YAML | Yes |
| Self-contained tools | Yes (one file) | No (file + manifest) | Yes |
| Validation | At import time | At config parse | At import time |
| IDE support | Full (type hints, docstrings) | Partial | Full |
| Maintenance burden | Low | Medium (sync manifest) | Low |

---

## Tool Execution & Confirmation Flow

### Auto-Execute Tools (impact_tier = "auto")

Tool executes immediately, result fed back to LLM:

```
LLM → tool_call(weather, {location: "Seattle"}) → execute → result → LLM → response
```

### Confirm-Execute Tools (impact_tier = "confirm")

Gateway pauses and asks the user before executing:

```
LLM → tool_call(send_message, {to: "Mom", msg: "Running late"})
    → Gateway sends to client: {"type": "tool.confirm_request", "tool_call_id": "abc", 
       "tool": "send_message", "description": "Send message to Mom: 'Running late'"}
    → Client shows confirmation UI, user approves/denies
    → Client sends: {"type": "tool.confirm", "tool_call_id": "abc", "approved": true}
    → Gateway executes tool → result → LLM → response
```

**Timeout:** If no confirmation within 30 seconds, the tool call is cancelled and the LLM is informed.

**Integration with pipeline:** The confirmation flow uses the existing WebSocket message types defined in the client-gateway-protocol (tool.confirm_request, tool.confirm). The agent loop `await`s the confirmation future before proceeding.

```python
async def execute_tool(tool_call: ToolCall, tools: dict[str, ToolDef], session: Session) -> str:
    tool = tools[tool_call.function.name]
    
    if tool.impact_tier == "confirm":
        approved = await session.request_confirmation(
            tool_call_id=tool_call.id,
            tool_name=tool.name,
            description=_describe_call(tool_call),
            timeout=30.0,
        )
        if not approved:
            return f"User declined to execute {tool.name}."
    
    ctx = ToolContext(session=session, secrets=config.secrets, http=http_client)
    try:
        result = await asyncio.wait_for(tool.fn(**tool_call.arguments, ctx=ctx), timeout=10.0)
        return str(result)
    except asyncio.TimeoutError:
        return f"Tool {tool.name} timed out after 10 seconds."
    except Exception as e:
        return f"Tool {tool.name} failed: {e}"
```

### Tool Context

Every tool receives a `ToolContext` providing controlled access to shared resources:

```python
@dataclass
class ToolContext:
    session: Session          # Current user session (for user identity, memory)
    secrets: SecretStore      # API keys (read-only)
    http: aiohttp.ClientSession  # Shared HTTP client (connection pooling)
    audit: AuditLogger        # Logs every tool invocation
```

This prevents tools from accessing raw config or other users' data. Tools operate within the security boundary of the ToolContext.

---

## Interaction with Pipeline Architecture

The tool routing system fits into the established pipeline as a branching processor:

```
[STT] → [TranscriptionFrame] → [ClassifierProcessor] → needs_tools? 
                                        │                     │
                                        │ No                  │ Yes
                                        ▼                     ▼
                                [DirectLLMProcessor]   [AgentLoopProcessor]
                                        │                     │
                                        └─────────┬───────────┘
                                                  ▼
                                      [SentenceAggregator] → [TTS] → [Transport]
```

**ClassifierProcessor** is a FrameProcessor that:
1. Receives TranscriptionFrame from STT
2. Runs the classifier (hybrid local + LLM)
3. Emits either a DirectLLMRequestFrame or AgentLoopRequestFrame downstream

**AgentLoopProcessor** is a FrameProcessor that:
1. Receives AgentLoopRequestFrame with tool hints
2. Runs the ReAct loop
3. Streams the final LLM response as TextFrames downstream
4. Handles InterruptionFrame (SystemFrame) by cancelling the current LLM call and any in-flight tool executions

**Barge-in during tool execution:**
- If user interrupts during a tool call, the tool execution is cancelled (if possible)
- Tool results that already completed are marked as UninterruptibleFrame and preserved
- The agent loop state is saved so it can be resumed or referenced in the next turn

---

## Approaches Summary

### Classifier Approaches

| Factor | A. LLM-Only | B. Local-Only | C. Hybrid |
|--------|:-:|:-:|:-:|
| Latency (no-tools path) | 150-400ms | <1ms | <1ms (50%), 150-400ms (40%) |
| Latency (tools path) | 150-400ms | <1ms | <1ms (10%), 150-400ms (rest) |
| Accuracy (natural speech) | High | Low-Medium | High (LLM fallback) |
| Cloud dependency | Full | None | Partial (graceful degradation) |
| Maintenance as tools grow | Low (update prompt) | High (update patterns) | Medium |
| Cost per month (~100 req/day) | <$0.02 | $0 | <$0.01 |

### Agent Loop Approaches

| Factor | ReAct | Plan-and-Execute |
|--------|:-:|:-:|
| Single-tool latency | ~1-2s (2 LLM calls) | ~2-3s (3 LLM calls) |
| Multi-tool latency | ~2-4s (2-3 calls) | ~3-5s (plan + execute) |
| Implementation complexity | Low | Medium-High |
| Error recovery | Natural (observe, adapt) | Complex (replan) |
| Parallel tool calls | Yes (native) | Yes (within plan) |
| Streaming final response | Yes | Yes (but more complex) |

---

## Analysis & Recommendation

### Classifier: Approach C (Hybrid)

The hybrid approach gives us the best of both worlds:
- **Zero latency for the majority of requests** (greetings, questions -> local fast-path)
- **High accuracy for ambiguous cases** (LLM fallback handles "it's cold in here" -> thermostat)
- **Graceful degradation** (if LLM classifier is unavailable, conservative local patterns still work)
- **Negligible cost** (<$0.01/month even with LLM fallback)
- **Tuneable** (monitor logs, move confident patterns from LLM to local over time)

### Agent Loop: ReAct

ReAct is the clear choice for a home assistant:
- **80%+ of tool requests are single-step** -- ReAct adds minimal overhead (2 LLM calls)
- **Parallel tool calls** mitigate multi-step latency
- **Simple implementation** (~50 lines of core logic)
- **Streaming final response** feeds directly into the sentence aggregator -> TTS pipeline
- **Plan-and-Execute** can be added later as an optional path if complex orchestration becomes common

### Tool Registration: Decorator + Directory Scanning

- True "drop a file, restart" extensibility
- Self-documenting tools (type hints -> JSON Schema, docstrings -> descriptions)
- Impact tiers declared per-tool, enforced at execution
- ToolContext provides controlled access to shared resources

### Key Architecture Decisions

1. **Classifier**: Hybrid local fast-path + LLM fallback (Gemini 2.0 Flash Lite via OpenRouter)
2. **Agent loop**: ReAct pattern with max 5 iterations, parallel tool execution, streaming final response
3. **Tool registration**: `@tool` decorator + auto-discovery from `tools/` directory
4. **Impact tiers**: `auto` (immediate) and `confirm` (user approval via WebSocket) -- declared per-tool
5. **Tool execution**: 10s timeout per tool, structured error handling, results as UninterruptibleFrames
6. **Confirmation flow**: Uses existing WebSocket `tool.confirm_request`/`tool.confirm` message types
7. **LLM for tools**: OpenRouter with function calling (`tools` parameter) -- model chosen based on task complexity
8. **Security**: ToolContext restricts tool access; audit logging on every invocation; no arbitrary code execution

### Open Questions for Scoring

- Should the classifier cache recent routing decisions (same user, similar phrasing)?
- How should tool descriptions be injected into the classifier prompt -- statically or dynamically based on user permissions?
- Should there be a "tool suggestion" mode where the agent proposes but doesn't execute, for learning/debugging?
- What's the right behavior when the LLM requests a tool that doesn't exist (hallucinated tool name)?

---

## Score

**Total: 33/50** (Feas:5, Maint:5, Risk:6, Effort:8, Align:9)

### Friction Log
- [Feasibility]: No PoC executed. All latency claims (Gemini Flash Lite 150-300ms, ReAct 1-2s) are unvalidated against the real stack from RPi5.
- [Feasibility]: Confirmation flow `session.request_confirmation()` is referenced but never defined. What happens if WebSocket drops during await?
- [Maintainability]: No testing strategy documented. No mock/stub patterns for ToolContext, no harness design.
- [Maintainability]: Module-level `_registry` global list causes cross-test contamination — no isolation or reset mechanism.
- [Risk]: Hallucinated tool names are an open question, not a mitigated risk. `execute_tool()` would KeyError.
- [Risk]: Hybrid classifier's 40% LLM-fallback estimate may be optimistic for children/non-native speakers.
- [Risk]: Barge-in tool cancellation says "if possible" — HTTP requests mid-flight need explicit cancellation token handling.
- [Effort]: Hybrid classifier slightly over-architects for 5 users/100 req/day — pure LLM-only is simpler.

### What's Missing
- No PoC at all
- No test strategy
- `session.request_confirmation()` undefined
- Hallucinated tool name handling unresolved
- Global registry contamination in tests
- LLM model selection for ReAct loop unspecified
- `_type_to_schema()` referenced but not implemented
- No per-user tool permissions model

### What's Strong
- Workload profiling (70/20/10 split) anchors all design choices
- ReAct vs Plan-and-Execute comparison well-reasoned
- Hybrid classifier with graceful degradation
- Decorator + directory scanning for extensibility
- ToolContext as security boundary
- Parallel tool execution via asyncio.gather()
- Impact tiers declared per-tool
