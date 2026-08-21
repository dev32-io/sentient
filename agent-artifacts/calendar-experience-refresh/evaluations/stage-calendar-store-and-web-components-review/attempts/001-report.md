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

Stage checks pass (mobile-data allTests, web unit tests 215/215, typecheck, build, and diff check), but the reviewed commit has blocking contract and correctness defects:

- Major CAL-STORE-OBS-001: snapshot observation reads occurrence rows and metadata in separate operations, so concurrent replacements can produce a mixed or failed observable snapshot.
- Major CAL-WEB-SLOT-001: CalendarWorkspace and CalendarCanvas define incompatible same-named slot contracts; the shell does not pass projection, loading, or canvas callbacks, so directly supplying CalendarCanvas renders unavailable content and cannot wire interactions.
- Major CAL-WEB-TARGET-001: narrow canvas date/event/overflow controls are 24px/22px/20px actual hit targets, not 44px effective targets.
- Major CAL-WEB-SCOPE-001: editing the Calendar selector sends the changed scope as the mutation lookup scope, although V2 update/delete has no scope-change operation; this fails or can target a same-ID event in another scope.
- Major CAL-WEB-EVIDENCE-001: no required reference screenshots, side-by-side comparison record, browser viewport run, or scrollWidth evidence is present.
- Minor CAL-WEB-YEAR-LOCALE-001: Year is hard-coded Sunday-first and Week/Month omit the projection locale for visible weekday labels.

The implementation is unchanged.

## Evidence

- **EV-001:** source scripts/env.sh && ./gradlew :shared:mobile-data:allTests — BUILD SUCCESSFUL
- **EV-002:** source scripts/env.sh && bun run --filter @sentient/webui test:unit — 28 test files passed; 215 tests passed
- **EV-003:** source scripts/env.sh && bun run --filter @sentient/webui typecheck — passed
- **EV-004:** source scripts/env.sh && bun run --filter @sentient/webui build — built successfully
- **EV-005:** source scripts/env.sh && git diff --check 85f0f851c3803bc6d16e80d80c3132a76a2e1559 ae6359d4d2a2db86922ad0deb01e156e2713dc9c — passed
- **EV-006:** git diff --no-ext-diff --name-only 85f0f851c3803bc6d16e80d80c3132a76a2e1559 ae6359d4d2a2db86922ad0deb01e156e2713dc9c | grep -Ei '\.(png|jpe?g|webp|pdf)$|screenshot|visual|evidence' — no matching visual evidence files
- **EV-007:** grep -R "scrollWidth" -n gateway/webui/src/components/calendar — no scrollWidth assertions

## Findings

- **CAL-STORE-OBS-001** (high, open): Snapshot flow can combine rows and metadata from different replacements.
- **CAL-WEB-SLOT-001** (high, open): Shell and leaf canvas expose incompatible slot contracts and no projection wiring.
- **CAL-WEB-TARGET-001** (high, open): Narrow canvas controls are below the required 44px effective target.
- **CAL-WEB-SCOPE-001** (high, open): Editable scope is used as lookup scope despite no V2 scope-change command.
- **CAL-WEB-EVIDENCE-001** (high, open): Required visual and scrollWidth evidence is absent.
- **CAL-WEB-YEAR-LOCALE-001** (medium, open): Weekday placement and labels ignore locale/weekStartsOn in several canvas renderers.

## Verdict

fail

## Residual Risk

- Exact Dusk visual fidelity and 1440x1000, 1024x900, 768x900, and 390x844 no-overflow behavior remain unverified without the required browser evidence.
- Dialog focus restoration under real browser inert behavior and store lifecycle races are covered only by unit-level evidence, not local-stack/browser evidence.
