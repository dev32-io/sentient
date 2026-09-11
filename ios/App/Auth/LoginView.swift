import SwiftUI
import MobileData

enum LoginPickerState: Equatable {
    case loading
    case empty
    case error(String)
    case ready
}

func loginPickerState(isLoading: Bool, userCount: Int, error: String?) -> LoginPickerState {
    if isLoading && userCount == 0 { return .loading }
    if let error { return .error(error) }
    return userCount == 0 ? .empty : .ready
}

struct LoginView: View {
    private let onOpenBackendSetup: () -> Void
    private let isRevealed: Bool
    @StateObject private var model: AuthViewModel
    @State private var reloadRevision = 0

    init(
        onAuthenticatedUser: @escaping (String) -> Void = { _ in },
        onConnect: @escaping () -> Void = {},
        onInitialUsersResolved: @escaping () -> Void = {},
        onOpenBackendSetup: @escaping () -> Void = {},
        isRevealed: Bool = true
    ) {
        self.onOpenBackendSetup = onOpenBackendSetup
        self.isRevealed = isRevealed
        _model = StateObject(wrappedValue: AuthViewModel(
            connect: onConnect,
            onAuthenticatedUser: onAuthenticatedUser,
            onInitialUsersResolved: onInitialUsersResolved
        ))
    }

    var body: some View {
        LoginContent(
            users: model.users,
            selectedUser: model.selectedUser,
            pickerState: loginPickerState(isLoading: model.isLoadingUsers, userCount: model.users.count, error: model.error),
            entered: model.pin.count,
            isSubmitting: model.isSubmitting,
            error: model.error,
            success: model.pinSuccess,
            feedbackRevision: model.pinFeedbackRevision,
            isRevealed: isRevealed,
            onSelect: model.select,
            onBack: model.back,
            onCancel: model.cancel,
            onDigit: model.appendDigit,
            onDelete: model.deleteDigit,
            onReload: { reloadRevision += 1 },
            onSettings: { model.cancel(); onOpenBackendSetup() }
        )
        .task(id: reloadRevision) { await model.loadUsers() }
        .onDisappear { model.cancel() }
    }
}

/// Value-driven composition. Auth, secure storage and connection ownership stay
/// outside this view; the only local state is search, focus and choreography.
struct LoginContent: View {
    let users: [AuthUserLite]
    let selectedUser: AuthUserLite?
    let pickerState: LoginPickerState
    let entered: Int
    let isSubmitting: Bool
    let error: String?
    let success: String?
    let feedbackRevision: Int
    var isRevealed = true
    let onSelect: (AuthUserLite) -> Void
    let onBack: () -> Void
    let onCancel: () -> Void
    let onDigit: (Character) -> Void
    let onDelete: () -> Void
    let onReload: () -> Void
    let onSettings: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.layoutDirection) private var layoutDirection
    @State private var query = ""
    @State private var showHelp = false
    @State private var headerArrived = false
    @State private var firstArrival = true
    @State private var transitioning = false
    @State private var stageOpacity = 1.0
    @State private var stageOffset: CGFloat = 0
    @State private var motionRevision = 0
    @State private var entranceFinished = false
    @State private var pendingFocus: LoginFocus?
    @State private var avatarFrames: [String: CGRect] = [:]
    @State private var flightUser: AuthUserLite?
    @State private var flightRect = CGRect.zero
    @State private var flightStarted = false
    @AccessibilityFocusState private var accessibilityFocus: LoginFocus?
    @FocusState private var searchFocused: Bool

    private var filteredUsers: [AuthUserLite] {
        let search = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return search.isEmpty ? users : users.filter { $0.displayName.localizedStandardContains(search) }
    }
    private var direction: CGFloat { layoutDirection == .rightToLeft ? -1 : 1 }
    private var countText: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "\(users.count) people" : "\(filteredUsers.count) of \(users.count)"
    }

    var body: some View {
        VStack(spacing: 0) {
            header
                .opacity(headerArrived ? 1 : 0)
            stage
                .coordinateSpace(name: LoginLayout.stageCoordinateSpace)
                .opacity(stageOpacity)
                .offset(x: stageOffset)
                .id(selectedUser?.userId)
                .transition(.asymmetric(
                    insertion: reduceMotion ? .identity : .opacity.combined(with: .offset(
                        x: (selectedUser == nil ? -12 : 12) * direction
                    )),
                    removal: .identity
                ))
                .allowsHitTesting(!transitioning && isRevealed)
                .disabled(transitioning || !isRevealed)
                .accessibilityHidden(transitioning || !isRevealed)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .background {
                    if flightUser != nil && !flightStarted {
                        avatarMeasurement(LoginLayout.stageAnchor)
                    }
                }
            Label("Home gateway", systemImage: "house")
                .designText(.caption)
                .foregroundStyle(DuskColors.ink2)
                .padding(.vertical, Space.md)
                .accessibilityLabel("Configured home gateway")
        }
        .padding(.horizontal, LoginLayout.horizontalPadding)
        .frame(maxWidth: LoginLayout.maximumWidth)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .coordinateSpace(name: LoginLayout.coordinateSpace)
        .onPreferenceChange(LoginAvatarFrames.self) { frames in
            avatarFrames = frames
            startAvatarFlightIfReady(frames)
        }
        .overlay(alignment: .topLeading) {
            if let flightUser {
                LoginFlyingAvatar(
                    name: flightUser.displayName,
                    tint: DesignUserAvatarTint(serverValue: flightUser.avatarTint),
                    rect: flightRect
                )
                .transition(.identity)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
        .background(DuskColors.bg.ignoresSafeArea())
        .duskTheme()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("login-screen")
        .task(id: isRevealed) {
            guard isRevealed else { headerArrived = false; return }
            withAnimation(reduceMotion ? nil : .easeInOut(duration: LoginMotion.headerDuration)) {
                headerArrived = true
            }
        }
        .sheet(isPresented: $showHelp) { LoginHelpSheet() }
        .onDisappear {
            resetMotion()
            onCancel()
        }
    }

    private var header: some View {
        HStack {
            Text("Sentient")
                .designText(.title)
                .foregroundStyle(DuskColors.ink)
            Spacer(minLength: Space.md)
            DesignIconButton(
                systemName: "slider.horizontal.3",
                label: "Connection settings",
                accessibilityId: "login-backend-setup",
                visualSizeOverride: DesignMetrics.minimumTarget
            ) {
                resetMotion()
                onCancel()
                onSettings()
            }
            .disabled(!isRevealed)
        }
        .padding(.top, Space.sm)
        .padding(.bottom, Space.md)
    }

    @ViewBuilder private var stage: some View {
        if let user = selectedUser {
            pinEntry(user)
        } else if dynamicTypeSize.isAccessibilitySize {
            // Large text may consume the viewport before the list begins.
            ScrollView { pickerHeader; pickerBody }
                .scrollDismissesKeyboard(.interactively)
        } else {
            VStack(spacing: 0) {
                pickerHeader
                ScrollView { pickerBody }
                    .scrollDismissesKeyboard(.interactively)
                    .mask(alignment: .bottom) {
                        VStack(spacing: 0) {
                            Rectangle()
                            LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                                .frame(height: LoginLayout.listFade)
                        }
                    }
            }
        }
    }

    private var pickerHeader: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Space.lg) {
                    SentientMark(size: LoginLayout.assistantSize, mode: .idle)
                    welcomeCopy
                }
                VStack(alignment: .leading, spacing: Space.md) {
                    SentientMark(size: LoginLayout.assistantSize, mode: .idle)
                    welcomeCopy
                }
            }
            .padding(.top, Space.md)
            .padding(.bottom, Space.md)
            .modifier(LoginArrival(revealed: isRevealed, welcome: true, animated: firstArrival))

            HStack(alignment: .firstTextBaseline) {
                Text("Who's here?")
                    .designText(.label)
                    .foregroundStyle(DuskColors.ink)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: Space.sm)
                Text(countText)
                    .designText(.caption)
                    .foregroundStyle(DuskColors.ink3)
            }
            if users.count > 6 {
                DesignSearchField(
                    prompt: "Find your name", query: $query,
                    accessibilityId: "login-search",
                    onClear: { query = "" }, title: "Find your name",
                    showsTitle: false, showsSearchIcon: true, focused: $searchFocused
                )
                .onChange(of: query) { _, _ in firstArrival = false }
            }
        }
        .padding(.bottom, Space.md)
    }

    private var welcomeCopy: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text("Welcome home.")
                .designText(.title)
                .foregroundStyle(DuskColors.ink)
                .accessibilityAddTraits(.isHeader)
            Text("A little help. A little more ease.")
                .designText(.label)
                .foregroundStyle(DuskColors.ink2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder private var pickerBody: some View {
        switch pickerState {
        case .loading:
            AsyncNotice(kind: .loading, title: "Making room for everyone.", detail: "Loading your profiles…")
                .accessibilityIdentifier("login-loading")
        case .error(let message):
            AsyncNotice(kind: .error, title: "Let's reconnect.", detail: message, retry: onReload)
                .accessibilityIdentifier("login-error")
        case .empty:
            AsyncNotice(kind: .empty, title: "A new beginning.", detail: "Ask your Sentient administrator to set up your account.", retry: onReload)
                .accessibilityIdentifier("login-empty")
        case .ready:
            if filteredUsers.isEmpty {
                VStack(spacing: Space.sm) {
                    Text("No matching names.").designText(.body)
                    Text("Try a different spelling.").designText(.label)
                    DesignTextButton(title: "Clear search") { query = ""; searchFocused = true }
                }
                .foregroundStyle(DuskColors.ink2)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Space.xl)
                .accessibilityIdentifier("login-no-matches")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(filteredUsers.enumerated()), id: \.element.userId) { index, user in
                        profileRow(user, isLast: index == filteredUsers.count - 1)
                            .modifier(LoginArrival(revealed: isRevealed, index: index, animated: firstArrival))
                    }
                }
            }
        }
    }

    private func profileRow(_ user: AuthUserLite, isLast: Bool) -> some View {
        Button { changePhase(to: user) } label: {
            HStack(spacing: LoginLayout.profileGap) {
                avatar(user, size: LoginLayout.profileAvatar)
                    .background(avatarMeasurement(user.userId))
                    .opacity(flightUser?.userId == user.userId ? 0 : 1)
                    .accessibilityHidden(true)
                Text(user.displayName)
                    .designText(.body)
                    .foregroundStyle(DuskColors.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                Image(systemName: "chevron.forward")
                    .font(.system(size: 14))
                    .foregroundStyle(DuskColors.ink3)
                    .accessibilityHidden(true)
            }
            .padding(.vertical, LoginLayout.rowVerticalPadding)
            .padding(.trailing, Space.sm)
            .frame(minHeight: LoginLayout.rowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(LoginProfileButtonStyle())
        .overlay(alignment: .bottom) {
            if !isLast { DuskColors.lineSoft.frame(height: DesignMetrics.hairline) }
        }
        .accessibilityLabel("Continue as \(user.displayName)")
        .accessibilityIdentifier("login-avatar-\(user.userId)")
        .accessibilityFocused($accessibilityFocus, equals: .profile(user.userId))
    }

    private func pinEntry(_ user: AuthUserLite) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.lg) {
                Button {
                    // Invalidate the request at the tap, not after the exit animation.
                    onCancel()
                    changePhase(to: nil)
                } label: {
                    Label("Everyone", systemImage: "arrow.backward")
                        .designText(.label)
                        .foregroundStyle(DuskColors.ink2)
                        .frame(minHeight: DesignMetrics.minimumTarget)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("login-back")
                HStack(alignment: .center, spacing: LoginLayout.profileGap) {
                    avatar(user, size: LoginLayout.pinAvatar)
                        .background {
                            if flightUser != nil && !flightStarted {
                                avatarMeasurement(LoginLayout.pinAnchor, in: LoginLayout.stageCoordinateSpace)
                            }
                        }
                        .opacity(flightUser != nil ? 0 : 1)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: Space.xs) {
                        Text("Hello, \(user.displayName).")
                            .designText(.title)
                            .foregroundStyle(DuskColors.ink)
                            .accessibilityAddTraits(.isHeader)
                            .accessibilityFocused($accessibilityFocus, equals: .pin)
                        Text("Enter your four-digit PIN.")
                            .designText(.label)
                            .foregroundStyle(DuskColors.ink2)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.bottom, Space.sm)
                PinPad(
                    entered: entered, isSubmitting: isSubmitting, error: error,
                    success: success, errorRevision: feedbackRevision,
                    onDigit: { if !transitioning && isRevealed { onDigit($0) } },
                    onDelete: { if !transitioning && isRevealed { onDelete() } }
                )
                .frame(maxWidth: .infinity)
                DesignTextButton(title: "Need help signing in?", accessibilityId: "login-help") {
                    showHelp = true
                }
                .frame(maxWidth: .infinity)
            }
            .padding(.top, Space.xs)
            .padding(.bottom, Space.md)
        }
    }

    private func avatar(_ user: AuthUserLite, size: CGFloat) -> some View {
        ElevatedUserAvatar(name: user.displayName, size: size, tint: DesignUserAvatarTint(serverValue: user.avatarTint))
            // The badge is fixed-size artwork; the adjacent full name scales.
            // Do not let Dynamic Type grow initials outside the canonical face.
            .dynamicTypeSize(.large)
    }

    private func avatarMeasurement(_ key: String, in coordinateSpace: String = LoginLayout.coordinateSpace) -> some View {
        GeometryReader { geometry in
            Color.clear.preference(key: LoginAvatarFrames.self, value: [key: geometry.frame(in: .named(coordinateSpace))])
        }
    }

    private func changePhase(to user: AuthUserLite?) {
        guard !transitioning else { return }
        let previousID = selectedUser?.userId
        searchFocused = false
        firstArrival = false
        resetMotion()
        pendingFocus = user == nil ? previousID.map(LoginFocus.profile) : .pin
        guard !reduceMotion else {
            var transaction = Transaction(animation: nil)
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                if let user { onSelect(user) } else { onBack() }
                accessibilityFocus = pendingFocus
            }
            return
        }
        transitioning = true
        entranceFinished = false
        let revision = motionRevision
        if let user, let origin = avatarFrames[user.userId], origin.width > 0 {
            flightUser = user
            flightRect = origin
        }
        // The clone exists throughout the exit. Completion, not a timer or yield,
        // hands off to the new stage's native insertion transition.
        withAnimation(.easeInOut(duration: LoginMotion.exitDuration), completionCriteria: .removed) {
            stageOpacity = 0
            stageOffset = -6 * direction
        } completion: {
            guard motionRevision == revision else { return }
            withAnimation(LoginMotion.entrance, completionCriteria: .removed) {
                stageOpacity = 1
                stageOffset = 0
                if let user { onSelect(user) } else { onBack() }
            } completion: {
                guard motionRevision == revision else { return }
                entranceFinished = true
                // If no usable target was laid out, reveal the real identity
                // rather than leaving input locked waiting for geometry.
                if !flightStarted { flightUser = nil }
                finishMotionIfReady()
            }
        }
    }

    private func startAvatarFlightIfReady(_ frames: [String: CGRect]) {
        guard flightUser != nil, !flightStarted, selectedUser != nil,
              let target = frames[LoginLayout.pinAnchor], target.width > 0,
              let stage = frames[LoginLayout.stageAnchor] else { return }
        flightStarted = true
        let revision = motionRevision
        // Measure inside the untransformed stage, then translate by its resting
        // container origin. Entrance/exit offsets never enter the destination.
        let resting = target.offsetBy(dx: stage.minX, dy: stage.minY)
        withAnimation(LoginMotion.avatar, completionCriteria: .removed) {
            flightRect = resting
        } completion: {
            guard motionRevision == revision else { return }
            flightUser = nil
            finishMotionIfReady()
        }
    }

    private func finishMotionIfReady() {
        guard entranceFinished, flightUser == nil else { return }
        transitioning = false
        accessibilityFocus = pendingFocus
    }

    private func resetMotion() {
        // Animation completions can still arrive after dismissal/settings.
        motionRevision += 1
        var transaction = Transaction(animation: nil)
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            flightUser = nil
            flightStarted = false
            transitioning = false
            entranceFinished = false
            pendingFocus = nil
            stageOpacity = 1
            stageOffset = 0
        }
    }
}

private enum LoginFocus: Hashable { case profile(String), pin }

private enum LoginLayout {
    // Mobile source geometry; shared material/control/type metrics remain canonical.
    static let horizontalPadding: CGFloat = 22
    static let maximumWidth: CGFloat = 520
    static let assistantSize: CGFloat = 64
    static let profileAvatar: CGFloat = 44
    static let pinAvatar: CGFloat = 56
    static let profileGap: CGFloat = 14
    static let rowVerticalPadding: CGFloat = 9
    static let rowHeight: CGFloat = 64
    static let listFade: CGFloat = 10
    static let coordinateSpace = "login-arrival"
    static let pinAnchor = "pin-identity"
    static let stageAnchor = "stage-container"
    static let stageCoordinateSpace = "login-stage"
}

private struct LoginAvatarFrames: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, latest in latest })
    }
}

private struct LoginProfileButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.background(configuration.isPressed ? DuskColors.bgSunk : .clear)
    }
}

private struct LoginHelpSheet: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.xl) {
                    Text("Forgotten your PIN? Ask the person who manages your Sentient accounts to reset it.")
                        .designText(.body)
                        .foregroundStyle(DuskColors.ink2)
                    DesignActionButton(title: "Got it") { dismiss() }
                }
                .padding(Space.xl)
            }
            .background(DuskColors.bg)
            .navigationTitle("A little help.")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .duskTheme()
    }
}

#Preview("Large text") {
    LoginView().environment(\.dynamicTypeSize, .accessibility3)
}
