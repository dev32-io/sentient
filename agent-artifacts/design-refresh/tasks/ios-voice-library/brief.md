# Task Brief: Refresh the iOS voice library, add/record/upload, and Fish clone surfaces

## Contribution Goal

Migrate every reachable native voice-management state to shared components while preserving current library, preview, recording, upload, clone, permission, and persistence behavior.

## Boundary — Included

- Voice library/search/filter/cards, active/preview/delete states, Add Voice record/upload/file-picker/validation/outcomes, Fish browse/filter/sample/clone flows, permissions/notices, native navigation/sheets/alerts, accessibility and static previews.

## Required Work

- 1. Migrate Voice/** screens to iOS foundation/common components and native SwiftUI controls. Use task-owned composition constants from v2; never import/execute prototype files or duplicate raw visual controls.
- 2. Preserve existing ViewModels/services as source of truth for library loading, filtering/sorting/facets/pagination, selected/active voice, preview state, user-pack deletion, Add Voice, upload bytes/validation, recording permission/state, Fish availability/search/language/sort/facets, clone editor, submission, and outcomes.
- 3. Keep recording/upload/preview lifecycle and cancellation at current adapter boundaries. External calls have bounded waits/cancellation and typed errors. Do not log or add to evidence raw audio, transcript, sample bytes, credentials, private names, or service payload content.
- 4. Preserve native microphone permission presentation and denial recovery for real users, but provide deterministic injected/fake state seams so tests/previews never request permission or capture/play audio.
- 5. Keep visible unavailable/Add/Voice Print/Fish affordances honest according to actual capability. Do not implement a future feature merely because a control is visible.
- 6. Use native NavigationStack destinations, fileImporter, sheet, alert, confirmationDialog/menu, keyboard/focus, safe areas, 44pt targets, larger Dynamic Type reflow, Reduced Motion, and Increased Contrast. Long voice names/tags/languages must wrap or truncate intentionally without clipping actions.
- 7. Add focused tests/previews for every listed state, filter/pagination logic, active selection, preview state using fakes, recording denied/review using fakes, upload validation, delete confirmation, Fish disabled/error/clone outcome, content redaction, and accessibility-size layout.
- 8. Add stable accessibility identifiers for visual inventory only. No final approved E2E case drives audio; voice end-to-end remains user-owned.

## Integration Expectation

Deliver this contribution for integration in stage product-surfaces.

## Context

- Owned path is ios/App/Settings/Voice/** and its tests/previews. Settings root/navigation is owned by ios-settings-system; shared visual components by ios-foundation-components.
- Reachable states include list loading/loaded/error/empty, filters, preview loading/playing, active voice, deletion; add record/upload idle/recording/review/denied/clip/validation/submitting/success/error; Fish disabled/loading/error/empty/search/filter/pagination/sample/selection/editor/cloning/outcome.
- Automated verification may use state fakes only and must not activate microphone, STT, TTS playback, acoustic paths, or audio routes.

## Boundary — Excluded

- Settings shell/root
- Chat VoiceCaptureControl
- Voice backend/capability service redesign
- Automated microphone/STT/TTS/audio testing
- Android/Web work
- Prototype runtime imports

## Interfaces and Dependencies

- Consumes iOS common components and existing Voice ViewModels/adapters.
- Produces refreshed native Voice route destinations with injectable non-audio test seams.
