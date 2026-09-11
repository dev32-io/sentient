# Evaluation Report: stage-product-surfaces-review

## Boundary

{"workItem":"design-refresh"}

## Criteria Evaluated

- Complete reachable-state coverage, component-boundary compliance, and no domain/session/persistence regressions
- Web text/chat/task/composer/capture separation, Settings trust cleanup, Calendar behavior, keyboard and 200% zoom
- iOS Rive/startup readiness/History, native Settings/Voice/Calendar navigation and large Dynamic Type
- No audio E2E, no network manipulation, and no prototype runtime imports

## Observations

MERGE: NO

Reviewed the integrated stage boundary at bc5f663fb06b205b069af12d784e3a1df890ffd4 against base 3a9871de53780eae65206de4bf14d8d8fb385c16 and the persisted product-surfaces contracts.

Two explicit accessibility acceptance gaps remain: the closed Web History drawer leaves invisible descendants keyboard-focusable, and the iOS History search target is fixed below the required 44pt minimum with page-local type sizing. Both are localized Minor findings, but blocking because keyboard/target compliance is an explicit stage acceptance requirement.

Fresh checks passed: WebUI unit (276 tests), typecheck, build; gateway unit (2528 pass, 4 skip); KMP mobile allTests; ios-setup; iOS simulator tests (118 Swift Testing plus 16 XCTest); design inventory; avatar verification; and diff checks. Repository remained clean.

## Evidence

- **EV-001:** Focused Web suite passes but does not prove closed-state tab isolation. — PASS — 46 files, 276 tests
- **EV-002:** Focused iOS tests pass but do not assert the search target metric. — PASS — 118 Swift Testing and 16 XCTest tests
- **EV-003:** Closed inventory metadata validates. — PASS
- **EV-004:** Bounded diff has no whitespace errors. — PASS

## Findings

- **F-001** (medium, open): Minor, blocking contract gap: the closed off-canvas drawer remains mounted with focusable controls; aria-hidden and pointer-events:none do not remove descendants from sequential keyboard focus.
- **F-002** (medium, open): Minor, blocking contract gap: History search is fixed to 40pt and uses page-local Typo.ui(14), below the explicit 44pt target and shared semantic-type requirements.

## Verdict

fail

## Residual Risk

- No audio/microphone E2E or network manipulation was performed, as required.
- Stage checks provide structural and unit proof; canonical browser zoom and large-Dynamic-Type visual behavior was not interactively exercised in this review.
