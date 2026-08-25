# Foundation components prototype

ID: `foundation-components`

Open `index.html` through the Visual Companion or a local static server.

## Boundary

- `sentient-components.css` — the single responsive mock component library. It owns locked Dusk tokens, existing type/spacing/radius scales, elevated-slate material roles, component states, and mobile recomposition.
- `sentient-components.js` — minimal reusable behavior enhancement for checkbox mixed state, range progress, toggles, segmented controls, chips, and the Sentient avatar state specimen.
- `showcase.css` — review-page layout only; it must not define component appearance.
- `index.html` — component review surface.

Label chips preserve identical intrinsic width and equal inline label padding across rest and selected states. Selection changes material depth, ink, and pressed position without inserting a leading marker or adding a highlight outline. Checked checkboxes use the raised primary-key response on precise-pointer hover and close their air gap only while pressed.
- `handoff.md` — reviewed implementation brief and explicit open boundaries.
- `assets/avatars/` — a self-contained prototype snapshot of the supplied canonical SVGs and transition component from `sentient-design/avatars/`, so the avatar works when this prototype directory is served in isolation.

The library is a design prototype, not a production dependency. Production implementation remains native to Preact, SwiftUI, and Compose while sharing the reviewed semantic and material contract.
