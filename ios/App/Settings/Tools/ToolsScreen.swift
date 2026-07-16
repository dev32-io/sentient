// ---------------------------------------------------------------------------
// ToolsScreen — Soul-group "Tools" category page (scaffold stub).
//
// Page-agent target: per-MCP-server + per-tool toggles + Hermes built-in toolset
// toggles, SLOW save (apply-with-restart). Nav + settings scope already threaded;
// fill this file only.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct ToolsScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void

    var body: some View {
        SettingsStubScreen(
            title: "Tools",
            screenId: "settings-tools",
            summary: "Per-MCP-server and per-tool toggles."
        )
    }
}
