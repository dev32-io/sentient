# Tool Routing Sub-Decision: Test Strategy

## Parent Decision Area
`tool-routing` — this is a sub-decision extracted during decomposition.

## Decision Area
How to test the classifier, ReAct agent loop, and individual tools in isolation and integration. The score flagged: no testing strategy documented, no mock/stub patterns for ToolContext, no harness design.

## Key Questions

1. **ToolContext mocking**: How to create test doubles for ToolContext (secrets, HTTP, audit, session) without coupling tests to implementation details?
2. **Classifier testing**: How to test the hybrid classifier (local fast-path + LLM fallback) — real LLM calls in CI vs recorded fixtures?
3. **ReAct loop testing**: How to test multi-step agent loops with deterministic tool call sequences? Mock the LLM to return scripted tool calls?
4. **Tool isolation**: Each tool in `tools/` should be independently testable with a fake ToolContext — what's the minimal harness?
5. **Integration testing**: End-to-end test from user text input → classifier → agent loop → tool execution → streamed response. How much is feasible without real cloud APIs?
6. **Regression testing**: How to capture and replay failing classifier decisions (e.g., "it's cold in here" misrouted) as regression tests?
7. **Performance testing**: How to validate latency budgets (classifier <400ms, single-tool <2s) in CI without real cloud APIs?

---

## Approaches

*To be explored in the Explore step.*
