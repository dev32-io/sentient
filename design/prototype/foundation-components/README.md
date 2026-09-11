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
- `assets/avatars/` — canonical Sentient identity source and runtime assets. `sentient-avatar.rive.json` is the editable Rive source, `sentient-avatar.riv` is generated for WebUI and iOS, the manifest pins its runtime contract and hashes, and the colocated SVG/JavaScript files remain fidelity references and static fallbacks. Regenerate and verify with `bun run design:avatar:verify`.

The prototype CSS/JavaScript library is review code, not a production dependency. Production UI remains native to Preact, SwiftUI, and Compose while sharing the reviewed semantic/material contract and packaging the canonical generated Rive identity asset.
