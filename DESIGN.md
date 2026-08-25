# Sentient design foundation

> **Status:** Reviewed foundation baseline. This is the durable cross-platform design authority; production adoption remains incremental and implementation-specific.

Sentient should feel like a calm, capable presence in the home: warm without being cute, intelligent without being theatrical, and trustworthy without feeling clinical. The interface should make a complex assistant feel understandable and under the household’s control.

## Authority and adoption

- `DESIGN.MD` owns the durable product character, material model, semantic roles, cross-platform behavior, and accessibility baseline.
- Current production token files own implementation values and must stay aligned across web and shared mobile code.
- Reviewed prototypes under `design/prototype/` are scoped visual and interaction contracts, not production dependencies or mandates for pixel-identical rendering.
- Temporary legacy explorations are not retained as authority; the consolidated prototypes and handoffs under `design/prototype/` replace them.
- Platform implementations express the same roles through native Preact, SwiftUI, and Compose behavior. Material conflicts must be resolved here rather than with page-local styling.

## Brand character

**Sentient is:**

- **Calm** — composed layouts, measured motion, plain language, and low visual noise.
- **Warm** — ember light, warm ink, tactile graphite surfaces, and humane typography.
- **Capable** — clear hierarchy, compact expert detail, and decisive controls when action is needed.
- **Present** — visible listening, thinking, responding, task, and interruption states.
- **Protective** — permissions, privacy scope, consequences, and recovery are explicit.
- **Household-minded** — shared context feels personal and lived-in, never corporate or dashboard-heavy.

**Sentient is not:** neon sci-fi, glassy futurism, a toy, a generic chat skin, an enterprise admin console, or a simulation of certainty.

## Experience principles

### Quiet by default; luminous when alive

Most of the interface stays low-chroma and settled. Ember is localized around focus, current activity, primary commitment, and the Sentient identity. If everything glows, nothing feels alive.

### Make agency visible

Show what Sentient is doing and what it needs from the user. Thinking, speaking, listening, queued work, interrupted work, permission requests, success, and failure must be distinguishable without reading a log.

Permission UI names the action, target, scope, and consequence before presenting a choice. A model-emitted request never looks like authorization already granted.

### Elevated slate explains behavior

**Elevated slate** is Sentient’s core physical concept: a thin warm-graphite face sits above the canvas like a precisely cut slate, with a soft localized top-edge light, compact contact shadow, and restrained downward ember cast. The face has a shallow inward bow: its center is slightly darker than its perimeter, like the `Stop` control reference. It must never brighten or swell through the center like a cushion. The object remains elevated through its cut edge and the space beneath it. It should feel tactile and substantial without becoming skeuomorphic.

Use one consistent physical model:

- **Canvas** holds the environment and does not float.
- **Plates** are broad, stable slates that group content with low elevation.
- **Keys** are compact actionable slates. Primary, secondary, quiet, destructive, and disabled variants keep the same physical construction; semantics change their face, edge, and glow rather than removing their depth. Destructive keys use an unmistakable clay-red face and red cast, not a near-neutral tint.
- **Wells** receive text or selection. Inputs, toggle tracks, segmented-control beds, slider tracks, and pressed label chips are visibly recessed with an upper occlusion shadow and a faint lower inner highlight.
- **Floats** are the highest slates: menus, dialogs, sheets, and permission prompts.

A raised control must have a subtly concave face, top-edge light, contact shadow, and directional cast. A well must have a darker receiver, inner top shadow, and lower reflected edge. Pressing a key closes the air gap by about 1px and collapses the cast; it does not bounce upward. Pointer hover must not add or brighten an outline. The resting edge may soften into the face while a small magnetic motion, stronger inward face tension, or localized glow carries the hover signal. Broad rows and disclosure headers keep text and icons fixed in place on hover; use tone, face tension, or localized glow rather than shifting their content. Disabled controls remain seated slates with shallow neutral depth—not flat translucent rectangles.

Depth is directional and compact. Avoid pale perimeter rims, thick bevels, detached underplates, soft shadows on every non-interactive surface, and decorative glow that does not communicate hierarchy.

### Progressive disclosure over permanent complexity

The primary conversation stays spacious. Tasks, tool detail, diagnostics, and advanced settings reveal contextually. Expert information may be dense, but it should not dominate ordinary household use.

### Platform fidelity over pixel identity

Brand character and semantic roles are shared; interaction behavior is native to each platform. Web, iOS, and Android should feel like the same product, not screenshots of the same renderer.

## Visual language

### Palette

Sentient uses the existing fixed warm-dark **Dusk** palette. These implementation values are locked for the design refresh; the prototypes’ nearby sampled colors are not a second palette. Light mode is out of scope until it is designed intentionally rather than mechanically inverted.

| Role | Token | Value | Intent |
|---|---|---:|---|
| Canvas | `color-bg` | `#2B2621` | Quiet warm environment |
| Elevated canvas | `color-bg-elev` | `#332D28` | Low material separation |
| Recessed canvas | `color-bg-sunk` | `#241F1B` | Wells and deep receivers |
| Slate face | `color-paper` | `#39322C` | Plates, keys, messages, and floats |
| Strong / quiet line | `color-line` / `color-line-soft` | `#4A4138` / `#3E362F` | Edge definition without pale outlines |
| Primary / secondary ink | `color-ink` / `color-ink-2` | `#F2E8D6` / `#D7C6AB` | Main and supporting content |
| Muted / disabled ink | `color-ink-3` / `color-ink-4` | `#9E907E` / `#706456` | Metadata and unavailable state |
| Ember | `color-accent` | `#F2A06A` | Commitment, focus, and genuine activity |
| Ember surfaces | `color-accent-soft` / `color-accent-50` | `#5A3A28` / `#402C22` | Selected and active slate treatment |
| Semantic accents | sage / amber / clay | Existing Dusk values | Narrow status, category, and persona signals |

Preserve semantic roles instead of selecting nearby colors by appearance. Reserve ember for primary actions, focus, active voice/assistant states, selected controls, and current-time emphasis. Sage, amber, clay, and status colors are narrow semantic markers, not broad decorative fills. Never rely on color alone to communicate state.

Contrast note: muted ink on `color-paper` is about `4.05:1`, so `color-ink-3` is not suitable for normal-size text on slate faces under the `4.5:1` AA target. Use `color-ink-2` for small supporting text on slate. Quiet boundaries also need shape, spacing, tonal difference, or elevation when they identify a control.

### Typography

The component library inherits the existing codebase typography rather than the prototypes’ inconsistent heading rules.

- **Display / identity:** Fraunces, then Cormorant Garamond or Georgia. Use for the wordmark, the existing 22px pane/page title, 18–22px dialog or editorial titles, and the rare 44px display moment.
- **Body / UI:** DM Sans with the platform system sans as fallback. Use 15px for body copy, at least 14px for controls and primary row labels, and at least 12.5px for supporting text.
- **Mono / telemetry:** JetBrains Mono with the platform monospace fallback. Ordinary user-facing metadata uses at least 12.5px. The 11px step is reserved for optional expert telemetry that is never required to understand state or take action.

Keep the established `11, 12.5, 15, 18, 22, 44` token scale and `1.25, 1.55, 1.6` line heights, but do not shrink routine interface copy merely to fit a composition. Reflow, wrap, truncate nonessential detail, or disclose it progressively instead. The serif voice is warmth, not ornament; routine card headings, settings rows, controls, and compact navigation remain in the UI face. Dynamic Type and user font scaling take precedence over fixed composition.

### Casing and emphasis

Visible interface text never uses all caps—not in headings, labels, controls, metadata, status, or examples. Do not use uppercase transforms. When a source value or identifier is capitalized, present a humane display label instead of exposing it as interface copy.

Use typography, icons, shape, semantic color, material depth, localized effects, and measured motion to direct attention. Capitalization is never an emphasis mechanism.

### Shape and density

Use a restrained radius family rather than a single radius everywhere:

- small controls and compact selection: `8`
- cards and ordinary containers: `12`
- conversation bubbles and major controls: `18`
- large feature surfaces: `26`
- pills only when the content is genuinely pill-like

Spacing follows the existing `4, 8, 12, 18, 26, 32, 40` foundation. Prefer fewer, stronger groupings over many nested boxes. Conversation measure stays comfortably readable; operational workspaces may be wider and denser.

### Icons and identity

Product icons use quiet geometric monoline construction: 24 × 24 view box, approximately 1.7 stroke, round caps and joins, and no embedded color.

The Sentient mark is identity, not a generic loading spinner. Canonical identity source and generated runtime artwork live under `design/prototype/foundation-components/assets/avatars/`: `sentient-avatar.rive.json` is the reviewable authored source, `sentient-avatar.riv` is the generated cross-platform runtime asset, and the colocated SVG/JavaScript files remain fidelity references and static fallbacks. The Rive asset owns idle, thinking, responding, their internal motion, Reduced Motion variants, and interruptible crossfade/scale/rotation transitions; local components must not redraw, recolor, or independently animate it. Voice listening is composer state and is never an avatar state.

User avatars are compact elevated-slate identity surfaces rather than flat tint circles or chat composites. The shared sizes are `28`, `44`, and `56`; each circular face keeps the shallow concave center, softened dark shoulder, contact shadow, and directional cast while terra, sage, amber, and clay provide restrained semantic tint. Avatar elevation must not use a sharp bright perimeter rim. Fallback, selected, and disabled states remain explicit. Image avatars, when introduced, use the same circular size and state boundary.

### Motion

Motion should answer one of three questions: **what changed, where did it go, or is it still alive?**

- Direct feedback is fast: about `150ms`.
- Surface and state changes are measured: about `250ms`.
- Continuous assistant/voice motion is calm, periodic, and interruptible. During an active responding or speaking message, the bubble’s directional ember cast may breathe on the canonical responding artwork’s 1.55-second cycle; the face does not swell, and Reduced Motion keeps a clear static active state.
- Streaming text reveals progressively inside a stable responsive message width while the face grows smoothly only in block size around new lines. The transition follows measured surface timing, never clips durable text, and becomes an immediate complete-text state under Reduced Motion.
- Pressed hardware closes its air gap rather than bouncing.
- Hover may add slight magnetic motion, inward face tension, or warm glow on precise pointers; it does not add a hover outline, and the resting edge may soften away. Touch surfaces do not imitate hover.
- Reduced Motion replaces travel, pulse, and repeated orbiting with clear static state changes.

Reusable composites transition whenever continuity explains a state change. Selection surfaces move between tabs or navigation rows; disclosures expand from their trigger; menus and option lists originate at their anchor; dialogs, sheets, and toasts enter and leave their spatial source; applying, success, and retry feedback crossfades without hiding useful content. Do not animate static layout merely for decoration, and do not let a composite hard-cut between logically connected states unless Reduced Motion requests it.

## Shared component language

Reusable components are defined by **role, anatomy, state, behavior, and accessibility**, not only by pixels.

Every interactive component must specify applicable states: rest, hover (web), focus, pressed, selected/on, loading or active, disabled, error, and destructive.

Foundation primitives include:

- action and icon buttons
- text field, text area, search field, select, slider, toggle, segmented control, checkbox, radio, and chip
- plate, well, progress indicator, divider, Sentient identity, and user avatar

Generic composite families include:

- page and pane headers, breadcrumbs, local navigation, tabs, toolbars, and action bars
- image- or icon-dominant action cards for login identity and future media-led entry points
- settings rows, grouped lists, text rows, metadata rows, overflow-action rows, reorderable lists, and responsive data rows
- validated field groups, inline editors, secret editors, file selection, upload progress, and staged actions
- identity pickers, Pin keypads, verification-code entry, steppers, and progress/result morphs
- search and filter bars, result summaries, empty/no-match recovery, skeletons, pagination, and incremental loading
- status text, notices, banners, stale-content states, disclosure groups, tooltips, menus, popovers, dialogs, sheets, toasts, and blocking overlays
- bulk selection, mixed state, selection counts, and contextual bulk actions

Product composites—including messages, rich responses, task strips, interruption markers, permission prompts, chat-composer controls, calendar compositions, and complete product pages—build from the foundation but require their own contextual review. They are not implied by a generic specimen.

Prefer semantic variants such as `primary`, `secondary`, `quiet`, `destructive`, and `selected` over page-specific styling. Selection must communicate through material and motion as well as color: toggleable label chips press into a well without inserting a marker, adding a selected outline, or changing their intrinsic width, while a segmented control moves one continuous selected slate between options. Chip labels keep equal inline padding in every state. A checkbox keeps a recessed receiver when empty and seats a compact ember slate with a check or mixed bar when selected; a checked box rises on precise-pointer hover like a primary key and closes its air gap only while pressed. Its full text label remains part of the native semantic target. A range control uses a recessed dark track, restrained semantic progress, and an elevated graphite thumb with a softened edge—never a white rail or bright perimeter ring.

Status text pairs a plain-language state with a compact elevated-slate light. The light keeps a dark shoulder, contact shadow, directional cast, and restrained semantic center; the adjacent text remains the authoritative signal when color, glow, or motion is unavailable.

A reorderable list exposes a dedicated elevated handle without turning the whole row into draggable chrome. Pointer drag is supplemented by keyboard movement and a concise position announcement; reordering must not depend on animation or gesture discovery alone.

Image- and icon-dominant cards reserve most of their area for one visual and one short label. When activation immediately continues—such as choosing a login identity—the card has no persistent selected treatment. Hover uses one coherent face-tension response without a second outline, nested glow, or competing avatar effect.

## Platform expression

### Web

- Support keyboard, pointer, coarse touch, and responsive layout as first-class inputs.
- Preserve visible focus and meaningful hover; hover must not be required to discover an action.
- Use constrained reading columns for conversation and wider workspaces for calendar/settings.
- Menus and dialogs use web semantics, predictable Escape behavior, focus containment, and focus restoration.
- Minimum interactive target: 44 × 44 CSS px where practical, including touch-capable layouts.

### iOS

- Use SwiftUI navigation, sheets, alerts, menus, swipe behavior, safe areas, Dynamic Type, and accessibility semantics.
- Minimum interactive target: 44 × 44 pt.
- Prefer native navigation titles and bottom sheets over reproducing desktop rails and dialogs.
- Preserve Sentient’s palette, typography, surfaces, and state language without fighting standard iOS behavior.

### Android

- Use Material 3 behavior and semantics through `SentientTheme`, including system bars, back behavior, dialogs, sheets, and accessibility.
- Minimum interactive target: 48 × 48 dp.
- Brand tokens map to semantic Material roles; components should not bypass the theme with nearby local colors.
- Preserve native layout, typography scaling, and predictive-back expectations.

## Content and trust

Sentient’s interface voice is calm, direct, specific, and consequence-aware.

- Prefer “Allow once” to “Yes.”
- Name the resource and change: “Update the shared school pickup event.”
- Say what happened after interruption or failure.
- Do not expose implementation names such as Hermes where the user is interacting with Sentient.
- Do not imply certainty, completion, privacy, or authorization that the system cannot prove.
- Do not log or surface private household content as decorative diagnostics.

## Accessibility baseline

- Target WCAG 2.2 AA contrast for text and essential component boundaries.
- Text remains usable at 200% web zoom and with native accessibility sizes.
- State has a text, icon, shape, or motion-independent signal in addition to color.
- Focus order follows visual and task order; overlays trap and restore focus appropriately. The no-outline hover rule never removes the visible keyboard focus indicator.
- Screen readers receive concise state announcements for assistant activity, permission requests, connection changes, and completion.
- Reduced Motion, increased contrast, reduced transparency/data, and platform accessibility settings receive intentional fallbacks.

## Design review checklist

Before accepting a component or screen:

1. Does it feel calm, warm, capable, present, and protective?
2. Is ember reserved for attention, activity, focus, or commitment?
3. Does depth explain interaction rather than decorate it?
4. Are async, permission, interruption, error, and disabled states explicit?
5. Is behavior native to the target platform?
6. Does it use semantic tokens and reusable component roles?
7. Does it remain understandable without color, hover, animation, or private content?
8. Has it been reviewed at compact phone, large phone, tablet, desktop, zoomed/scaled text, and reduced-motion conditions?
9. Is all visible interface copy free of all-caps styling, including examples and metadata?
10. Are routine labels at least 14px and supporting text at least 12.5px, without shrinking copy to rescue a crowded layout?

## Implementation and review sources

- `design/prototype/foundation-components/` — reviewed responsive foundation subset and implementation handoff
- `design/prototype/foundation-components/assets/avatars/` — canonical Sentient identity source, generated Rive runtime asset, fidelity references, and deterministic generation manifest
- `scripts/design/sentient-avatar-rive.sh` — pinned generation, validation, transition, Reduced Motion, and SVG-parity verification
- `gateway/webui/src/styles/tokens/` — canonical web token values
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/design/DesignTokens.kt` — shared mobile token mirror

## Locked foundation decisions

- Use the current production Dusk palette and existing typography scale/hierarchy.
- Use one responsive mock component library for web and mobile review.
- Treat elevated slate as the shared material concept: actionable faces rise; receiving surfaces recess.
- Use canonical Sentient artwork for assistant identity and elevated-slate surfaces for user identity.
- Keep product composites and chat-composer controls out of the primitive foundation review.
- Never use all-caps styling in visible interface copy.
- Keep routine labels at 14px or larger and supporting text at 12.5px or larger; reserve 11px for optional expert telemetry.

## Open foundation decisions

- Confirm float-tier elevation when menus, popovers, dialogs, and sheets receive their dedicated review.
- Confirm shared semantic component names before implementation libraries are refreshed.
- Voice listening remains composer-owned; the Sentient identity exposes only idle, thinking, and responding.
- Define image-avatar loading, crop, and failure behavior before image avatars ship.
