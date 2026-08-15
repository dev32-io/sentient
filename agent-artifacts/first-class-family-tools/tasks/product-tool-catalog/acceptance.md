# Task Acceptance: Govern tools by stable product group

## Deliverables

- Users can govern existing native and MCP tools through stable product groups, with identical visibility and dispatch decisions across gateway, web settings, and mobile settings.

## Acceptance

- An existing MCP tool and an existing native tool can appear in the same product-group projection while dispatching through their original execution lanes
- A group wildcard affects all tools in that group, and an explicit per-tool value overrides it
- Switching a tool off removes it on the next turn and a stale/hallucinated call still fails at dispatch
- A fresh profile sees standard tools according to role defaults and no advanced tools
- Legacy deny/off values for fetch, SearXNG, HA, MA, gateway, and native tools cannot become allow/ask after migration
- Web and KMP clients decode, display, edit, reset, and save the same product-group permission contract
- Empty web, Home, and Music contribution slots compose successfully and can be implemented independently after this stage without changing the authoritative registry shape

## Boundary Proof

- Focused resolver tests cover precedence, role ceiling, standard/advanced defaults, native/MCP parity, and mid-turn rechecks
- Migration fixtures cover every legacy group, collisions, absent maps, empty maps, wildcard values, per-tool values, and unmappable restrictive entries
- Gateway API, web patch helper, and KMP patch helper tests pin one shared wire shape and reset semantics
- Provider-composition tests prove the three group slots are independently replaceable and produce one authoritative catalog
