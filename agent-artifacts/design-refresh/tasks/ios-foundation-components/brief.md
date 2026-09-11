# Task Brief: Build the SwiftUI design-v2 projection, primitives, and common composites

## Contribution Goal

Provide a native SwiftUI foundation/common layer that projects additive KMP v2 values exactly, preserves platform behavior, and replaces page-local visual primitives without changing domain ownership.

## Boundary — Included

- Thin Swift accessors for KMP v2, native SwiftUI material primitives, applicable settings/common composites, accessibility/Dynamic Type adaptations, previews/tests, and a migration boundary for existing call sites.

## Required Work

- 1. Add a thin Swift projection over io.sentient.mobilesdk.design.v2 through MobileData/SKIE. Map exact colors, type 11/12.5/15/18/22/44 with semantic Dynamic Type styles, line-height intent, spacing 4/8/12/18/26/32/40, radii 8/12/18/26/pill, 150ms feedback, 250ms state/surface changes, and named material/effect roles. Do not modify KMP v1 or Android consumers.
- 2. Implement native SwiftUI styles/components for plate/well, action and destructive buttons, icon button, field, secure field, multiline editor, toggle, segmented picker, menu/select, slider, chip, checkbox-equivalent where used, progress, divider, and elevated-slate user avatar. Replicate—not import—the reviewed concave face, 1pt top highlight, contact/directional cast, recessed well, focus ring, pressed depth, disabled/loading/error variants.
- 3. Keep routine controls/primary labels at least the 15pt base where Dynamic Type semantics require it, supporting content at least 12.5pt, and reserve 11pt for optional expert telemetry. Use at least 44pt targets, no visible all-caps styling, non-color state cues, Increased Contrast adjustments, and Reduce Motion immediate/static behavior.
- 4. Consolidate common composites used by pages: native page/pane chrome, settings row/card/group header, validated/secret fields, identity/PIN form pieces, search/filter rows, async/loading/empty/error notices, action/footer rows, and save/apply feedback. Refactor ios/App/Settings/Components and SettingsPageScaffold into these implementations or compatibility wrappers so later page tasks do not duplicate visuals.
- 5. Preserve native NavigationStack, toolbar/navigation title, Button, Toggle, Picker/Menu, TextField/SecureField, Slider, sheet, alert, confirmationDialog, contextMenu, focus, keyboard, safe-area, and scrolling semantics. Do not replace them with HTML-like custom navigation or a generic custom modal system.
- 6. Add a static design-boundary check for Swift files that allows literals/visual recipes only in approved Theme/Foundation/Component paths and named layout constants. Product pages may own structural geometry only through named values derived from v2. Seed an explicit temporary allowlist for later tasks to close rather than blindly rewriting domain code.
- 7. Add previews/tests for every primitive state, larger accessibility Dynamic Type, narrow iPhone width, iPad width, increased contrast, dark appearance, Reduced Motion, focus/labels, and 44pt hit areas. Tests should pin stable semantics and token projection, not incidental SwiftUI rendering internals.

## Integration Expectation

Deliver this contribution for integration in stage platform-foundations.

## Context

- Current thin v1 adapters are ios/App/Theme/Tokens.swift, Colors.swift, Typo.swift, Theme.swift, and MarkdownDuskTheme.swift; shared v1 values must remain for Android compatibility.
- Current reusable settings controls are ios/App/Settings/Components/*.swift and SettingsPageScaffold.swift. Product pages, Calendar, Chat, startup, and Rive integration are later tasks.
- DESIGN.MD and prototype files are reference context only. Swift production code must replicate reviewed recipes through native SwiftUI styles and may not load/import prototype CSS, HTML, JavaScript, or assets.

## Boundary — Excluded

- Rive dependency/asset/startup implementation
- Chat, History, Calendar, or settings-page product composition
- KMP voice/protocol behavior
- Android UI changes
- Prototype runtime imports or pixel-identical rendering

## Interfaces and Dependencies

- Consumes the additive KMP v2 API from design-foundation-v2.
- Produces native SwiftUI Theme/Foundation and common component APIs consumed by all iOS product tasks, plus a literal/component boundary checker.
