# Common composites prototype

ID: `common-composites`

Open `index.html` through the Visual Companion or a local static server. See `handoff.md` for the reviewed implementation brief.

## Boundary

- Covers reusable compositions: page/header fragments, local navigation, image/icon-dominant cards, Pin and verification entry, grouped settings rows, validated forms, inline editors, list and overflow-action rows, reorderable lists, filter bars, elevated status text, notices, async states, disclosure, steppers, upload/progress, results and pagination, skeletons, bulk selection, responsive data rows, tooltips, menus, dialogs, and toast shells.
- Excludes chat bubbles, chat composer controls, calendar, product-specific flows, and complete pages.
- `common-composites.css` owns composite anatomy and the review-page layout.
- `common-composites.js` provides bounded specimen interactions and meaningful state transitions, with static Reduced Motion fallbacks.
- Visible copy follows the user-friendly type floors and casing rules in `DESIGN.MD`; the mockup does not use all-caps styling.
- Dropdowns use the mock listbox shell rather than the browser’s native expanded menu so the reviewed float material and interaction remain visible.
- `vendor/` is a self-contained snapshot of the reviewed `foundation-components` primitive library and identity assets so this prototype can be served in isolation.

This is a design review artifact, not a production dependency. Production implementation remains native to Preact, SwiftUI, and Compose and follows `DESIGN.MD`.
