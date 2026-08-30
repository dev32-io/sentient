# iOS search-field visual review

Status: **DONE WITH ISSUE**

Comparator: ODiff `0.035`, visible-alpha-union `<=5.25%`, Dusk `#2B2621`, anti-aliasing ignored.

## Final review

| Case | Visible-alpha union | Gate |
| --- | ---: | --- |
| `search-field--placeholder--rest` | 9.41% | fail |
| `search-field--placeholder--focus` | 9.81% | fail |

The final captures use the production `DesignSearchField` and a native SwiftUI `TextField`. The focused capture verifies that the underlying `UITextField` is first responder and leaves its native caret visible.

Human inspection confirms the approved visible label, placeholder, 320pt field geometry, recessed Dusk material, 8pt corner family, and focused outline/cast are represented. The empty authority has no search icon and no clear action. Existing conditional clear behavior remains available to filled production consumers; no unapproved filled/clear fixture was fabricated. iPhone hover is recorded as not applicable.

The numeric result is not accepted as a pass. Remaining diffs include native DM Sans glyph/caret rasterization and non-text SwiftUI stroke/gradient edges. Meeting `<=5.25%` would require changing the shared well renderer, hiding native focus affordances, or adding prohibited component-specific masks/offsets. This component therefore remains **DONE WITH ISSUE**, not visually accepted.

## Evidence

- `baseline/` — fresh pre-refinement rest capture and diff (15.19%).
- `final/search-field--placeholder--rest.png`
- `final/search-field--placeholder--rest.visual-diff.png`
- `final/search-field--placeholder--rest.report.json`
- `final/search-field--placeholder--focus.png`
- `final/search-field--placeholder--focus.visual-diff.png`
- `final/search-field--placeholder--focus.report.json`
