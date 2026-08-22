# Evaluation Report: stage-calendar-experience-and-web-assembly-review

## Boundary

{"workItem":"calendar-experience-refresh"}

## Criteria Evaluated

- Shared cache-first complete pagination, stale-while-revalidate, coalescing, cancellation, one coherent StateFlow, source-compatible SettingsComponent/factory exposure, and Android intermediate compilation
- Complete web route, authenticated capability projection, Dialog safety, exact V2 mutations, and deterministic local-only disposable fixture/cleanup adapter
- Production web is compared by the final E2E agent through Playwright MCP against sentient-design/design/web/calendar.html and sentient-design/components/web/sentient-web.js at exactly 1440x1000, 1024x900, 768x900, and 390x844
- Web CAL-UX-001..007, 013, and 014 use unique synthetic data, guaranteed cleanup, semantic/keyboard/focus evidence, and documented deviations without adding a separate browser-runner project or mandatory screen-reader gate

## Observations

MERGE: YES_WITH_RISK

Re-review was limited to the bounded repairs in d61b7f8d and 5a64362e. All six prior findings are verified resolved: namespace switching now clears/epochs state with namespace-pinned writes, unauthorized web responses are non-disclosing, Year month selection enters Month, fixture cleanup avoids fixed home deletion, overflow focus uses a mounted fallback, and timezone changes revalidate. No repair-introduced blocking regression was found.

## Evidence

- **EV-001:** source scripts/env.sh && bun run --filter @sentient/webui test:unit && bun run --filter @sentient/webui typecheck && bun run --filter @sentient/webui build — PASS: 28 files, 228 tests; typecheck and build pass; only chunk-size warning
- **EV-002:** source scripts/env.sh && ./gradlew :shared:mobile-data:allTests :android:assembleDebug — PASS: BUILD SUCCESSFUL
- **EV-003:** source scripts/env.sh && ./gradlew :shared:mobile-data:testDebugUnitTest --rerun-tasks --console=plain — PASS: BUILD SUCCESSFUL; 30 tasks executed
- **EV-004:** source scripts/env.sh && git diff --check — PASS: no output
- **EV-005:** Fresh evidence stored outside the repository; contains no credentials, tokens, user content, or raw logs. — Sanitized metadata-only review manifest for the reviewed commit, repair commits, and check outcomes.

## Findings

- **CAL-REVIEW-001** (critical, resolved): Synchronous namespace invalidation, epoch checks, and namespace-pinned atomic writes prevent predecessor state or completions crossing namespaces.
- **CAL-REVIEW-002** (high, resolved): 401/403/authentication failures clear cached occurrences and render a non-disclosing permission state.
- **CAL-REVIEW-003** (high, resolved): Year month selection now sets Month view and the selected anchor through one controller intent.
- **CAL-REVIEW-004** (high, resolved): Fixture ownership is unique and cleanup deletes seeded rows plus run-owned databases/users without deleting fixed shared home storage.
- **CAL-REVIEW-005** (low, resolved): Overflow preview focus restoration uses a mounted trigger or deterministic mounted view-bar fallback.
- **CAL-REVIEW-006** (low, resolved): Locale-derived timezone changes create a distinct window identity and trigger revalidation.

## Verdict

pass

## Residual Risk

- The final Playwright MCP agent still must provide the exact 1440x1000, 1024x900, 768x900, and 390x844 visual/semantic evidence and guaranteed local fixture cleanup; this stage re-review did not run that matrix.
- Gradle emits existing Kotlin/Gradle configuration warnings, but all requested tasks pass.
