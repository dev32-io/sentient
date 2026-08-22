# Task Brief: Add operator-controlled calendar V2 safety limits

## Contribution Goal

Operators can tune every calendar query, input, paging, recurrence, and model-output bound through validated YAML while safe defaults remain below the generic tool-result backstop.

## Boundary — Included

- Shared orchestrator config schema and defaults
- Gateway YAML calendar V2 limits
- Config type mapping tests and fixture updates

## Required Work

- 1. Extend shared/config/src/schemas/orchestrator-config.ts and gateway/config.yaml with validated calendar.query, calendar.input, and calendar.output limits while retaining recurrence, nudge, and default_event_tz_id.
- 2. Pin defaults: query.max_days 366, query.max_occurrences 250, query.page_size 100; input.max_title_chars 512, max_description_chars 8000, max_query_chars 512, max_group_chars 128, max_tag_chars 64, max_tags 32; output.max_result_chars 16000. Keep recurrence max_occurrences 1000 and max_days 366.
- 3. Give every field a positive bounded schema range that permits lower test values and prevents operator values large enough to defeat recurrence/query safety or the generic 20000-character result cap. Validate output.max_result_chars at composition time as strictly below the generic backstop if the config framework cannot express the cross-field constraint.
- 4. Extend the internal CalendarConfig mapping/type produced by calendar-v2-contracts so query, input, output, recurrence, nudge, and resolved default event timezone are one immutable object consumed by stores/services/adapters.
- 5. Preserve default parsing when the new sub-blocks are omitted, but do not add calendar entries to operator-config-migrator.ts and do not introduce calendar data migration.
- 6. Update shared config schema tests and all direct OrchestratorConfig fixture literals identified by typecheck so defaults and explicit low test limits are covered.
- 7. Document each YAML setting concisely, including that tools fail with result_too_large while REST pages and that max_result_chars is a proactive limit rather than the broker cap.

## Integration Expectation

Deliver this contribution for integration in stage calendar-v2-config.

## Context

- Current shared/config calendar schema exposes recurrence max_occurrences/max_days, nudge max_per_day, and default_event_tz_id only.
- gateway/config.yaml sets the generic tool-result cap to 20000 characters; calendar must reject oversized output before that generic truncator.
- Operator-tunable behavior belongs in YAML/config, not hard-coded provider constants.

## Boundary — Excluded

- Bootstrap dependency wiring
- Temporal/query enforcement implementation
- Any automatic rewrite of operator or calendar data files

## Interfaces and Dependencies

- Produces validated orchestrator.calendar V2 configuration and a typed CalendarConfig mapping contract for gateway bootstrap.
- Consumed by temporal, recurrence, query, tool, REST, store, and nudge composition.
