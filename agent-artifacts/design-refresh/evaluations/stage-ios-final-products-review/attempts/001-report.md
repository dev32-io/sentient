# Evaluation Report: stage-ios-final-products-review

## Boundary

{"workItem":"design-refresh"}

## Criteria Evaluated

- Native iOS chat projection/outbox/task/permission/composer capture invariants with fake-only audio proof
- Setup/login/update/account/admin/secret privacy and authorization
- Startup readiness integration, native NavigationStack/sheets/alerts, and larger Dynamic Type

## Observations

MERGE: NO

Reviewed the integrated stage diff from 70b8de316bd0b086928bfea97f348f9ded13992c through ea022ab262853f819870ea2f39c857a9c79ace8d. Access/account/admin/privacy presentation and the required build/static checks passed, but two blocking Major chat-capture defects violate explicit composer/cancellation acceptance requirements.

Requirement conclusions:
- Chat projection/message/task/permission wiring: pass based on source inspection and suites.
- Draft/capture composition: fail; draft presence removes the voice control, and typing during Auto tears it down and cancels capture.
- System capture cancellation: fail; physical gesture termination has no cancellation distinction and defaults to commit.
- Setup/login/update/account/admin/secret privacy/authorization: pass within inspected boundary and tests.
- Startup/native navigation/Dynamic Type integration: pass within stage evidence.
- Required checks: all pass; worktree remained clean.

Findings: IOS-FINAL-001 and IOS-FINAL-002.

## Evidence

- **EV-001:** Sanitized command and review summary. — All five required stage checks passed and the worktree remained clean.
- **EV-002:** Conditional VoiceCaptureControl mounting and draft/Auto interaction evidence. — Voice control is mounted only in the else branch when draftPresent is false.
- **EV-003:** Physical gesture terminal and lifecycle cancellation wiring. — DragGesture.onEnded always calls reducer release without cancelled=true.
- **EV-004:** Reducer cancellation and terminal intent mapping. — cancelled=true maps to cancelHeld, while default sustained Send maps to sendHeld.
- **EV-005:** Current reducer-only fake proof boundary. — Tests cover explicit target cancellation but not physical/system gesture cancellation or mounted control-to-KMP wiring.
- **EV-006:** Authoritative KMP commit/cancel behavior for emitted intents. — sendHeld finalizes capture; cancelHeld/lifecycleCancel discard it.

## Findings

- **IOS-FINAL-001** (high, open): Draft presence removes VoiceCaptureControl; typing during Auto removes the control and its teardown cancels the active semantic capture.
- **IOS-FINAL-002** (high, open): Physical gesture termination never distinguishes system cancellation and can emit sendHeld for a cancelled sustained hold.

## Verdict

fail

## Residual Risk

- The iOS voice tests are reducer-only rather than the requested fake-KMP/control integration proof; fixing the two defects should add bounded fake wiring tests for draft persistence, background/teardown, cancellation, and emitted semantic intent sequences.
