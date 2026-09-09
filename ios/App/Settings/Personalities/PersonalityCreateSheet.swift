// ---------------------------------------------------------------------------
// PersonalityCreateSheet — the "New personality" form presented over the
// Personalities page: a name field (immutable once created) + an instructions
// mono editor + a Create action. The Create button hands the values to the
// owner's async callback (which runs the create FSM) and the owner dismisses on
// success. Stateless w.r.t. the VM: local field state only + one closure out.
// ---------------------------------------------------------------------------
import SwiftUI

struct PersonalityCreateSheet: View {
    let isBusy: Bool
    let error: String?
    let onCreate: (String, String) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var body_ = ""
    @FocusState private var nameFocused: Bool

    private var canCreate: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isBusy
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.lg) {
                    if let error {
                        AsyncNotice(kind: .error, title: "Couldn't create personality", detail: error)
                            .accessibilityIdentifier("settings-personalities-new-error")
                    }
                    Text("Choose a name and describe how this personality should behave. The name cannot be changed after creation.")
                        .designText(.supporting)
                        .foregroundStyle(DuskColors.ink2)
                    field
                    DesignMultilineEditor(
                        title: "Instructions",
                        text: $body_,
                        placeholder: "How this personality should behave…",
                        accessibilityId: "settings-personalities-new-body"
                    )
                }
                .padding(Space.lg)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
            .background(DuskColors.bg)
            .navigationTitle("New personality")
            .navigationBarTitleDisplayMode(.inline)
            .accessibilityIdentifier("settings-personalities-create-sheet")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .accessibilityIdentifier("settings-personalities-new-cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { Task { await onCreate(name, body_) } }
                        .disabled(!canCreate)
                        .accessibilityIdentifier("settings-personalities-new-submit")
                }
            }
            .duskTheme()
        }
    }

    private var field: some View {
        DesignField(
            title: "Name",
            prompt: "e.g. Focused",
            text: $name,
            accessibilityId: "settings-personalities-new-name",
            focused: $nameFocused
        )
        .textInputAutocapitalization(.words)
        .autocorrectionDisabled()
        .task { nameFocused = true }
    }
}

#Preview {
    PersonalityCreateSheet(isBusy: false, error: nil, onCreate: { _, _ in })
        .preferredColorScheme(.dark)
}
