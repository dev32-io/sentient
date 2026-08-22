# Evaluation Report: stage-calendar-core-foundations-review

## Boundary

{"workItem":"calendar-experience-refresh"}

## Criteria Evaluated

- Pinned SQLDelight/Kotlin 2.3.10 compatibility, source-set-correct dependencies, schema/migration/namespace correctness, and commonMain purity
- Deterministic Day/Week/Month/Year, raw temporal, filter, overflow, and navigation contracts
- Explicit all-scope complete web pagination, account/backend preference isolation, and calendar-view.tsx remaining untouched
- Exact reference vocabulary is checked directly against sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/web/calendar.html, sentient-design/components/web/sentient-web.js, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js without importing prototype data

## Observations

MERGE: NO

Re-review result:
- CAL-FOUND-001 remains open and blocking: the repair still changes `calendar-view.tsx` and its existing test instead of restoring the foundation boundary; it also removes the shared-helper assertion and duplicates temporal helpers in that view.
- CAL-FOUND-002 is resolved: Month date selection now transitions to focused Day.
- CAL-FOUND-003 is resolved: singular scope/group and text/query aliases are canonicalized and locally applied.
- CAL-FOUND-004 is resolved: absent backend identity no longer persists preferences, and explicit identities are normalized and isolated.
- CAL-FOUND-005 is a new Major, repair-introduced blocking regression: `calendar-view.tsx` forwards the CalendarApi compatibility `timeZoneId` as `eventTimeZoneId`, contrary to the temporal contract not to infer an IANA zone from that field. The repair also creates a second temporal helper implementation instead of consuming `calendar-time.ts`.

All stage checks passed: mobile-data tests, 172 web unit tests, web typecheck, and diff check.

## Evidence

- **EV-001:** Recorded evidence — Sanitized direct probes and repair-boundary evidence.
- **EV-002:** source scripts/env.sh && ./gradlew :shared:mobile-data:allTests — BUILD SUCCESSFUL
- **EV-003:** source scripts/env.sh && bun run --filter @sentient/webui test:unit && bun run --filter @sentient/webui typecheck — 172 unit tests passed; typecheck exited 0
- **EV-004:** source scripts/env.sh && git diff --check — passed with no output

## Findings

- **CAL-FOUND-001** (high, open): Repair did not restore the existing calendar view files to the stage boundary.
- **CAL-FOUND-002** (high, resolved): Month selection transition verified by regression test and probe.
- **CAL-FOUND-003** (high, resolved): Alias-shaped filters verified preserved and applied.
- **CAL-FOUND-004** (high, resolved): Missing identities fail closed and explicit identities isolate preferences.
- **CAL-FOUND-005** (high, open): Repair forwards compatibility timeZoneId as eventTimeZoneId and duplicates shared temporal helpers.

## Verdict

fail

## Residual Risk

- Native platform driver/path wiring, shared mobile cache policy, and UI assembly remain outside this stage boundary.
