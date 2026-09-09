// ---------------------------------------------------------------------------
// SettingsPageScaffold — shared chrome for a settings category detail page.
//
// A category page is PUSHED onto UserSessionHost's NavigationStack (as its Route).
// The scaffold supplies shared custom header chrome and keeps native interactive
// back navigation available unless a page temporarily guards that transition. A
// page agent wraps its real controls here and keeps the `screenId` identifier.
//
// The stub screens (one per not-yet-built category) render `SettingsStubScreen`
// through this scaffold so the leveled navigation is fully wired NOW — a later page
// agent only fills its own screen file, never Route.swift / UserSessionHost.swift.
// ---------------------------------------------------------------------------
import SwiftUI

struct SettingsPageScaffold<Content: View>: View {
    let title: String
    let screenId: String
    let onBack: (() -> Void)?
    let allowsInteractiveBack: Bool
    let backAccessibilityId: String?
    @ViewBuilder let content: () -> Content

    init(
        title: String,
        screenId: String,
        onBack: (() -> Void)? = nil,
        allowsInteractiveBack: Bool = true,
        backAccessibilityId: String? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.screenId = screenId
        self.onBack = onBack
        self.allowsInteractiveBack = allowsInteractiveBack
        self.backAccessibilityId = backAccessibilityId
        self.content = content
    }

    var body: some View {
        DesignPageChrome(
            title: title,
            accessibilityId: screenId,
            onBack: onBack,
            allowsInteractiveBack: allowsInteractiveBack,
            backAccessibilityId: backAccessibilityId,
            content: content
        )
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
