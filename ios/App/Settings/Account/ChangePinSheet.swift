import SwiftUI

private let accountPinLength = 4

func pinChangeValidationError(current: String, newPin: String) -> String? {
    guard current.count == accountPinLength, newPin.count == accountPinLength else {
        return "Enter both four-digit PINs."
    }
    guard current != newPin else { return "Choose a different new PIN." }
    return nil
}

struct ChangePinSheet: View {
    let saving: Bool
    let error: String?
    let onSubmit: (String, String) async -> Bool

    @State private var current = ""
    @State private var newPin = ""
    @Environment(\.dismiss) private var dismiss

    private var validation: String? { pinChangeValidationError(current: current, newPin: newPin) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.lg) {
                    AsyncNotice(
                        kind: .warning,
                        title: "PINs stay private",
                        detail: "Enter your current PIN, then choose a different four-digit PIN."
                    )
                    DesignMaskedField(
                        title: "Current PIN",
                        prompt: "Four digits",
                        text: sanitized($current),
                        accessibilityId: "settings-account-pin-current",
                        keyboard: .numberPad,
                        autoFocus: true
                    )
                    DesignMaskedField(
                        title: "New PIN",
                        prompt: "Four digits",
                        text: sanitized($newPin),
                        error: current.count == accountPinLength ? validation : nil,
                        accessibilityId: "settings-account-pin-new",
                        keyboard: .numberPad
                    )
                    if let error {
                        AsyncNotice(kind: .error, title: "Couldn't change PIN", detail: error)
                            .accessibilityIdentifier("settings-account-pin-error")
                    }
                    if saving { DesignProgress(title: "Updating PIN") }
                }
                .padding(Space.lg)
            }
            .background(DuskColors.bg)
            .navigationTitle("Change PIN")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier("settings-account-pin-cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Update") {
                        Task { if await onSubmit(current, newPin) { dismiss() } }
                    }
                    .disabled(validation != nil || saving)
                    .accessibilityIdentifier("settings-account-pin-submit")
                }
            }
            .duskTheme()
        }
    }

    private func sanitized(_ binding: Binding<String>) -> Binding<String> {
        Binding(
            get: { binding.wrappedValue },
            set: { binding.wrappedValue = String($0.filter(\.isNumber).prefix(accountPinLength)) }
        )
    }
}

#Preview("Error — large text") {
    ChangePinSheet(saving: false, error: "Current PIN is wrong", onSubmit: { _, _ in false })
        .environment(\.dynamicTypeSize, .accessibility3)
}
