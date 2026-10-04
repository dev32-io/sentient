// Standalone fixture only. Ordinary app/test targets do not launch this host.
// Compile production App sources except SentientApp.swift with S_SHELL_FIXTURE.
#if S_SHELL_FIXTURE
import SwiftUI
import MobileData
import UIKit

@main
final class ShellParityFixtureApp: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let host = UIHostingController(rootView: ShellParityFixture())
        host.traitOverrides.accessibilityContrast = ProcessInfo.processInfo.environment["S_CONTRAST"] == "increased" ? .high : .normal
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = host
        window?.makeKeyAndVisible()
        return true
    }
}

private struct ShellParityFixture: View {
    private let env = ProcessInfo.processInfo.environment
    @State private var drawerOpen = false
    @State private var drawerPresented = false
    @State private var settingsPresented = false
    @State private var query = ""
    @State private var callbacks = 0
    @State private var updateShown = true
    @State private var recoveryShown = true
    @State private var headerHeight: CGFloat = 0
    @State private var dockHeight: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    private var size: DynamicTypeSize {
        switch env["S_SIZE"] {
        case "ax3": .accessibility3
        case "ax5": .accessibility5
        default: .large
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            Text("Callbacks: \(callbacks); motion: \(reduceMotion ? "reduced" : "normal"); contrast: \(contrast == .increased ? "increased" : "normal")")
                .font(.caption).dynamicTypeSize(.large).accessibilityIdentifier("s-observed-state")
            switch env["S_SCENARIO"] {
            case "drawer":
                NavigationStack {
                    SideDrawer(isOpen: $drawerOpen, onOpen: { callbacks += 1 }) {
                        VStack {
                            ChatTitleBar(onOpenPanel: { drawerOpen = true }, onOpenInbox: { callbacks += 100 },
                                         onNewChat: { callbacks += 100 }, historyIsOpen: drawerPresented)
                            DesignActionButton(title: "Background action", accessibilityId: "s-background") { callbacks += 100 }
                            Spacer()
                        }
                    } drawer: { history }
                    .onPreferenceChange(DrawerPresentedKey.self) { drawerPresented = $0 }
                    .navigationDestination(isPresented: $settingsPresented) { settings }
                }
            case "history": history
            case "notices": notices
            case "backend": ShellParityBackendFixture()
            case "inbox": ShellParityInboxFixture()
            case "settings":
                NavigationStack { settings }
            default:
                LoginContent(users: [AuthUserLite(userId: "s-profile", displayName: "Disposable profile", avatarTint: "sage")],
                             selectedUser: nil, pickerState: .ready, entered: 0, isSubmitting: false, error: nil,
                             success: nil, feedbackRevision: 0, entryReason: .expired,
                             onSelect: { _ in callbacks += 1 }, onBack: {}, onCancel: {}, onDigit: { _ in },
                             onDelete: {}, onReload: {}, onSettings: {})
            }
        }
        .environment(\.dynamicTypeSize, size)
        .duskTheme()
    }

    private var settings: some View {
        SettingsRootView(access: .ready(isAdmin: true, fishBrowseEnabled: true),
                         updateStatus: UpdateStatusUpToDate.shared, versionText: "fixture (1)",
                         onOpen: { _ in callbacks += 1 }, onLogout: { callbacks += 1 },
                         onCheck: { UpdateStatusUpToDate.shared }, onInstall: { callbacks += 1 })
    }

    private var history: some View {
        let now = Int64(Date().timeIntervalSince1970 * 1_000)
        return HistorySidePanelContent(rows: [
            HistoryEntry(kind: .session(id: "s-pinned", draftId: nil), title: "Pinned Cube", lastActiveAt: now - 864_000_000,
                         hasDraft: false, provenance: "cube", readOnly: true, currentPin: true),
            HistoryEntry(kind: .draft(id: "s-draft"), title: "Disposable local draft", lastActiveAt: now, hasDraft: true),
            HistoryEntry(kind: .session(id: "s-older", draftId: nil), title: "Disposable earlier chat", lastActiveAt: now - 864_000_000, hasDraft: false)
        ].filter { query.isEmpty || $0.title.localizedStandardContains(query) }, query: $query,
        loading: false, hasLoaded: true, hasError: true, isSearching: !query.isEmpty, nowMs: now,
        userName: "Disposable profile", household: "Fixture household", activeSessionId: nil, activeDraftId: "s-draft",
        hasPermanentDeleteFailure: true, unfilteredRowCount: 3, onSelect: { _ in callbacks += 1 }, onNewChat: { callbacks += 1 },
        onSettings: {
            callbacks += 1
            if env["S_SCENARIO"] == "drawer" { drawerOpen = false; settingsPresented = true }
        }, onRetry: { callbacks += 1 }, onRetryDeletes: { callbacks += 1 },
        onAskRename: { _ in }, onAskDelete: { _ in }, onAskDiscard: { _ in })
    }

    private var notices: some View {
        GeometryReader { geometry in
            ZStack(alignment: .bottom) {
                VStack(spacing: 0) {
                    DesignPageHeader(title: "Fixture page", onBack: { callbacks += 1 })
                        .accessibilityIdentifier("s-page-header")
                        .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { headerHeight = $0 }
                    ShellNoticeRegion(availableHeight: max(0, geometry.size.height - headerHeight - dockHeight)) {
                        VStack(spacing: Space.sm) {
                            if recoveryShown {
                                AsyncNotice(kind: .warning, title: "Message unavailable", detail: "This message is no longer available.",
                                            retry: { recoveryShown = false }, accessibilityId: "s-recovery", actionTitle: "Dismiss")
                            }
                            if updateShown {
                                UpdateBanner(versionName: "fixture", onUpdate: { callbacks += 1 }, onDismiss: { updateShown = false })
                            }
                            ConnectionBanner(state: .lost, onReconnect: { callbacks += 1 })
                            ContentErrorBanner(text: "Disposable content recovery", canRetry: true, onRetry: { callbacks += 1 })
                            ReopenFailedNoticeBanner(noticeText: "Couldn't reopen that chat — started a new one.", onDismiss: { callbacks += 1 })
                        }
                        .padding(Space.md)
                    }
                    Spacer()
                }
                Composer(tasks: [], ttsEnabled: false, talkMode: .idle, micLevels: [], voiceDisabled: true,
                         canInterrupt: false, initialDraft: "Disposable draft", onSend: { _ in callbacks += 1 },
                         onVoiceIntent: { _ in callbacks += 100 }, onTtsToggle: { callbacks += 1 },
                         onInterrupt: {}, onFocusGained: {})
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("s-dock-boundary")
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { dockHeight = $0 }
            }
        }
    }
}

@Observable @MainActor
private final class ShellParityClearGate {
    var pending = false
    private var completion: CheckedContinuation<ScheduledInboxClearFailure?, Never>?
    func wait() async -> ScheduledInboxClearFailure? {
        await withCheckedContinuation { completion = $0; pending = true }
    }
    func finish(_ outcome: ScheduledInboxClearFailure?) {
        pending = false
        completion?.resume(returning: outcome)
        completion = nil
    }
}

private struct ShellParityInboxFixture: View {
    private let gate: ShellParityClearGate
    @State private var inbox: ScheduledInboxState
    @State private var loadGeneration = 0
    init() {
        let gate = ShellParityClearGate()
        self.gate = gate
        _inbox = State(initialValue: ScheduledInboxState(loadCards: { true }, clearCards: { _ in await gate.wait() }))
    }
    var body: some View {
        VStack {
            DesignActionButton(title: "Finish loading", accessibilityId: "s-load-complete") {
                loadGeneration += 1
                inbox.receive([ScheduledSessionCard(sessionId: "s-session", scheduleId: "s-schedule", occurrenceId: "s-card-\(loadGeneration)",
                    intendedAt: "2026-03-09T07:00:00Z", completedAt: "2026-03-09T07:01:00Z", status: .completed, preview: "Disposable message")], authoritative: true)
                inbox.cardsState = .ready
            }
            ScheduledInboxHeader(canClearAll: !inbox.cards.isEmpty, onBack: {}, onClearAll: inbox.clearAll)
            ScrollView {
                if let failure = inbox.clearFailure { AsyncNotice(kind: .error, title: failure.title, detail: failure.detail) }
                ScheduledInboxEmptyState(presentation: scheduledInboxEmptyPresentation(cardCount: inbox.cards.count,
                    loading: { if case .loading = inbox.cardsState { true } else { false } }(),
                    ready: { if case .ready = inbox.cardsState { true } else { false } }(),
                    pendingClear: inbox.hasPendingClears, clearFailed: inbox.clearFailure != nil))
                ForEach(inbox.cards, id: \.occurrenceId) { card in
                    ScheduledInboxSwipeRow(card: card, isRevealed: false, disabled: false, onBeginSwipe: {},
                        onSetRevealed: { _ in }, onClear: { inbox.clear(card) }, onOpen: {})
                }
            }
            DesignActionButton(title: "Acknowledge clear", state: gate.pending ? .normal : .disabled,
                               accessibilityId: "s-clear-ack") { gate.finish(nil) }
            DesignActionButton(title: "Fail clear", state: gate.pending ? .normal : .disabled,
                               accessibilityId: "s-clear-fail") { gate.finish(.unknownOutcome) }
        }
    }
}

@Observable @MainActor
private final class ShellParityProbeGate {
    var pending = false
    var starts = 0
    private var completion: CheckedContinuation<Bool, Never>?
    func wait() async -> Bool {
        await withCheckedContinuation { completion = $0; pending = true; starts += 1 }
    }
    func finish(_ success: Bool) {
        pending = false
        completion?.resume(returning: success)
        completion = nil
    }
}

private struct ShellParityBackendFixture: View {
    private let gate: ShellParityProbeGate
    @StateObject private var model: BackendSetupViewModel
    @State private var saved = false
    init() {
        let gate = ShellParityProbeGate()
        self.gate = gate
        _model = StateObject(wrappedValue: BackendSetupViewModel(existing: nil, reconfigure: { _ in },
                                                               probe: { _ in await gate.wait() }, retryDelay: .zero))
    }
    var body: some View {
        VStack {
            HStack {
                DesignActionButton(title: "Approve probe", state: gate.pending ? .normal : .disabled,
                                   accessibilityId: "s-probe-ok") { gate.finish(true) }
                DesignActionButton(title: "Reject probe", state: gate.pending ? .normal : .disabled,
                                   accessibilityId: "s-probe-fail") { gate.finish(false) }
            }
            Text("Probe starts: \(gate.starts)").accessibilityIdentifier("s-probe-starts")
            if saved { Text("Fixture saved").accessibilityIdentifier("s-backend-saved") }
            NavigationStack {
                BackendSetupView(model: model, onSaved: { saved = true }, primesLocalNetwork: false)
            }
        }
    }
}
#endif
