import SwiftUI
import MobileData

struct MembersScreen: View {
    @State private var vm: MembersViewModel

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        _vm = State(initialValue: MembersViewModel(account: settings.account, admin: settings.admin))
    }

    var body: some View {
        @Bindable var bindable = vm
        MembersBody(
            access: vm.access,
            users: vm.users,
            meId: vm.meId,
            slotsFree: vm.slotsFree,
            canAdd: vm.canAdd,
            mutatingUserId: vm.mutatingUserId,
            mutationError: vm.mutationError,
            onRetry: { Task { await vm.load() } },
            onAdd: { vm.openAddSheet() },
            onToggleConfirmed: { user in Task { await vm.toggleAdmin(user) } },
            onDelete: { user in Task { await vm.deleteUser(user) } }
        )
        .task { await vm.load() }
        .sheet(isPresented: $bindable.isAddSheetOpen, onDismiss: { vm.closeAddSheet() }) {
            AddMemberSheet(
                adding: vm.isAdding,
                error: vm.addError,
                onSubmit: { name, pin in await vm.addUser(displayName: name, pin: pin) }
            )
            .presentationDetents([.medium, .large])
        }
    }
}

private struct MembersBody: View {
    let access: MembersViewModel.Access
    let users: [UserSummary]
    let meId: String
    let slotsFree: Int
    let canAdd: Bool
    let mutatingUserId: String?
    let mutationError: String?
    let onRetry: () -> Void
    let onAdd: () -> Void
    let onToggleConfirmed: (UserSummary) -> Void
    let onDelete: (UserSummary) -> Void

    @State private var pendingDelete: UserSummary?
    @State private var pendingToggle: UserSummary?

    var body: some View {
        SettingsPageScaffold(title: "Members", screenId: "settings-members-screen") {
            content
        }
        .confirmationDialog(deleteTitle, isPresented: deleteDialog, titleVisibility: .visible, presenting: pendingDelete) { user in
            Button("Remove member", role: .destructive) { onDelete(user) }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("This signs them out and removes their agent. This cannot be undone.")
        }
        .confirmationDialog(toggleTitle, isPresented: toggleDialog, titleVisibility: .visible, presenting: pendingToggle) { user in
            Button(user.isAdmin ? "Demote" : "Promote", role: user.isAdmin ? .destructive : nil) {
                onToggleConfirmed(user)
            }
            Button("Cancel", role: .cancel) {}
        } message: { user in
            Text(toggleMessage(for: user))
        }
    }

    @ViewBuilder private var content: some View {
        switch access {
        case .loading:
            AsyncNotice(kind: .loading, title: "Loading members")
        case .notAdmin:
            AsyncNotice(
                kind: .warning,
                title: "Admin access required",
                detail: "Your access may have changed. Return to Settings or retry after an administrator restores it.",
                retry: onRetry
            )
        case .error:
            AsyncNotice(kind: .error, title: "Couldn't load members", detail: "Check your connection and try again.", retry: onRetry)
        case .ready:
            if let mutationError {
                AsyncNotice(kind: .error, title: "Member change failed", detail: mutationError, retry: onRetry)
            }
            roster
        }
    }

    private var roster: some View {
        DesignPane(title: "Household", detail: "\(users.count) active · \(slotsFree) slot\(slotsFree == 1 ? "" : "s") free") {
            ForEach(users, id: \.userId) { user in
                MemberRow(
                    user: user,
                    isSelf: user.userId == meId,
                    isMutating: mutatingUserId == user.userId,
                    onToggle: { pendingToggle = user },
                    onDelete: { pendingDelete = user }
                )
                DesignDivider()
            }
            DesignActionButton(
                title: canAdd ? "Add member" : "Household is full",
                role: .quiet,
                state: canAdd ? .normal : .disabled,
                accessibilityId: "settings-members-add",
                action: onAdd
            )
        }
    }

    private var deleteTitle: String { pendingDelete.map { "Remove \($0.displayName)?" } ?? "Remove member?" }
    private var toggleTitle: String {
        guard let user = pendingToggle else { return "Change role?" }
        return user.isAdmin ? "Demote \(user.displayName)?" : "Promote \(user.displayName)?"
    }
    private var deleteDialog: Binding<Bool> {
        Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })
    }
    private var toggleDialog: Binding<Bool> {
        Binding(get: { pendingToggle != nil }, set: { if !$0 { pendingToggle = nil } })
    }
    private func toggleMessage(for user: UserSummary) -> String {
        user.isAdmin
            ? "This signs them out everywhere. Only another administrator can restore their access."
            : "This signs them out everywhere. They must sign in again to use administrator access."
    }
}

private struct MemberRow: View {
    let user: UserSummary
    let isSelf: Bool
    let isMutating: Bool
    let onToggle: () -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack(spacing: Space.md) {
            ElevatedUserAvatar(name: user.displayName)
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(user.displayName).designText(.label).foregroundStyle(DuskColors.ink)
                Text(roleDescription).designText(.caption).foregroundStyle(DuskColors.ink3)
            }
            Spacer(minLength: Space.sm)
            if isMutating {
                DesignProgress()
            } else if !isSelf {
                DesignMenuButton(
                    accessibilityLabel: "Actions for \(user.displayName)",
                    accessibilityId: "settings-member-actions-\(user.userId)"
                ) {
                    Button(user.isAdmin ? "Demote" : "Promote", action: onToggle)
                        .accessibilityIdentifier("settings-member-toggle-\(user.userId)")
                    Button("Remove", role: .destructive, action: onDelete)
                        .accessibilityIdentifier("settings-member-delete-\(user.userId)")
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .frame(width: DesignMetrics.minimumTarget, height: DesignMetrics.minimumTarget)
                }
            }
        }
        .frame(minHeight: DesignMetrics.minimumTarget)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("settings-member-\(user.userId)")
    }

    private var roleDescription: String {
        "\(user.isAdmin ? "Admin" : "Member")\(isSelf ? " · you" : "")"
    }
}

private let memberPreviewUsers = [
    UserSummary(userId: "u1", displayName: "Kevin", isAdmin: true, avatarTint: "", port: 0, createdAt: ""),
    UserSummary(userId: "u2", displayName: "Sam", isAdmin: false, avatarTint: "", port: 0, createdAt: ""),
]

#Preview("Admin — large text") {
    NavigationStack {
        MembersBody(
            access: .ready, users: memberPreviewUsers, meId: "u1", slotsFree: 1, canAdd: true,
            mutatingUserId: nil, mutationError: nil, onRetry: {}, onAdd: {},
            onToggleConfirmed: { _ in }, onDelete: { _ in }
        )
    }
    .environment(\.dynamicTypeSize, .accessibility3)
}

#Preview("Not admin") {
    NavigationStack {
        MembersBody(
            access: .notAdmin, users: [], meId: "", slotsFree: 0, canAdd: false,
            mutatingUserId: nil, mutationError: nil, onRetry: {}, onAdd: {},
            onToggleConfirmed: { _ in }, onDelete: { _ in }
        )
    }
}
