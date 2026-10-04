// ---------------------------------------------------------------------------
// UserSessionHost — the authed root. Owns the User/Connection-scoped UserSession
// (@StateObject, built once on entry into the authed branch) and a NavigationStack
// whose ROOT is the chat surface keyed by committed route identity.
//
// Swift mirror of Android's AppNavHost chat gating:
//   - The SDK + socket live in UserSession ABOVE the stack, so opening history /
//     settings / switching conversation never drops the connection.
//   - Every route commitment rebuilds ChatView via `.id(chatRoute)`, including
//     same-session reopen and repeated new-chat selection. Acknowledged routes
//     bind existing shared SDK proof without another activation.
//   - Logout enters UserSession's serialized push/session/auth boundary; RootView's
//     auth gate then routes to login (the UserSession @StateObject deinits here).
//
// Presence: scenePhase drives userSession.pause()/resume() with a cold-start-skip
// (init already connected) — the first .active after launch is skipped. The OTA
// re-check (updateModel.check()) rides the same resume signal so it inherits that
// skip; the launch-time check is UpdateGate's one-shot .task.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

@MainActor
final class ForegroundInboxRefreshController: ObservableObject {
    private let accountFence: String
    private let refresh: () async -> Void
    private var task: Task<Void, Never>?
    private var trailingInvalidation = false
    private var generation = 0

    init(accountFence: String, refresh: @escaping () async -> Void) {
        self.accountFence = accountFence
        self.refresh = refresh
    }

    func request(accountFence: String) {
        guard accountFence == self.accountFence else { return }
        guard task == nil else {
            trailingInvalidation = true
            return
        }
        let operation = generation
        task = Task { [weak self] in
            guard let self else { return }
            repeat {
                trailingInvalidation = false
                await refresh()
            } while operation == generation && trailingInvalidation && !Task.isCancelled
            guard operation == generation else { return }
            task = nil
        }
    }

    func cancel() {
        generation &+= 1
        task?.cancel()
        task = nil
        trailingInvalidation = false
    }

    deinit { task?.cancel() }
}

struct UserSessionHost: View {
    /// User/Connection scope: the SDK + ChatComponent live here, above the stack.
    @StateObject private var userSession: UserSession
    /// User-scoped so route changes cannot discard an in-flight clear or its recovery state.
    @State private var scheduledInboxViewModel: ScheduledMessagesViewModel
    @StateObject private var inboxRefresh: ForegroundInboxRefreshController
    @StateObject private var notificationResume = NotificationResumeController()
    @ObservedObject private var nativePush = NativePushCoordinator.shared
    @ObservedObject private var notificationNavigation = NativePushCoordinator.shared.navigation

    /// Shared OTA-update state (owned by UpdateGate above). Forwarded to Settings
    /// and re-checked on real foregrounds, riding the same scenePhase resume signal.
    private let updateModel: UpdateModel
    private let optionalUpdateBanner: UpdateBanner?
    @State private var drawerPresented = false

    private let appConfig: AppConfig
    private let userTint: DesignUserAvatarTint
    let userName: String
    private let accountFence: String

    @State private var chatRoute = ChatRouteSelection()
    @State private var routeLifetime = HostRouteLifetime()
    @State private var draftsRestored = false
    @State private var path: [Route] = []
    /// Identity/data passed to the child editor; the Fish results route remains
    /// the owner of catalog/filter/paging state underneath it.
    @State private var fishEditorEntry: FishVoiceEntry?

    @Environment(\.scenePhase) private var scenePhase
    /// Cold-start-skip: only resume after a REAL background. The init-connect
    /// already brought the socket up, so the first .active is a no-op.
    @State private var hasBackgrounded = false
    @State private var authenticationEnding = false
    private let sceneLog = AppLog("nav", "scene")

    init(appConfig: AppConfig, updateModel: UpdateModel, optionalUpdateBanner: UpdateBanner? = nil) {
        self.optionalUpdateBanner = optionalUpdateBanner
        self.appConfig = appConfig
        userTint = DesignUserAvatarTint(serverValue: appConfig.avatarTint)
        userName = appConfig.displayName
        let fence = "\(appConfig.gatewayWsUrl)|\(appConfig.authenticatedUserId ?? "")"
        accountFence = fence
        self.updateModel = updateModel
        NativePushCoordinator.shared.configure(appConfig: appConfig)
        let session = UserSession(
            gatewayWsUrl: appConfig.gatewayWsUrl,
            allowSelfSignedDevHost: appConfig.allowSelfSignedDevHost,
            // This branch is mounted only when AppConfig has a persisted,
            // explicit server-authenticated identity. An empty value is a
            // fail-closed guard for an impossible stale view transition.
            authenticatedUserId: appConfig.authenticatedUserId ?? "",
            // UserSession owns push preparation, session teardown, then auth clearing.
            onLoggedOut: { appConfig.logout(reason: appConfig.loginReason) }
        )
        _userSession = StateObject(wrappedValue: session)
        let inboxViewModel = ScheduledMessagesViewModel(useCases: session.settings.schedules)
        _scheduledInboxViewModel = State(initialValue: inboxViewModel)
        _inboxRefresh = StateObject(wrappedValue: ForegroundInboxRefreshController(
            accountFence: fence,
            refresh: { [weak inboxViewModel] in await inboxViewModel?.reloadCards() }
        ))
        // Default draft restoration competes only until the first explicit intent.
    }

    var body: some View {
        GeometryReader { geometry in
            NavigationStack(path: Binding(
                get: { path },
                set: { newPath in
                    guard newPath != path, beginNavigation(from: chatRoute.viewIdentity) != nil else { return }
                    path = newPath
                }
            )) {
                Group {
                    if draftsRestored {
                        let producingRoute = chatRoute
                        let producingIntent = routeLifetime.currentIntent
                        ChatView(
                            makeVM: {
                                // A body/factory captured before a newer intent must
                                // not claim SDK authority, even for a pending draft.
                                let mayBind = acceptsProducer(producingRoute) && routeLifetime.accepts(producingIntent)
                                let vm = ChatViewModel(
                                    component: userSession.component,
                                    sessionId: mayBind ? producingRoute.sessionId : nil,
                                    draftId: mayBind ? producingRoute.draftId : nil,
                                    activateOnInit: mayBind && !producingRoute.acknowledged,
                                    onDraftRouteChanged: { originalId, restoredId, sessionId in
                                        guard !authenticationEnding,
                                              routeLifetime.acceptsProducer(producingRoute.viewIdentity, current: chatRoute.viewIdentity) else { return }
                                        if originalId != restoredId, chatRoute.draftId == originalId {
                                            routeLifetime.retireEditor()
                                        }
                                        chatRoute.reconcileDraft(
                                            from: originalId,
                                            to: restoredId,
                                            sessionId: sessionId
                                        )
                                    }
                                )
                                if mayBind {
                                    routeLifetime.installEditor(
                                        saveAndRetire: { [weak vm] isCurrent in
                                            guard let vm else { return true }
                                            return await vm.saveAndRetireEditor(isCurrent: isCurrent)
                                        },
                                        suspendRoute: { [weak vm] in vm?.suspendRouteForActivation() },
                                        restoreRoute: { [weak vm] in vm?.restoreRouteAfterActivation() },
                                        retire: { [weak vm] in vm?.retireEditor() }
                                    )
                                } else {
                                    vm.retireEditor()
                                }
                                return vm
                            },
                            makeHistoryVM: { userSession.makeHistoryVM() },
                            userName: userName,
                            activeSessionId: chatRoute.sessionId,
                            activeDraftId: chatRoute.draftId,
                            beginNavigation: { beginNavigation(from: producingRoute.viewIdentity) },
                            isNavigationCurrent: { routeLifetime.accepts($0) && !authenticationEnding },
                            onSelectSession: { id in
                                guard acceptsProducer(producingRoute) else { return }
                                routeLifetime.retireEditor()
                                chatRoute.select(id)
                                path.removeAll()
                            },
                            onSelectDraft: { draftId, sessionId in
                                guard acceptsProducer(producingRoute) else { return }
                                routeLifetime.retireEditor()
                                chatRoute.selectDraft(draftId, sessionId: sessionId)
                                path.removeAll()
                            },
                            onNewChat: {
                                guard acceptsProducer(producingRoute) else { return }
                                routeLifetime.retireEditor()
                                chatRoute.selectNewDraft()
                                path.removeAll()
                            },
                            onOpenSettings: {
                                guard beginNavigation(from: producingRoute.viewIdentity) != nil else { return }
                                path = [.settings]
                            },
                            onOpenInbox: {
                                guard acceptsProducer(producingRoute) else { return }
                                openInbox()
                            },
                            onLogout: {
                                guard acceptsProducer(producingRoute) else { return }
                                logout()
                            }
                        )
                        .environment(\.chatUserAvatarTint, userTint)
                        .id(chatRoute.viewIdentity)
                    } else {
                        ProgressView()
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(DuskColors.bg)
                    }
                }
                .navigationDestination(for: Route.self) { route in destination(for: route) }
            }
            // Recovery first, optional update second. Both reserve content space;
            // no header offsets or competing floating overlays. Drawer is modal.
            .onPreferenceChange(DrawerPresentedKey.self) { drawerPresented = $0 }
            .safeAreaInset(edge: .top, spacing: 0) {
                if !drawerPresented && !authenticationEnding && (hasNotificationNotice || optionalUpdateBanner != nil) {
                    ShellNoticeRegion(availableHeight: geometry.size.height) {
                        VStack(spacing: Space.sm) {
                            notificationResumeNotice.padding(.horizontal, Space.lg)
                            optionalUpdateBanner
                        }
                        .padding(.vertical, Space.sm)
                    }
                }
            }
        }
        .onChange(of: path) { old, new in
            userSession.cube?.navigationChanged(from: old.last?.cubePage, to: new.last?.cubePage)
        }
        .alert("Cube access cleanup failed", isPresented: Binding(
            get: { userSession.cubeCleanupError != nil },
            set: { if !$0 { userSession.cubeCleanupError = nil } }
        )) {
            Button("Retry logout") { logout(preservingLoginReason: true) }
            Button("Cancel", role: .cancel) { recoverFromLogoutFailure() }
        } message: { Text(userSession.cubeCleanupError ?? "Unlock iPhone and retry.") }
        .onReceive(userSession.$cubeCleanupError) { error in
            if error != nil { recoverFromLogoutFailure() }
        }
        .allowsHitTesting(!authenticationEnding)
        .accessibilityHidden(authenticationEnding)
        .overlay {
            if authenticationEnding {
                ProgressView(appConfig.loginReason == .expired ? "Session expired. Returning to sign in…" : "Logging out…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(DuskColors.bg.ignoresSafeArea())
            }
        }
        .onReceive(notificationNavigation.$destination) { destination in
            guard destination != nil, !authenticationEnding, routeLifetime.active else { return }
            // Reserve before scheduling: a suspended default restore must not mount
            // a route-binding VM while notification activation is waiting for ACK.
            guard let intent = routeLifetime.begin() else { return }
            notificationResume.supersedeNavigation()
            Task { @MainActor in
                guard routeLifetime.accepts(intent), !authenticationEnding else { return }
                consumeNotification()
                // A target bound to another account may already have been dropped
                // by onAppear; it must not strand startup behind a spinner.
                if routeLifetime.accepts(intent), !routeLifetime.hasEditor { draftsRestored = true }
            }
        }
        .onReceive(nativePush.$foregroundInboxInvalidation) { invalidation in
            guard let invalidation, !authenticationEnding, routeLifetime.active else { return }
            inboxRefresh.request(accountFence: invalidation.accountFence)
        }
        .onAppear {
            consumeNotification()
        }
        .task {
            await restoreLastDraft()
        }
        .task {
            for await state in userSession.component.connection.state {
                guard routeLifetime.active, !Task.isCancelled else { return }
                guard state.authExpired else { continue }
                authenticationExpired()
                return
            }
        }
        .onDisappear {
            routeLifetime.retire()
            userSession.cube?.pause()
            notificationResume.cancel()
            inboxRefresh.cancel()
            scheduledInboxViewModel.cancel()
        }
        .onChange(of: scenePhase) { _, phase in
            guard routeLifetime.active else { return }
            switch phase {
            case .background:
                hasBackgrounded = true
                sceneLog.info("background")
                userSession.pause()
                // Flush the diagnostic ring to the current session file on background
                // (the app-global vitals facade; same instance as init / Settings).
                VitalsHolder.shared.onAppBackground()
            case .active:
                guard !authenticationEnding else { return }
                if hasBackgrounded {
                    sceneLog.info("foreground")
                    userSession.resume()
                    inboxRefresh.request(accountFence: accountFence)
                    // OTA re-check rides the SAME foreground signal as resume, so it
                    // inherits the cold-start-skip (the launch check is UpdateGate's
                    // one-shot .task) — only on a REAL resume after a background.
                    Task { await updateModel.check() }
                } else {
                    sceneLog.info("cold-start-skip")
                }
            default: break
            }
        }
    }

    private func acceptsProducer(_ route: ChatRouteSelection) -> Bool {
        !authenticationEnding && routeLifetime.acceptsProducer(route.viewIdentity, current: chatRoute.viewIdentity)
    }

    private func beginNavigation(from route: Int) -> HostRouteLifetime.Intent? {
        guard !authenticationEnding, routeLifetime.acceptsProducer(route, current: chatRoute.viewIdentity),
              let intent = routeLifetime.begin() else { return nil }
        notificationResume.supersedeNavigation()
        notificationNavigation.clear()
        return intent
    }

    private func consumeNotification() {
        guard routeLifetime.active, !authenticationEnding,
              let destination = notificationNavigation.take(accountFence: accountFence) else { return }
        resumeNotificationDestination(destination)
    }

    private func restoreLastDraft() async {
        consumeNotification()
        guard !draftsRestored else { return }
        await routeLifetime.restoreDefault(
            load: { try? await userSession.component.drafts?.restore() },
            apply: { snapshot in
                if let pending = snapshot?.pendingSends.max(by: { $0.createdAt < $1.createdAt }) {
                    chatRoute.selectDraft(pending.draftId, sessionId: pending.sessionId)
                } else if let latest = snapshot?.drafts.max(by: { $0.updatedAt < $1.updatedAt }) {
                    chatRoute.selectDraft(latest.id, sessionId: latest.sessionId)
                }
                draftsRestored = true
            }
        )
    }

    private func recoverFromLogoutFailure() {
        guard authenticationEnding, routeLifetime.active else { return }
        authenticationEnding = false
        draftsRestored = true
        if let draftId = chatRoute.draftId {
            chatRoute.selectDraft(draftId, sessionId: chatRoute.sessionId)
        } else {
            chatRoute.select(chatRoute.sessionId)
        }
    }

    private func logout(preservingLoginReason: Bool = false) {
        guard !authenticationEnding, routeLifetime.active else { return }
        appConfig.prepareLogin(reason: preservingLoginReason ? appConfig.loginReason : nil)
        authenticationEnding = true
        _ = routeLifetime.begin()
        routeLifetime.retireEditor()
        notificationResume.cancel()
        inboxRefresh.cancel()
        scheduledInboxViewModel.cancel()
        path.removeAll()
        notificationNavigation.clear()
        userSession.explicitLogout()
    }

    private func authenticationExpired() {
        guard !authenticationEnding, routeLifetime.active else { return }
        appConfig.prepareLogin(reason: .expired)
        authenticationEnding = true
        _ = routeLifetime.begin()
        routeLifetime.retireEditor()
        let destination = notificationResume.state.destination
        notificationResume.cancel()
        inboxRefresh.cancel()
        scheduledInboxViewModel.cancel()
        path.removeAll()
        notificationNavigation.preserve(destination, for: accountFence)
        userSession.authenticationExpired()
    }

    private func openInbox() {
        guard beginNavigation(from: chatRoute.viewIdentity) != nil else { return }
        inboxRefresh.request(accountFence: accountFence)
        path = [.scheduledInbox]
    }

    // ── Settings route graph ─────────────────────────────────────────────────────
    // Every settings destination is registered HERE, once. A category page agent
    // fills its own screen file (below) and never re-touches Route.swift or this
    // host: the wiring (settings scope + push/pop closures) is already threaded in.

    private func openCubePage(_ page: CubePage) {
        guard beginNavigation(from: chatRoute.viewIdentity) != nil else { return }
        if page == .hub {
            // Setup is a flow, not a second parent of the owned-device hub.
            while path.last?.cubePage != nil, path.last != .cube { path.removeLast() }
        }
        path.append(.cubePage(page))
    }

    /// Pop one level off the stack (category page → settings root, or sub → parent).
    private func popRoute() {
        guard !path.isEmpty, beginNavigation(from: chatRoute.viewIdentity) != nil else { return }
        path.removeLast()
    }

    private func pushRoute(_ route: Route) {
        guard beginNavigation(from: chatRoute.viewIdentity) != nil else { return }
        path.append(route)
    }

    private func routeToAcknowledgedSession(_ sessionId: String) {
        guard !authenticationEnding, routeLifetime.active else { return }
        routeLifetime.retireEditor()
        chatRoute.select(sessionId, acknowledged: true)
        draftsRestored = true
        path.removeAll()
    }

    private func resumeNotificationDestination(_ destination: NotificationDestination) {
        guard !authenticationEnding, let intent = routeLifetime.begin() else { return }
        if !routeLifetime.hasEditor { draftsRestored = false }
        routeLifetime.suspendEditorRoute(intent)
        notificationResume.resume(
            destination,
            accountFence: accountFence,
            activate: { await userSession.activateSession($0) },
            route: { sessionId in
                guard routeLifetime.accepts(intent), !authenticationEnding else { return }
                routeToAcknowledgedSession(sessionId)
            },
            prepareRoute: { await routeLifetime.prepareReplacement(intent) },
            clear: clearScheduledCard,
            isCurrent: { routeLifetime.accepts(intent) && !authenticationEnding },
            activationFinished: {
                guard routeLifetime.accepts(intent), !authenticationEnding else { return }
                // Failed startup activation leaves usable fresh chat + existing retry
                // notice. Never run the stale default draft restore afterward.
                draftsRestored = true
            },
            activationAbandoned: { routeLifetime.restoreEditorRoute(intent) }
        )
    }

    private func clearScheduledCard(_ sessionId: String) async -> Bool {
        do {
            switch onEnum(of: try await userSession.settings.schedules.clearCard(sessionId: sessionId)) {
            case .success: return true
            case .failure, .loading: return false
            }
        } catch {
            return false
        }
    }

    private var hasNotificationNotice: Bool {
        switch notificationResume.state {
        case .idle, .pending, .clearing: false
        case .unavailable, .retryableFailure, .clearFailure: true
        }
    }

    @ViewBuilder
    private var notificationResumeNotice: some View {
        switch notificationResume.state {
        case .idle, .pending, .clearing:
            EmptyView()
        case .unavailable:
            AsyncNotice(
                kind: .warning,
                title: "Message unavailable",
                detail: "This message is no longer available.",
                retry: notificationResume.dismiss,
                accessibilityId: "notification-session-unavailable",
                actionTitle: "Dismiss"
            )
        case .retryableFailure(let destination):
            AsyncNotice(
                kind: .warning,
                title: "Couldn't open message",
                detail: "Check your connection and try again.",
                retry: { resumeNotificationDestination(destination) },
                accessibilityId: "notification-session-retry",
                actionTitle: "Try again"
            )
        case .clearFailure(let destination):
            AsyncNotice(
                kind: .warning,
                title: "Message opened",
                detail: "It couldn't be cleared from Messages. Try clearing it again.",
                retry: {
                    guard routeLifetime.active, !authenticationEnding else { return }
                    notificationResume.retryClear(destination, accountFence: accountFence, clear: clearScheduledCard)
                },
                accessibilityId: "notification-session-clear-retry",
                actionTitle: "Retry clear"
            )
        }
    }

    @ViewBuilder
    private func destination(for route: Route) -> some View {
        let settings = userSession.settings
        switch route {
        case .cube:
            CubeScreen(model: userSession.cube, onBack: popRoute, onOpen: openCubePage)
        case .cubePage(let page):
            CubeScreen(model: userSession.cube, page: page, onBack: popRoute, onOpen: openCubePage)
        case .settings:
            SettingsSheet(
                settings: settings,
                updateModel: updateModel,
                onLogout: { logout() },
                onOpen: pushRoute
            )
        case .settingsMemory:
            MemoryScreen(settings: settings, onBack: popRoute)
        case .settingsCalendar:
            CalendarSessionRoute(userSession: userSession, onBack: popRoute)
        case .settingsScheduledMessages:
            ScheduledMessagesScreen(settings: settings, onBack: popRoute)
        case .settingsPushNotifications:
            PushNotificationsScreen(settings: settings, onBack: popRoute)
        case .settingsPersonalities:
            PersonalitiesScreen(settings: settings, onBack: popRoute)
        case .settingsVoice:
            VoiceScreen(settings: settings, onOpen: pushRoute, onBack: popRoute)
        case .settingsVoiceAdd:
            VoiceAddScreen(settings: settings, onBack: popRoute)
        case .settingsVoiceFish:
            VoiceFishScreen(
                settings: settings,
                onBack: popRoute,
                onOpenEditor: { entry in
                    guard beginNavigation(from: chatRoute.viewIdentity) != nil else { return }
                    fishEditorEntry = entry
                    path.append(.settingsVoiceFishEditor(entry.id))
                }
            )
        case .settingsVoiceFishEditor:
            if let entry = fishEditorEntry {
                VoiceFishScreen(settings: settings, onBack: popRoute, editorEntry: entry)
            } else {
                EmptyView()
            }
        case .settingsAudio:
            AudioScreen(settings: settings, onBack: popRoute)
        case .settingsModel:
            ModelScreen(settings: settings, onBack: popRoute)
        case .settingsAuxiliary:
            ModelScreen(settings: settings, auxiliaryOnly: true, onBack: popRoute)
        case .settingsTools:
            ToolsScreen(settings: settings, onBack: popRoute)
        case .settingsSystemPrompt:
            SystemPromptScreen(settings: settings, onBack: popRoute)
        case .settingsAdvanced:
            AdvancedScreen(settings: settings, onBack: popRoute)
        case .settingsAccount:
            AccountScreen(settings: settings, onBack: popRoute)
        case .settingsMembers:
            MembersScreen(settings: settings, onBack: popRoute)
        case .settingsSecrets:
            SecretsScreen(settings: settings, onBack: popRoute)
        case .settingsDiagnostics:
            DiagnosticsScreen(onBack: popRoute)
        case .scheduledInbox:
            ScheduledInboxScreen(
                viewModel: scheduledInboxViewModel,
                isOpening: notificationResume.state.isBusy,
                onBack: popRoute,
                onSelectSession: { sessionId in
                    guard let destination = NotificationDestination(sessionId: sessionId) else { return }
                    resumeNotificationDestination(destination)
                }
            )
        case .history:
            // History is presented as the in-chat keeper drawer, not a stack page;
            // this case exists for the typed graph's completeness.
            EmptyView()
        }
    }
}

/// Committed native route identity, not SDK intent or transport health. Every route
/// commitment recreates its VM, including an acknowledged B → B reopen.
struct ChatRouteSelection: Hashable {
    private(set) var sessionId: String?
    private(set) var draftId: String?
    private(set) var acknowledged = false
    private var epoch = 0
    var viewIdentity: Int { epoch }

    mutating func select(_ sessionId: String?, acknowledged: Bool = false) {
        self.sessionId = sessionId
        draftId = nil
        self.acknowledged = acknowledged
        epoch += 1
    }

    mutating func selectDraft(_ draftId: String, sessionId: String?, acknowledged: Bool = false) {
        self.sessionId = sessionId
        self.draftId = draftId
        self.acknowledged = acknowledged
        epoch += 1
    }

    mutating func selectNewDraft(_ draftId: String = UUID().uuidString) {
        selectDraft(draftId, sessionId: nil)
    }

    mutating func reconcileDraft(from originalId: String, to restoredId: String, sessionId: String?) {
        guard draftId == originalId,
              draftId != restoredId || self.sessionId != sessionId else { return }
        if originalId == restoredId {
            self.sessionId = sessionId
        } else {
            selectDraft(restoredId, sessionId: sessionId, acknowledged: acknowledged)
        }
    }
}
