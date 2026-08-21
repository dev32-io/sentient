# Evaluation Report: stage-calendar-core-foundations-review

## Boundary

{"workItem":"calendar-experience-refresh"}

## Criteria Evaluated

- Pinned SQLDelight/Kotlin 2.3.10 compatibility, source-set-correct dependencies, schema/migration/namespace correctness, and commonMain purity
- Deterministic Day/Week/Month/Year, raw temporal, filter, overflow, and navigation contracts
- Explicit all-scope complete web pagination, account/backend preference isolation, and calendar-view.tsx remaining untouched
- Exact reference vocabulary is checked directly against sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/web/calendar.html, sentient-design/components/web/sentient-web.js, sentient-design/design/mobile/calendar.html, and sentient-design/components/mobile/sentient-mobile.js without importing prototype data

## Observations

MERGE: YES

Iteration 2 closes all prior findings. The calendar view and test now match the prior approved stage boundary and use the single shared `calendar-time.ts` implementation. Month selection, alias-shaped filters, and backend namespace fail-closed behavior remain verified. The repair preserves raw offset-bearing V2 start/end/originalStart values, all-day identities, and no longer forwards or synthesizes a compatibility timezone. No repair-introduced regression was observed.

## Evidence

- **EV-001:** Recorded evidence — Sanitized direct raw-temporal probe and boundary/helper checks passed.
- **EV-002:** source scripts/env.sh && ./gradlew :shared:mobile-data:allTests — BUILD SUCCESSFUL
- **EV-003:** source scripts/env.sh && bun run --filter @sentient/webui test:unit && bun run --filter @sentient/webui typecheck — 174 unit tests passed; typecheck exited 0
- **EV-004:** source scripts/env.sh && git diff --check — passed with no output

## Findings

- **CAL-FOUND-001** (high, resolved): Approved shared-helper boundary restored.
- **CAL-FOUND-002** (high, resolved): Verified resolved.
- **CAL-FOUND-003** (high, resolved): Verified resolved.
- **CAL-FOUND-004** (high, resolved): Verified resolved.
- **CAL-FOUND-005** (high, resolved): Verified resolved; no synthesized or inferred event timezone remains in the repaired path.

## Verdict

pass

## Residual Risk

- Native platform driver/path wiring, shared mobile cache policy, and UI assembly remain outside this stage boundary.
