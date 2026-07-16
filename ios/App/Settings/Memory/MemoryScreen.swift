// ---------------------------------------------------------------------------
// MemoryScreen — Soul-group "Memory" category page (scaffold stub).
//
// A later page agent fills this body with the MEMORY.md / USER.md slot editor
// (segmented slot, edit/preview, char-capped editor + counter) over
// `settings.applyProfileChange` / `settings.profileRepository`. The nav wiring,
// settings scope, and back seam are already threaded — do NOT touch Route.swift
// or UserSessionHost.swift.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct MemoryScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void

    var body: some View {
        SettingsStubScreen(
            title: "Memory",
            screenId: "settings-memory",
            summary: "MEMORY.md / USER.md slots, edit/preview toggle, char-capped editor."
        )
    }
}
