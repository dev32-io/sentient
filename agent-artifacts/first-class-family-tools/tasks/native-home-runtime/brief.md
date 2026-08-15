# Task Brief: Observe and operate the home through native tools

## Contribution Goal

Family members can discover household resources, read home state, and invoke routine controls, scenes, scripts, and automations through Sentient-owned Home tools without HA MCP discovery.

## Boundary — Included

- Implement a typed, cancellable HomeAdapter for the configured HA REST and WebSocket APIs with exact-origin policy, bounded reconnect/request behavior, runtime validation, and sanitized failures
- Register compact standard Home tools for overview, search across entities/scenes/automations/scripts, entity state, history, floors/areas/zones, permitted camera reads, and operation status
- Register standard dedicated activation/control tools for routine entities, scenes, scripts, and automations without exposing raw service-call syntax as the primary model contract
- Resolve natural names and room/area constraints deterministically; return candidate identifiers on ambiguity instead of guessing
- Normalize results into semantic outcomes such as succeeded, not_found, ambiguous, unavailable, rejected, failed, and accepted_unverified
- Classify impact honestly so observation is read, routine household actions are mediated as write, and sensitive controls cannot hide inside a broadly allowed read tool
- Route all native definitions and dispatches through product-group permissions and the existing inbound scanner/result cap
- Degrade HA unavailability per call without affecting web, music, or session channels

## Required Work

- Implement a typed, cancellable HomeAdapter for the configured HA REST and WebSocket APIs with exact-origin policy, bounded reconnect/request behavior, runtime validation, and sanitized failures
- Register compact standard Home tools for overview, search across entities/scenes/automations/scripts, entity state, history, floors/areas/zones, permitted camera reads, and operation status
- Register standard dedicated activation/control tools for routine entities, scenes, scripts, and automations without exposing raw service-call syntax as the primary model contract
- Resolve natural names and room/area constraints deterministically; return candidate identifiers on ambiguity instead of guessing
- Normalize results into semantic outcomes such as succeeded, not_found, ambiguous, unavailable, rejected, failed, and accepted_unverified
- Classify impact honestly so observation is read, routine household actions are mediated as write, and sensitive controls cannot hide inside a broadly allowed read tool
- Route all native definitions and dispatches through product-group permissions and the existing inbound scanner/result cap
- Degrade HA unavailability per call without affecting web, music, or session channels

## Integration Expectation

Deliver this contribution for integration in stage 02-foundations.

## Context

- The gateway already stores a configured Home Assistant URL, local host mapping, and token used by ha-mcp; native adapters must reuse the secret boundary without placing credentials in model context.
- Home Assistant external input is untrusted and must be validated. Natural names should resolve to stable entity/area identifiers with explicit not-found and ambiguity outcomes.
- Scene activation and automation/script triggering are common standard behavior, even though their implementation may call generic HA services.
- Live household mutations are prohibited during development and evaluation; only observational live HA calls are allowed.

## Boundary — Excluded

- Creating, editing, or deleting scenes, automations, or scripts
- Todos and calendar mutations
- Raw YAML/files, raw WebSocket escape hatches, add-ons, updates, restart, HACS, registry administration, or custom code
- Ambient HA event ingestion
- Removing ha-mcp before native configuration coverage and final cutover

## Interfaces and Dependencies

- HomeAdapter accepts validated domain requests and owns credentials; tool runners never accept URL, token, or arbitrary headers from model arguments
- Natural-name resolution returns exactly one target, not_found, or ambiguity with bounded candidates
- Side-effecting calls are never transparently retried after dispatch ambiguity
- Dedicated activation hides generic service plumbing while preserving the resolved target and semantic outcome
- Tool descriptions and schemas stay compact enough for always-visible standard use
- Implement only the pre-wired Home provider contribution and Home-owned configuration fragments established in stage 01; do not modify web or Music contributions

## Constraints

- Never expose or log HA tokens, raw state payloads, camera bodies, user requests, or household content
- Never use live HA control, activation, scene, script, or automation calls in tests; use fakes/mocks for every write path
- Live observational checks may read overview, search, state, history, areas, zones, camera metadata/image only when permitted, and operation status
- Model-emitted entity IDs and actions are validated and permission-mediated before execution
- A timeout after possible dispatch returns accepted_unverified and must not cause adapter or loop retry
