# Sentient shared assets

This folder is the project-level source of truth for reusable visual assets. Product pages must not contain embedded SVG paths or page-local image data. Every asset is presented against the exact Sentient Dusk tokens documented in `../brand-spec.md`; asset previews must not invent alternate backgrounds, filters, tints, or motion.

## Inventory

- `brand/sentient-mark.svg` — idle Sentient identity mark with a substantial, uniform ember rim and a quiet inner highlight. The complete ring makes the static state feel intentional rather than frozen mid-motion.
- `brand/sentient-avatar-thinking.svg` — active reasoning state derived from the idle atom. Three electrons travel at a fast, independently staggered cadence while asymmetric aperture arcs and the off-center inner field move in tighter cycles for legibility at chat scale.
- `brand/sentient-avatar-responding.svg` — shared replying and speaking state derived from the idle atom. Three electrons orbit at a responsive pace while concentric ember signals expand and the outer rim itself pulses through copper, ember, and parchment intensity.
- Avatar state transitions are composed in the shared web/mobile component runtimes by crossfading direct references between these three canonical SVGs. Interrupting thinking or responding transitions immediately back to the idle mark; no page embeds or redraws avatar artwork.
- `icons/ui/` — 28 original project UI icons. See `icons/README.md` for provenance and geometry.
- `icons/sentient-ui.svg` — compatibility sprite; individual files in `icons/ui/` are canonical.
- `previews/` — review exports documenting prior design decisions; these are not production UI dependencies.

## Design-system use

- Identity artwork is rendered without CSS filters, reconstructed halos, or local color substitutions.
- UI icons inherit Dusk ink or semantic state colors from their owning component.
- Terra is reserved for active or decisive states; sage, amber, and clay retain their semantic roles.
- Motion uses the shared `150ms` and `250ms` timings for interface feedback. Internal avatar timing remains owned by the canonical SVG assets and stops under reduced motion.

## Review surface

Open `design/web/assets.html` to review every visual asset and its project-relative path. The page itself remains a thin composition and loads `components/web/sentient-assets.js` directly.
