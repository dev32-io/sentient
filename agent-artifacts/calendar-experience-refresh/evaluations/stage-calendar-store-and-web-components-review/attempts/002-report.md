# Evaluation Report: stage-calendar-store-and-web-components-review

## Boundary

{"workItem":"calendar-experience-refresh"}

## Criteria Evaluated

- Atomic observable SQLDelight store, raw RFC3339 temporal round-trip, and namespace/purge behavior
- Web leaf components remain isolated through a typed CalendarWorkspace canvas slot, component-scoped CSS, shared calendar-time helpers, and explicit draft/capability ownership
- Exact web comparison uses sentient-design/HANDOFF.md, sentient-design/brand-spec.md, sentient-design/design/web/calendar.html, and sentient-design/components/web/sentient-web.js at 1440x1000, 1024x900, 768x900, and 390x844
- 900px sidebar collapse, seven-column no-overflow correction, viewport-safe preview, Dialog inert/safe dismissal, complete V2 editor, focus, semantics, and reduced motion

## Observations

MERGE: NO

Iteration 1 repair verification: all stage checks pass (mobile-data allTests, web unit 219/219, typecheck, build, and diff check). CAL-STORE-OBS-001, CAL-WEB-SLOT-001, CAL-WEB-TARGET-001, CAL-WEB-SCOPE-001, and CAL-WEB-YEAR-LOCALE-001 are resolved by the bounded repair.

Two blocking issues remain:

- Major CAL-WEB-EVIDENCE-001: the repair provides the full 16-entry production viewport matrix and reference captures, but only `comparison-month-*.png` side-by-side artifacts. The explicit canvas acceptance requires Day, Week, Month, and Year side-by-side comparison at all four required viewports; Day/Week/Year comparisons are absent.
- Major CAL-WEB-SLOT-002: `CalendarWorkspace` falls back to `onDateChange` but not the documented `onAnchorDateChange` alias when constructing canvas callbacks. A supported consumer providing only `onAnchorDateChange` gets working date-navigation controls but inert canvas date, event fallback, overflow, and Year month navigation.

The evaluated worktree was not changed.

## Evidence

- **EV-001:** source scripts/env.sh && ./gradlew :shared:mobile-data:allTests — BUILD SUCCESSFUL
- **EV-002:** source scripts/env.sh && bun run --filter @sentient/webui test:unit — 28 test files passed; 219 tests passed
- **EV-003:** source scripts/env.sh && bun run --filter @sentient/webui typecheck — passed
- **EV-004:** source scripts/env.sh && bun run --filter @sentient/webui build — built successfully
- **EV-005:** source scripts/env.sh && git diff --check — passed
- **EV-006:** Sanitized responsive evidence summary generated outside the repository. — 16 production entries cover all four views at all four required viewports; narrow Month/Week have seven columns, no horizontal overflow, compact controls, and minimum 44x44 targets
- **EV-007:** find agent-artifacts/calendar-experience-refresh/evidence/stage-calendar-store-and-web-components-review/files -name 'comparison-*.png' — Only comparison-month-1024x900.png, comparison-month-1440x1000.png, comparison-month-390x844.png, and comparison-month-768x900.png exist
- **EV-008:** nl -ba gateway/webui/src/components/calendar/calendar-shell.tsx | sed -n '958,981p' — canvasDateSelect/canvasMonthSelect use onDateChange fallback; onAnchorDateChange is not included

## Findings

- **CAL-STORE-OBS-001** (high, resolved): Single-query metadata/occurrence decoding and deterministic concurrency coverage close the finding.
- **CAL-WEB-SLOT-001** (high, resolved): Shared slot contract now carries projection, state, and callbacks.
- **CAL-WEB-TARGET-001** (high, resolved): Required narrow sizes measure 44x44 targets without horizontal overflow.
- **CAL-WEB-SCOPE-001** (high, resolved): Edit scope is read-only and mutations use immutable source scope.
- **CAL-WEB-YEAR-LOCALE-001** (medium, resolved): Locale/weekStartsOn placement and labels now have focused coverage.
- **CAL-WEB-EVIDENCE-001** (high, open): Only Month has side-by-side comparisons; Day, Week, and Year side-by-side artifacts are absent.
- **CAL-WEB-SLOT-002** (high, open): onAnchorDateChange-only consumers lose canvas date/month callbacks.

## Verdict

fail

## Residual Risk

- Exact-reference visual acceptance remains incomplete until Day/Week/Year side-by-side comparisons are captured at 1440x1000, 1024x900, 768x900, and 390x844.
- Consumers using only the documented onAnchorDateChange alias cannot operate canvas date-selection actions until the fallback is wired.
