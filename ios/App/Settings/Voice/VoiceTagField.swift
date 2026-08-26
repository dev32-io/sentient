import SwiftUI

struct VoiceTagField: View {
    let tags: [String]
    let disabled: Bool
    let onChange: ([String]) -> Void
    @State private var draft = ""

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            DesignField(title: "Tags", prompt: "Add a tag", text: $draft, accessibilityId: "settings-voice-add-tag-input")
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onSubmit(addTag)
            DesignActionButton(
                title: "Add tag", role: .quiet, state: canAdd ? .normal : .disabled,
                accessibilityId: "settings-voice-add-tag-btn", action: addTag
            )
            if !tags.isEmpty {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: DesignMetrics.minimumTarget))], alignment: .leading, spacing: Space.xs) {
                    ForEach(tags, id: \.self) { tag in
                        DesignChip(title: "\(tag) ×", selected: true) { onChange(tags.filter { $0 != tag }) }
                            .accessibilityLabel("Remove tag \(tag)")
                            .accessibilityIdentifier("settings-voice-add-tag-chip-\(tag)")
                    }
                }
            }
        }
    }

    private var canAdd: Bool {
        !disabled && !normalizedDraft.isEmpty && tags.count < VoiceCaps.maxTags && !tags.contains(normalizedDraft)
    }

    private var normalizedDraft: String {
        String(draft.trimmingCharacters(in: .whitespaces).prefix(VoiceCaps.tagMax))
    }

    private func addTag() {
        guard canAdd else { return }
        onChange(tags + [normalizedDraft])
        draft = ""
    }
}

#Preview("Tags — long content") {
    VoiceTagField(tags: ["calm", "a deliberately long descriptive tag", "storytelling"], disabled: false, onChange: { _ in })
        .padding(Space.lg)
        .background(DuskColors.bg)
        .environment(\.dynamicTypeSize, .accessibility3)
        .preferredColorScheme(.dark)
}
