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
    let onCreate: (String, String) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var body_ = ""

    private var canCreate: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isBusy
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.lg) {
                    field
                    VStack(alignment: .leading, spacing: Space.sm) {
                        Text("Instructions")
                            .font(Typo.ui(TypeScale.sm, .medium))
                            .foregroundStyle(DuskColors.ink)
                        MonoEditor(
                            text: body_,
                            placeholder: "How this personality should behave…",
                            accessibilityId: "settings-personalities-new-body",
                            onChange: { body_ = $0 }
                        )
                    }
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
        VStack(alignment: .leading, spacing: Space.sm) {
            Text("Name")
                .font(Typo.ui(TypeScale.sm, .medium))
                .foregroundStyle(DuskColors.ink)
            TextField("e.g. Focused", text: $name)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .foregroundStyle(DuskColors.ink)
                .padding(Space.sm)
                .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
                .overlay(RoundedRectangle(cornerRadius: Radii.sm).stroke(DuskColors.lineSoft, lineWidth: 1))
                .accessibilityIdentifier("settings-personalities-new-name")
        }
    }
}

#Preview {
    PersonalityCreateSheet(isBusy: false, onCreate: { _, _ in })
        .preferredColorScheme(.dark)
}
