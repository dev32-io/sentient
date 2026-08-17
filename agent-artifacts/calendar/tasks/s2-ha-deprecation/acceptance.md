# Task Acceptance: Deprecate and hide the four HA calendar tools

## Deliverables

- Remove the four home_*_calendar_event tools from the model-facing surface entirely so they are absent from provider output, the MCP catalog, and role-default generation, while leaving adapter methods available for a future sync bridge and making orphaned profile permission entries harmless.

## Acceptance

- AC-008: none of home_get_calendar_events, home_create_calendar_event, home_update_calendar_event, home_remove_calendar_event appear in provider output, /api/v1/mcp-catalog, or the role-default template
- Orphaned profile.tools.permissions entries for removed HA calendar tools are harmless (optional migrator cleanup added)

## Boundary Proof

- Tests assert the four tools are absent from provider output and catalog projection; role-default generation omits them
