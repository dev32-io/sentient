# iOS settings-editor Wave 4 evidence

Profile: ODiff `0.035`, anti-aliasing ignored, Dusk `#2B2621`, visible-alpha-union `<=5.25%`.

| Case | Visible diff | Pixels | Result |
|---|---:|---:|---|
| `settings-editor--vertical--saved` | 5.10% | 41,794 / 818,822 | Pass |
| `settings-editor--vertical--unsaved` | 5.24% | 42,947 / 818,822 | Pass |

Both final actuals and diff images were inspected. Residuals are concentrated in native text rasterization/font metrics, native TextField/TextEditor wells, action-button text/material rendering, and the shared plate shadow. Component geometry, hierarchy, labels, state treatment, and action placement remain visibly aligned.

Verification in `final/checks/`:

- Focused settings-editor registry test: 1 passed.
- Full iOS suite: 195 passed, 1 expected inactive-capture skip, 0 failed.
- Signed arm64 simulator build and strict deep codesign verification: passed.
- Visual comparator tools: 10 passed.
- Design inventory contract and `git diff --check`: passed.
- iOS design boundary: expected repository baseline, 71 violations at base and current; no contribution delta.
- Aggregate design-foundation check: expected failure only at the same 71 pre-existing iOS boundary violations.
