# Task Acceptance: Cut over core capabilities and retire their MCP sidecars

## Deliverables

- Web, Home Assistant, and Music Assistant run exclusively through the reviewed first-class implementations, with obsolete MCP adapters removed and existing users migrated conservatively.

## Acceptance

- Gateway startup and ToolBroker.ready produce core definitions with all four retired MCP endpoints unavailable
- The former four MCP containers are absent from the desired managed-service graph and safely reaped when harness-owned
- SearXNG search and content fetch work through outbound-worker and egress-proxy
- HA and MA native reads remain available when their optional credentials/services are configured; absence degrades only those groups
- Existing explicit off/deny settings remain restrictive after migration and settings save/reload
- A delegated read-only web/home/music request can use eligible gateway-hosted native reads without gaining side-effecting capability
- General third-party MCP tools continue listing, permission resolution, dispatch, transport eviction, and delegation proxy behavior
- Default local E2E can authenticate with PIN 1234 and exercise web plus observational HA/MA behavior without any household mutation

## Boundary Proof

- Config/schema/orchestrator regression tests assert the desired service graph and safe obsolete-container reaping
- Migration tests run legacy fixtures through repeated migration and prove stable restrictive output
- Broker/MCP-host tests distinguish native core definitions, delegated read projection, side-effect exclusion, and surviving third-party MCP calls
- A local stack smoke verifies service health, login with PIN 1234, native tool catalog/settings, benign web search/fetch, and optional HA/MA observational reads only
- Repository searches and deployment tests show no remaining active references to retired service endpoints, images, or templates
