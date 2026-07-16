// ---------------------------------------------------------------------------
// AccountScreen — User-group "Account" category page. Identity card (display
// name + inline Save; the usecase rolls the token so the drawer header updates)
// and Security card (Change PIN → masked sheet). NO sign-out here — logout stays
// the root danger row.
//
// Owns the @Observable AccountViewModel via @State; the stateless AccountBody
// takes bindings + closures so previews render every state with no VM. `onBack`
// is accepted (host contract) but the pushed page uses the system back button.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct AccountScreen: View {
    @State private var vm: AccountViewModel
    private let onBack: () -> Void

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        self.onBack = onBack
        _vm = State(initialValue: AccountViewModel(account: settings.account))
    }

    var body: some View {
        @Bindable var bindable = vm
        AccountBody(
            name: $bindable.draftName,
            isDirty: vm.isDirty,
            nameSave: vm.nameSave,
            pinError: vm.pinError,
            pinSaving: vm.pinSaving,
            pinSheetOpen: $bindable.isPinSheetOpen,
            onSaveName: { await vm.saveName() },
            onOpenPin: { vm.openPinSheet() },
            onClosePin: { vm.closePinSheet() },
            onChangePin: { current, new in await vm.changePin(current: current, new: new) }
        )
        .task { await vm.load() }
    }
}

/// Stateless Account body: identity + security cards. Bindings + closures only.
private struct AccountBody: View {
    @Binding var name: String
    let isDirty: Bool
    let nameSave: AccountViewModel.SaveState
    let pinError: String?
    let pinSaving: Bool
    @Binding var pinSheetOpen: Bool
    let onSaveName: () async -> Void
    let onOpenPin: () -> Void
    let onClosePin: () -> Void
    let onChangePin: (String, String) async -> Bool

    var body: some View {
        SettingsPageScaffold(title: "Account", screenId: "settings-account-screen") {
            SettingsCard(title: "Identity", sub: "How Sentient knows it's you.") {
                nameRow
                Divider().overlay(DuskColors.lineSoft)
                voicePrintRow
            }
            SettingsCard(title: "Security", sub: "Used for sensitive actions like unlocking doors or spending money.") {
                pinRow
            }
        }
        .sheet(isPresented: $pinSheetOpen, onDismiss: onClosePin) {
            ChangePinSheet(saving: pinSaving, error: pinError, onSubmit: onChangePin)
        }
    }

    private var nameRow: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text("Display name")
                .font(Typo.ui(TypeScale.sm, .medium))
                .foregroundStyle(DuskColors.ink)
            HStack(spacing: Space.sm) {
                TextField("Your name", text: $name)
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink)
                    .padding(.horizontal, Space.md)
                    .padding(.vertical, Space.sm)
                    .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
                    .overlay(RoundedRectangle(cornerRadius: Radii.sm).stroke(DuskColors.lineSoft, lineWidth: 1))
                    .accessibilityIdentifier("settings-account-name")
                saveButton
            }
        }
        .padding(.vertical, Space.sm)
    }

    @ViewBuilder
    private var saveButton: some View {
        switch nameSave {
        case .saving:
            ProgressView()
                .controlSize(.small)
                .frame(minWidth: 64)
        case .saved:
            Label("Saved", systemImage: "checkmark")
                .font(Typo.ui(TypeScale.sm, .semibold))
                .foregroundStyle(DuskColors.ok)
                .frame(minWidth: 64)
        case .idle, .failed:
            Button("Save") { Task { await onSaveName() } }
                .font(Typo.ui(TypeScale.sm, .semibold))
                .foregroundStyle(isDirty ? DuskColors.accent : DuskColors.ink4)
                .disabled(!isDirty)
                .accessibilityIdentifier("settings-account-save")
        }
    }

    private var voicePrintRow: some View {
        HStack(spacing: Space.lg) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text("Voice print")
                    .font(Typo.ui(TypeScale.sm, .medium))
                    .foregroundStyle(DuskColors.ink)
                Text("Used to recognize you when you speak.")
                    .font(Typo.ui(TypeScale.xs))
                    .foregroundStyle(DuskColors.ink3)
            }
            Spacer(minLength: Space.sm)
            ComingSoonBadge()
        }
        .padding(.vertical, Space.sm)
    }

    private var pinRow: some View {
        HStack(spacing: Space.lg) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text("PIN")
                    .font(Typo.ui(TypeScale.sm, .medium))
                    .foregroundStyle(DuskColors.ink)
                Text("4 digits. Required for sensitive actions.")
                    .font(Typo.ui(TypeScale.xs))
                    .foregroundStyle(DuskColors.ink3)
            }
            Spacer(minLength: Space.sm)
            Button("Change PIN") { onOpenPin() }
                .font(Typo.ui(TypeScale.sm, .semibold))
                .foregroundStyle(DuskColors.accent)
                .accessibilityIdentifier("settings-account-changepin")
        }
        .padding(.vertical, Space.sm)
    }
}

/// Small "Coming soon" pill for not-yet-shipped rows.
private struct ComingSoonBadge: View {
    var body: some View {
        Text("Coming soon")
            .font(Typo.ui(TypeScale.xs, .semibold))
            .foregroundStyle(DuskColors.ink3)
            .padding(.horizontal, Space.sm)
            .padding(.vertical, Space.xs)
            .background(DuskColors.bgElev, in: Capsule())
            .overlay(Capsule().stroke(DuskColors.lineSoft, lineWidth: 1))
    }
}

// ── Previews — Account body states (no VM / no SettingsComponent) ─────────────

#Preview("idle-clean") {
    NavigationStack {
        AccountBody(
            name: .constant("Kevin"), isDirty: false, nameSave: .idle,
            pinError: nil, pinSaving: false, pinSheetOpen: .constant(false),
            onSaveName: {}, onOpenPin: {}, onClosePin: {}, onChangePin: { _, _ in true }
        )
    }
    .preferredColorScheme(.dark)
}

#Preview("dirty-saving") {
    NavigationStack {
        AccountBody(
            name: .constant("Kevin Ye"), isDirty: true, nameSave: .saving,
            pinError: nil, pinSaving: false, pinSheetOpen: .constant(false),
            onSaveName: {}, onOpenPin: {}, onClosePin: {}, onChangePin: { _, _ in true }
        )
    }
    .preferredColorScheme(.dark)
}
