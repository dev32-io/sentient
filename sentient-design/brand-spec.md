# Sentient Dusk — elevated slate material

Sentient uses the existing fixed warm-dark Dusk palette. The design refresh does not introduce a second palette. Its new material concept is **elevated slate**: thin warm-graphite faces, compact directional depth, and localized ember light around attention, activity, focus, and commitment.

## Canonical Dusk tokens

The implementation values remain synchronized across:

- `gateway/webui/src/styles/tokens/`
- `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/design/DesignTokens.kt`
- `ios/App/Theme/`
- `android/src/main/kotlin/io/sentient/android/theme/`

```css
:root {
  --color-bg: #2B2621;
  --color-bg-elev: #332D28;
  --color-bg-sunk: #241F1B;
  --color-paper: #39322C;
  --color-line: #4A4138;
  --color-line-soft: #3E362F;
  --color-ink: #F2E8D6;
  --color-ink-2: #D7C6AB;
  --color-ink-3: #9E907E;
  --color-ink-4: #706456;
  --color-accent: #F2A06A;
  --color-accent-soft: #5A3A28;
  --color-accent-50: #402C22;
  --color-amber: #E9B168;
  --color-sage: #B9C8A6;
  --color-sage-soft: #3A4232;
  --color-clay: #9A5A3E;
  --color-ok: #5F8A5B;
  --color-warn: #C2892F;
  --color-stop: #B8442E;
}
```

## Existing typography and scales

- Display: `"Fraunces", "Cormorant Garamond", Georgia, serif`
- Body/UI: `"DM Sans", "Inter", system-ui, -apple-system, sans-serif`
- Mono: `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace`
- Type: `11, 12.5, 15, 18, 22, 44`; line heights `1.25, 1.55, 1.6`
- Spacing: `4, 8, 12, 18, 26, 32, 40`
- Radius: `8, 12, 18, 26`, plus pill
- Motion: `150ms` direct feedback; `250ms` state/surface change

Component work uses this existing hierarchy. Prototype-local type sizes and heading substitutions are not authoritative.

## Elevated slate construction

### Raised slate

Buttons, the moving selected slate inside segmented controls, unselected chips, and other actionable keys share one construction:

1. a thin warm-graphite face with a shallow inward bow: the center is slightly darker than the perimeter, never brighter or outwardly puffed;
2. a narrow top inner highlight that reads as a cut edge rather than surface puffiness;
3. a compact dark contact shadow immediately beneath the face;
4. a restrained downward cast, with ember added only for focus, activity, selection, or commitment.

Primary, secondary, quiet, destructive, and disabled keys remain members of the same material family. A semantic variant changes the face tint, edge, ink, and glow—it does not become visually flat. Destructive actions use an unmistakable clay-red face and red cast at both text-button and compact icon sizes.

Hover uses a slight magnetic motion, stronger inward face tension, or localized glow. It never adds or brightens an outline; the resting edge may soften into the face instead. Press moves the face down about 1px and collapses the cast. Disabled keys remain seated with shallow neutral depth and no ember response. Keyboard focus remains visibly indicated independently of hover.

### Recessed well

Inputs, text areas, toggle tracks, segmented-control beds, and slider tracks are receiving surfaces. They use:

1. a darker `color-bg-sunk` receiver;
2. an inset upper occlusion shadow;
3. a faint lower inner highlight reflected from the slate edge;
4. a clear focus edge and localized ember focus ring.

An input must not read as a flat dark rectangle. Its well treatment should be visibly related to the toggle track and segmented-control bed. A selected label chip stays pressed into this receiving material and adds a compact ember marker; a segmented group visibly glides one continuous selected slate between choices rather than switching faces instantaneously.

### Identity surfaces

User avatars are circular elevated-slate identity surfaces at `28`, `44`, and `56`. Their shallow concave face, softened dark shoulder, contact shadow, and directional cast remain consistent with raised slates without adding a sharp bright perimeter rim. Initial fallbacks use Fraunces over restrained terra, sage, amber, and clay Dusk tints; fallback, selected, and disabled states remain explicit and never depend on initials or color alone.

The Sentient avatar uses the canonical assets under `sentient-design/avatars/`: idle, thinking, and responding. Those SVGs own their nucleus, orbital artwork, and internal animation. The accompanying custom element owns the supplied crossfade, scale, and rotation transition between states and provides reduced-motion behavior. Product surfaces size and label this primitive but do not redraw or recolor it.

### Plate and float

Plates group stable content at low elevation. Menus, dialogs, sheets, and permission prompts are floating slates with a stronger directional cast. Broad content surfaces do not receive active ember glow unless the whole surface is genuinely live.

## Material rules

1. Ordinary surfaces remain low-chroma Dusk; warmth is not spread across every fill.
2. Ember is reserved for primary actions, focus, selected controls, responding/listening identity, current-time emphasis, and genuine activity.
3. Every raised control keeps the slate face/contact/cast construction, including quiet, destructive, and disabled variants.
4. Every receiving control keeps the recessed-well construction, including text inputs, text areas, toggle tracks, segmented beds, and slider tracks.
5. Use `color-ink-2`, not muted `color-ink-3`, for normal-size supporting text on `color-paper` when AA contrast is required.
6. Calendar and category colors use narrow semantic markers rather than coating entire plates.
7. Avoid pale perimeter rims, thick bevels, detached underplates, omnidirectional glow, and shadow that does not explain interaction.
