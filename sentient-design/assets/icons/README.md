# Sentient icon assets

## Provenance

The linked Sentient repositories contain only the existing `sentient-mark.svg`; no reusable product icon library was available to copy. The icons in `ui/` were therefore created for this handoff and are original project assets.

## Visual contract

- 24 × 24 viewBox
- 1.7px monoline stroke
- round caps and joins
- no embedded color; components apply canonical Dusk ink, terra, or semantic state colors via CSS masking
- default icon color is `--color-ink-2`; hover moves to `--color-ink`; selected decisive controls may use `--color-accent`
- icon buttons use the Sentient radius scale and a minimum 44 × 44px touch target on touch-first surfaces
- geometric, quiet silhouettes aligned with Sentient’s restrained household interface

## Usage

Product pages continue to reference only `components/web/sentient-web.js` or `components/mobile/sentient-mobile.js`. Those shared components reference icons from `assets/icons/ui/`; do not embed SVG paths in product pages. Color, focus, hover, and selected states come from `brand-spec.md` and must remain paired for contrast.

`sentient-ui.svg` is retained for backward compatibility. New component work should use the individual files in `ui/`, which render reliably in the Open Design preview.

Review the complete project asset inventory—including every icon—at `design/web/assets.html`. Animated assistant states live separately in `assets/brand/` because they are identity assets rather than interface controls.
