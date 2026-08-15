# Task Brief: Fetch web content through the confined outbound worker

## Contribution Goal

A family member can call first-class fetch_content and read_web_content tools that safely extract and retrieve bounded web content without placing complete pages into the conversation.

## Boundary — Included

- Add a required generalized outbound-worker managed service, internal-only network placement, ingress route, health behavior, resource limits, and egress-proxy dependency
- Expose a narrow validated worker API for HTTP/HTTPS content fetch and readable extraction rather than MCP or a general unauthenticated forward proxy
- Port the relevant pi-web-access patterns for URL normalization, DNS resolution, redirect-by-redirect checks, HTML readability/Markdown extraction, text/JSON handling, cancellation, and compressed/decompressed response limits
- Implement suffix-aware dangerous-domain policy from bundled release data plus persistent operator additions; canonicalize case, trailing dots, and IDNA before initial and redirect checks
- Add a typed gateway OutboundWorkerClient with bounded waits, external response validation, cancellation, and sanitized failure values
- Add a user-scoped WebArtifactStore with opaque identifiers, TTL, entry/byte eviction, restrictive filesystem permissions, ownership checks, bounded slices, and targeted passage lookup
- Register native fetch_content and read_web_content tools in the web product group and route results through the existing inbound scanner and tool-result cap
- Return source metadata, total lengths, returned range, and continuation guidance without embedding full content

## Required Work

- Add a required generalized outbound-worker managed service, internal-only network placement, ingress route, health behavior, resource limits, and egress-proxy dependency
- Expose a narrow validated worker API for HTTP/HTTPS content fetch and readable extraction rather than MCP or a general unauthenticated forward proxy
- Port the relevant pi-web-access patterns for URL normalization, DNS resolution, redirect-by-redirect checks, HTML readability/Markdown extraction, text/JSON handling, cancellation, and compressed/decompressed response limits
- Implement suffix-aware dangerous-domain policy from bundled release data plus persistent operator additions; canonicalize case, trailing dots, and IDNA before initial and redirect checks
- Add a typed gateway OutboundWorkerClient with bounded waits, external response validation, cancellation, and sanitized failure values
- Add a user-scoped WebArtifactStore with opaque identifiers, TTL, entry/byte eviction, restrictive filesystem permissions, ownership checks, bounded slices, and targeted passage lookup
- Register native fetch_content and read_web_content tools in the web product group and route results through the existing inbound scanner and tool-result cap
- Return source metadata, total lengths, returned range, and continuation guidance without embedding full content

## Integration Expectation

Deliver this contribution for integration in stage 02-fetch.

## Context

- The gateway is a native host process and must not acquire an ambient arbitrary-URL fetch path.
- The new worker is a supervised internal-only container reached from the host through the existing loopback ingress path; its public HTTP traffic exits only through the existing egress proxy.
- LAN/private destinations are accepted for this story. The required boundary is canonical DNS/domain filtering, especially known dangerous domains, plus redirect, scheme, port, time, and size limits.
- The full web artifact belongs to the authenticated user and remains outside the append-only conversation projection until explicitly retrieved.

## Boundary — Excluded

- Web search, SearXNG querying, or model summarization
- Remote hosted extraction providers, authenticated browser-cookie fetch, video, GitHub clone, or PDF-specialized workflows
- Blocking LAN/private IP destinations
- Removing fetch-mcp before final cutover

## Interfaces and Dependencies

- Outbound-worker requests accept only validated operation inputs and never model-supplied credentials
- OutboundWorkerClient maps network/HTTP/schema failures into typed domain results and never leaks internal errors to the model
- Web artifacts are addressed by opaque IDs and ownership is checked from the broker-held user capability, not a caller-supplied userId
- read_web_content supports either bounded offset/limit retrieval or bounded passage matching, not an unbounded dump
- Operator-tunable limits and domain policy live in YAML/config surfaces; protocol constants and extraction details remain in code

## Constraints

- No native gateway code path may directly dereference model-supplied public URLs
- The worker must have no direct external network route except through egress-proxy
- Every redirect is checked before following it
- Fetched and extracted content is untrusted, scanned, capped, and never logged
- Artifact files and directories use restrictive permissions and bounded retention
- A blocked source may be reported by hostname/reason but its body is never fetched or returned
