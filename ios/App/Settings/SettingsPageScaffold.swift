// ---------------------------------------------------------------------------
// SettingsPageScaffold — shared chrome for a settings category detail page.
//
// A category page is PUSHED onto UserSessionHost's NavigationStack (as its Route),
// so the system supplies the back button (pops to the settings root); the scaffold
// only owns the scrolling body under an inline nav title. A page agent wraps its
// real controls in this scaffold and keeps the `screenId` accessibilityIdentifier.
//
// The stub screens (one per not-yet-built category) render `SettingsStubScreen`
// through this scaffold so the leveled navigation is fully wired NOW — a later page
// agent only fills its own screen file, never Route.swift / UserSessionHost.swift.
// ---------------------------------------------------------------------------
import SwiftUI

struct SettingsPageScaffold<Content: View>: View {
    let title: String
    let screenId: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        DesignPageChrome(title: title, accessibilityId: screenId, content: content)
    }
}

/// Placeholder body for a category page whose controls a later page agent will build.
/// Keeps the title + `screenId` so navigation + smoke selectors are stable already.
struct SettingsStubScreen: View {
    let title: String
    let screenId: String
    let summary: String

    var body: some View {
        SettingsPageScaffold(title: title, screenId: screenId) {
            Text(summary)
                .designText(.caption)
                .foregroundStyle(DuskColors.ink3)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("Coming soon")
                .designText(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(DuskColors.ink4)
        }
    }
}

#Preview {
    NavigationStack {
        SettingsStubScreen(
            title: "Memory",
            screenId: "settings-memory",
            summary: "MEMORY.md / USER.md slots, edit/preview toggle, char-capped editor."
        )
    }
    .preferredColorScheme(.dark)
}
