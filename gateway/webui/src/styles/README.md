# Web design foundation

The production WebUI has one token source: the generated
`design-foundation-v2.css` projection. `src/main.tsx` imports it once, then the
small `compatibility.css` layer exposes only temporary aliases for existing
product styles. `index.css` is a compatibility entry for review/evidence pages;
new code must not import the deleted legacy token files or define `:root`
tokens locally.

`components/common/foundation.tsx` and `composites.tsx` own semantic controls
and shared page/settings compositions. The files under
`components/settings/primitives/` are API-compatible adapters, not a second
visual system. Product pages may retain their existing structural CSS during
migration, but new controls use the common exports.

Run `bun run design:foundation:check` to verify generated projections, the
production import boundary, prototype isolation, token declarations, and the
explicit transitional allowlist. Prototype CSS/JS/assets are review inputs,
never Web runtime dependencies.
