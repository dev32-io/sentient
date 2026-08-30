# Web apply-bar Wave 4 evidence

## Outcome

DONE. The reachable production `ApplyBar` now expresses the approved dirty, applying, and success material/state language while preserving the existing settings-owned pending operations, async/error behavior, callbacks, native buttons, busy disabled state, focus order, and fixed-float placement.

## Reuse / extend / local / adaptation

- **Reuse:** production `ActionButton`, Dusk tokens, float elevation, and the existing `ApplyBarState`/`runApply` owner.
- **Extend:** `ApplyBar` derives a visual `data-state` from its existing state machine and exposes the approved status-marker/copy/actions anatomy.
- **New local:** apply-bar-only status marker, semantic state surfaces, pulse, and compact two-column action layout in `apply-bar.css`.
- **Platform adaptation:** Web remains a fixed settings float rather than the prototype's inline specimen. Existing product behavior also keeps both actions disabled while busy and retains the production spinner. Error and concurrent-retry states remain production-owned but are not admitted as visual-diff cases because the handoff has no approved error reference.

## Visual comparisons

Profile for every comparison: Web ODiff `0.56`, anti-aliasing ignored, canonical Dusk `#2B2621`, visible-alpha-union maximum `0.2%`.

| Case | Visible diff | Result |
|---|---:|---|
| dirty / rest | 0.00% | pass |
| applying / active | 0.07% | pass |
| done / success | 0.00% | pass |
| dirty-to-done / 0000ms | 0.00% | pass |
| dirty-to-done / 0300ms | 0.07% | pass |
| dirty-to-done / 0900ms | 0.00% | pass |

The two 0.07% residuals are confined to the production loading spinner retained inside the disabled primary `ActionButton`; no geometry, material, or copy residual remains. See `final/static/results.ndjson` and the two generated diff PNGs.

## Responsive and accessibility observations

`final/responsive/metrics.json` records real production-fixture observations:

- 390×844 compact: no horizontal overflow; two 168×44 actions; visible keyboard focus.
- 200% profile (640 CSS px for a 1280px surface): no horizontal overflow; stable 624×74 bar.
- Reduced Motion applying: marker animation is `none`; busy actions remain disabled.
- Increased contrast: bar edge resolves to `color-ink-3`.
- RTL compact: no horizontal overflow and 44px action targets.

## Checks

- Focused apply-bar/machine/fixture tests: pass.
- Full Web tests: 54 files, 386 tests pass.
- Web typecheck: pass.
- Web production build: pass (existing chunk-size warning only).
- Root lint: pass with pre-existing calendar non-null-assertion warnings.
- Visual tool tests: 10 pass.
- Design inventory check: pass.
- Web foundation check: pass.
- Full foundation command: Web/token generation passed; expected unrelated iOS design-boundary violations remain in existing iOS component files.
- `git diff --check`: pass.
