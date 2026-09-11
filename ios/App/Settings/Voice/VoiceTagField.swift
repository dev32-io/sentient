import SwiftUI

struct VoiceTagField: View {
    let tags: [String]
    let disabled: Bool
    let onChange: ([String]) -> Void
    @Binding var draft: String

    private static let suggestions = ["warm", "calm", "deep", "bright", "family", "kids", "news", "soft"]

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            if !tags.isEmpty {
                tagFlow(title: "Selected tags", values: tags, selected: true)
            }
            if !availableSuggestions.isEmpty {
                tagFlow(title: "Suggested tags", values: availableSuggestions, selected: false)
            }
            VStack(alignment: .leading, spacing: Space.sm) {
                DesignField(
                    title: tags.count >= VoiceCaps.maxTags ? "Tags (maximum \(VoiceCaps.maxTags))" : "Add a tag",
                    prompt: tags.count >= VoiceCaps.maxTags ? "Maximum reached" : "Type a tag",
                    text: $draft,
                    accessibilityId: "settings-voice-add-tag-input",
                    isEnabled: !disabled && tags.count < VoiceCaps.maxTags
                )
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onSubmit(addTag)
                DesignActionButton(
                    title: "Add tag", role: .quiet, state: canAdd ? .normal : .disabled,
                    accessibilityId: "settings-voice-add-tag-btn", action: addTag
                )
            }
        }
    }

    private func tagFlow(title: String, values: [String], selected: Bool) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(title)
                .designText(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(DuskColors.ink2)
            CenteredFlowLayout(spacing: Space.xs, alignment: .leading) {
                ForEach(values, id: \.self) { tag in
                    DesignChip(
                        title: selected ? "\(tag) ×" : tag,
                        selected: selected,
                        isEnabled: !disabled && (selected || tags.count < VoiceCaps.maxTags),
                        accessibilityId: selected ? "settings-voice-add-tag-chip-\(tag)" : nil,
                        action: {
                            if selected { removeTag(tag) }
                            else { addTag(tag) }
                        }
                    )
                    .accessibilityLabel(selected ? "Remove tag \(tag)" : "Add tag \(tag)")
                }
            }
        }
    }

    private var availableSuggestions: [String] {
        let selected = Set(tags.map { $0.lowercased() })
        return Self.suggestions.filter { !selected.contains($0.lowercased()) }
    }

    private var canAdd: Bool {
        canAdd(normalizedDraft)
    }

    private var normalizedDraft: String {
        normalized(draft)
    }

    private func normalized(_ value: String) -> String {
        String(value.trimmingCharacters(in: .whitespaces).prefix(VoiceCaps.tagMax))
    }

    private func canAdd(_ value: String) -> Bool {
        !disabled && !value.isEmpty && tags.count < VoiceCaps.maxTags &&
            !tags.contains { $0.caseInsensitiveCompare(value) == .orderedSame }
    }

    private func addTag() {
        addTag(normalizedDraft)
    }

    private func addTag(_ value: String) {
        let value = normalized(value)
        guard canAdd(value) else { return }
        onChange(tags + [value])
        draft = ""
    }

    private func removeTag(_ tag: String) {
        onChange(tags.filter { $0 != tag })
    }
}

#Preview("Tags — long content") {
    @Previewable @State var draft = ""
    VoiceTagField(tags: ["calm", "a deliberately long descriptive tag", "storytelling"], disabled: false, onChange: { _ in }, draft: $draft)
        .padding(Space.lg)
        .background(DuskColors.bg)
        .environment(\.dynamicTypeSize, .accessibility3)
        .preferredColorScheme(.dark)
}
