# Task Brief: Manage household scenes, automations, scripts, todos, and calendars

## Contribution Goal

Family members can inspect, create, modify, and deliberately remove common Home Assistant household configuration through standard Sentient tools without enabling administrative escape hatches.

## Boundary — Included

- Add standard compact Home tool contracts to get, create, and update scenes, automations, and scripts using validated structured inputs and natural-name resolution
- Add standard tools for todo reads/add/update/remove and calendar event reads/create/update/remove
- Support common native HA constructs for time, sun, state, numeric state, event, device, and zone triggers; routine conditions/actions; script sequences; scene state capture; and blueprint-backed automation where the native API supports it
- Read existing configuration before targeted modification, use upstream version/hash or equivalent optimistic-concurrency protection where available, and return conflict rather than overwriting changed state
- Validate referenced entities, areas, scenes, scripts, and automations before write dispatch
- Keep dedicated removal tools visible with confirm-level defaults and semantic deleted/not_found/conflict/accepted_unverified outcomes
- Keep raw Python transforms, YAML/files, generic custom code, and system administration in advanced/off groups rather than smuggling them into standard configuration tools
- Update Home settings descriptions so users understand the capability and impact of each standard and advanced tool

## Required Work

- Add standard compact Home tool contracts to get, create, and update scenes, automations, and scripts using validated structured inputs and natural-name resolution
- Add standard tools for todo reads/add/update/remove and calendar event reads/create/update/remove
- Support common native HA constructs for time, sun, state, numeric state, event, device, and zone triggers; routine conditions/actions; script sequences; scene state capture; and blueprint-backed automation where the native API supports it
- Read existing configuration before targeted modification, use upstream version/hash or equivalent optimistic-concurrency protection where available, and return conflict rather than overwriting changed state
- Validate referenced entities, areas, scenes, scripts, and automations before write dispatch
- Keep dedicated removal tools visible with confirm-level defaults and semantic deleted/not_found/conflict/accepted_unverified outcomes
- Keep raw Python transforms, YAML/files, generic custom code, and system administration in advanced/off groups rather than smuggling them into standard configuration tools
- Update Home settings descriptions so users understand the capability and impact of each standard and advanced tool

## Integration Expectation

Deliver this contribution for integration in stage 05-home-config.

## Context

- Scene, automation, and script setup are normal family-assistant behavior, not advanced administration.
- Home Assistant exposes different storage shapes: scenes capture entity-state maps, scripts contain sequences, and automations contain triggers, conditions, and actions. Sentient contracts must preserve capability without copying oversized MCP descriptions into every turn.
- The existing current catalog already includes todo and calendar behavior; the native surface must retain it.
- Deletes are visible but should resolve to confirmation by default. Live household writes remain prohibited during verification.

## Boundary — Excluded

- Raw YAML/package editing, arbitrary Python transforms, dashboards, add-ons, HACS, backups, updates/restarts, registries, custom tools, or ambient behavior
- Live creation, modification, activation, or deletion against the user's Home Assistant
- Replacing HA's own validation or configuration persistence semantics

## Interfaces and Dependencies

- Home configuration tools accept Sentient-defined structured inputs and return canonical resource identifiers plus semantic outcomes
- Updates that depend on a prior read carry an optimistic version/hash through the adapter; stale writes fail as conflict
- Delete contracts are separate from create/update so permissions can require confirmation without making routine edits invisible
- Adapter output validation distinguishes accepted, queryable/verified, rejected, conflict, not_found, failed, and accepted_unverified
- Tool definitions remain bounded; detailed guidance belongs in prompt resources or code validation, not multi-thousand-character inline descriptions

## Constraints

- All writes pass role and per-tool mediation immediately before dispatch
- No automatic retry for create/update/delete after ambiguous transport failure
- Validate unknown HA responses and never trust model-produced configuration as authorization
- Never log configuration bodies, entity states, event details, todos, calendar content, prompts, or credentials
- All write behavior is tested with controlled doubles; live checks are observational only
