# Task Brief: Cut over core capabilities and retire their MCP sidecars

## Contribution Goal

Web, Home Assistant, and Music Assistant run exclusively through the reviewed first-class implementations, with obsolete MCP adapters removed and existing users migrated conservatively.

## Boundary — Included

- Remove fetch, searxng, home_assistant, and music_assistant entries from the MCP catalog after native equivalents are authoritative
- Remove fetch-mcp, searxng-mcp, ha-mcp, and ma-mcp managed-service definitions, templates, build wrappers, ingress routes, docs, migrations, and stale tests
- Retain SearXNG and rewire ingress/health/dependency topology around outbound-worker and egress-proxy
- Make the system orchestrator safely reap obsolete managed containers without touching unrelated operator workloads
- Finalize profile migration and settings projection so old explicit permissions map to first-class groups and retired keys no longer affect visibility
- Expose only eligible non-prompting native read tools to delegated Hermes through the existing gateway-hosted MCP/PDP path, preserving user and role mediation; never expose native side-effecting tools merely because their old MCP tier was misclassified
- Update default prompts, operator comments, service version/status surfaces, deployment assets, architecture docs, and setup behavior to describe first-class tools and the new worker topology
- Prove gateway startup and a first turn do not contact former core MCP endpoints or wait on their discovery

## Required Work

- Remove fetch, searxng, home_assistant, and music_assistant entries from the MCP catalog after native equivalents are authoritative
- Remove fetch-mcp, searxng-mcp, ha-mcp, and ma-mcp managed-service definitions, templates, build wrappers, ingress routes, docs, migrations, and stale tests
- Retain SearXNG and rewire ingress/health/dependency topology around outbound-worker and egress-proxy
- Make the system orchestrator safely reap obsolete managed containers without touching unrelated operator workloads
- Finalize profile migration and settings projection so old explicit permissions map to first-class groups and retired keys no longer affect visibility
- Expose only eligible non-prompting native read tools to delegated Hermes through the existing gateway-hosted MCP/PDP path, preserving user and role mediation; never expose native side-effecting tools merely because their old MCP tier was misclassified
- Update default prompts, operator comments, service version/status surfaces, deployment assets, architecture docs, and setup behavior to describe first-class tools and the new worker topology
- Prove gateway startup and a first turn do not contact former core MCP endpoints or wait on their discovery

## Integration Expectation

Deliver this contribution for integration in stage 04-cutover.

## Context

- General third-party MCP client/host support remains part of Sentient. Only the fetch, SearXNG, HA, and MA core model surfaces and sidecars retire.
- The gateway-hosted MCP socket remains the delegated Hermes reach-back boundary. Safe native read tools may be projected there so delegation does not silently lose existing read-only web/home/music capability.
- SearXNG, egress-proxy, ingress-proxy, and outbound-worker remain managed infrastructure; ingress routing changes from two MCP adapters to the generalized worker.
- Existing profiles and deployments can contain legacy permission keys, running managed containers, templates, images, and comments describing the old topology.

## Boundary — Excluded

- Removing @modelcontextprotocol/sdk, McpClient, gateway-hosted MCP, third-party mcp_catalog entries, or delegated MCP support
- Removing SearXNG, egress-proxy, ingress-proxy, HA/MA credentials, or the native adapters
- Production mutation or live household write smoke tests

## Interfaces and Dependencies

- Core tool definitions come only from native product catalog registration
- Third-party MCP tools retain server routing and the same product permission boundary
- Delegated native projection is derived from authoritative tool metadata and eligibility rules, not a second hand-maintained allowlist
- Obsolete-service reaping uses existing harness ownership labels and never deletes unowned containers
- Migration is idempotent and safe across repeated boot/apply operations
- This final barrier consumes all three completed branches: grounded web search, Home configuration coverage, and composed Music playback

## Constraints

- No permission widening during cutover; restrictive unmappable values remain restrictive and are reported
- Do not expose standard side-effecting Home or Music tools to an unanswerable delegated confirmation path
- Preserve secrets without rendering them into profiles, prompts, or logs
- Production verification is observational only and requires separate explicit authorization; planned proof uses local dev and read-only integrations
