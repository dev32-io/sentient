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
// accessibilityIdentifiers: settings-version, settings-update,
// settings-update-action, settings-logout, settings-back. The settings-open entry
// point lives in the ChatView title bar (ChatView.swift).
//
// OTA: the version-check stub is replaced by a real update row bound to the shared
// UpdateModel (owned by UpdateGate, threaded through UserSessionHost). The row
// shows the status line + a context action (Check for updates / Update), mirroring
// the Android SettingsScreen UpdateRow.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

private let titleText = "Settings"
private let versionLabel = "App version"
private let logoutLabel = "Log out"
private let versionUnknown = "unknown"

// Update-row copy (mirrors Android SettingsScreen).
private let updatesLabel = "Updates"
private let upToDateText = "Up to date"
private let checkFailedText = "Check failed"
private let checkAction = "Check for updates"
private let updateAction = "Update"
private let availablePrefix = "Update available — v"

private let log = AppLog("settings", "view")

/// Human status line for the update row, derived from the hoisted UpdateStatus.
private func updateStatusText(_ status: UpdateStatus) -> String {
    switch onEnum(of: status) {
    case .upToDate: return upToDateText
    case .available(let a): return "\(availablePrefix)\(a.versionName)"
    case .checkFailed: return checkFailedText
    }
}

/// Human-readable build identifier, e.g. "1.0 (1)", from the app bundle's
/// CFBundleShortVersionString + CFBundleVersion. Single source: Info.plist —
/// no version literal lives in this file. Mirrors Android's BuildConfig read.
private var versionText: String {
    let bundle = Bundle.main
    let short = bundle.infoDictionary?["CFBundleShortVersionString"] as? String ?? versionUnknown
    let build = bundle.infoDictionary?["CFBundleVersion"] as? String ?? versionUnknown
    return "\(short) (\(build))"
}

/// Thin Settings sheet. `onLogout` clears the token + disconnects (see
/// `AppConfig.logout()`); `onDismiss` returns to chat. Both are plain closures —
/// the host owns the AppConfig and the sheet presentation. `updateModel` is the
/// shared OTA state (owned by UpdateGate) — Settings reads its status + drives
/// the manual check / install.
struct SettingsSheet: View {
    /// Shared OTA-update state; the row reads `status` and drives check/install.
    @ObservedObject var updateModel: UpdateModel
    let onLogout: () -> Void
    let onDismiss: () -> Void

    /// The diagnostics command surface (list + upload vitals sessions). Owned here
    /// so it lives for the sheet's lifetime; the app-global VitalsHolder backs it.
    @StateObject private var sendLogs = SendLogsViewModel()

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Space.lg) {
                versionRow
                updateRow
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

    // ── Updates ───────────────────────────────────────────────────────────────

    /// OTA status line + a context action: [Update] when a release is available,
    /// else [Check for updates]. Mirrors the Android SettingsScreen UpdateRow.
    private var updateRow: some View {
        let available = updateModel.status as? UpdateStatusAvailable
        return VStack(alignment: .leading, spacing: Space.xs) {
            Text(updatesLabel)
                .font(.system(size: TypeScale.xs, weight: .semibold))
                .foregroundStyle(DuskColors.ink3)
            HStack(spacing: Space.sm) {
                Text(updateStatusText(updateModel.status))
                    .font(.system(size: TypeScale.base))
                    .foregroundStyle(DuskColors.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if available != nil {
                    updateActionButton(updateAction, tint: DuskColors.accent) {
                        log.info("update.install.tap")
                        updateModel.install()
                    }
                } else {
                    updateActionButton(checkAction, tint: DuskColors.ink2) {
                        log.info("update.check.tap")
                        Task { await updateModel.check() }
                    }
                }
            }
        }
        .accessibilityIdentifier("settings-update")
    }

    private func updateActionButton(
        _ title: String,
        tint: Color,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: TypeScale.sm, weight: .semibold))
                .foregroundStyle(tint)
                .padding(.horizontal, Space.sm)
                .padding(.vertical, Space.xs)
                .overlay(
                    RoundedRectangle(cornerRadius: Radii.sm)
                        .stroke(tint.opacity(0.6), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("settings-update-action")
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
    SettingsSheet(
        updateModel: UpdateModel(
            gatewayWsUrl: "wss://localhost:8888/api/v1/ws",
            allowSelfSignedDevHost: true
        ),
        onLogout: {},
        onDismiss: {}
    )
}
