# Calendar native floating-hit helper

`verify-floating-hit-routing.yaml` moves the four **semantic interception** obligations (face + protruding badge corner, LTR + RTL) out of the UIKit nil-event hit-leaf assertion. A SwiftUI Button can consume the real gesture even when `UIWindow.hitTest(..., with: nil)` reports the underlying Month control. Native taps must open usable filters **and leave Month active after each close**. A positive owned-date tap must instead navigate Month → Day.

The Swift unit test still checks both directions' viewport extent to the physical bottom, open gap/bottom reachability and measured native bottom inset. The native helper is additional required coverage, not an OS skip or a replacement with fewer obligations.

## Preconditions

- Parent has verified the installed `io.dev32.sentient.debug` app uses the **real local stack**, not production. Already authenticated and **already open in Calendar**, no sheet/keyboard open. No launch/login/reset occurs in this helper.
- Exactly the reviewed **393×852 portrait, normal/default Large Dynamic Type** profile. Parent verifies the device profile; the flow also requires 44pt normal mode controls, the 393×631 Month viewport and 58×54 filter control. Other sizes/categories/localizations require a separately reviewed profile, not guessed coordinates.
- Parent launches/prepares the requested LTR or forced RTL process beforehand. The helper preserves those launch arguments and verifies actual Day/Year/filter physical order. Do not call `open-calendar.yaml` or the broad batch runner here; their launch/setup can discard the forced RTL context.
- Disposable local Calendar filter preferences: setup clears them, selects Month/Today, verifies zero filters through disabled **Clear filters**, then sets only public `qa-native-hit` text. `CalendarFilterMapping.activeCount` makes that exactly one filter/badge. No event CRUD or account changes.

Before each invocation, parent selects **Month → Today** in the already-running app and obtains fresh **identifiers-only** geometry. Choose one owned date fully inside the current authorized native viewport and away from the footer; supply its complete ID as `CALENDAR_HIT_VISIBLE_DATE_ID`. Do not select from the full AX collection, reuse a stale/other-profile ID, or infer visibility from a global regex/index. Format validation cannot prove local visibility or authority; parent must establish both. The helper re-establishes Month/Today without discovering or substituting a date.

All six parameters are mandatory, with no defaults:

| Parameter | Value |
|---|---|
| `CALENDAR_HIT_LOCAL_VERIFIED` | `1` (parent attestation, not an automatic backend check) |
| `CALENDAR_HIT_PROFILE` | `393x852-portrait-normal` |
| `CALENDAR_HIT_DIRECTION` | `ltr` or `rtl` |
| `CALENDAR_HIT_FACE_POINT` | LTR `34,788`; RTL `359,788` |
| `CALENDAR_HIT_CORNER_POINT` | LTR `56,764`; RTL `337,764` |
| `CALENDAR_HIT_VISIBLE_DATE_ID` | Exact `calendar-date-YYYY-MM-DD` ID freshly verified by parent as above; no literal date/default in this flow |

Coordinates must match the declared direction/profile exactly; unsupported/missing parameters fail before interaction. The face/corner taps have `retryTapIfNoChange: false` so a missing response is not repaired by an extra tap.

## Parent run matrix

Run the helper **once per direction on each supported OS**: iOS18/LTR, iOS18/RTL, iOS26/LTR, iOS26/RTL. Two physical interception cases per invocation preserve all four obligations per OS. The prior manual iOS26 proof does not constitute a green run of this helper or its iOS18 comparison.

Example explicit-file invocation, after parent preparation:

```sh
source scripts/env.sh
maestro --device "$IOS_DEVICE" test \
  -e CALENDAR_HIT_LOCAL_VERIFIED=1 \
  -e CALENDAR_HIT_PROFILE=393x852-portrait-normal \
  -e CALENDAR_HIT_DIRECTION=ltr \
  -e CALENDAR_HIT_FACE_POINT=34,788 \
  -e CALENDAR_HIT_CORNER_POINT=56,764 \
  -e CALENDAR_HIT_VISIBLE_DATE_ID="${CALENDAR_HIT_VISIBLE_DATE_ID:?Supply the freshly verified visible owned-date ID}" \
  qa/mobile/flows/ios/_calendar/verify-floating-hit-routing.yaml
```

For the already-running RTL process, pass `rtl`, `359,788`, `337,764`. `tags: [helper]` intentionally excludes this precondition-sensitive flow from default batch discovery. An equivalent parent-controlled Maestro executor may supply the same environment parameters.

The helper contains **no screenshot, recording, hierarchy-dump, event-content or direct HTTP commands**. App reads still use the real local backend. Use the parent's privacy-controlled local executor/artifact policy: Maestro itself can automatically create debug/failure screenshots and hierarchy artifacts, so do not collect/export those as evidence or upload to cloud. Retain only sanitized command outcomes/profile/direction. The CLI example does not itself disable automatic Maestro artifacts.

## Assertions and cleanup

- Both real coordinate taps must expose `calendar-filter-search` and an enabled Clear control; after each `calendar-close-filters`, the search sheet must disappear and the real `calendar-native-viewport` must remain. Sheet visibility alone would miss an underlying Month → Day activation.
- Positive control asserts/taps only the exact parent-supplied `CALENDAR_HIT_VISIBLE_DATE_ID`, with no global date regex/index or auto-discovery. One native tap must remove the Month viewport while Calendar's Day control remains. Then Month/Today is restored. There is no assertion against an invented adjacent viewport ID.
- Successful completion clears the QA query, verifies zero filters, closes the sheet and leaves Month/Today active. On failure, stop and preserve the failure; parent clears the local query via Calendar filters and restores Month/Today before another independent run. Do not retry until green or loosen profile/visibility checks.

The earlier iOS26/RTL helper failed its positive control: the global regex/index lookup reached January 0001 through the full civil-month collection rather than the authorized visible month. This is a helper targeting failure, not a filter failure or product-routing defect; prior four physical interception proofs remain valid. Parent recovers with Today and fresh local state/identifiers before rerunning the revised four-profile matrix. No Year-1 product change is part of this correction.

No source hooks, fake QA host, new XCUITest target, gesture overrides or fixed frame waits are needed. Run native coverage alongside the unchanged unit geometry/gap/inset obligations before claiming acceptance.
