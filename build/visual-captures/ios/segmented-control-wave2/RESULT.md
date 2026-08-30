# iOS segmented-control Wave 2 evidence

Outcome: **DONE WITH ISSUE**. All 12 final cases were captured serially with ODiff threshold `0.035`, visible-alpha-union limit `5.25%`, Dusk `#2B2621`, and anti-aliasing ignored. Final ratios range from `12.84%` to `21.08%`; see `final/report.jsonl` and `/tmp/sentient-component-refinement-map/completed-reports/segmented-control.md`.

Checks:
- focused visual fixture tests: 11 tests, 1 skipped, 0 failures
- full iOS tests: 42 tests, 1 skipped, 0 failures
- iPhone 16 arm64 simulator build: passed
- visual tool tests: 10 passed
- git diff check: passed

The immutable 0000ms case establishes a 12.84% native text/well-rendering floor even with no selected slate. The 0055ms browser startup frame also differs meaningfully from native matched-geometry motion and requires a group-level measured indicator or a fabricated fixture state, both outside the permitted boundary.
