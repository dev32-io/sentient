// ---------------------------------------------------------------------------
// SystemPromptScreen — Soul-group "System Prompt" category page (scaffold stub).
//
// Page-agent target: edit/preview toggle, mono editor, restore-default (confirm),
// SLOW save (PUT soul + apply-with-restart) over `settings.applyProfileChange`.
// Nav + settings scope already threaded; fill this file only.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct SystemPromptScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void

    var body: some View {
        SettingsStubScreen(
            title: "System Prompt",
            screenId: "settings-system-prompt",
            summary: "Edit the system prompt; restore default."
        )
    }
}
