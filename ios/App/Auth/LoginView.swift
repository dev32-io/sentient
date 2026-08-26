// ---------------------------------------------------------------------------
// LoginView — the avatar-grid → PIN-pad login flow.
//
// Owns a login-scoped @StateObject AuthViewModel (UI state only). AppConfig drives
// login-vs-chat; the authenticated server userId is passed to the app/session
// boundary explicitly after a successful response.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct LoginView: View {
    /// Called after the server returns AuthUser.userId and the token is saved.
    let onAuthenticatedUser: (String) -> Void
    /// Legacy connect hook retained as the session-start trigger.
    let onConnect: () -> Void
    /// Initial list success, empty, or actionable error makes login revealable.
    let onInitialUsersResolved: () -> Void
    /// Called when the user taps the gear to open backend setup.
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
        phaseContent
            .padding(Space.xl)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: .topLeading) { backBar }
            .overlay(alignment: .topTrailing) {
                Button { onOpenBackendSetup() } label: {
                    Image(systemName: "gearshape")
                        .foregroundStyle(DuskColors.ink3)
                }
                .padding()
                .accessibilityIdentifier("login-backend-setup")
            }
            .duskTheme()
            .task { await model.loadUsers() }
    }

    // ── Avatar grid / PIN entry ────────────────────────────────────────────────

    @ViewBuilder
    private var phaseContent: some View {
        switch model.phase {
        case .pickUser: userGrid
        case .enterPin: pinEntry
        }
    }

    private var userGrid: some View {
        VStack(spacing: Space.xl) {
            if model.isLoadingUsers && model.users.isEmpty {
                ProgressView()
                    .accessibilityIdentifier("login-loading")
            } else {
                Text("Who's here?")
                    .font(.system(size: TypeScale.xl, weight: .semibold))
                    .foregroundStyle(DuskColors.ink)
                CenteredFlowLayout(spacing: Space.lg) {
                    ForEach(model.users, id: \.userId) { user in
                        AvatarTile(user: user, onTap: { model.select(user) })
                    }
                }
                errorText
            }
        }
    }

    private var pinEntry: some View {
        VStack(spacing: Space.xl) {
            Text(model.selectedUser?.displayName ?? "")
                .font(.system(size: TypeScale.xl, weight: .semibold))
                .foregroundStyle(DuskColors.ink)
            Text("Enter your PIN")
                .font(.system(size: TypeScale.base))
                .foregroundStyle(DuskColors.ink3)
            PinPad(
                entered: model.pin.count,
                onDigit: { model.appendDigit($0) },
                onDelete: { model.deleteDigit() }
            )
            errorText
        }
    }

    /// Top-leading nav bar — only in the PIN phase. It remains outside the
    /// vertically-centered PIN stack so it behaves as a navigation affordance.
    @ViewBuilder
    private var backBar: some View {
        if model.phase == .enterPin {
            HStack {
                Button(action: { model.back() }) {
                    Label("Back", systemImage: "chevron.left")
                        .font(.system(size: TypeScale.base))
                        .foregroundStyle(DuskColors.ink3)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("login-back")
                Spacer()
            }
            .padding(.horizontal, Space.lg)
            .padding(.vertical, Space.sm)
        }
    }

    // ── Error ───────────────────────────────────────────────────────────────────

    @ViewBuilder
    private var errorText: some View {
        if let error = model.error {
            Text(error)
                .font(.system(size: TypeScale.base))
                .foregroundStyle(DuskColors.stop)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("login-error")
        }
    }
}
