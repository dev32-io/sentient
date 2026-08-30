import SwiftUI

/// Compatibility copy used by the settings save flows.
let soulAlreadyApplyingText = "Another change is applying — try again in a moment."

/// Legacy loading row; the progress primitive owns the indicator semantics.
struct SoulLoadingRow: View {
    var body: some View {
        DesignProgress()
            .frame(maxWidth: .infinity)
            .padding(.vertical, Space.xl)
            .accessibilityIdentifier("settings-loading")
    }
}

/// Legacy inline error; notice rendering is shared by `AsyncNotice`.
struct SoulInlineError: View {
    let message: String

    var body: some View {
        AsyncNotice(kind: .error, title: message, accessibilityId: "settings-error")
    }
}

/// Legacy amber notice; notice rendering is shared by `AsyncNotice`.
struct SoulNoticeBanner: View {
    let text: String

    var body: some View {
        AsyncNotice(kind: .warning, title: text, accessibilityId: "settings-notice")
    }
}

/// Legacy applying banner; notice rendering is shared by `AsyncNotice`.
struct SoulApplyingBanner: View {
    let text: String

    var body: some View {
        AsyncNotice(kind: .loading, title: text, accessibilityId: "settings-applying")
    }
}

/// Legacy toolbar back button; native toolbar rendering is shared by the
/// design toolbar adapter without replacing NavigationStack behavior.
struct SoulBackButton: View {
    let accessibilityId: String
    let action: () -> Void

    var body: some View {
        DesignToolbarIconButton(
            systemName: "chevron.left",
            label: "Back",
            accessibilityId: accessibilityId,
            action: action
        )
    }
}

#Preview {
    VStack(spacing: Space.lg) {
        SoulLoadingRow()
        SoulApplyingBanner(text: "Applying — assistant restarting…")
        SoulNoticeBanner(text: soulAlreadyApplyingText)
        SoulInlineError(message: "Couldn't save your changes.")
    }
    .padding(Space.lg)
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
