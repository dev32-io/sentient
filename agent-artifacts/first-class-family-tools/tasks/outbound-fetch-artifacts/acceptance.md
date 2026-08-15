# Task Acceptance: Fetch web content through the confined outbound worker

## Deliverables

- A family member can call first-class fetch_content and read_web_content tools that safely extract and retrieve bounded web content without placing complete pages into the conversation.

## Acceptance

- fetch_content returns a bounded readable extract and artifact ID for an allowed page while the complete extraction is absent from the tool result
- read_web_content retrieves an owned artifact slice or matching passages and refuses expired, malformed, or foreign-user IDs
- A deny rule for example.test also blocks its subdomains after case, trailing-dot, or IDNA normalization
- A redirect to a blocked domain is refused even when the initial URL was allowed
- Timeout, oversize, unsupported content, DNS failure, worker outage, and cancellation produce bounded typed errors
- The worker cannot reach the internet when the egress-proxy path is unavailable
- Native fetch definitions exist independently of fetch-mcp discovery

## Boundary Proof

- Worker boundary tests cover URL parsing, canonical domains, DNS failures, suffix denial, redirects, ports, response limits, decompression, cancellation, and extraction
- Artifact-store tests cover ownership, expiry, capacity eviction, file modes, offset slices, and bounded matching passages
- Tool tests prove inbound scanning, result capping, permission mediation, and no full-content leakage
- A local read-only E2E may fetch a benign public page and retrieve a bounded second slice; it must not access production or mutate household integrations
