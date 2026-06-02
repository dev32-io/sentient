// ---------------------------------------------------------------------------
// LoginView — the avatar-grid → PIN-pad login flow.
//
// Owns a login-scoped @StateObject AuthModel (UI state only). The app-level
// SdkStore stays the single SDK store; LoginView passes its connect() into the
// model so a successful login → token save → sdkStore.connect(). Navigation to
// chat is event-driven in RootView off the SDK status, not modelled here.
//
// pickUser shows the avatar grid; enterPin shows the selected name + PinPad +
// the `login-error` text on a bad PIN. Users load once via .task. A Back button
// in the PIN phase returns to the grid (one back target per the nav rule).
// ---------------------------------------------------------------------------
import SwiftUI
import MobileSdk

struct LoginView: View {
    /// Called to start the SDK connection after a successful login + token save.
    let onConnect: () -> Void

    @StateObject private var model: AuthModel

    init(onConnect: @escaping () -> Void) {
        self.onConnect = onConnect
        _model = StateObject(wrappedValue: AuthModel(connect: onConnect))
    }

    var body: some View {
        ZStack {
            switch model.phase {
            case .pickUser: userGrid
            case .enterPin: pinEntry
            }
        }
        .padding(Space.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .duskTheme()
        .task { await model.loadUsers() }
    }

    // ── Avatar grid ───────────────────────────────────────────────────────────

    private var userGrid: some View {
        VStack(spacing: Space.xl) {
            if model.isLoadingUsers && model.users.isEmpty {
                ProgressView()
                    .accessibilityIdentifier("login-loading")
            } else {
                Text("Who's here?")
                    .font(.system(size: TypeScale.xl, weight: .semibold))
                    .foregroundStyle(DuskColors.ink)
                LazyVGrid(columns: gridColumns, spacing: Space.lg) {
                    ForEach(model.users, id: \.userId) { user in
                        AvatarTile(user: user, onTap: { model.select(user) })
                    }
                }
                errorText
            }
        }
    }

    private var gridColumns: [GridItem] {
        [GridItem(.adaptive(minimum: 96), spacing: Space.lg)]
    }

    // ── PIN entry ───────────────────────────────────────────────────────────────

    private var pinEntry: some View {
        VStack(spacing: Space.xl) {
            backButton
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

    private var backButton: some View {
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
