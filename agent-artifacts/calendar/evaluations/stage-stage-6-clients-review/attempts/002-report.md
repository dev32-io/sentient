# Evaluation Report: stage-stage-6-clients-review

## Boundary

{"workItem":"calendar"}

## Criteria Evaluated

- Web calendar REST client and view over /api/v1/calendar matching golden fixtures
- Mobile SDK CalendarHttpClient golden-fixture wire fidelity and serving-tz representation

## Observations

MERGE: NO

CAL-001 is resolved by the bounded repair: the REST list now emits distinct occurrence identity and expanded start/end fields, and the web view keys rows by occurrenceId. The web view/device-timezone/CRUD tests were also added.

CAL-002 remains open and blocking. The manager-directed REST boundary proof requires a recurring-event list response containing N entries with distinct occurrenceId values and expanded per-occurrence starts, plus GET base-shape proof. `gateway/src/api/handlers/calendar.test.ts` now proves only one stub occurrence; it does not exercise or assert N recurring entries. The existing targeted handler test passes, but it is insufficient for the explicit acceptance requirement.

No repair-introduced functional regression was observed in the bounded diff.

## Evidence

- **EV-001:** Added view occurrence, device-timezone, and CRUD coverage. — Passed: 19 test files, 142 tests; typecheck passed.
- **EV-002:** Targeted REST/type contract verification; test covers one stub occurrence, not N recurring entries. — Typecheck passed; 9 targeted tests passed.
- **EV-003:** Declared mobile stage checks. — Both Gradle checks passed.
- **EV-004:** Bounded repair diff check. — No whitespace errors.

## Findings

- **CAL-001** (high, resolved): Expanded occurrence identity and times are now preserved through REST and rendered as distinct rows.
- **CAL-002** (high, open): The REST test asserts one stub occurrence, not N recurring response entries with distinct IDs and expanded starts as explicitly required.

## Verdict

fail

## Residual Risk

- Mobile SDK CRUD wire fidelity remains lightly tested, but this is pre-existing to the bounded repair and is deferred under re-review rules.
