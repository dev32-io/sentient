# Task Brief: Build the WebUI foundation/common component system and Rive identity adapter

## Contribution Goal

Provide native Preact/CSS primitives and common composites that implement the reviewed Dusk material system, plus a thin three-state Rive identity wrapper backed by platform-owned asset copies.

## Boundary — Included

- A coherent Web foundation component/CSS layer, applicable common composites, compatibility migration for current settings primitives, native accessibility/responsive behavior, production-owned Rive/static asset copies, and a thin Rive adapter.
- Focused component tests/previews and lint/static boundaries for the foundation locations.

## Required Work

- 1. Add platform-owned production CSS and components under gateway/webui/src/components/common and a dedicated foundation style entry. Consume only generated v2 tokens; replicate the exact slate/well/plate/float recipes from design/prototype/foundation-components/sentient-components.css rather than importing prototype CSS.
- 2. Implement or consolidate native semantic primitives: surface/plate/well, action button, icon button, field, textarea, select/menu trigger, slider, toggle, segmented control, chip, checkbox, progress, divider, Sentient identity, and user avatar. Cover rest/hover/focus/pressed/selected/disabled/loading/error as applicable. Use semantic HTML and at least 44 CSS px targets for touch/coarse-pointer contexts; no visible all-caps copy.
- 3. Implement common composites needed across current pages: page/pane chrome, settings row/card, validated/secret field, identity/PIN entry, search/filter bar, notice/async state, action row, and the existing Dialog behavior. Preserve Escape, focus trap/restoration, backdrop policy, inert background, responsive bottom-sheet presentation, and native browser semantics.
- 4. Preserve compatibility while migrating settings/primitives imports: either re-export reviewed common implementations or update only shared primitive call sites. Do not refresh product pages in this task and do not leave two visually divergent primitive systems.
- 5. Add a pinned supported Rive Web runtime dependency. Copy sentient-avatar.riv into a platform-owned Web asset path (for example gateway/webui/public/assets/sentient-avatar.riv) and copy the canonical static mark fallback into gateway/webui/public. Production code must not fetch/import design/prototype/**. Add a build/check step that proves the packaged .riv bytes equal the canonical manifest SHA-256 bad6f8c82fba6386233cef356adc59fa6017a7c97c0de61a377546405b1e892b.
- 6. Replace the four-mode/ignored SentientMark seam with exactly idle, thinking, responding. The wrapper loads artboard SentientAvatar/state machine Avatar, sets reducedMotion from prefers-reduced-motion, and fires toIdle/toThinking/toResponding for the latest semantic state. Rive owns all 250ms choreography and interruption; host CSS must not recreate it. Loading failure renders the copied static mark and keeps a native text/accessibility status.
- 7. Update Avatar so user identities use the reviewed elevated-slate face at 28/44/56 tiers with stable terra/sage/amber/clay tints and initials fallback, while assistant identities use the Rive wrapper. Listening remains composer-owned and cannot activate an avatar state.
- 8. Add focused tests/previews for semantic markup, keyboard/focus, target sizes, disabled/loading states, dialog restoration, 200% zoom/narrow reflow, reduced motion input, rapid latest-state mapping, Rive load fallback, and packaged checksum. Do not test animation fidelity beyond the existing design:avatar:verify command.

## Integration Expectation

Deliver this contribution for integration in stage platform-foundations.

## Context

- Generated v2 CSS/TypeScript from design-foundation-v2 is the production token input. Prototype files under design/prototype are task context/reference only and must never be imported or served by production.
- Current common components live in gateway/webui/src/components/common; settings-specific primitives live in components/settings/primitives and are also used by voices/account wizard.
- Current assistant identity is static in common/sentient-mark.tsx and common/avatar.tsx; the canonical reference bytes/contract are in design/prototype/foundation-components/assets/avatars.

## Boundary — Excluded

- Route/page-specific restyling
- Chat message/composer, Calendar, and settings-page composition
- Direct runtime imports from design/prototype or use of prototype JavaScript
- iOS/Android implementation
- Changing Rive source/runtime bytes

## Interfaces and Dependencies

- Consumes generated v2 Web tokens and canonical asset hashes from design-foundation-v2/reference manifest.
- Produces common Preact primitives/composites, exactly three-state SentientIdentity/Avatar APIs, platform-owned assets, and compatibility exports consumed by all Web product tasks.
