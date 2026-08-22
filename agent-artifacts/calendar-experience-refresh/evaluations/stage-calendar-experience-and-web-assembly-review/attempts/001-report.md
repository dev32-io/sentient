# Evaluation Report: stage-calendar-experience-and-web-assembly-review

## Boundary

{"workItem":"calendar-experience-refresh"}

## Criteria Evaluated

- Shared cache-first complete pagination, stale-while-revalidate, coalescing, cancellation, one coherent StateFlow, source-compatible SettingsComponent/factory exposure, and Android intermediate compilation
- Complete web route, authenticated capability projection, Dialog safety, exact V2 mutations, and deterministic local-only disposable fixture/cleanup adapter
- Production web is compared by the final E2E agent through Playwright MCP against sentient-design/design/web/calendar.html and sentient-design/components/web/sentient-web.js at exactly 1440x1000, 1024x900, 768x900, and 390x844
- Web CAL-UX-001..007, 013, and 014 use unique synthetic data, guaranteed cleanup, semantic/keyboard/focus evidence, and documented deviations without adding a separate browser-runner project or mandatory screen-reader gate

## Observations

MERGE: NO

Stage checks pass, but the bounded implementation has three blocking correctness/privacy defects: mobile namespace transitions can leak/write prior-account cache data, expired web authorization retains and renders cached private events, and Year month selection does not enter Month view. The local fixture cleanup also removes a shared household database, and two smaller accessibility/timezone issues remain.

## Evidence

- **EV-001:** source scripts/env.sh && bun run --filter @sentient/webui test:unit — PASS: 28 test files, 225 tests
- **EV-002:** source scripts/env.sh && bun run --filter @sentient/webui typecheck && bun run --filter @sentient/webui build — PASS: typecheck and production build; build emitted only a chunk-size warning
- **EV-003:** source scripts/env.sh && ./gradlew :shared:mobile-data:allTests :android:assembleDebug — PASS: BUILD SUCCESSFUL
- **EV-004:** source scripts/env.sh && git diff --check — PASS: no output
- **EV-005:** git diff --stat 5c961a1f91a0cd1d6eb8fd62deb3ac140a6f8921 a72f47256f8f96faf23bef415258bba52dfa72cb — 22 bounded files changed; implementation includes shared CalendarExperience, web route assembly, and local fixture adapter

## Findings

- **CAL-REVIEW-001** (critical, open): Namespace changes do not clear prior snapshot/preferences or invalidate in-flight revalidation, allowing prior-account occurrences to be displayed or committed into the newly active cache namespace.
- **CAL-REVIEW-002** (high, open): Only forbidden is rendered as permission; 401 codes such as expired retain and display CalendarController cached private occurrences behind a stale notice.
- **CAL-REVIEW-003** (high, open): Year month selection only changes the anchor date and never changes the controller view to Month.
- **CAL-REVIEW-004** (high, open): Fixture cleanup deletes the fixed shared home calendar database, so concurrent runs or unrelated local household data are not isolated.
- **CAL-REVIEW-005** (low, open): The overflow dialog is unmounted while its button is retained as preview origin; closing the preview cannot restore focus to the detached origin.
- **CAL-REVIEW-006** (low, open): Timezone-only locale changes reuse the previous cache key and can skip revalidation for a newly projected device-local interval.

## Verdict

fail

## Residual Risk

- Final Playwright MCP evidence was not collected in this stage review; the persisted final-E2E agent must still run the exact 1440x1000, 1024x900, 768x900, and 390x844 matrix with guaranteed local cleanup.
- Gradle verification completed successfully with most tasks UP-TO-DATE; no repository files were changed during review.
