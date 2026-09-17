# iOS hybrid rendering performance

## Reproduce safely

```sh
source scripts/env.sh
bash qa/design-refresh/profile-ios-hybrids.sh /tmp/sentient-hybrid-before chat history notifications controls
# Repeat after changes using identical runtime, machine load, fixtures, and build flags.
bash qa/design-refresh/profile-ios-hybrids.sh /tmp/sentient-hybrid-after chat history notifications controls
```

Omit families to traverse all ten. Runner creates/deletes its own iPhone 16 simulator, builds signed optimized Debug (catalog routes retained), clears the build-time backend URL, warms each family, then samples during scripted gestures. It never reuses an authenticated simulator. Catalog launch skips diagnostics/backend initialization. Output includes synthetic screenshots and local paths; keep it outside Git. Existing generated Xcode project and MobileData arm64 XCFramework must be current (see `ios/README.md`). `IOS_PROFILE_RUNTIME` can select another installed runtime; compare only matching runtimes.

`sample` measures sampled app stacks and footprint, **not GPU time, frame rate, or physical-device smoothness**. The 25-second sample covers an initial portion of the gesture flow; do not divide by the full Maestro flow duration or infer hitch-time ratios. Inspect main-thread subtrees, not summed inclusive counts across recursive frames or all threads. Separate launch/cold realization from warmed runs. Repeat comparisons before accepting small differences. For frame-time claims, use working Instruments Animation Hitches/SwiftUI tracks on a physical device.

## Initial observations (2026-09-15)

Xcode 26.5, iPhone 16 simulator / iOS 26.5, Swift `-O`, real catalog production fixtures. All ten families launched and completed traversal. Warm comparison below is one paired run; large changes are promising, small changes are not statistically established.

Initial evidence remains temporary under session scratch `results/`: `warm-before-*.sample.txt`, `warm-async-*.sample.txt`, matching gesture logs/screenshots, and `measurement-manifests/` (base commit, retained before/after executable hashes, candidate source patch/checksums). Base commit: `ee932e8d`. Baseline executable was retained, but its dirty-source manifest was not captured before compilation; its source differs from candidate by original renderer flags and catalog jump-bar sizing. Treat these initial figures as exploratory, not a durable reproducible benchmark baseline. The checked-in runner now records working-tree patch/status, source checksums, and executable checksum for future paired runs.

| Family | Synchronous RenderBox main-thread samples, before → asynchronous | Interpretation |
|---|---|---|
| Chat (150 mixed-height/GFM messages, composer/tasks) | 1,744 / 19,104 → 21 / 18,617 | Main-thread synchronous presentation work drops from 9.13% to 0.11% of observed main-thread samples. `waitUntilScheduled` samples: 887 → 11. Footprint 82.6 MB in both runs. Not an FPS estimate. |
| Controls | 47 / 19,796 → 0 / 19,729 | Small absolute workload; no broad frame-rate claim. |
| Notifications | 61 / 19,606 → 47 / 19,727 | Difference small; needs repetition. Shared card/well/control implementation participates in same change. |
| History | 12 / 19,438 → 12 / 19,624 | No demonstrated isolated-panel gain. Does not reproduce chat remaining mounted under production drawer; original reported History regression remains a separate validation target. |

Snapshots were taken after the gesture flows, not at identical message positions; they are useful for checking missing chrome, **not pixel-equivalence evidence**. Static visual and interaction verification is separate.

### Rejected experiment

Replacing the shared manual blur with `GraphicsContext.shadow(..., options: .shadowOnly)` made forced plate renders roughly 8% faster and float renders 1–4% faster, but changed pixels deterministically (maximum channel deltas 11/255 and 17/255). Original blur/spread/inset recipes retained. No bitmap cache or blanket `drawingGroup()` introduced.

### Tool limitation

`xctrace` simulator recording stalled before recording began (`kAMDNotConnectedError`, tap-configuration disconnect). LLDB and `sample` attach successfully. No global developer-security settings were changed. This limits GPU/render-server diagnosis; a missing trace is not a performance pass.

## Acceptance boundaries

- Native controls, text, focus, hit targets, accessibility, gradients, shadow recipes, and animation cadence remain owned by existing components.
- Canvas asynchronous presentation changes scheduling, not drawing recipes. Check transient states and fast motion for delayed/missing decoration, not just settled images.
- Month/year native calendar Canvas remains the unchanged control.
- Calendar day/week kinetic continuity and chat lazy-height scrollbar behavior require geometry/gesture checks; they are not proven by renderer CPU samples.
- Coverage and remaining fixture states: `ios-hybrid-catalog-coverage.md`.

## Implemented-subset verification

- Earlier calendar/component integration: 157 XCTest cases (2 skipped), plus 221 Swift Testing cases; no failures. Calendar tests now target stable-slot/native-row contracts instead of obsolete rolling-snapshot internals.
- Independent simulator E2E: 9/9 representative cases passed across foundation, controls, forms, composites, notifications, history, chat, voice, calendar. Toggles, text input, menu/disclosure/selection, notification reveal/clear/close, History→Chat navigation, and calendar view switching exercised.
- Foundation/forms/initial-history/initial-chat/calendar captures matched exactly; loading/Rive regions showed localized animated variance. Scrolled composites/notification captures differed by settling offsets; chat scrolled to different chronology. These are behavioral checks, not strict scrolled-image equivalence.
- Rapid press transients, live streaming, microphone capture, and fast voice transitions remain qualification gaps. No permission was requested to exercise real audio.
- Independent reviews passed shared/notification, chat/history, and repaired calendar changes. All ten component families passed representative E2E: nine families on the integrated component build; calendar repeated reversals on the repaired build. An unchanged minor synthetic Year fixture issue remains: “Unavailable” overlaps the final date row. Month/year rendering code was deliberately retained as the working control.
- Initial catalog did not reproduce the chat scrollbar jump: its 150-message GFM fixture kept a 26,644-point content extent. Later real-app and hosted-native checks did reproduce extent instability; see the follow-up below. No eager-list replacement, hidden indicator, or offset workaround was shipped. Physical-device hitch rate remains unmeasured.

## Completed optimization coverage

- Shared raised/surface/well kernels reuse face geometry across paint passes; all four kernels present decorative Canvas asynchronously. Existing native controls, drawing recipes, transparency, hit testing, and accessibility remain intact.
- All shared wrappers inherit these kernels: buttons, selection/range controls, fields/editors, cards, menus, feedback/apply/page surfaces. Avatar/PIN and standalone chat/history/voice decoration retain their equivalent asynchronous paths. Already conditional/bounded rendering stays unchanged.
- Growing model, schedule, personality, diagnostics, and tool collections use lazy stacks. Existing lazy voice, history, chat, and inbox lists remain lazy.
- Notification rows prederive immutable previews and parse completion dates once per row initialization; display formatting still responds to current locale/time zone. Tray remains mounted through original visibility/animation behavior.
- Chat computes display messages and chronology once per render, reuses divider formatters, and avoids timelines for static bubbles/completed tasks/inactive waveforms/Reduced Motion orbit. The subsequent avatar correction removes Rive from header/history/idle states and exposes identity-addressed assistant activity through the shared SDK/data layer; transport and audio playback behavior remain unchanged.
- Calendar Day/Week uses stable arithmetic slots, reusable native per-row hosts within bounded loaded periods, and sparse height corrections. There are no rolling snapshots or programmatic offset resets during ordinary flicks. Recenter happens at rest. Revision publication preserves content-bearing row anchors, synchronously retires revoked pixels/AX/actions, fences callbacks, and preserves terminal alignment/focus.

Calendar’s original braking was reproduced: window roll wrote an anchor offset, then `isDecelerating` became false. Small defer/offset workarounds were rejected. The approved internal rewrite preserved cards, spacing, callbacks, and accessibility. Review caught and repaired partial-row publication, stale-anchor reuse, terminal geometry, and stale-presentation authority regressions. Native regression tests include publication reentry and movement after anchor restoration; a negative control proves the transaction-publication guard test fails without that guard.

Final calendar E2E reran 8-up/8-down/8-down 100 ms flicks plus six additional reversal batches on iPhone 16 / iOS 18.3. The pre-repair Day blank gap no longer reproduced; Day/Week event rows remained populated and correctly separated. These checks prove visible progression/reversal and settled geometry, not physical-device FPS.

A separate scratch-only instrumented build confirmed actual UIKit post-release momentum across loaded-period boundaries and reversals: 100 ms gestures continued for approximately 2.72–2.78 seconds before natural deceleration end. Representative Day offsets moved +1,082 / −1,263 points after release; Week +1,168 / −1,259 points. Each included repeated `isDecelerating == true` samples. All 24 Week gestures and 21 of 24 Day gestures recorded natural ends; three Day gestures had continued deceleration samples but no end callback before the next gesture (cause unresolved). Some fixture publication boundaries produced isolated counter-direction corrections. This establishes continued momentum, not perfectly monotonic motion or physical-device frame pacing. Instrumentation never entered repository source.

## Real-app avatar follow-up (2026-09-16)

Catalog checks missed the real workload. Follow-up used the normal authenticated local debug app, not a catalog route, on iPhone 16 / iOS 18.3.1. Builds used Swift `-Onone` with matching dSYM; do not combine these results with the earlier `-O` catalog measurements.

### Confirmed defects and corrections

- Authored hidden thinking/responding loops kept Rive advancing even when idle pixels appeared static. Header and historical/idle messages now use the bundled SVG-derived static image; they construct no Rive model/view.
- Global thinking/speaking state previously targeted the last historical reply. Shared presentation now carries turn/reply identity, follows actual audio queue ownership, publishes after complete frame folding, and fences older/interrupted activity. Only the matching latest assistant reply can animate, including the pre-token placeholder and committed speech tail.
- Rive inputs automatically wake playback. Inputs are now deferred while ineligible, with latest-state reconciliation on resume. Coverage, scene phase, and actual avatar scroll visibility gate playback. Reduced Motion applies the authored static variant and pauses.
- Model construction now uses `StateObject`'s lazy initializer. A strong model/controller/driver cycle was removed; native lifetime tests assert model and view-model release.

Independent SDK and iOS source reviews passed after repairs. Focused native avatar checks passed 20/20; the final native suite reported 383 passed, 2 optional visual-capture cases skipped, and no failures. Tests cover reply ownership, native runtime count, offscreen pause/resume while the bubble remains visible, Reduced Motion destination states, and deallocation. Shared SDK/data `allTests` also passed.

### Normal debug app verification

Final build was installed without resetting app data and left installed. Actual idle chat and History-over-mounted-chat both contained **zero Rive views, zero MTKViews, and zero Metal layers** in the mounted UIKit tree.

| Active gesture sample | Main samples | Run-loop wait | Rive draw path | `nextDrawable` wait |
|---|---:|---:|---:|---:|
| Final chat | 4,705 | 4,582 | 0 | 0 |
| Final History over Chat | 5,608 | 5,351 | 0 | 0 |
| Earlier History over Chat | 7,810 | 4,752 | 2,456 | 2,397 |

This confirms removal of the measured Rive/Metal blocking path, **not a presented-FPS result**. Real assistant generation/audio was not triggered; isolated native and SDK tests cover active-state behavior. Final executable payload SHA-256: `b8b39b99c304266aee7414fb2cb9031edf73a29a9bf6b4d11f1a5386a4ba4dc8`.

### Scroll issues deferred during avatar delivery

At the avatar-only checkpoint, scroll-height behavior was **not fixed**. The subsequent approved scroll delivery and final verification are recorded below. The old installed app reproduced a `2,642 → 1,860pt` extent collapse; current source also failed a separate hosted long-Markdown regression (`2,395 → 2,989/3,029pt`), despite the selected real conversation remaining stable in current-build trials. The exploratory failing regression was preserved separately for deferred investigation, not marked as passing or included in avatar acceptance.

User paused scroll implementation. Follow-up research must cover exact loaded-history geometry with virtualized rendering, the reported failure to anchor a newly sent user message at the top, and streaming/reconciliation/keyboard interactions. Native `List` first-visit estimate changes were not accepted as the solution. Existing pure send-anchor tests do not establish native top alignment.

### Follow-up research: send-to-top failure

A separate disposable native host reproduced the failure using current `MessageList` and synthetic messages. From beginning, middle, and bottom reader positions, the new-send scroll request was issued but clamped by native maximum offset:

| Viewport | Phase | Requested top offset | Native max / final offset | Row below viewport top |
|---|---|---:|---:|---:|
| 733pt | Pending | 3,116 | 2,536 | 580pt |
| 733pt | Committed echo | 3,116 | 2,513 | 603pt |
| 430pt | Pending | 3,116 | 2,839 | 277pt |
| 430pt | Committed echo | 3,116 | 2,816 | 300pt |

The tail lacked enough scrollable space to place the user row at the top. Pending-to-committed reconciliation shortened it further. A later long assistant response made the target reachable in the smaller viewport, but the one-shot policy deliberately did not scroll again. Normal live-echo identity remained stable; waiting 30 rendered frames did not overcome the clamp. These observations establish reachability as a cause, not merely a missing delay. They do not rule out other edge cases. Reduced viewport simulated keyboard geometry; an actual keyboard transition remains unverified.

Preserving the existing top-alignment contract requires enough temporary trailing extent, shrinking as the response fills it, with explicit anchor ownership during reconciliation. A timing retry alone cannot create missing extent. This was the research finding that informed the subsequently approved implementation below.

### Follow-up research: stable geometry

Native recycling and exact measurement are separate responsibilities. Stock self-sizing collection cells still estimate unseen heights. [Signal separates component measurement from view construction](https://github.com/signalapp/Signal-iOS/blob/16cf50a6de143c9e1d0b044f6f258f107916116c/Signal/ConversationView/Components/CVComponent.swift), then supplies sizes to its custom collection layout for a bounded loaded window. Its background measurement is renderer-specific; it does not establish that arbitrary SwiftUI hosting can be measured off-main.

Keeping MarkdownUI means assessing exact hosting-measurement cost before choosing a replacement scroll owner. Pre-parsed Markdown reduces parsing, not layout measurement. Width, Dynamic Type, row grouping, content revisions, and image geometry invalidate sizes. MarkdownUI's [default image provider](https://github.com/gonzalezreal/swift-markdown-ui/blob/2.4.1/Sources/MarkdownUI/Extensibility/DefaultImageProvider.swift) uses zero-size placeholders before images load, so unknown image dimensions are another source of genuine height changes.

Research made no claim about iMessage's private implementation and did not authorize an architecture change. The user subsequently approved exact runtime measurement with recycled native cells and the existing loading indicator; estimated-height replacement remained outside the accepted solution.

## Approved native chat scroll delivery — final verification

`MessageRowLayout` is the shared bubble renderer for measurement and display. A reusable hosting measurer uses actual width, fonts, and current Dynamic Type environment; the native collection consumes measured sizes and recycles visible cells. No independent Markdown-height formulas, guessed image heights, new dependency, or new pagination policy were introduced. Initial batched measurement reuses the existing history loading overlay; unchanged rows are not remeasured merely because message count changes.

Independent measurement matched mounted rows within one physical pixel. A long Markdown row grew from 467pt to 2,287pt at an accessibility size, with measurement/display agreement retained. Cold measurement of 200 fixture rows cost 0.60–0.71 seconds aggregate main-thread work on the simulator; work is batched behind the existing loading state. These are renderer-specific measurements, not a platform minimum or physical-device timing guarantee.

Send-to-top now reserves measured trailing space before positioning. Pending/committed identity remains stable; batched sends select the newest chronological send. Manual drag cancels deferred positioning and releases forced following. Tail space retires only when doing so will not clamp the reader's current offset or interrupt drag/deceleration.

Review repairs also covered same-view history reloads, stale deferred callbacks, and cold history arriving without an observed loading edge. Existing-history intent now comes from route semantics rather than inferring a send from the first arriving historical row. Initial bottom intent is consumed only after its matching positioning operation actually applies.

Rich-content sizing remains encapsulated. Previously resolved Markdown images are synchronously reusable through a bounded decoded-image cache, with exact dimension metadata retained across eviction. Unknown network image content may still change intrinsic size when it first resolves; this is handled as a real content change with anchor preservation, not an estimated text-row correction. Consumer lifetime and generation fences prevent abandoned revisions from updating replacement rows. No hidden host is retained for every historical row.

### Checks

- Final native suite: **406 passed, 2 optional visual-capture tests skipped**. An unrelated notification timing test failed once during repair verification, then passed isolated and in the full rerun.
- Independent source review: PASS after cold-history and deferred-drag repairs.
- Native regressions assert actual mounted cell positions, unchanged-history extent, normal/accessibility fonts, bounded cell mounting, send/echo/stream behavior, warm-cache reuse, image resolution/reuse/eviction, reload ordering, and cancellation of held positioning callbacks after drag.
- Isolated true-touch checks passed full traversal, rapid reversals, keyboard dismissal/draft preservation, selection, and representative accessibility. A short-response tail fixture recorded `isDecelerating == true` at 100ms after release and continued offset movement. External link activation was intentionally not performed; its hit target was checked.
- Final normal debug-app verification: existing history opened at offset **1,269pt**, equal to native maximum; content extent remained **1,827pt** through full first and warm traversals. The earlier cold-ready 72.33pt positioning failure no longer reproduced.
- Idle actual chat and History retained zero Rive views. Existing authentication and app data were preserved. The verified build was left installed; no real messages or audio were sent.

Final executable payload SHA-256: `a07232049cb13e5ac523ff82da56ab747d666d80aec27b33fdfaacba135d68d0`. No physical-device FPS/GPU claim. Disk exhaustion interrupted final evidence writing; after space was restored, retained evidence was recovered and remaining warm/history checks completed without repeating installation.
