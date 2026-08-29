# iOS setting-row Wave 3 evidence

Profile: ODiff `0.035`, visible-alpha-union gate `<=5.25%`, background `#2B2621`, anti-aliasing ignored, serialized on the pinned iPhone 16 simulator.

## Static references

| Case | Baseline | Final | Gate |
| --- | ---: | ---: | --- |
| toggle off | 4.92% | 3.06% | pass |
| toggle on | 5.31% | 3.43% | pass |
| segmented default selected | 14.27% | 3.65% | pass |
| segmented expert selected | 14.24% | 3.64% | pass |
| select English closed | 11.49% | 11.52% | native Menu adaptation; above gate |
| select Spanish selected | 11.12% | 11.16% | native Menu adaptation; above gate |
| range 62% | 17.25% | 17.25% | canonical native range-owner adaptation; above gate |
| select English open | not captured | not captured | native SwiftUI Menu popup; not a static fixture |

The final toggle/segmented rows use the production `DesignSettingsRow` composition and pass the fixed gate. The select cases retain the reachable native `DesignSelect`/`Menu`; its intrinsic iOS menu label and two-way chevron are not replaced with the prototype listbox geometry. The range case retains the reachable `DesignSlider`; its native title-above-track composition is not replaced with a desktop-only trailing range. These residuals are visible platform-owner differences, not masked or shifted comparison output.

## Source-to-platform map

- Reuse: `DesignCard`, `DesignSettingsRow`, Dusk tokens, `Space`, `Typo`, and existing native toggle/segmented/select/range owners.
- Extend: `DesignSettingsRow` now uses a source-derived flexible label column, 56pt native row content measure (card-hosted rows retain the reviewed rhythm), ink2 supporting text, trailing stacked accessories for accessibility sizes, and an accessibility containment boundary.
- New local: direct fixture registry/adapter and focused registry assertions. Fixtures mount production views only.
- Platform adaptation: iPhone has no required hover; static focus/pressed states are not fabricated; the open custom listbox is represented by the native SwiftUI Menu boundary.

No authority, reference, comparator, mask, crop, shift, substitute, or Wave 1 material-kernel file was changed.
