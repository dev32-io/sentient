# Task Brief: Establish the additive design-foundation v2 contract and generated projections

## Contribution Goal

Create one versioned, machine-checkable design foundation in the shared KMP module and deterministic Web projections without changing Android's existing v1 visual consumers.

## Boundary — Included

- A versioned machine-readable v2 contract owned by shared/mobile-sdk, additive generated Kotlin declarations under io.sentient.mobilesdk.design.v2, generated Web CSS and TypeScript projections, and deterministic generate/check commands.
- Semantic colors, typography, line heights, spacing, radii, motion, material/effect descriptors, avatar asset/state descriptors, and stable component-state vocabulary.
- Freshness/version/hash tests proving the KMP and Web projections came from the same v2 contract.

## Required Work

- 1. Add the canonical v2 data source under shared/mobile-sdk without editing DesignTokens.kt v1. Encode colors bg #2B2621, elevated #332D28, sunk #241F1B, paper #39322C, lines #4A4138/#3E362F, ink #F2E8D6/#D7C6AB/#9E907E/#706456, ember #F2A06A/#5A3A28/#402C22, amber #E9B168, sage #B9C8A6, sage-soft #3A4232, clay #9A5A3E, ok #5F8A5B, warn #C2892F, stop #B8442E; type 11/12.5/15/18/22/44; line heights 1.25/1.55/1.6; spacing 4/8/12/18/26/32/40; radii 8/12/18/26 plus a true pill; feedback 150ms; state/surface transition 250ms; responding cadence 1.55s.
- 2. Encode platform-neutral slate/well/plate/float effect roles using the exact mixtures, offsets, and opacity recipes at design/prototype/foundation-components/sentient-components.css:1-157. Preserve the physical model: actionable faces are elevated and subtly concave, receiving surfaces are recessed, broad plates stay quiet, there is no bright perimeter rim or center highlight, and Ember is reserved for commitment/focus/activity.
- 3. Encode the identity descriptor exactly: runtime file sentient-avatar.riv, manifest path, artboard SentientAvatar, state machine Avatar, states idle/thinking/responding, triggers toIdle/toThinking/toResponding, Boolean reducedMotion, transition duration 250ms, and checksum from the committed manifest. Listening is not an avatar state.
- 4. Generate additive Kotlin declarations in io.sentient.mobilesdk.design.v2 and generated Web outputs under gateway/webui/src/styles/tokens/. Do not hand-edit generated outputs or change existing Android v1 call sites.
- 5. Add root commands design:foundation:generate and design:foundation:check. Check mode must regenerate to temporary files, compare bytes/hash/version, validate exact locked values and the Rive descriptor checksum, and fail on drift.
- 6. Add focused tests for schema validation, generation determinism, exact values, version/hash agreement, and unchanged v1 token declarations. Document operator-tunable versus protocol/implementation values; design values remain in the versioned contract rather than page code.

## Integration Expectation

Deliver this contribution for integration in stage contracts-and-harness.

## Context

- The current manual v1 source is shared/mobile-sdk/src/commonMain/kotlin/io/sentient/mobilesdk/design/DesignTokens.kt; Android consumes it through android/src/main/kotlin/io/sentient/android/theme/Tokens.kt and must remain visually unchanged.
- DESIGN.MD is durable authority. Exact material recipes begin in design/prototype/foundation-components/sentient-components.css. The five prototype README/handoff pairs under design/prototype are scoped authorities.
- The canonical identity contract is already committed under design/prototype/foundation-components/assets/avatars/: sentient-avatar.rive.json, sentient-avatar.riv, and sentient-avatar.rive-manifest.json.

## Boundary — Excluded

- Production WebUI or iOS component migration
- Any Android UI, theme, avatar, or token-consumer edits
- Changing the already reviewed Rive SceneSpec or runtime asset
- Light mode or speculative unused component families

## Interfaces and Dependencies

- Produces an additive KMP v2 API, generated Web CSS/TypeScript modules, a contract version/hash, and design:foundation generate/check commands consumed by later platform tasks.
- Preserves the existing io.sentient.mobilesdk.design.DesignTokens v1 API and all Android UI behavior.
