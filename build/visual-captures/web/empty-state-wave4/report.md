# `empty-state` — Web wave 4 refinement report

## Pinned authority

- Base: `e46b6157dd960acb17c425bb81e27201139c53ac`
- Branch: `feature/design-refresh-web-w4-empty-state`
- Immutable visual authority: `design/prototype/common-composites/handoff/static/empty-state--settings--rest.png`
- Structure/copy authority: `design/prototype/common-composites/index.html` (`.cmp-state` with decorative plus mark, heading, supporting copy, and caller action)
- Layout authority: `design/prototype/common-composites/common-composites.css` (`.cmp-state-grid`, `.cmp-state`, `.cmp-state-mark`; narrow stacking at 620px)
- Foundation authority: `DESIGN.MD`, `design/prototype/common-composites/handoff.md`, and `design/prototype/foundation-components/handoff.md`
- Canonical canvas: Dusk `#2B2621`

The authority exposes only `empty-state--settings--rest`. Hover, focus, pressed, disabled, compact isolated, and reduced-motion isolated empty-state references remain absent and are registered as missing authority rather than synthesized.

## Refreshed production ownership and state boundary

`gateway/webui/src/components/common/composites.tsx#AsyncState` remains the production owner and its public API is unchanged: callers own `title`, optional `message`, and optional `action`.

The implementation now gives only `state="empty"` the reviewed decorative plus mark and centered empty anatomy. It does not supply “Add item,” add an action, or alter any caller copy. Loading remains the named spinner status, errors remain assertive alerts without the empty mark, and filtered recovery remains the separate `NoResultsState` production component and fixture.

Current true-empty consumers include the login gate, an empty history drawer, and an empty personalities collection. Existing no-match call sites in model and voice filtering still pass `AsyncState state="empty"`; they were inspected but intentionally not migrated in this exact empty-state slice because their filter-reset action ownership is product-owned and changing the already-refined `NoResultsState` contract would expand scope. No caller action, copy, localization boundary, keyboard order, or focus behavior changed.

## Reuse / extend / new local / platform adaptation

- **Reuse:** `AsyncState` public API and live-region semantics; production `Plate`; production `ActionButton`; canonical type, color, spacing, well-shadow, plate, and button tokens.
- **Extend:** only the `AsyncState` empty branch and its stable `data-state`; dedicated Web visual-diff registration for the single approved rest case.
- **New local:** the decorative `.snt-async-state__mark` recipe inside common-composite CSS. It has no interaction or accessible name.
- **Platform adaptation:** the Web fixture retains the approved plate host while production callers continue to control their surrounding surface. At the fixture’s narrow viewport, the production foundation preserves its 44px interactive target, four CSS pixels taller than the prototype’s rendered quiet button; the surrounding plate consequently extends slightly lower rather than shrinking the native target. No motion was introduced, so Reduced Motion behavior remains static; increased contrast continues through foundation plate/button rules.

## Fresh visual evidence

Serialized evidence: `build/visual-captures/web/empty-state-wave4/`

- `actual.png`
- `diff.png`
- `visual-diff.json`
- `sha256.txt`

Gate result against the immutable PNG:

- ODiff threshold: `0.56`
- Anti-aliasing: ignored
- Background: `#2B2621`
- Basis: visible-alpha union
- Difference: `555 / 274860`, reported `0.2%`
- Required maximum: `<= 0.2%`
- Result: **PASS** (`withinLimit: true`)

The counted pixels are localized to text rasterization in the heading/action region. The inspected non-text difference is the intentional narrow-Web 44px action target described above; mark construction and horizontal geometry align with the authority.

## Verification

Passed:

- Focused Web component and fixture tests: 63 tests
- Full Web suite: 53 files, 387 tests
- Web TypeScript check
- Web production build
- Visual comparator gate
- Visual tool tests: 10 tests
- Design inventory check
- Web foundation boundary check
- Changed-file Biome check
- `git diff --check`

Repository-wide checks with pre-existing failures outside this branch:

- `design:foundation:check`: generated contract and Web foundation portions pass; the iOS boundary step reports existing violations in untouched `ios/App/Settings/Components/*` files.
- Root `lint`: reports existing calendar non-null-assertion diagnostics in untouched `gateway/src/calendar/*` files.

No authority/comparator file, iOS file, mask, shift, crop, substitution, hidden branch, capture offset, or shared visual kernel was changed.
