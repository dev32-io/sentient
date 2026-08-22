# Sentient design handoff

## Design-system authority

All pages, components, and documentation inherit the current Sentient Dusk contract defined in `brand-spec.md`. The upstream sources are `gateway/webui/src/styles/tokens/`, `shared/mobile-sdk/.../DesignTokens.kt`, and their iOS/Android projections. Project files must use the exact source values and semantic roles; perceptually similar replacement colors are not conformant.

The shared web and mobile runtimes expose the complete Dusk palette, spacing, radius, typography, shadow, and motion scales. Thin page wrappers must not redefine those foundations. `sentient-family-calendar.html` and `sentient-platforms-v2.html` are the only self-contained product/launcher surfaces and carry the same canonical token set directly.

## Structure

- `design/web/` — 19 thin web page compositions, including `assets.html`
- `design/mobile/` — 21 thin, platform-neutral mobile page compositions
- `components/sentient-avatar.js` — cross-platform avatar Web Component; direct canonical asset references, state transitions, and interruption API
- `components/web/sentient-web.js` — shared web rendering, styles, states, and interactions
- `components/web/sentient-assets.js` — filterable asset-library component used by the thin showcase page
- `components/mobile/sentient-mobile.js` — shared mobile rendering, styles, states, and interactions
- `components/*/showcase.html` — component state and variant review surfaces
- `assets/brand/` — one coherent atomic avatar family with a warm ember halo: uniform static idle plus animated thinking and responding variants
- `assets/icons/ui/` — 28 original, reusable monoline SVG icons used by web and mobile components
- `assets/README.md` and `assets/icons/README.md` — inventory, provenance, visual contract, and usage guidance
- `assets/previews/` — exported review imagery

## Composition contract

Every product page contains only platform metadata, root Sentient custom elements, and direct references to the required shared component runtimes. Chat pages load `components/sentient-avatar.js` before their platform runtime. Product UI, CSS, motion, and behavior are owned by `components/`; do not add page-local UI or inline styles.

## Refinement workflow

1. Reconcile visual changes with `brand-spec.md` and the upstream Sentient token files before editing a component. Never introduce a second palette, local font stack, or ad hoc motion timing.
2. Refine shared behavior or visuals in the relevant `sentient-*.js` component runtime.
3. Review variants in the adjacent `showcase.html`. The avatar state lab demonstrates idle → thinking → responding, automatic sequencing, and interruption back to idle.
4. Confirm the change in representative files under `design/web/` or `design/mobile/`.
5. Add reusable SVG artwork to `assets/icons/ui/` or `assets/brand/`, never to an individual page. Stateful Sentient avatars must render through `<sentient-avatar>` from `components/sentient-avatar.js`; that component directly references the canonical SVG files and exposes `transitionTo('idle' | 'thinking' | 'responding')` plus `interrupt()`. Static brand marks may remain direct `<img src="../../assets/brand/…">` references. Component CSS must not recreate, decorate, filter, or substitute avatar graphics. Cross-state transitions may only crossfade and transform layers that directly reference the canonical SVG assets, so idle, thinking, and responding remain single-source. State variants preserve the Sentient nucleus and three orbital planes while using a thick, warm ember rim instead of a white perimeter. Idle remains fully static with a deliberately uniform luminous ring. Thinking combines fast, independently staggered electron travel, tightly cycling aperture arcs, and a shifting internal field so motion remains legible at small chat sizes. Responding is shared by active text replies and spoken output: quicker electrons move inside a breathing inner field while concentric ember signals expand and the outer rim pulses in warmth, brightness, glow, and weight. Every animated asset must restore fixed electron positions and halt field, signal, and edge motion under reduced motion. The handoff’s product icons and avatar states are documented in `assets/README.md` and `assets/icons/README.md`.
6. Review the complete asset inventory in `design/web/assets.html`; update `components/web/sentient-assets.js` whenever a new asset is added.

## Page matrix

Web: account, advanced, assets, audio, calendar, chat, get-app, login, members, memory, model, personalities, secrets, settings, setup, system-prompt, tools, voice, wizard.

Mobile: account, advanced, audio, calendar, chat, diagnostics, force-update, history, login, members, memory, model, personalities, secrets, settings, setup, system-prompt, tools, voice-add, voice-fish, voice.

## Calendar experience

`design/web/calendar.html` and `design/mobile/calendar.html` are thin entry points for the canonical calendar experience in their shared runtimes. Both provide scope and tag filtering, day/week/month/year switching through a floating view bar, event preview, date navigation, and add-event flows. Web uses a filter sidebar, primary calendar canvas, and persistent preview rail; mobile uses horizontal filters, compact calendar summaries, agenda-first event rows, and bottom sheets sized for one-handed use. View preference is retained locally.

Calendar colors, spacing, radii, type, and motion must use Dusk tokens. Terra is reserved for the add action and current top-level route; view switching uses tonal paper selection. Sage, amber, and clay communicate calendar/persona semantics. The sample household events are prototype content only and are not product metrics.

`sentient-family-calendar.html` remains a temporary comparison reference while the shared web and mobile routes are reviewed. Remove it only after the canonical routes are accepted; do not add new behavior there.

## Mobile consolidation

The mobile handoff intentionally uses one canonical `design/mobile/` composition set. iOS and Android previously rendered the same interaction and visual system; platform-specific metadata and duplicate wrappers were removed so refinements land once in `components/mobile/sentient-mobile.js`.
