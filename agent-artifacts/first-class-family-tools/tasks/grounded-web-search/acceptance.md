# Task Acceptance: Answer web searches with bounded grounded synthesis

## Deliverables

- A family member can ask one first-class web_search tool for current information and receive a concise cited answer backed by bounded SearXNG sources without bloating the main session.

## Acceptance

- A grounded web_search returns a bounded answer with citations and no complete source body
- The worker can search SearXNG without searxng-mcp being available
- The user's selected model is attempted first and a changed selection applies on the next search
- A failed selected model falls back once to configured DeepSeek Flash; failure of both returns deterministic cited results
- Some source fetch failures still yield a useful answer from successful sources or snippets
- Search cancellation closes worker and provider activity without a late result entering the turn
- Research/artifact IDs allow explicit bounded follow-up through read_web_content

## Boundary Proof

- Worker tests cover SearXNG query mapping, result validation, domain filtering, recency, result caps, and failures
- WebSummaryRunner tests cover tools:[], prompt budgets, user-model selection, DeepSeek fallback, deterministic fallback, schema rejection, shared deadline, and cancellation
- Native tool tests prove partial-source behavior, citations, artifact references, inbound scanning, and context bounds
- A local read-only E2E may use PIN 1234 to perform a benign web search/fetch against the local stack and verify bounded output
