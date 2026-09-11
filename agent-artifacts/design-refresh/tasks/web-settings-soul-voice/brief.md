# Task Brief: Refresh Web Soul settings and voice-library product surfaces

## Contribution Goal

Migrate Memory, Personalities, Voice, Audio, Model, Tools, System Prompt, and Advanced surfaces to the shared component system while preserving their current data, apply, preview, and error behavior.

## Boundary — Included

- Every reachable loading/ready/empty/search/filter/dirty/applying/success/error/retry/preview/permission/expanded/disabled/coming-soon state in the owned panes and voice library.
- Responsive composition, native semantic controls, shared primitives, and trust-safe copy.

## Required Work

- 1. Replace owned raw controls/page-local styles with web-foundation-components primitives/common composites. Replicate applicable reviewed common-composite patterns; never import prototype CSS/JS/assets.
- 2. Preserve Memory slot loading/errors, edit/preview, caps, save/restart and failure states; Personalities load/expand/activate/create/delete behavior; Audio TTS/channel drafts; Model provider/search/capability selection; Tools server/tool permission controls; System Prompt edit/preview/restore; Advanced reasoning/sliders/extra prompt.
- 3. Preserve Voice library loading/failure/empty/search/filter/sort/pagination, current voice, preview loading/playing/error, record/upload/clone/delete where currently reachable, and honest unavailable controls. Do not add future Voice Print or unsupported functionality.
- 4. Keep server data/hooks as source of truth and preserve apply semantics. Do not duplicate profiles/settings into component stores beyond existing drafts. Keep backend authorization and typed error handling intact.
- 5. Replace visible Hermes/native service implementation labels with user-facing capability language. Internal API identifiers may remain in request payloads/types but must not be presented as authority or logged. Link technical troubleshooting to Diagnostics without exposing secrets.
- 6. Preserve safe audio boundaries: this is a visual/interaction migration. Unit tests may mock preview state but agents must not run microphone, recording, STT, TTS playback, audio-quality, or device-route E2E.
- 7. Ensure supporting text is at least 12.5px equivalent, routine actions at least 14px/semantic base, touch targets 44px on coarse pointers, no all-caps display, visible focus, keyboard operation, Reduced Motion, and 200% zoom/narrow reflow.
- 8. Add focused tests for representative load/empty/error/dirty/apply states in each pane, Tools Allow/Ask/Deny/Off, no ordinary Hermes copy, voice filter/preview state without playback, and long-label/zoom behavior.

## Integration Expectation

Deliver this contribution for integration in stage product-surfaces.

## Context

- Owned paths are gateway/webui/src/components/settings/panes/{memory,personalities,audio,model,tools,system-prompt,advanced}-pane.tsx, components/voices/**, and task-specific styles. settings-view/sidebar/apply/account/admin/Diagnostics are owned by web-settings-shell-trust.
- Voice operations are immediate and excluded from APPLY_BAR_KEYS; other Soul panes use existing draft/apply behavior.
- Current Memory and Tools copy exposes Hermes implementation naming. Household-facing copy must be capability-oriented; implementation names/versions are available only through the new Diagnostics pane.

## Boundary — Excluded

- Settings shell/navigation/apply implementation
- Account/Members/Secrets/Diagnostics
- Gateway settings/tool/voice APIs
- Real microphone/audio/voice E2E
- Android/iOS work
- Prototype runtime imports

## Interfaces and Dependencies

- Consumes the refreshed settings shell and Web common components; retains existing settings/voice hooks and pane selection contracts.
- Produces refreshed Soul panes and voice product composites without changing persistence or tool authorization.
