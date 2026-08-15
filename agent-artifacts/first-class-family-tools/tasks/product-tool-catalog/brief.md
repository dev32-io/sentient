# Task Brief: Govern tools by stable product group

## Contribution Goal

Users can govern existing native and MCP tools through stable product groups, with identical visibility and dispatch decisions across gateway, web settings, and mobile settings.

## Boundary — Included

- Define product tool group and tool metadata in shared configuration/types, including standard versus advanced default exposure without inferring it from transport
- Generalize the permission resolver, role defaults, broker target metadata, and catalog projection to address tools by product group while retaining MCP server identity for dispatch
- Make foreground and background built-in tools addressable through the same permission mechanism when intended by their metadata
- Implement a conservative profile migration from legacy server/native keys to stable product groups, including collisions and unmappable restrictive values
- Replace server-shaped settings projections with product-group sections while preserving wildcard and per-tool allow, ask, deny, and off edits
- Update web settings and shared KMP mobile settings models/patch helpers together, including advanced groups that default off and contribute no model definitions
- Keep settings changes effective on the next turn and recheck permissions at dispatch
- Establish pre-wired, typed, independently owned web, Home, and Music provider contribution slots plus configuration seams so those three implementations can land in parallel without editing the same registration authority

## Required Work

- Define product tool group and tool metadata in shared configuration/types, including standard versus advanced default exposure without inferring it from transport
- Generalize the permission resolver, role defaults, broker target metadata, and catalog projection to address tools by product group while retaining MCP server identity for dispatch
- Make foreground and background built-in tools addressable through the same permission mechanism when intended by their metadata
- Implement a conservative profile migration from legacy server/native keys to stable product groups, including collisions and unmappable restrictive values
- Replace server-shaped settings projections with product-group sections while preserving wildcard and per-tool allow, ask, deny, and off edits
- Update web settings and shared KMP mobile settings models/patch helpers together, including advanced groups that default off and contribute no model definitions
- Keep settings changes effective on the next turn and recheck permissions at dispatch
- Establish pre-wired, typed, independently owned web, Home, and Music provider contribution slots plus configuration seams so those three implementations can land in parallel without editing the same registration authority

## Integration Expectation

Deliver this contribution for integration in stage 01-governance.

## Context

- Today permissions are keyed by MCP server name, while foreground native tools share the synthetic native namespace and background tools may be unsettable.
- The new product group is an authorization and settings identity, not a transport identity. General MCP servers remain dispatchable by server while built-in tools can use stable groups such as web, home, music, memory, and skills.
- Permission precedence must remain centralized: explicit tool value, then group wildcard, then role/catalog default, then fail closed. Role reach is an independent upper bound.
- Existing profiles may contain fetch, searxng, home_assistant, music_assistant, gateway, and native keys. Migration must preserve explicit deny/off intent and never silently widen an unmappable entry.

## Boundary — Excluded

- Adding web, Home Assistant, or Music Assistant native runners
- Removing any MCP managed service or catalog entry
- Changing role membership or weakening impact-tier reach

## Interfaces and Dependencies

- Product group identity must be carried in authoritative tool metadata and must not be reconstructed from tool names in the broker or clients
- ToolBroker definitions() and dispatch() must call the same shared permission resolver
- Profile storage retains explicit absent-versus-empty and null-clear semantics
- The settings API must provide enough metadata for clients to render group masters and individual tools without rebuilding a permission map from a role-filtered read view
- General third-party MCP servers receive a stable default group without losing their server routing identity
- The bootstrap/catalog owns stable web, Home, and Music contribution slots before the parallel frontier begins; later providers implement only their group-owned module and must not add a second registry or modify another group's contribution
- Stage 01 is a release gate: its resolver, migration, gateway API, web, KMP, and provider-composition checks must pass before web, Home, and Music foundation tasks start

## Constraints

- A model-emitted tool call is never authorization
- Explicit deny/off values survive migration; ambiguous restrictive entries remain restrictive and surface diagnostics
- Advanced default-off tools are absent from tools[] until enabled
- Do not log profile permission bodies or credentials
- Preserve unrelated profile fields and existing MCP extensibility
