# First-class family tools design

## Design Goal

Own the core family-assistant tool contracts, permission identity, orchestration, and semantic results while isolating public-web egress and retaining broad HA/MA capability.

## Chosen Approach

- Introduce a transport-independent product tool catalog whose stable group and tool identities drive defaults, settings projection, model visibility, role gating, and dispatch mediation.
- Implement web, home, and music as gateway-native foreground runners behind typed adapters rather than MCP-discovered definitions.
- Replace fetch-mcp and searxng-mcp with one supervised, internal-only outbound worker reached through a typed loopback client and routed outward only through the existing egress proxy.
- Retain SearXNG as the internal search engine and store full fetched content in a bounded, user-scoped artifact store outside the append-only conversation projection.
- Add a no-tools web utility runner with workload-specific bounds and an explicit user-model, DeepSeek Flash, deterministic fallback chain.
- Implement HA and MA adapters against their native APIs, translating compact Sentient contracts into upstream calls and validating all upstream input before returning typed semantic outcomes.
- Keep standard judgement-enabling primitives visible by default; mark only uncommon administrative and granular escape hatches advanced/off by default.

## Verification Boundaries

- Contract tests cover tool schemas, permission resolution, visibility versus dispatch consistency, and conservative migration.
- Outbound boundary tests cover canonical domains, suffix denial, DNS failures, redirects, limits, partial results, cancellation, and malformed upstream responses.
- Artifact tests cover ownership, expiry, eviction, slicing, passage lookup, and context bounds.
- Utility-runner tests cover user-model success, configured fallback, deterministic fallback, schema rejection, cancellation, and no-tools requests.
- Home and music adapter tests cover resolution, ambiguity, semantic outcomes, accepted-but-unverified behavior, and no automatic write retry.
- Live checks are restricted to HA/MA reads and web/search observations; automated and manual live suites must contain no household mutations.

## Components and Interfaces

- ProductToolCatalog: stable group/tool metadata, impact, default exposure, descriptions, schemas, and execution identity.
- ToolBroker: existing authority and permission choke point extended to resolve product group identity for every native and MCP tool.
- OutboundWorkerClient and outbound worker: typed search/fetch/artifact operations, policy enforcement, extraction, and bounded failures.
- Egress proxy and dangerous-domain policy: outbound transport plus independent operator/bundled hostname controls.
- SearXNG adapter: bounded JSON search and source normalization.
- WebArtifactStore: opaque user-scoped identifiers, TTL and capacity bounds, bounded slice and passage retrieval.
- WebSummaryRunner: no-tools provider calls, schema validation, cancellation, model fallback, and deterministic formatting.
- HomeAdapter and home tool runners: HA API boundary, natural-name resolution, structured configuration validation, activation/control, and semantic outcomes.
- MusicAdapter and music tool runners: persistent MA connection, media/player/queue primitives, composed play orchestration, and semantic outcomes.
- Settings projections and profile migration: consistent web/mobile group and tool controls preserving restrictive legacy intent.

## Data and Control Flow

- At each turn the broker refreshes profile permissions and emits only role-reachable, non-off product and MCP tool definitions.
- A web search reaches the outbound worker, which queries internal SearXNG, selects sources, fetches allowed pages through the egress proxy, extracts and stores full artifacts, and returns bounded passages.
- WebSummaryRunner synthesizes those passages using the user's selected model, then DeepSeek Flash on failure, with deterministic formatting as the terminal fallback; only the bounded answer and citations reach the ReAct loop.
- A home invocation is validated and permission-mediated before HomeAdapter resolves configured HA resources and executes native API operations; returned upstream values are validated and normalized.
- A composed music invocation resolves room/player and content using MusicAdapter primitives, performs the minimum required queue/play operations, observes resulting state, and returns one semantic outcome.
- Standard music primitives use the same adapter directly when conversational refinement requires model judgement.
- Settings changes address stable product group/tool keys; legacy server-addressed entries migrate conservatively before the new resolver becomes authoritative.

## Failure and Recovery

- The outbound worker returns per-source typed failures and preserves partial search results; bounded deadlines prevent one source from blocking the whole answer.
- Blocked domains are refused before dispatch and on every redirect; canonicalization prevents trivial hostname bypasses.
- Artifact expiry or ownership mismatch returns an unavailable result without exposing another user's content.
- Utility-model failures fall through a bounded explicit chain and never fail the whole conversation when deterministic source formatting is possible.
- HA/MA connection failures degrade only their tool calls and do not kill unrelated session channels.
- No side-effecting HA/MA operation is automatically retried after an ambiguous transport failure; accepted-but-unverified remains a first-class result.
- Permission is re-evaluated at dispatch so stale model definitions cannot authorize a call.
- Migration is fail-closed: unmappable restrictive legacy entries remain restrictive and are surfaced for operator review rather than dropped.
- Live HA/MA test coverage is observational only; mutation behavior is proven with controlled adapters, mocks, fakes, or isolated fixtures.

## Alternatives Considered

- Keeping the four MCP adapters was rejected because dynamic discovery, sidecar/session failures, upstream schemas, and multi-call orchestration are the user-visible problem.
- Running public fetch directly in the native gateway was rejected because it removes the enforceable outbound process/network boundary and creates an ambient fetch capability for future tools.
- Exposing only composed music tools was rejected because conversational search, comparison, direct selection, queue inspection, and transfer require model judgement through standard primitives.
- Classifying all primitives as advanced was rejected because implementation level does not determine household frequency or context value.
- Putting complete fetched pages or summaries of complete pages into the main turn was rejected because it unpredictably consumes the session context window.
