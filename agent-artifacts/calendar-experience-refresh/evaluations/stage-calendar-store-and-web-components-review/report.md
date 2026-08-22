# Evaluation Report: stage-calendar-store-and-web-components-review

## Boundary

{"workItem":"calendar-experience-refresh"}

## Criteria Evaluated

- Atomic observable SQLDelight store, raw RFC3339 temporal round-trip, and namespace/purge behavior
- Web leaf components remain isolated through a typed CalendarWorkspace canvas slot, component-scoped CSS, shared calendar-time helpers, and explicit draft/capability ownership
- Exact web comparison uses sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/web/calendar.html, and sentient-design/components/web/sentient-web.js at 1440x1000, 1024x900, 768x900, and 390x844
- 900px sidebar collapse, seven-column no-overflow correction, viewport-safe preview, Dialog inert/safe dismissal, complete V2 editor, focus, semantics, and reduced motion

## Observations

MERGE: YES

Iteration 2 verifies closure of both remaining blockers. The normalized CalendarWorkspace action adapter now handles anchor-only and compatibility callback shapes, with focused routing tests. The evidence packet now contains labeled side-by-side Day, Week, Month, and Year comparisons at all four required viewports plus 16-state scrollWidth/clientWidth measurements. All stage checks pass: mobile-data allTests, web unit 221/221, typecheck, build, and diff check. No repair-introduced regression was found within the bounded diff.

## Evidence

- **EV-001:** source scripts/env.sh && ./gradlew :shared:mobile-data:allTests — BUILD SUCCESSFUL
- **EV-002:** source scripts/env.sh && bun run --filter @sentient/webui test:unit — 28 test files passed; 221 tests passed
- **EV-003:** source scripts/env.sh && bun run --filter @sentient/webui typecheck — passed
- **EV-004:** source scripts/env.sh && bun run --filter @sentient/webui build — built successfully
- **EV-005:** source scripts/env.sh && git diff --check — passed
- **EV-006:** python3 generated responsive evidence matrix — 16 production states complete; all page/canvas overflow checks pass; narrow Month/Week have seven columns, compact controls, and 44x44 minimum targets
- **EV-007:** find .../files -name 'comparison-*.png' — 16 labeled Day/Week/Month/Year side-by-side artifacts exist at every required viewport
- **EV-008:** bun run --filter @sentient/webui test:unit -- src/components/calendar/calendar-shell.test.tsx — focused callback-routing tests pass, including anchor-only and compatibility aliases

## Findings

- **CAL-STORE-OBS-001** (high, resolved): Single-query metadata/occurrence decoding and deterministic concurrency coverage remain intact.
- **CAL-WEB-SLOT-001** (high, resolved): Shared slot contract remains unified.
- **CAL-WEB-TARGET-001** (high, resolved): Required narrow targets remain 44x44 without overflow.
- **CAL-WEB-SCOPE-001** (high, resolved): Immutable source scope remains enforced.
- **CAL-WEB-YEAR-LOCALE-001** (medium, resolved): Locale/weekStartsOn handling remains covered.
- **CAL-WEB-EVIDENCE-001** (high, resolved): All 16 labeled side-by-side artifacts are present.
- **CAL-WEB-SLOT-002** (high, resolved): Normalized adapter covers anchor-only and compatibility aliases with focused tests.

## Verdict

pass

## Residual Risk

None recorded.
