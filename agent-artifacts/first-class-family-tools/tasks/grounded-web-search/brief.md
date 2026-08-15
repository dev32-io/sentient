# Task Brief: Answer web searches with bounded grounded synthesis

## Contribution Goal

A family member can ask one first-class web_search tool for current information and receive a concise cited answer backed by bounded SearXNG sources without bloating the main session.

## Boundary — Included

- Add a bounded SearXNG JSON search operation to the outbound worker with query, result-count, recency, and domain include/exclude validation
- Implement native web_search with quick and grounded behavior: normalize results, select a bounded number of sources, fetch grounded sources concurrently through the worker, and preserve partial failures
- Store fetched source artifacts through WebArtifactStore and return opaque research/artifact references for explicit follow-up
- Add WebSummaryRunner using a Markdown prompt resource, tools:[], workload-specific input/output/deadline settings, structured output validation, and cancellation
- Resolve the user's selected model per request; on provider/model failure make one bounded attempt with web.summary.model defaulting to deepseek-v4-flash:cloud; on failure format a deterministic answer from snippets and citations
- Send only selected bounded passages, source titles, and URLs to the utility runner, then scan and cap its returned answer before the main loop receives it
- Expose citations and per-source status without returning complete fetched pages
- Add operator configuration for source count, passage budget, summary model, deadlines, and result limits

## Required Work

- Add a bounded SearXNG JSON search operation to the outbound worker with query, result-count, recency, and domain include/exclude validation
- Implement native web_search with quick and grounded behavior: normalize results, select a bounded number of sources, fetch grounded sources concurrently through the worker, and preserve partial failures
- Store fetched source artifacts through WebArtifactStore and return opaque research/artifact references for explicit follow-up
- Add WebSummaryRunner using a Markdown prompt resource, tools:[], workload-specific input/output/deadline settings, structured output validation, and cancellation
- Resolve the user's selected model per request; on provider/model failure make one bounded attempt with web.summary.model defaulting to deepseek-v4-flash:cloud; on failure format a deterministic answer from snippets and citations
- Send only selected bounded passages, source titles, and URLs to the utility runner, then scan and cap its returned answer before the main loop receives it
- Expose citations and per-source status without returning complete fetched pages
- Add operator configuration for source count, passage budget, summary model, deadlines, and result limits

## Integration Expectation

Deliver this contribution for integration in stage 03-capabilities.

## Context

- SearXNG remains the internal metasearch engine and already routes its engine traffic through the egress proxy.
- The outbound worker from the preceding contribution is the only web execution surface and already owns safe fetching/extraction.
- Web synthesis is a utility workload outside the ReAct loop: no tools, bounded passages, validated output, and a deterministic terminal fallback.
- The desired model order is the user's current selection, then configured deepseek-v4-flash:cloud, then deterministic source formatting.

## Boundary — Excluded

- Browser curator UI, Pi extension/session APIs, multi-provider hosted search routing, source_check, video/PDF/GitHub-specialized extraction
- Changing the user's chat-model selection
- Removing SearXNG itself

## Interfaces and Dependencies

- web_search has a compact stable schema and returns concise answer text, citations, source statuses, and research/artifact IDs
- WebSummaryRunner is a no-tools utility boundary and does not submit messages or entries to the main session on its own
- User-model resolution happens at call time so settings changes apply to the next search
- Fallback attempts share a bounded workload deadline and never recurse into the ReAct loop
- SearXNG and fetched responses are validated as unknown external data
- Extend only the web-owned provider and worker surfaces delivered by outbound-fetch-artifacts; the concurrent Home and Music foundation contributions are consumed only at final cutover

## Constraints

- Full page bodies never enter the utility prompt or main tool result
- One failed source does not discard successful results
- Search/fetch/summary text remains untrusted and crosses the inbound scanner
- No prompts, queries, page bodies, summary text, or credentials in logs
- The configured fallback model is an operator knob; deepseek-v4-flash:cloud is the shipped default
