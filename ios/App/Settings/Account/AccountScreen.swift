import SwiftUI
import MobileData

struct AccountScreen: View {
    @State private var vm: AccountViewModel

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        _vm = State(initialValue: AccountViewModel(account: settings.account))
    }

    var body: some View {
        @Bindable var bindable = vm
        AccountBody(
            name: $bindable.draftName,
            loadState: vm.loadState,
            isDirty: vm.isDirty,
            nameSave: vm.nameSave,
            pinError: vm.pinError,
            pinSaving: vm.pinSaving,
            pinSheetOpen: $bindable.isPinSheetOpen,
            onLoad: { Task { await vm.load() } },
            onSaveName: { await vm.saveName() },
            onOpenPin: { vm.openPinSheet() },
            onClosePin: { vm.closePinSheet() },
            onChangePin: { current, new in await vm.changePin(current: current, new: new) }
        )
        .task { await vm.load() }
    }
}

private struct AccountBody: View {
    @Binding var name: String
    let loadState: AccountViewModel.LoadState
    let isDirty: Bool
    let nameSave: AccountViewModel.SaveState
    let pinError: String?
    let pinSaving: Bool
    @Binding var pinSheetOpen: Bool
    let onLoad: () -> Void
    let onSaveName: () async -> Void
    let onOpenPin: () -> Void
    let onClosePin: () -> Void
    let onChangePin: (String, String) async -> Bool

    var body: some View {
        SettingsPageScaffold(title: "Account", screenId: "settings-account-screen") {
            loadNotice
            if loadState == .ready {
                DesignPane(title: "Identity", detail: "How Sentient knows it's you.") {
                    DesignField(
                        title: "Display name",
                        prompt: "Your name",
                        text: $name,
                        error: saveError,
                        accessibilityId: "settings-account-name"
                    )
                    saveFeedback
                    DesignSettingsRow(
                        title: "Voice print",
                        detail: "Voice recognition isn't available yet."
                    ) {
                        Label("Coming soon", systemImage: "clock")
                            .designText(.supporting)
                            .foregroundStyle(DuskColors.ink3)
                    }
                }

                DesignPane(title: "Security", detail: "Used for sensitive household actions.") {
                    DesignSettingsRow(title: "PIN", detail: "Four digits") {
                        DesignTextButton(
                            title: "Change PIN",
                            accessibilityId: "settings-account-changepin",
                            action: onOpenPin
                        )
                    }
                }
            }
        }
        .sheet(isPresented: $pinSheetOpen, onDismiss: onClosePin) {
            ChangePinSheet(saving: pinSaving, error: pinError, onSubmit: onChangePin)
                .presentationDetents([.medium, .large])
        }
    }

    @ViewBuilder private var loadNotice: some View {
        switch loadState {
        case .loading:
            AsyncNotice(kind: .loading, title: "Loading account")
        case .failed(let message):
            AsyncNotice(kind: .error, title: "Couldn't load account", detail: message, retry: onLoad)
        case .ready:
            EmptyView()
        }
    }

    private var saveError: String? {
        if case .failed(let message) = nameSave { return message }
        return nil
    }

    @ViewBuilder private var saveFeedback: some View {
        switch nameSave {
        case .saved:
            AsyncNotice(kind: .success, title: "Display name saved")
        case .failed:
            DesignActionButton(
                title: "Try saving again",
                state: isDirty ? .normal : .disabled,
                accessibilityId: "settings-account-save",
                action: { Task { await onSaveName() } }
            )
        case .idle, .saving:
            DesignActionButton(
                title: "Save display name",
                state: nameSave == .saving ? .loading : isDirty ? .normal : .disabled,
                accessibilityId: "settings-account-save",
                action: { Task { await onSaveName() } }
            )
        }
    }
}

#Preview("Ready — large text") {
    NavigationStack {
        AccountBody(
            name: .constant("Kevin"), loadState: .ready, isDirty: true, nameSave: .idle,
            pinError: nil, pinSaving: false, pinSheetOpen: .constant(false),
            onLoad: {}, onSaveName: {}, onOpenPin: {}, onClosePin: {}, onChangePin: { _, _ in true }
        )
    }
    .environment(\.dynamicTypeSize, .accessibility3)
}

#Preview("Load failed") {
    NavigationStack {
        AccountBody(
            name: .constant(""), loadState: .failed("Check your connection."), isDirty: false, nameSave: .idle,
            pinError: nil, pinSaving: false, pinSheetOpen: .constant(false),
            onLoad: {}, onSaveName: {}, onOpenPin: {}, onClosePin: {}, onChangePin: { _, _ in false }
        )
    }
}
