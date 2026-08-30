# `local-navigation` refinement report

**Scope:** Web only, branch `feature/design-refresh-web-w4-local-navigation`, base `e46b6157`.

## Authority and production ownership re-opened

- Immutable visual/behavior authority: `design/prototype/common-composites/{README.md,handoff.md,index.html,common-composites.css,common-composites.js}` and all five static plus five General→Privacy frame references.
- Durable authority: `DESIGN.md` and `design/prototype/foundation-components/handoff.md`.
- URL/history owner remains `gateway/webui/src/app.tsx`; no routing hierarchy or persistence logic changed.
- Settings state/focus owner remains `gateway/webui/src/components/settings/settings-view.tsx`; narrow overview→pane behavior and back-focus restoration are unchanged.
- Role-filtered route catalog remains `gateway/webui/src/components/settings/sidebar/nav-config.ts`; no keys, ordering, labels, groups, or admin gating changed.
- Renderer remains `gateway/webui/src/components/settings/sidebar/sidebar-nav.tsx`.

## Refreshed implementation map

- **Reuse:** `ActionButton`, `Icon`, Dusk semantic tokens/material recipes, native button keyboard behavior, existing role-filtered navigation data, existing settings state owner, and existing responsive shell.
- **Extend:** `ActionButton` now forwards native `aria-current`; `SidebarNav` composes a typed `LocalNavigation` renderer with one continuous measured current surface.
- **New local:** settings-sidebar-only current-surface positioning, described-row anatomy, dirty/chevron slots, Reduced Motion and increased-contrast CSS, direct production visual fixture, and focused semantics tests.
- **Platform adaptation:** production keeps all existing Soul/User/Admin groups and compact one-line route labels. Descriptions and chevrons are supplied only by the approved isolated fixture because production has no owned copy or hierarchy for them. Web narrow navigation remains the existing overview→pane flow; no breadcrumb, tabs, or alternate mobile navigation were introduced.

## Changed behavior

- Exactly one active settings button now exposes `aria-current="page"`.
- Selection is represented by one continuous well surface that moves between route buttons; Reduced Motion makes the change immediate.
- Dirty state remains restricted to the existing Soul keys and is included in the button’s accessible name.
- Native keyboard order, visible focus, pointer hover, coarse/narrow target sizing, admin visibility, routing callbacks, URL/history ownership, localization inputs, and narrow-pane focus restoration are preserved.

## Direct visual evidence

Evidence: `build/visual-captures/web/local-navigation-wave4/`.

- Five static states and all five General→Privacy frames were captured serially from the production `LocalNavigation` renderer.
- Profile: Web ODiff `0.56`, visible-alpha-union, canonical Dusk `#2B2621`, AA ignored, gate `<=0.2%`.
- Static results: account `0.15%`, general `0.15%`, privacy `0.15%`, focus `0.15%`, hover `0.15%`.
- Motion results: `0.15%`, `0.12%`, `0.14%`, `0.14%`, `0.14%` for 0/62/125/188/250ms.
- All ten comparisons passed. Residual counted pixels are confined to text/icon rasterization; inspected geometry, material, focus, hover, and moving-surface frames match the authority.

## Verification

Passed:

- Focused local-navigation, role-gating, narrow-focus, route-state, accessibility compatibility, and visual-registry tests.
- Full Web Vitest: 54 files / 387 tests.
- Web TypeScript and production Vite build (only the existing chunk-size warning).
- Visual-diff tool tests: 10/10.
- Design-refresh inventory check.
- Web foundation assets/import graph/tokens/production boundary.
- Root lint completed with 22 pre-existing `gateway/src/calendar` non-null-assertion warnings; no changed-file finding.
- `git diff --check`.

Expected unrelated failure:

- The aggregate `design:foundation:check` reaches and passes the Web foundation check, then fails in the iOS design boundary on existing `ios/App/Settings/Components/Design*.swift` violations. This branch changes no iOS file.

## Residual risk

- The moving surface uses `ResizeObserver` to follow responsive/font geometry. Browsers without `ResizeObserver` retain the correctly initialized surface and native navigation semantics but would not remeasure after a later resize; all supported production browsers provide it.
