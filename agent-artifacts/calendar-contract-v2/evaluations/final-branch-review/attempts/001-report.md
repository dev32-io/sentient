# Evaluation Report: final-branch-review

## Boundary

{"workItem":"calendar-contract-v2"}

## Criteria Evaluated

No qualified criteria declared.

## Observations

MERGE: NO

Fresh boundary checks passed: gateway 178 tests plus typecheck, web 11 tests plus typecheck, and mobile calendar/privacy-focused build checks. However, the reviewed commit has five open findings: three blocking Major contract/scope defects, one additional blocking Major legacy-input defect, and one non-blocking Minor config-range mismatch. The blocking issues are the prohibited UI/screen changes, silently dropped web list query filtering, retained KMP V1 more/baseEventId compatibility normalization, and accepted legacy web {rrule,rule} recurrence input. These violate explicit clean-cutover and no-UI acceptance requirements.

## Evidence

- **EV-001:** Gateway calendar/domain, adapter, REST, bootstrap, and lifecycle checks. — 178 tests passed; gateway typecheck passed
- **EV-002:** Web calendar service/component checks. — 11 tests passed; web typecheck passed
- **EV-003:** Mobile SDK/data calendar/privacy tests and Android/KMP compilation. — BUILD SUCCESSFUL
- **EV-004:** Repository remained unchanged during review. — clean; no diff-check output

## Findings

- **CAL-V2-FINAL-001** (high, open): Feature diff modifies calendar UI/screens/ViewModels and related UI files despite the explicit no-UI-change boundary.
- **CAL-V2-FINAL-002** (high, open): Web CalendarApi.list sends query, but REST listInput drops it, so list({query}) silently returns unfiltered events.
- **CAL-V2-FINAL-003** (high, open): KMP retains CalendarEventPage.more and CalendarEvent.baseEventId, and sets baseEventId = eventId in occurrence conversion.
- **CAL-V2-FINAL-005** (high, open): Web client accepts legacy {rrule,rule} recurrence objects and converts them into V2 payloads.
- **CAL-V2-FINAL-004** (medium, open): calendar.nudge.max_per_day permits zero via min(0), conflicting with the stated positive-range requirement.

## Verdict

fail

## Residual Risk

- The passing checks are boundary/unit and compile checks; no separately launched browser/mobile full-stack run was required by the persisted evidence matrix.
- The nudge zero-limit issue may be intentional as a disable setting, but it conflicts with the stated positive-range requirement.
