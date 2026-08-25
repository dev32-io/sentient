# Foundation components implementation handoff

## Outcome

- Implement the reviewed foundation subset as a calm, warm, cross-platform component language governed by `DESIGN.MD`.
- Preserve the locked Dusk roles, existing typography hierarchy, and one physical model: actionable faces rise, receiving surfaces recess, and broad plates stay quiet.
- Keep web, iOS, and Android UI behavior native; the prototype CSS/JavaScript is a visual and semantic contract, not shared runtime code or a pixel-identity mandate. The generated Rive identity asset is the deliberate shared runtime-asset exception for WebUI and iOS.
- Keep product composites and chat-composer controls outside this implementation scope.

## Source

- Entry point: `design/prototype/foundation-components/index.html`.
- Component appearance: `design/prototype/foundation-components/sentient-components.css`; review-page layout is isolated in `showcase.css` and must not be ported as component styling.
- Reference behavior: `design/prototype/foundation-components/sentient-components.js`.
- Durable authority: `DESIGN.MD`.
- Canonical tokens: `gateway/webui/src/styles/tokens/` and `shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/design/DesignTokens.kt`.
- Canonical Sentient identity: `design/prototype/foundation-components/assets/avatars/`. `sentient-avatar.rive.json` is the reviewable authored source, `sentient-avatar.riv` is the generated runtime asset shared by WebUI and iOS, and `sentient-avatar.rive-manifest.json` pins source hashes, generator inputs, state-machine names, timings, and documented SVG-to-Rive adaptations. The colocated SVG/JavaScript files are fidelity references and static fallbacks.
- Deterministic generation and verification: `scripts/design/sentient-avatar-rive.sh` or `bun run design:avatar:verify`; the pinned third-party generator bootstrap is `scripts/design/bootstrap-rive-cli.sh`.
- Existing avatar migration targets: `gateway/webui/src/components/common/avatar.tsx`, `ios/App/Chat/brand/UserAvatar.swift`, and `android/src/main/kotlin/io/sentient/android/chat/brand/InitialAvatar.kt`.
- No checkpoint snapshot was created; the current prototype entry point is the reviewed state.

## Behavior

- Raised keys use a shallow concave face, compact contact shadow, and downward cast. Press closes the air gap; hover may tighten the face, move slightly, or glow but must not add a bright outline.
- Wells use upper inner occlusion and a lower reflected edge. Toggle tracks, segmented beds, text inputs, text areas, and pressed chips share this receiving-surface model.
- Preserve applicable rest, precise-pointer hover, visible keyboard focus, pressed, selected/on, destructive, and disabled states. Loading and error are not demonstrated here.
- The segmented control moves one continuous selected slate. Selected chips remain visibly pressed without inserting a marker, adding a highlight outline, changing width, or changing their equal left/right label padding.
- Checkboxes retain native input semantics: the empty state is a recessed receiver; checked and mixed states seat a compact ember slate with a visible check or bar. Checked hover uses the raised-key response; the slammed treatment appears only during press. The entire text label is the target, and disabled state remains explicit.
- Range controls retain native keyboard semantics while using a recessed dark track, restrained ember progress, and an elevated graphite thumb. Do not use a white remainder rail or bright thumb rim.
- Sentient identity uses the generated Rive asset with exactly idle, thinking, and responding. The asset owns internal motion, directed 250ms crossfade/scale/rotation choreography, transition interruption, and authored Reduced Motion variants. Platform wrappers only map semantic state, set Reduced Motion, size the view, and provide native labels and fallback behavior.
- User avatars use the reviewed elevated-slate face at the shared size tiers, with terra/sage/amber/clay tint roles, initials fallback, selected, and disabled states. Keep the concave center, dark softened shoulder, contact shadow, and cast; do not add a sharp bright perimeter rim.
- At narrow widths, specimen columns stack and the avatar transition control recomposes without horizontal overflow. Production layouts must use their native responsive and safe-area behavior rather than copying showcase breakpoints blindly.
- Meet the platform target minimums in `DESIGN.MD`, retain visible focus, expose concise identity/state labels, avoid color-only state, and remain usable with text scaling, Reduced Motion, and increased contrast.
- Routine controls and primary row labels use at least 14px; supporting text and ordinary metadata use at least 12.5px. The 11px token is only for optional expert telemetry and must never carry required meaning or action.
- Visible interface copy never uses all-caps styling, including examples and metadata. Use hierarchy, graphics, semantic color, material effects, and measured motion for emphasis.
- Preserve meaningful continuity when component state changes. Selection surfaces move, anchored surfaces enter from their source, and Reduced Motion receives an immediate static state change.
- Invalid Sentient state values resolve to idle in the reference component. Missing artwork behavior is not defined; implementations should bundle canonical assets rather than fetch them remotely.

## Decisions

- Dusk and the established type, spacing, radius, and motion scales are locked; the user-friendly type floors in `DESIGN.MD` govern how the smaller steps may be used, and nearby prototype samples are not new tokens.
- Ember is reserved for focus, commitment, selection, and genuine activity. Semantic tints remain narrow identity/status signals.
- Destructive keys retain common slate physics but use an unmistakable clay-red face and cast.
- User avatars are elevated identity surfaces, not flat tinted circles; current production avatar rings are legacy behavior to replace.
- Sentient artwork must not be locally redrawn, recolored, or independently animated.
- Static identity primitives belong in the foundation. Voice listening, microphone, send, interrupt, waveform, playback, and other input expression belong to the composer and never add an avatar state.
- Preact, SwiftUI, and Compose should implement semantic roles natively rather than consuming the prototype CSS or custom element.

## Open

- **No blocker for implementing the reviewed subset.**
- Shared production component names and APIs still need agreement before implementation libraries are refreshed.
- Float-tier elevation for menus, popovers, dialogs, and sheets requires dedicated review.
- Radio, select, tabs, progress, feedback, overlays, loading, and error specimens are not approved by this prototype.
- Links, inline code, numeric alignment, and specialized expert telemetry remain to be reviewed. Production still requires explicit 200% zoom and native large-text validation.
- Image-avatar loading, crop, failure, and privacy behavior is undefined; block image-avatar implementation until reviewed.
- Voice listening remains composer-owned; no listening avatar state exists.
