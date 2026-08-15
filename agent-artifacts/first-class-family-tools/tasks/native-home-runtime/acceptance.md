# Task Acceptance: Observe and operate the home through native tools

## Deliverables

- Family members can discover household resources, read home state, and invoke routine controls, scenes, scripts, and automations through Sentient-owned Home tools without HA MCP discovery.

## Acceptance

- Standard Home definitions are available with ha-mcp absent
- A user can search for lights, scenes, scripts, and automations and receive bounded unambiguous identifiers or candidate choices
- State, history, area/zone, overview, and permitted camera observations return validated bounded results
- Routine control and scene/script/automation activation execute through dedicated native contracts and return semantic outcomes under mocked adapters
- A stale permission or role-denied invocation fails before HomeAdapter side effects
- HA connection failure leaves other tool groups and session processing healthy

## Boundary Proof

- Adapter contract tests validate REST/WebSocket envelopes, reconnect/timeout behavior, cancellation, exact-origin credentials, and sanitized failures
- Resolver tests cover exact, alias, area-constrained, zero-match, and multi-match behavior
- Tool tests cover product-group visibility, impact/permission mediation, inbound scanning, result caps, semantic outcomes, and no automatic retry
- Optional live evidence is read-only: authenticate to local dev with PIN 1234 and inspect HA overview/search/state only; no test may invoke a mutating Home tool
