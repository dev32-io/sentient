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
    let onAuthenticatedUser: (String) -> Void
    let onConnect: () -> Void
    let onInitialUsersResolved: () -> Void
    var onOpenBackendSetup: () -> Void

    @StateObject private var model: AuthViewModel

    init(
        onAuthenticatedUser: @escaping (String) -> Void = { _ in },
        onConnect: @escaping () -> Void = {},
        onInitialUsersResolved: @escaping () -> Void = {},
        onOpenBackendSetup: @escaping () -> Void = {}
    ) {
        self.onAuthenticatedUser = onAuthenticatedUser
        self.onConnect = onConnect
        self.onInitialUsersResolved = onInitialUsersResolved
        self.onOpenBackendSetup = onOpenBackendSetup
        _model = StateObject(wrappedValue: AuthViewModel(
            connect: onConnect,
            onAuthenticatedUser: onAuthenticatedUser,
            onInitialUsersResolved: onInitialUsersResolved
        ))
    }

    var body: some View {
        ScrollView {
            VStack(spacing: Space.xl) {
                Spacer(minLength: Space.xxl)
                phaseContent
                Spacer(minLength: Space.xl)
            }
            .padding(.horizontal, Space.lg)
            .frame(maxWidth: .infinity, minHeight: DesignMetrics.minimumTarget)
        }
        .safeAreaInset(edge: .top) { navigationBar }
        .background(DuskColors.bg)
        .duskTheme()
        .task { await model.loadUsers() }
        .accessibilityIdentifier("login-screen")
    }

    @ViewBuilder
    private var phaseContent: some View {
        switch model.phase {
        case .pickUser: userPicker
        case .enterPin: pinEntry
        }
    }

    private var userPicker: some View {
        VStack(spacing: Space.xl) {
            Text("Who's using Sentient?")
                .designText(.title)
                .foregroundStyle(DuskColors.ink)
                .multilineTextAlignment(.center)
            pickerContent
        }
    }

    @ViewBuilder
    private var pickerContent: some View {
        switch loginPickerState(isLoading: model.isLoadingUsers, userCount: model.users.count, error: model.error) {
        case .loading:
            AsyncNotice(kind: .loading, title: "Loading household")
                .accessibilityIdentifier("login-loading")
        case .error(let error):
            AsyncNotice(kind: .error, title: "Couldn't load household", detail: error, retry: reloadUsers)
                .accessibilityIdentifier("login-error")
        case .empty:
            AsyncNotice(
                kind: .empty,
                title: "No members found",
                detail: "Add a household member on the gateway, then try again.",
                retry: reloadUsers
            )
            .accessibilityIdentifier("login-empty")
        case .ready:
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: DesignMetrics.dominantCardMinimumWidth, maximum: DesignMetrics.dominantCardMaximumWidth), spacing: Space.md)],
                spacing: Space.md
            ) {
                ForEach(model.users, id: \.userId) { user in
                    AvatarTile(user: user, onTap: { model.select(user) })
                }
            }
            .frame(maxWidth: .infinity)
        }
    }

    private var pinEntry: some View {
        DesignCard(bodyStyle: .padded) {
            VStack(spacing: Space.lg) {
                Text("Enter PIN for \(model.selectedUser?.displayName ?? "")")
                    .designText(.title)
                    .foregroundStyle(DuskColors.ink)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                PinPad(
                    entered: model.pin.count,
                    isSubmitting: model.isSubmitting,
                    error: model.error,
                    success: model.pinSuccess,
                    errorRevision: model.pinFeedbackRevision,
                    onDigit: { model.appendDigit($0) },
                    onDelete: { model.deleteDigit() }
                )
                .frame(maxWidth: .infinity)
            }
        }
    }

    private var navigationBar: some View {
        HStack {
            if model.phase == .enterPin {
                Button(action: model.back) {
                    Label("Back", systemImage: "chevron.left")
                        .frame(minHeight: DesignMetrics.minimumTarget)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("login-back")
            }
            Spacer()
            Button(action: onOpenBackendSetup) {
                Image(systemName: "gearshape")
                    .frame(width: DesignMetrics.minimumTarget, height: DesignMetrics.minimumTarget)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Backend settings")
            .accessibilityIdentifier("login-backend-setup")
        }
        .padding(.horizontal, Space.lg)
        .background(DuskColors.bg)
    }

    private func reloadUsers() {
        Task { await model.loadUsers() }
    }
}

#Preview("Large text") {
    LoginView()
        .environment(\.dynamicTypeSize, .accessibility3)
}
