// ---------------------------------------------------------------------------
// SettingsView — the thin v1 Settings surface (D-I5). Per the operator's
// original directive ("leave the settings page very thin, just show version, we
// will add other settings stuff later") this sheet has exactly two rows:
//   - App version (settings-version): read from the bundle
//     CFBundleShortVersionString (+ CFBundleVersion). No version literal here.
//   - Logout (settings-logout): store.logout() = sdk.disconnect() + clear the
//     Keychain token → RootView reacts to status != .ready → shows login.
//
// Mirrors the Android SettingsScreen (settings/SettingsScreen.kt): same two
// rows, same testTags/accessibilityIdentifiers, same version-check STUB (spec
// §12.2 P2 carry — no networking in v1). Presented as a `.sheet` from the
// ChatView title bar (settings-open), matching the iOS HistorySheet pattern
// (NavigationStack + a `Done` cancellation toolbar action for dismiss/back).
//
// The view is stateless beyond what it reads: the app-level AppConfig drives the
// only command (logout). RootView owns the login-vs-chat swap; this sheet does
// NOT model navigation — logout flips the SDK status and the host reacts.
//
// accessibilityIdentifiers: settings-version, settings-logout, settings-back.
// The settings-open entry point lives in the ChatView title bar (ChatView.swift).
// ---------------------------------------------------------------------------
import SwiftUI

private let titleText = "Settings"
private let versionLabel = "App version"
private let logoutLabel = "Log out"
private let versionUnknown = "unknown"

private let log = AppLog("settings", "view")

/// Human-readable build identifier, e.g. "1.0 (1)", from the app bundle's
/// CFBundleShortVersionString + CFBundleVersion. Single source: Info.plist —
/// no version literal lives in this file. Mirrors Android's BuildConfig read.
private var versionText: String {
    let bundle = Bundle.main
    let short = bundle.infoDictionary?["CFBundleShortVersionString"] as? String ?? versionUnknown
    let build = bundle.infoDictionary?["CFBundleVersion"] as? String ?? versionUnknown
    return "\(short) (\(build))"
}

/// Version-check hook STUB (spec §12.2 P2 carry). A future "check for updates"
/// call lands here — it will query an operator-configured release endpoint and
/// surface an "update available" affordance. v1 does NO networking; this is a
/// placeholder so the call site already exists when P2 is picked up.
private func checkForUpdatesStub() {
    // P2: replace with a real release-manifest fetch + compare against the
    // bundle version. Intentionally a no-op in v1.
    log.debug("check-for-updates.stub version=\(versionText)")
}

/// Thin Settings sheet. `onLogout` clears the token + disconnects (see
/// `AppConfig.logout()`); `onDismiss` returns to chat. Both are plain closures —
/// the host owns the AppConfig and the sheet presentation.
struct SettingsSheet: View {
    let onLogout: () -> Void
    let onDismiss: () -> Void

    /// The diagnostics command surface (list + upload vitals sessions). Owned here
    /// so it lives for the sheet's lifetime; the app-global VitalsHolder backs it.
    @StateObject private var sendLogs = SendLogsViewModel()

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Space.lg) {
                versionRow
                SettingsDiagnostics(model: sendLogs, nowMs: Int64(Date().timeIntervalSince1970 * 1000))
                logoutButton
                Spacer()
            }
            .padding(.horizontal, Space.lg)
            .padding(.top, Space.md)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(DuskColors.bg)
            .navigationTitle(titleText)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done", action: onDismiss)
                        .accessibilityIdentifier("settings-back")
                }
            }
            .task { await sendLogs.load() }
        }
        .duskTheme()
    }

    // ── Version ─────────────────────────────────────────────────────────────

    private var versionRow: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(versionLabel)
                .font(.system(size: TypeScale.xs, weight: .semibold))
                .foregroundStyle(DuskColors.ink3)
            Text(versionText)
                .font(.system(size: TypeScale.base))
                .foregroundStyle(DuskColors.ink)
                .accessibilityIdentifier("settings-version")
        }
    }

    // ── Logout ──────────────────────────────────────────────────────────────

    private var logoutButton: some View {
        Button(action: onLogout) {
            Text(logoutLabel)
                .font(.system(size: TypeScale.base, weight: .semibold))
                .foregroundStyle(DuskColors.stop)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Space.sm)
                .overlay(
                    RoundedRectangle(cornerRadius: Radii.md)
                        .stroke(DuskColors.stop, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .padding(.top, Space.md)
        .accessibilityIdentifier("settings-logout")
    }
}

#Preview {
    SettingsSheet(onLogout: {}, onDismiss: {})
}
