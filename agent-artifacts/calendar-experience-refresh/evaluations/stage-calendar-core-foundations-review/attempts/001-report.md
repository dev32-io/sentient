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

Major/blocking findings:
- CAL-FOUND-001 — `gateway/webui/src/components/calendar/calendar-view.tsx` and its test are changed, violating the explicit stage boundary that this file remains untouched until assembly.
- CAL-FOUND-002 — `selectCalendarDate` retains Month view, and controller `selectDate` only sets selectedDate; Month selection does not enter focused Day as required.
- CAL-FOUND-003 — `setFilters` accepts the exported `scope`/`group`/`text`/`query` filter shapes but `safeFilters`/preference validation silently ignore those aliases, so supported filters can be no-ops.
- CAL-FOUND-004 — Missing backend identity falls back to origin/`default-backend`; distinct injected backends can therefore reuse one account preference namespace instead of isolating or failing closed.

The SQLDelight/Kotlin builds, mobile tests, web unit tests/typecheck, XCFramework link for both iOS targets, and diff check passed. No commonMain platform-API or prototype-data/diagnostic-content issue was found.

## Evidence

- **EV-001:** source scripts/env.sh && ./gradlew :shared:mobile-data:allTests — BUILD SUCCESSFUL
- **EV-002:** source scripts/env.sh && ./gradlew :shared:mobile-data:assembleMobileDataDebugXCFramework — BUILD SUCCESSFUL; iosArm64 and iosSimulatorArm64 framework links completed
- **EV-003:** source scripts/env.sh && bun run --filter @sentient/webui test:unit && bun run --filter @sentient/webui typecheck — 169 unit tests passed; typecheck exited 0
- **EV-004:** source scripts/env.sh && git diff --check 57e24fb8c9f3f23a2fc037848c9a8a2ab85d10ec 040e1ddbdb05fa626a61f7966e2196f691114e9d — passed with no output
- **EV-005:** Fresh runtime and changed-path evidence. — Sanitized probes show Month date selection remains in month view, alias-shaped controller filters are ignored, and calendar-view.tsx plus its test are in the bounded diff.

## Findings

- **CAL-FOUND-001** (high, open): Existing calendar-view.tsx and its test are modified within the foundation stage.
- **CAL-FOUND-002** (high, open): Month date selection remains in Month instead of transitioning to focused Day.
- **CAL-FOUND-003** (high, open): Alias-shaped scope, group, and text filters are silently discarded.
- **CAL-FOUND-004** (high, open): Optional backend identity can collapse distinct backends into one preference namespace.

## Verdict

fail

## Residual Risk

- Native platform driver/path wiring, shared mobile cache policy, and UI assembly are outside this stage boundary and remain unreviewed here.
