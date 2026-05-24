# Tool Routing Sub-Decision: Registry Isolation

## Parent Decision Area
`tool-routing` — this is a sub-decision extracted during decomposition.

## Decision Area
How to prevent the module-level `_registry` global list from causing cross-test contamination, and how to manage tool registration lifecycle (startup, reload, test isolation). The score flagged: module-level `_registry` global list causes cross-test contamination — no isolation or reset mechanism. Also flagged: `_type_to_schema()` referenced but not implemented, hallucinated tool name handling unresolved.

## Key Questions

1. **Registry lifecycle**: Should the registry be a global singleton, a class instance, or a context-scoped object? What enables test isolation?
2. **Registry reset**: How to clear and rebuild the registry between tests without import-time side effects?
3. **Hallucinated tool names**: When the LLM requests a tool that doesn't exist, what's the error handling — KeyError crash, graceful error message back to LLM, or retry with corrected tool list?
4. **Type-to-schema mapping**: Implementation of `_type_to_schema()` — support for `str`, `int`, `float`, `bool`, `list[str]`, `Optional[T]`, `Literal[...]`, enums. How complete does this need to be?
5. **Hot reload**: Can tools be added/removed without a full gateway restart? Is this worth the complexity for a 5-user home system?
6. **Tool name validation**: Should tool names be validated at registration time (alphanumeric, no spaces, unique)?
7. **Duplicate detection**: What happens if two tool files declare the same `@tool(name="weather")`?

---

## Approaches

*To be explored in the Explore step.*
