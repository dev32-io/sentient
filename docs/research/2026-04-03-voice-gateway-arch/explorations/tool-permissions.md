# Tool Routing Sub-Decision: Per-User Tool Permissions

## Parent Decision Area
`tool-routing` — this is a sub-decision extracted during decomposition.

## Decision Area
How tool access is controlled per user. The current design has impact tiers (auto/confirm) declared per-tool, but no per-user permissions model. A child user should not have access to `send_message` or `purchase` tools even with confirmation. The score flagged: no per-user tool permissions model.

## Key Questions

1. **Permission model**: Per-user allow/deny lists? Role-based (admin, adult, child)? Per-tool per-user overrides?
2. **Permission storage**: Where are permissions stored — in the user's auth profile, a separate permissions config file, or inline in tool definitions?
3. **Permission enforcement point**: At the classifier (don't even mention restricted tools to the LLM)? At the agent loop (block execution)? Both?
4. **Impact tier overrides**: Can a parent escalate a tool from "auto" to "confirm" for a child user? E.g., `web_search` is auto for adults but confirm for kids.
5. **Dynamic permissions**: Can permissions change at runtime (e.g., "parental mode" toggle) or only on gateway restart?
6. **Classifier interaction**: If a user doesn't have permission to any tools, should the classifier always fast-path to "no tools"? Should restricted tools be excluded from the classifier prompt?

---

## Approaches

*To be explored in the Explore step.*
