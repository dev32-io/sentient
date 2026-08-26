import SwiftUI

private let memberPinLength = 4

func addMemberValidationError(name: String, pin: String) -> String? {
    guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        return "Enter a display name."
    }
    guard pin.count == memberPinLength else { return "Enter a four-digit PIN." }
    return nil
}

struct AddMemberSheet: View {
    let adding: Bool
    let error: String?
    let onSubmit: (String, String) async -> Bool

    @State private var name = ""
    @State private var pin = ""
    @Environment(\.dismiss) private var dismiss

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var validation: String? { addMemberValidationError(name: name, pin: pin) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.lg) {
                    Text("Create a new member of this household.")
                        .designText(.body)
                        .foregroundStyle(DuskColors.ink3)
                    DesignField(
                        title: "Display name",
                        prompt: "Their name",
                        text: $name,
                        error: name.isEmpty ? nil : validation == "Enter a display name." ? validation : nil,
                        accessibilityId: "settings-members-add-name"
                    )
                    DesignMaskedField(
                        title: "PIN",
                        prompt: "Four digits",
                        text: sanitizedPin,
                        error: pin.isEmpty ? nil : validation == "Enter a four-digit PIN." ? validation : nil,
                        accessibilityId: "settings-members-add-pin",
                        keyboard: .numberPad
                    )
                    if let error {
                        AsyncNotice(kind: .error, title: "Couldn't add member", detail: error)
                            .accessibilityIdentifier("settings-members-add-error")
                    }
                    if adding { DesignProgress(title: "Adding member") }
                }
                .padding(Space.lg)
            }
            .background(DuskColors.bg)
            .navigationTitle("Add member")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier("settings-members-add-cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        Task { if await onSubmit(trimmedName, pin) { dismiss() } }
                    }
                    .disabled(validation != nil || adding)
                    .accessibilityIdentifier("settings-members-add-submit")
                }
            }
            .duskTheme()
        }
    }

    private var sanitizedPin: Binding<String> {
        Binding(
            get: { pin },
            set: { pin = String($0.filter(\.isNumber).prefix(memberPinLength)) }
        )
    }
}

#Preview("Error — large text") {
    AddMemberSheet(adding: false, error: "Household is full", onSubmit: { _, _ in false })
        .environment(\.dynamicTypeSize, .accessibility3)
}
