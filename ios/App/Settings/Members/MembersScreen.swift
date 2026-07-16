// ---------------------------------------------------------------------------
// MembersScreen — Admin "Members" category page. Household roster: avatar tint +
// name + role pill, per-member Promote/Demote + Delete (confirm), and Add user
// (name + PIN; disabled at the 3/3 slot cap). The self row hides its role/delete
// actions (self-demote guard, mirroring the webui members-pane).
//
// Owns the @Observable MembersViewModel via @State; MembersBody is stateless
// (previewable per Access state). Admin-gated: a non-admin sees a guard message.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct MembersScreen: View {
    @State private var vm: MembersViewModel
    private let onBack: () -> Void

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        self.onBack = onBack
        _vm = State(initialValue: MembersViewModel(
            account: settings.account,
            admin: settings.admin
        ))
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
            onAdd: { vm.openAddSheet() },
            onToggle: { user in Task { await vm.toggleAdmin(user) } },
            onDelete: { user in Task { await vm.deleteUser(user) } }
        )
        .task { await vm.load() }
        .sheet(isPresented: $bindable.isAddSheetOpen, onDismiss: { vm.closeAddSheet() }) {
            AddMemberSheet(
                adding: vm.isAdding,
                error: vm.addError,
                onSubmit: { name, pin in await vm.addUser(displayName: name, pin: pin) }
            )
        }
    }
}

/// Stateless roster body; owns only the transient delete-confirm target.
private struct MembersBody: View {
    let access: MembersViewModel.Access
    let users: [UserSummary]
    let meId: String
    let slotsFree: Int
    let canAdd: Bool
    let mutatingUserId: String?
    let onAdd: () -> Void
    let onToggle: (UserSummary) -> Void
    let onDelete: (UserSummary) -> Void

    @State private var pendingDelete: UserSummary?

    var body: some View {
        SettingsPageScaffold(title: "Members", screenId: "settings-members-screen") {
            content
        }
        .confirmationDialog(
            deleteTitle,
            isPresented: deleteDialogBinding,
            titleVisibility: .visible,
            presenting: pendingDelete
        ) { user in
            Button("Remove", role: .destructive) { onDelete(user) }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("This signs them out and removes their agent. This cannot be undone.")
        }
    }

    private var deleteTitle: String {
        pendingDelete.map { "Remove \($0.displayName)?" } ?? "Remove member?"
    }

    private var deleteDialogBinding: Binding<Bool> {
        Binding(get: { pendingDelete != nil }, set: { open in if !open { pendingDelete = nil } })
    }

    @ViewBuilder
    private var content: some View {
        switch access {
        case .loading:
            ProgressView().controlSize(.small).padding(.vertical, Space.md)
        case .notAdmin:
            guardMessage("Admin access is required to manage members.")
        case .error:
            guardMessage("Couldn't load members.")
        case .ready:
            roster
        }
    }

    private func guardMessage(_ text: String) -> some View {
        Text(text)
            .font(Typo.ui(TypeScale.sm))
            .foregroundStyle(DuskColors.ink3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, Space.md)
    }

    private var roster: some View {
        SettingsCard(title: "Household", sub: "\(users.count) active · \(slotsFree) slot\(slotsFree == 1 ? "" : "s") free") {
            ForEach(users, id: \.userId) { user in
                MemberRow(
                    user: user,
                    isSelf: user.userId == meId,
                    isMutating: mutatingUserId == user.userId,
                    onToggle: { onToggle(user) },
                    onDelete: { pendingDelete = user }
                )
            }
            Divider().overlay(DuskColors.lineSoft)
            addButton
        }
    }

    private var addButton: some View {
        Button(action: onAdd) {
            Label("Add user", systemImage: "plus")
                .font(Typo.ui(TypeScale.sm, .semibold))
                .foregroundStyle(canAdd ? DuskColors.accent : DuskColors.ink4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, Space.sm)
        }
        .buttonStyle(.plain)
        .disabled(!canAdd)
        .accessibilityIdentifier("settings-members-add")
    }
}

/// One roster row: avatar + name (+ "you") + role pill + actions (hidden for self).
private struct MemberRow: View {
    let user: UserSummary
    let isSelf: Bool
    let isMutating: Bool
    let onToggle: () -> Void
    let onDelete: () -> Void

    private static let avatarSize: CGFloat = 34

    var body: some View {
        HStack(spacing: Space.md) {
            avatar
            VStack(alignment: .leading, spacing: Space.xs) {
                HStack(spacing: Space.xs) {
                    Text(user.displayName).font(Typo.ui(TypeScale.sm, .medium)).foregroundStyle(DuskColors.ink)
                    if isSelf { Text("· you").font(Typo.ui(TypeScale.xs)).foregroundStyle(DuskColors.ink3) }
                }
                rolePill
            }
            Spacer(minLength: Space.sm)
            if isMutating {
                ProgressView().controlSize(.small)
            } else if !isSelf {
                actions
            }
        }
        .padding(.vertical, Space.sm)
        .accessibilityIdentifier("settings-member-\(user.userId)")
    }

    private var avatar: some View {
        Circle()
            .fill(colorFromHex(user.avatarTint) ?? DuskColors.bgElev)
            .frame(width: Self.avatarSize, height: Self.avatarSize)
            .overlay(
                Text(String(user.displayName.prefix(1)).uppercased())
                    .font(Typo.ui(TypeScale.sm, .semibold))
                    .foregroundStyle(DuskColors.ink)
            )
    }

    private var rolePill: some View {
        Text(user.isAdmin ? "Admin" : "Member")
            .font(Typo.ui(TypeScale.xs, .semibold))
            .foregroundStyle(user.isAdmin ? DuskColors.accent : DuskColors.ink3)
    }

    private var actions: some View {
        HStack(spacing: Space.md) {
            Button(user.isAdmin ? "Demote" : "Promote", action: onToggle)
                .font(Typo.ui(TypeScale.xs, .semibold))
                .foregroundStyle(DuskColors.ink2)
                .accessibilityIdentifier("settings-member-toggle-\(user.userId)")
            Button(action: onDelete) {
                Image(systemName: "trash").font(.system(size: TypeScale.sm))
            }
            .foregroundStyle(DuskColors.stop)
            .accessibilityIdentifier("settings-member-delete-\(user.userId)")
        }
    }
}

/// Parse "#RRGGBB" (or "RRGGBB") to a Color; nil on empty/malformed input.
private func colorFromHex(_ hex: String) -> Color? {
    let cleaned = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    guard cleaned.count == 6, let value = UInt32(cleaned, radix: 16) else { return nil }
    let red = Double((value >> 16) & 0xFF) / 255
    let green = Double((value >> 8) & 0xFF) / 255
    let blue = Double(value & 0xFF) / 255
    return Color(.sRGB, red: red, green: green, blue: blue, opacity: 1)
}

// ── Previews — roster states (no VM) ─────────────────────────────────────────

private let sampleUsers: [UserSummary] = [
    UserSummary(userId: "u1", displayName: "Kevin", isAdmin: true, avatarTint: "#7C5CFF", port: 0, createdAt: ""),
    UserSummary(userId: "u2", displayName: "Sam", isAdmin: false, avatarTint: "#3AA675", port: 0, createdAt: ""),
]

#Preview("ready") {
    NavigationStack {
        MembersBody(
            access: .ready, users: sampleUsers, meId: "u1", slotsFree: 1, canAdd: true,
            mutatingUserId: nil, onAdd: {}, onToggle: { _ in }, onDelete: { _ in }
        )
    }
    .preferredColorScheme(.dark)
}

#Preview("non-admin") {
    NavigationStack {
        MembersBody(
            access: .notAdmin, users: [], meId: "", slotsFree: 0, canAdd: false,
            mutatingUserId: nil, onAdd: {}, onToggle: { _ in }, onDelete: { _ in }
        )
    }
    .preferredColorScheme(.dark)
}
