# iOS hybrid debug-catalog coverage

Launch Debug `SentientApp` with `--qa-foundation-catalog`. Select any family from persistent jump bar, or start one family with `--qa-foundation-family <id>`.

Optional fixture controls:

- `--qa-fixture-count <1...1000>` scales repeated chat, history, and notification data. Defaults: chat 150, history 50, notifications 24.
- `--qa-history-state loaded|loading|empty|error|stale|stale-checking|no-match` selects full-panel history state. Default: `loaded`.
- `--qa-calendar-view day|week|month` selects production calendar viewport. Default: `day`.

Root ID remains `qa-foundation-catalog`; family IDs remain `qa-foundation-section-<id>`. Ordinary specimens expose `qa-specimen-<title-slug>` plus component-owned IDs.

Only selected family mounts. Fixtures use fixed timestamps/date (`2028-02-16` calendar anchor), synthetic values, local SwiftUI state, and bounded closures. No ViewModel, SDK session, auth, network, audio capture, service, diagnostics, or live product state starts.

## Mounted production coverage

| Family ID | Real shipped specimens / controlled states |
|---|---|
| `foundation` | Dusk color/type tokens; `designPlate`, `designFloat`, `designWell`; raised action surfaces |
| `controls` | `DesignActionButton`, `DesignIconButton`, `DesignCompactIconButton`, `DesignCompactButton`, `DesignTextButton`, `DesignToolbarButton`, `DesignSegmentedPicker`, `DesignChip`, `DesignCheckbox`, `DesignSelectableButton`, `DesignMenuTriggerLabel`, `DesignToggleRow`, `DesignToggleSwitch`, `DesignSelect`, `DesignSlider`; normal/loading/selected/disabled/destructive states where supported |
| `forms` | `DesignField` filled/empty/error/disabled; `DesignSecureField`, `DesignMaskedField`, `DesignMultilineEditor`, `DesignDatePicker`, `DesignStepper`, `DesignSearchField`, `DesignSettingsSelectRow`, `DesignSettingsSliderRow`, `ValidatedField`, `SecretValueField`, `IdentityFieldGroup` |
| `feedback` | `AsyncNotice` info/loading/empty/error/success/warning; `DesignProgress` determinate/indeterminate; `DesignStatusBadge`, `DesignDivider`, `SoulLoadingRow`, `SoulInlineError`; `DesignApplyFeedback`, `SaveApplyFeedback`; real `DesignApplyBar` dirty and applying specimens |
| `composites` | `DesignPageHeader`, `DesignPageChrome`, `DesignSettingsEditor`, `UpdateFooter`, `DesignCard`, `DesignSettingsRow`, `DesignPane`, `DesignGroupHeader`, `DesignCategoryRow`, `DesignDisclosureGroup`, `DesignDisclosureButton`, `DesignMenuButton`, `DesignSelectableCard`, `SearchFilterRow`, `DesignDominantVisualCard`, `ElevatedUserAvatar`, `DesignPinKeypad`, `DesignDismissibleNotice`, `DesignActionFooter` |
| `history` | Full stateless production `HistorySidePanelContent`: `HistoryAccountHeader`, search, Past chats chrome, independently scrolling lazy `HistoryRow` list, selected/active/variable-title rows, stale/checking banner, initial loading, genuine empty, no-match, empty error, settings action, and overlaid new-chat FAB. State selected through `--qa-history-state`. |
| `chat` | Full production `MessageList` owns viewport/scrolling and mounts real `MessageBubble`/`MessageBubbleShell`/MarkdownUI chronology. Default 150 synthetic `ChatMessage` rows include committed GFM headings, task lists, links, tables, fenced code, long variable heights, consecutive assistant continuations, streaming empty/non-empty rows, interrupted rows, day grouping, and production initial positioning. Real `Composer` and expanded `ComposerTaskStrip` remain mounted below list. |
| `voice` | `VoiceCaptureSurface` idle/hold/auto/denied; `PttBigWave`; static idle mark and bundled Rive thinking/responding identity |
| `notifications` | `DesignBadgedIconButton` 0/3/100; `DesignNotificationCardButton` normal/disabled; `DesignNotificationActionTray` visible/armed; repeated real `ScheduledInboxSwipeRow` with variable heights, disabled state, and locally controlled reveal/open/clear callbacks; enabled/disabled production `ScheduledInboxHeader` bulk-clear action |
| `calendar` | Production viewport owns all scrolling. Day/week mount real `CalendarAdjacentViewport` (`UICollectionView`, hosted recyclable heading/status/overview/event/empty rows) with fixed populated projections, local accessibility-focus/cursor/revision state, and callback-request data bounded to production maximum working set plus protected period. Month mounts real `CalendarMorphStage`; `FloatingViewBar` switches day/week/month and keeps filter badge coverage. |

## Scroll and profiling contract

`history`, `chat`, and `calendar` bypass catalog vertical `ScrollView`; each production scroll owner receives remaining screen viewport. Jump bar stays outside viewport and keeps all families reachable. This avoids nested production scroll views and profiles shipped lazy/native composition rather than substitute rows.

## Remaining static-catalog gaps

Pressed/drag-in-flight, keyboard-focused, native menu-open, confirmation-dialog-open, and exact Rive transition frames still require interaction or deterministic capture authority. Calendar fixture callback adapter is intentionally bounded and synthetic; it exercises rolling/reuse without repository leases or network authority. Product-route inventory catalog (`--qa-visual-page`) remains unchanged and generic by contract.
