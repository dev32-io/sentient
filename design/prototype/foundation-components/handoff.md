# Foundation components handoff

## Outcome

- Implement the approved foundation subset from the current prototype as native Preact, SwiftUI, and Compose components.
- Treat each isolated PNG below as the visual authority for one implementation-preview target. Each PNG has a transparent surrounding canvas; composite it on the canonical Dusk canvas when reviewing contrast and directional depth. The prototype source remains the authority for behavior and responsive composition.
- Keep product composites and chat-composer controls outside this handoff.

## Prototype

- Entry point: `design/prototype/foundation-components/index.html`.
- Component appearance: `design/prototype/foundation-components/sentient-components.css`.
- Reference behavior: `design/prototype/foundation-components/sentient-components.js`.
- Review-page-only layout: `design/prototype/foundation-components/showcase.css`; do not port it as component styling.
- Canonical implementation values remain in `gateway/webui/src/styles/tokens/` and `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/design/DesignTokens.kt`.

## Static references

### Plate

- `design/prototype/foundation-components/handoff/static/plate--default--compact-rest.png` — Plate reference: default; compact rest.
- `design/prototype/foundation-components/handoff/static/plate--default--rest.png` — Plate reference: default; rest.

### Action button

- `design/prototype/foundation-components/handoff/static/action-button--destructive--compact-rest.png` — Action button reference: destructive; compact rest.
- `design/prototype/foundation-components/handoff/static/action-button--destructive--focus.png` — Action button reference: destructive; focus.
- `design/prototype/foundation-components/handoff/static/action-button--destructive--hover.png` — Action button reference: destructive; hover.
- `design/prototype/foundation-components/handoff/static/action-button--destructive--pressed.png` — Action button reference: destructive; pressed.
- `design/prototype/foundation-components/handoff/static/action-button--destructive--rest.png` — Action button reference: destructive; rest.
- `design/prototype/foundation-components/handoff/static/action-button--primary--compact-rest.png` — Action button reference: primary; compact rest.
- `design/prototype/foundation-components/handoff/static/action-button--primary--focus.png` — Action button reference: primary; focus.
- `design/prototype/foundation-components/handoff/static/action-button--primary--hover.png` — Action button reference: primary; hover.
- `design/prototype/foundation-components/handoff/static/action-button--primary--pressed.png` — Action button reference: primary; pressed.
- `design/prototype/foundation-components/handoff/static/action-button--primary--rest.png` — Action button reference: primary; rest.
- `design/prototype/foundation-components/handoff/static/action-button--quiet--compact-rest.png` — Action button reference: quiet; compact rest.
- `design/prototype/foundation-components/handoff/static/action-button--quiet--focus.png` — Action button reference: quiet; focus.
- `design/prototype/foundation-components/handoff/static/action-button--quiet--hover.png` — Action button reference: quiet; hover.
- `design/prototype/foundation-components/handoff/static/action-button--quiet--pressed.png` — Action button reference: quiet; pressed.
- `design/prototype/foundation-components/handoff/static/action-button--quiet--rest.png` — Action button reference: quiet; rest.
- `design/prototype/foundation-components/handoff/static/action-button--secondary--compact-disabled.png` — Action button reference: secondary; compact disabled.
- `design/prototype/foundation-components/handoff/static/action-button--secondary--compact-rest.png` — Action button reference: secondary; compact rest.
- `design/prototype/foundation-components/handoff/static/action-button--secondary--disabled.png` — Action button reference: secondary; disabled.
- `design/prototype/foundation-components/handoff/static/action-button--secondary--focus.png` — Action button reference: secondary; focus.
- `design/prototype/foundation-components/handoff/static/action-button--secondary--hover.png` — Action button reference: secondary; hover.
- `design/prototype/foundation-components/handoff/static/action-button--secondary--pressed.png` — Action button reference: secondary; pressed.
- `design/prototype/foundation-components/handoff/static/action-button--secondary--rest.png` — Action button reference: secondary; rest.

### Icon button

- `design/prototype/foundation-components/handoff/static/icon-button--default--compact-disabled.png` — Icon button reference: default; compact disabled.
- `design/prototype/foundation-components/handoff/static/icon-button--default--compact-rest.png` — Icon button reference: default; compact rest.
- `design/prototype/foundation-components/handoff/static/icon-button--default--disabled.png` — Icon button reference: default; disabled.
- `design/prototype/foundation-components/handoff/static/icon-button--default--focus.png` — Icon button reference: default; focus.
- `design/prototype/foundation-components/handoff/static/icon-button--default--hover.png` — Icon button reference: default; hover.
- `design/prototype/foundation-components/handoff/static/icon-button--default--pressed.png` — Icon button reference: default; pressed.
- `design/prototype/foundation-components/handoff/static/icon-button--default--rest.png` — Icon button reference: default; rest.
- `design/prototype/foundation-components/handoff/static/icon-button--destructive--compact-rest.png` — Icon button reference: destructive; compact rest.
- `design/prototype/foundation-components/handoff/static/icon-button--destructive--focus.png` — Icon button reference: destructive; focus.
- `design/prototype/foundation-components/handoff/static/icon-button--destructive--hover.png` — Icon button reference: destructive; hover.
- `design/prototype/foundation-components/handoff/static/icon-button--destructive--pressed.png` — Icon button reference: destructive; pressed.
- `design/prototype/foundation-components/handoff/static/icon-button--destructive--rest.png` — Icon button reference: destructive; rest.
- `design/prototype/foundation-components/handoff/static/icon-button--quiet--compact-rest.png` — Icon button reference: quiet; compact rest.
- `design/prototype/foundation-components/handoff/static/icon-button--quiet--focus.png` — Icon button reference: quiet; focus.
- `design/prototype/foundation-components/handoff/static/icon-button--quiet--hover.png` — Icon button reference: quiet; hover.
- `design/prototype/foundation-components/handoff/static/icon-button--quiet--pressed.png` — Icon button reference: quiet; pressed.
- `design/prototype/foundation-components/handoff/static/icon-button--quiet--rest.png` — Icon button reference: quiet; rest.

### Text field

- `design/prototype/foundation-components/handoff/static/text-field--filled--focus.png` — Text field reference: filled; focus.
- `design/prototype/foundation-components/handoff/static/text-field--filled--hover.png` — Text field reference: filled; hover.
- `design/prototype/foundation-components/handoff/static/text-field--filled--rest.png` — Text field reference: filled; rest.

### Search field

- `design/prototype/foundation-components/handoff/static/search-field--placeholder--focus.png` — Search field reference: placeholder; focus.
- `design/prototype/foundation-components/handoff/static/search-field--placeholder--hover.png` — Search field reference: placeholder; hover.
- `design/prototype/foundation-components/handoff/static/search-field--placeholder--rest.png` — Search field reference: placeholder; rest.

### Text area

- `design/prototype/foundation-components/handoff/static/text-area--filled--focus.png` — Text area reference: filled; focus.
- `design/prototype/foundation-components/handoff/static/text-area--filled--hover.png` — Text area reference: filled; hover.
- `design/prototype/foundation-components/handoff/static/text-area--filled--rest.png` — Text area reference: filled; rest.

### Toggle

- `design/prototype/foundation-components/handoff/static/toggle--off--focus.png` — Toggle reference: off; focus.
- `design/prototype/foundation-components/handoff/static/toggle--off--hover.png` — Toggle reference: off; hover.
- `design/prototype/foundation-components/handoff/static/toggle--off--pressed.png` — Toggle reference: off; pressed.
- `design/prototype/foundation-components/handoff/static/toggle--off--rest.png` — Toggle reference: off; rest.
- `design/prototype/foundation-components/handoff/static/toggle--on--focus.png` — Toggle reference: on; focus.
- `design/prototype/foundation-components/handoff/static/toggle--on--hover.png` — Toggle reference: on; hover.
- `design/prototype/foundation-components/handoff/static/toggle--on--pressed.png` — Toggle reference: on; pressed.
- `design/prototype/foundation-components/handoff/static/toggle--on--rest.png` — Toggle reference: on; rest.

### Segmented control

- `design/prototype/foundation-components/handoff/static/segmented-control--avatar-state--compact-layout.png` — Segmented control reference: avatar state; compact layout.
- `design/prototype/foundation-components/handoff/static/segmented-control--avatar-state--idle-selected.png` — Segmented control reference: avatar state; idle selected.
- `design/prototype/foundation-components/handoff/static/segmented-control--avatar-state--responding-selected.png` — Segmented control reference: avatar state; responding selected.
- `design/prototype/foundation-components/handoff/static/segmented-control--avatar-state--thinking-selected.png` — Segmented control reference: avatar state; thinking selected.
- `design/prototype/foundation-components/handoff/static/segmented-control--density--comfortable-selected.png` — Segmented control reference: density; comfortable selected.
- `design/prototype/foundation-components/handoff/static/segmented-control--density--compact-focus.png` — Segmented control reference: density; compact focus.
- `design/prototype/foundation-components/handoff/static/segmented-control--density--compact-hover.png` — Segmented control reference: density; compact hover.
- `design/prototype/foundation-components/handoff/static/segmented-control--density--compact-layout.png` — Segmented control reference: density; compact layout.
- `design/prototype/foundation-components/handoff/static/segmented-control--density--compact-pressed.png` — Segmented control reference: density; compact pressed.
- `design/prototype/foundation-components/handoff/static/segmented-control--density--compact-selected.png` — Segmented control reference: density; compact selected.

### Chip

- `design/prototype/foundation-components/handoff/static/chip--selected--compact-rest.png` — Chip reference: selected; compact rest.
- `design/prototype/foundation-components/handoff/static/chip--selected--focus.png` — Chip reference: selected; focus.
- `design/prototype/foundation-components/handoff/static/chip--selected--hover.png` — Chip reference: selected; hover.
- `design/prototype/foundation-components/handoff/static/chip--selected--pressed.png` — Chip reference: selected; pressed.
- `design/prototype/foundation-components/handoff/static/chip--selected--rest.png` — Chip reference: selected; rest.
- `design/prototype/foundation-components/handoff/static/chip--unselected--compact-rest.png` — Chip reference: unselected; compact rest.
- `design/prototype/foundation-components/handoff/static/chip--unselected--focus.png` — Chip reference: unselected; focus.
- `design/prototype/foundation-components/handoff/static/chip--unselected--hover.png` — Chip reference: unselected; hover.
- `design/prototype/foundation-components/handoff/static/chip--unselected--pressed.png` — Chip reference: unselected; pressed.
- `design/prototype/foundation-components/handoff/static/chip--unselected--rest.png` — Chip reference: unselected; rest.

### Checkbox

- `design/prototype/foundation-components/handoff/static/checkbox--checked--focus.png` — Checkbox reference: checked; focus.
- `design/prototype/foundation-components/handoff/static/checkbox--checked--hover.png` — Checkbox reference: checked; hover.
- `design/prototype/foundation-components/handoff/static/checkbox--checked--pressed.png` — Checkbox reference: checked; pressed.
- `design/prototype/foundation-components/handoff/static/checkbox--checked--rest.png` — Checkbox reference: checked; rest.
- `design/prototype/foundation-components/handoff/static/checkbox--disabled--rest.png` — Checkbox reference: disabled; rest.
- `design/prototype/foundation-components/handoff/static/checkbox--mixed--focus.png` — Checkbox reference: mixed; focus.
- `design/prototype/foundation-components/handoff/static/checkbox--mixed--hover.png` — Checkbox reference: mixed; hover.
- `design/prototype/foundation-components/handoff/static/checkbox--mixed--pressed.png` — Checkbox reference: mixed; pressed.
- `design/prototype/foundation-components/handoff/static/checkbox--mixed--rest.png` — Checkbox reference: mixed; rest.
- `design/prototype/foundation-components/handoff/static/checkbox--unchecked--focus.png` — Checkbox reference: unchecked; focus.
- `design/prototype/foundation-components/handoff/static/checkbox--unchecked--hover.png` — Checkbox reference: unchecked; hover.
- `design/prototype/foundation-components/handoff/static/checkbox--unchecked--pressed.png` — Checkbox reference: unchecked; pressed.
- `design/prototype/foundation-components/handoff/static/checkbox--unchecked--rest.png` — Checkbox reference: unchecked; rest.

### Range

- `design/prototype/foundation-components/handoff/static/range--62--disabled.png` — Range reference: 62; disabled.
- `design/prototype/foundation-components/handoff/static/range--62--focus.png` — Range reference: 62; focus.
- `design/prototype/foundation-components/handoff/static/range--62--hover.png` — Range reference: 62; hover.
- `design/prototype/foundation-components/handoff/static/range--62--rest.png` — Range reference: 62; rest.

### User avatar

- `design/prototype/foundation-components/handoff/static/user-avatar--amber-44--rest.png` — User avatar reference: amber 44; rest.
- `design/prototype/foundation-components/handoff/static/user-avatar--clay-44--rest.png` — User avatar reference: clay 44; rest.
- `design/prototype/foundation-components/handoff/static/user-avatar--fallback-44--rest.png` — User avatar reference: fallback 44; rest.
- `design/prototype/foundation-components/handoff/static/user-avatar--sage-44--rest.png` — User avatar reference: sage 44; rest.
- `design/prototype/foundation-components/handoff/static/user-avatar--terra-28--rest.png` — User avatar reference: terra 28; rest.
- `design/prototype/foundation-components/handoff/static/user-avatar--terra-44--disabled.png` — User avatar reference: terra 44; disabled.
- `design/prototype/foundation-components/handoff/static/user-avatar--terra-44--rest.png` — User avatar reference: terra 44; rest.
- `design/prototype/foundation-components/handoff/static/user-avatar--terra-44--selected.png` — User avatar reference: terra 44; selected.
- `design/prototype/foundation-components/handoff/static/user-avatar--terra-56--rest.png` — User avatar reference: terra 56; rest.

### Sentient identity

- `design/prototype/foundation-components/handoff/static/sentient-identity--idle--reduced-motion.png` — Sentient identity reference: idle; reduced motion.
- `design/prototype/foundation-components/handoff/static/sentient-identity--idle--rest.png` — Sentient identity reference: idle; rest.
- `design/prototype/foundation-components/handoff/static/sentient-identity--responding--reduced-motion.png` — Sentient identity reference: responding; reduced motion.
- `design/prototype/foundation-components/handoff/static/sentient-identity--responding--rest.png` — Sentient identity reference: responding; rest.
- `design/prototype/foundation-components/handoff/static/sentient-identity--thinking--reduced-motion.png` — Sentient identity reference: thinking; reduced motion.
- `design/prototype/foundation-components/handoff/static/sentient-identity--thinking--rest.png` — Sentient identity reference: thinking; rest.

## Motion references

Frames are ordered by filename. Every frame preserves one component boundary.

- `design/prototype/foundation-components/handoff/recordings/checkbox--unchecked-to-checked/` — Checkbox transition from unchecked to checked.
- `design/prototype/foundation-components/handoff/recordings/checkbox--unchecked-to-mixed/` — Checkbox transition from unchecked to mixed.
- `design/prototype/foundation-components/handoff/recordings/chip--unselected-to-selected/` — Chip transition from raised rest to selected well.
- `design/prototype/foundation-components/handoff/recordings/segmented-control--comfortable-to-compact/` — Segmented-control selection moving from Comfortable to Compact.
- `design/prototype/foundation-components/handoff/recordings/sentient-avatar--idle-to-thinking/` — Sentient identity transition from idle to thinking.
- `design/prototype/foundation-components/handoff/recordings/sentient-avatar--responding-loop/` — Representative responding loop keyframes.
- `design/prototype/foundation-components/handoff/recordings/sentient-avatar--responding-to-idle/` — Sentient identity transition from responding to idle.
- `design/prototype/foundation-components/handoff/recordings/sentient-avatar--thinking-loop/` — Representative thinking loop keyframes.
- `design/prototype/foundation-components/handoff/recordings/sentient-avatar--thinking-to-responding/` — Sentient identity transition from thinking to responding.
- `design/prototype/foundation-components/handoff/recordings/toggle--off-to-on/` — Toggle transition from off to on.

## Behavior and accessibility

- Preserve native button, input, switch, checkbox, range, and text-field semantics. The full visible checkbox label remains part of its target.
- Preserve visible keyboard focus. Hover is supplementary and must never be required to identify or operate a control.
- Pressed keys close their air gap without bouncing. Disabled controls remain explicit, seated components rather than translucent flat shapes.
- The segmented control moves one continuous selected slate. Chip selection does not add a marker, outline, or label-width change.
- Checkboxes expose unchecked, checked, mixed, disabled, hover, focus, and pressed behavior without relying on color alone. Range implementations retain native keyboard behavior and an explicit value.
- Use platform-native minimum targets and scaling behavior from `DESIGN.MD`; compact references document the prototype’s narrow-width component geometry, not a page layout to copy.
- Sentient identity exposes only idle, thinking, and responding. WebUI and iOS package `design/prototype/foundation-components/assets/avatars/sentient-avatar.riv`; `sentient-avatar.rive-manifest.json` defines transitions, interruption, and Reduced Motion. Platform wrappers map state, accessibility preference, size, labels, and fallback only. Invalid state values resolve to idle.
- User avatars retain explicit tint, size, fallback, selected, and disabled variants. Image-avatar loading, crop, privacy, and failure behavior remain undefined.
- Visible copy never uses all-caps styling. Routine controls remain at least 14px and supporting text at least 12.5px; the 11px step is optional expert telemetry only.

## Exceptions and open boundaries

- Shared production component names and APIs remain an implementation decision.
- Loading and error states are not approved by this prototype.
- Radio, select, tabs, progress, feedback, overlays, float-tier surfaces, links, inline code, and specialized telemetry require separate review.
- Voice listening and composer controls do not add Sentient identity states.
- Production still requires platform validation for keyboard navigation, screen readers, increased contrast, Reduced Motion, 200% web zoom, and native large-text settings.
