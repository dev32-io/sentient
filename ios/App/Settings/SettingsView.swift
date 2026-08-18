// ---------------------------------------------------------------------------
// SettingsView — the root Settings category list (mobile-settings-parity). Replaces
// the thin v1 sheet (version + logout + inline diagnostics) with the leveled root:
// grouped CategoryRows (Soul / User / Admin / Support) that push per-category detail
// pages, a root-level "Log out" danger row, and the state-morphing UpdateFooter +
// version caption at the very bottom.
//
// Pushed as the `.settings` destination on UserSessionHost's NavigationStack (no
// nested stack): tapping a row appends its Route to the outer `path` via `onOpen`.
// Back uses the NATIVE NavigationStack back button (pops `.settings` off `path`
// back to chat) so the interactive edge-swipe pop works — no custom leading item,
// which would replace the system back and kill UIKit's interactivePopGesture. The
// Dusk look comes from restyling the system bar (bg toolbar background + dark
// toolbar scheme + accent tint), not replacing it. The Admin group is gated on `me.isAdmin`,
// collected once by the thin `SettingsRootViewModel` over `ObserveSettingsAccessUseCase`.
//
// accessibilityIdentifiers: settings-screen, settings-logout,
// settings-update-action (UpdateFooter), settings-version (UpdateFooter caption),
// settings-cat-<key> per row. (Root back is the system button — no custom id;
// no e2e flow targets it.)
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

private let titleText = "Settings"
private let logoutLabel = "Log out"
private let versionUnknown = "unknown"

// Group headers (webui nav-config parity: Soul / User / Admin / Support).
private let groupSoul = "Soul"
private let groupUser = "User"
private let groupAdmin = "Admin"
private let groupSupport = "Support"

/// Human-readable build identifier, e.g. "0.2.0 (6)", from the app bundle's
/// CFBundleShortVersionString + CFBundleVersion. Single source: Info.plist.
private var versionText: String {
    let bundle = Bundle.main
    let short = bundle.infoDictionary?["CFBundleShortVersionString"] as? String ?? versionUnknown
    let build = bundle.infoDictionary?["CFBundleVersion"] as? String ?? versionUnknown
    return "\(short) (\(build))"
}

/// One root-list category: icon + title + destination route + id key.
private struct CategoryItem: Identifiable {
    let icon: SettingsIcon
    let title: String
    let route: Route
    let key: String
    var id: String { key }
}

private let soulItems: [CategoryItem] = [
    .init(icon: .memory, title: "Memory", route: .settingsMemory, key: "memory"),
    .init(icon: .calendar, title: "Calendar", route: .settingsCalendar, key: "calendar"),
    .init(icon: .personalities, title: "Personalities", route: .settingsPersonalities, key: "personalities"),
    .init(icon: .voice, title: "Voice", route: .settingsVoice, key: "voice"),
    .init(icon: .audio, title: "Audio", route: .settingsAudio, key: "audio"),
    .init(icon: .model, title: "Model", route: .settingsModel, key: "model"),
    .init(icon: .tools, title: "Tools", route: .settingsTools, key: "tools"),
    .init(icon: .systemPrompt, title: "System Prompt", route: .settingsSystemPrompt, key: "system-prompt"),
    .init(icon: .advanced, title: "Advanced", route: .settingsAdvanced, key: "advanced"),
]

private let userItems: [CategoryItem] = [
    .init(icon: .account, title: "Account", route: .settingsAccount, key: "account"),
]

private let adminItems: [CategoryItem] = [
    .init(icon: .members, title: "Members", route: .settingsMembers, key: "members"),
    .init(icon: .secrets, title: "Secrets", route: .settingsSecrets, key: "secrets"),
]

private let supportItems: [CategoryItem] = [
    .init(icon: .diagnostics, title: "Diagnostics", route: .settingsDiagnostics, key: "diagnostics"),
]

/// Root Settings sheet: owns the thin access VM, delegates rendering to the stateless
/// `SettingsRootView`. `settings` is the connection-scope settings component (usecases
/// for the pushed category pages); `updateModel` is the shared OTA state.
struct SettingsSheet: View {
    private let settings: SettingsComponent
    @ObservedObject private var updateModel: UpdateModel
    private let onLogout: () -> Void
    private let onOpen: (Route) -> Void
    @State private var vm: SettingsRootViewModel

    init(
        settings: SettingsComponent,
        updateModel: UpdateModel,
        onLogout: @escaping () -> Void,
        onOpen: @escaping (Route) -> Void
    ) {
        self.settings = settings
        _updateModel = ObservedObject(wrappedValue: updateModel)
        self.onLogout = onLogout
        self.onOpen = onOpen
        _vm = State(initialValue: SettingsRootViewModel(observeAccess: settings.observeSettingsAccess))
    }

    var body: some View {
        SettingsRootView(
            showAdmin: vm.showAdmin,
            updateStatus: updateModel.status,
            versionText: versionText,
            onOpen: onOpen,
            onLogout: onLogout,
            onCheck: { await updateModel.check(); return updateModel.status },
            onInstall: { updateModel.install() }
        )
        .task { await vm.load() }
    }
}

/// Stateless content for the root Settings list: grouped rows + logout + footer.
/// Takes derived state + closures only (no VM) so previews render every access
/// state with fake data.
private struct SettingsRootView: View {
    let showAdmin: Bool
    let updateStatus: UpdateStatus
    let versionText: String
    let onOpen: (Route) -> Void
    let onLogout: () -> Void
    let onCheck: () async -> UpdateStatus
    let onInstall: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.lg) {
                group(groupSoul, soulItems)
                group(groupUser, userItems)
                if showAdmin { group(groupAdmin, adminItems) }
                group(groupSupport, supportItems)

                DangerButton(title: logoutLabel, accessibilityId: "settings-logout", action: onLogout)
                    .padding(.top, Space.sm)

                UpdateFooter(
                    status: updateStatus,
                    versionText: versionText,
                    accessibilityId: "settings-update",
                    versionAccessibilityId: "settings-version",
                    onCheck: onCheck,
                    onInstall: onInstall
                )
                .padding(.top, Space.sm)
            }
            .padding(.horizontal, Space.lg)
            .padding(.top, Space.md)
            .padding(.bottom, Space.xl)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .background(DuskColors.bg)
        .navigationTitle(titleText)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(DuskColors.bg, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .accessibilityIdentifier("settings-screen")
        .duskTheme()
    }

    /// A titled section: GroupHeader + its CategoryRows.
    @ViewBuilder
    private func group(_ header: String, _ items: [CategoryItem]) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            GroupHeader(title: header)
            ForEach(items) { item in
                CategoryRow(
                    icon: item.icon,
                    title: item.title,
                    accessibilityId: "settings-cat-\(item.key)",
                    onTap: { onOpen(item.route) }
                )
            }
        }
    }
}

// ── Previews — root states with fake data (no VM / no SettingsComponent) ──────────

#Preview("admin") {
    NavigationStack {
        SettingsRootView(
            showAdmin: true,
            updateStatus: UpdateStatusUpToDate.shared,
            versionText: "0.2.0 (6)",
            onOpen: { _ in },
            onLogout: {},
            onCheck: { UpdateStatusUpToDate.shared },
            onInstall: {}
        )
    }
    .preferredColorScheme(.dark)
}

#Preview("non-admin") {
    NavigationStack {
        SettingsRootView(
            showAdmin: false,
            updateStatus: UpdateStatusAvailable(
                latestBuild: 7,
                versionName: "0.3.0",
                notes: "",
                mandatory: false,
                target: UpdateTargetIosItms(itmsUrl: "itms-services://?action=download-manifest&url=https://example.com/manifest.plist")
            ),
            versionText: "0.2.0 (6)",
            onOpen: { _ in },
            onLogout: {},
            onCheck: { UpdateStatusUpToDate.shared },
            onInstall: {}
        )
    }
    .preferredColorScheme(.dark)
}
