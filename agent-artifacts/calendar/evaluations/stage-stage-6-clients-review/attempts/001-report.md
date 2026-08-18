# Evaluation Report: stage-stage-6-clients-review

## Boundary

{"workItem":"calendar"}

## Criteria Evaluated

- Web calendar REST client and view over /api/v1/calendar matching golden fixtures
- Mobile SDK CalendarHttpClient golden-fixture wire fidelity and serving-tz representation

## Observations

MERGE: NO

Stage checks pass, but the bounded client work does not satisfy the calendar acceptance contract.

Major findings:
- [CAL-001] Recurring occurrences are not wire-faithful to clients. `gateway/src/api/handlers/calendar.ts:toWire` serializes `event.start` even when passed an expanded `Occurrence`, and omits occurrence identity/start fields. `gateway/src/calendar/calendar-store.ts:list` returns occurrences, so the web client receives the base event start rather than each occurrence; recurring week/day rendering is therefore incorrect. This blocks merge for the required expansion behavior.
- [CAL-002] Required boundary-proof tests are missing. The web contribution contains only two REST-client tests (`gateway/webui/src/services/calendar-api.test.ts`); there are no calendar view tests, no device-timezone rendering test, and no view CRUD behavior test. This leaves the explicitly required acceptance coverage unverified and blocks merge.

The REST/client compilation checks themselves passed, and no credential or content logging issue was observed in the reviewed files.

## Evidence

- **EV-001:** Declared web stage checks. — Passed: 18 files, 139 tests; TypeScript check passed.
- **EV-002:** Declared mobile stage checks. — BUILD SUCCESSFUL for both declared mobile stage checks.
- **EV-003:** Recurrence wire-fidelity evidence. — Store list returns Occurrence[]; handler toWire maps event.start and does not serialize occurrenceStart/occurrenceId.

## Findings

- **CAL-001** (high, open): Expanded occurrence starts are discarded at the REST boundary, so recurring instances render at the base event start.
- **CAL-002** (high, open): No calendar view, device-timezone, or view CRUD tests were added; only two REST-client tests exist.

## Verdict

fail

## Residual Risk

- Mobile SDK golden coverage is limited to GET/list despite the required CRUD wire surface; the implementation compiles and the declared Calendar test filter passes, but POST/PATCH/DELETE fidelity is not directly pinned.
