# Task Brief: Refresh iOS Settings root and system/Soul panes

## Contribution Goal

Migrate the native Settings root, Memory, Personalities, Audio, Model, Tools, System Prompt, Advanced, and Diagnostics surfaces to shared components while preserving all current data and apply behavior.

## Boundary — Included

- All reachable loading/ready/empty/dirty/applying/applied/already-applying/failure/retry/expanded/confirmation/edit-preview states in the owned root and panes, native navigation/back/discard behavior, trust cleanup, and larger-text accessibility.

## Required Work

- 1. Compose owned pages exclusively from iOS foundation/common components and native SwiftUI navigation/control APIs. Replicate reviewed design values/effects locally through the shared styles; never import prototype files.
- 2. Preserve Memory slot load/error/edit/preview/cap/save/restart/discard; Personalities load/expand/activate/create/delete; Audio TTS/channel drafts; Model provider/search/capability selection; Tools server expansion/master/per-tool Allow/Ask/Deny/Off; System Prompt edit/preview/restore; Advanced reasoning/sliders/extra prompt; Diagnostics session/list/send/progress/sent/retry states.
- 3. Keep existing ViewModels/KMP services as source of truth and retain typed failures, persistence, restart/already-applying state, and native dirty-back confirmation. Do not redesign settings storage, tool authorization, model selection, logs, or service supervision.
- 4. Remove visible Hermes/implementation naming from Memory, Tools, cards, route labels, and ordinary help copy. Use capability language. Diagnostics may show sanitized technical names/versions/session IDs needed for recovery, but never message text, prompts, transcripts, raw audio, secrets, tokens, PINs, or credentials.
- 5. Preserve visible unfinished controls as reviewed unavailable/coming-soon states without adding behavior. Preserve current route graph and outer NavigationStack; use native sheet, alert, confirmationDialog, menu, keyboard, focus, safe areas, and toolbar/back behavior.
- 6. Ensure semantic Dynamic Type reflow through an accessibility size, 44pt targets, non-color state, visible labels, Reduced Motion, Increased Contrast, scrollable bodies and reachable pinned actions. No required content uses the 11pt telemetry size or all-caps styling.
- 7. Add/update previews and focused ViewModel/view tests for every owned state, dirty-save-restore flows, native discard/restore confirmation, Tools permission values, service unknown/failure, Diagnostics privacy, implementation-neutral ordinary copy, and accessibility-size clipping.
- 8. Provide stable accessibility identifiers for Settings root and one harmless reversible setting used by E2E-008; automated validation changes/saves/reloads/restores it without playing audio.

## Integration Expectation

Deliver this contribution for integration in stage product-surfaces.

## Context

- Owned paths are ios/App/Settings/SettingsView.swift, SettingsPageScaffold.swift as consumer only, and directories Memory, Personalities, Audio, Model, Tools, SystemPrompt, Advanced, Diagnostics plus task-specific previews/tests.
- Account/Members/Secrets are owned by ios-settings-account-admin; Voice routes by ios-voice-library; Calendar by ios-calendar-refresh. Shared Settings/Components are owned by ios-foundation-components.
- Ordinary household copy must be implementation-neutral; technical service/component names and versions belong only in Diagnostics.

## Boundary — Excluded

- Account/Members/Secrets/Voice/Calendar page internals
- Chat/startup/history
- Backend/KMP settings behavior changes
- Audio playback or microphone E2E
- Prototype imports or Android UI

## Interfaces and Dependencies

- Consumes iOS common components and existing ViewModels/routes.
- Owns SettingsView route composition for all settings tasks while preserving destination APIs and native navigation.
