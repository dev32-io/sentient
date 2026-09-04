// ---------------------------------------------------------------------------
// DiagnosticsScreen — the Support-group Diagnostics category page. Hosts the
// existing `SettingsDiagnostics` view + `SendLogsViewModel` (moved off the root
// Settings sheet, not rewritten): a short description + the vitals session list
// (select → send → progress → sent/retry). Identifiers are unchanged
// (settings-send-logs, settings-log-*), so existing smoke selectors still match.
//
// Pushed as the `.settingsDiagnostics` route; the system back button pops to the
// settings root. `onBack` is threaded for a future custom back affordance and is
// otherwise handled by the system button.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

private let diagnosticsSummary =
    "Send sanitized timing, version, session, and error details to help diagnose an issue. "
    + "Messages, prompts, transcripts, audio, secrets, tokens, PINs, and credentials are never included."

struct DiagnosticsScreen: View {
    /// Page-agent seam for a custom back; the system back button handles it today.
    let onBack: () -> Void

    /// Owned here so it lives for the page's lifetime; the app-global VitalsHolder backs it.
    @StateObject private var sendLogs = SendLogsViewModel()

    var body: some View {
        SettingsPageScaffold(title: "Diagnostics", screenId: "settings-diagnostics") {
            Text(diagnosticsSummary)
                .designText(.caption)
                .foregroundStyle(DuskColors.ink3)
                .frame(maxWidth: .infinity, alignment: .leading)

            SettingsDiagnostics(
                model: sendLogs,
                nowMs: Int64(Date().timeIntervalSince1970 * 1000)
            )
        }
        .task { await sendLogs.load() }
    }
}

#Preview {
    NavigationStack {
        DiagnosticsScreen(onBack: {})
    }
    .preferredColorScheme(.dark)
}
