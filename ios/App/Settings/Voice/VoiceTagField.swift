// ---------------------------------------------------------------------------
// VoiceTagField — the add-voice tag editor (add on submit, remove per chip),
// mirroring the webui TagEditor: capped at VoiceCaps.maxTags, each tag trimmed to
// VoiceCaps.tagMax, de-duplicated. Owns only its own input-draft text; the tag
// list is hoisted to the caller via `tags` + `onChange`.
// ---------------------------------------------------------------------------
import SwiftUI

struct VoiceTagField: View {
    let tags: [String]
    let disabled: Bool
    let onChange: ([String]) -> Void

    @State private var draft = ""

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text("Tags")
                .font(Typo.ui(TypeScale.sm, .medium))
                .foregroundStyle(DuskColors.ink)
            inputRow
            if !tags.isEmpty {
                chips
            }
        }
    }

    private var inputRow: some View {
        HStack(spacing: Space.sm) {
            TextField("Add a tag", text: $draft)
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onSubmit(addTag)
                .accessibilityIdentifier("settings-voice-add-tag-input")
            Button("Add", action: addTag)
                .font(Typo.ui(TypeScale.sm, .semibold))
                .foregroundStyle(canAdd ? DuskColors.accent : DuskColors.ink4)
                .disabled(!canAdd)
                .accessibilityIdentifier("settings-voice-add-tag-btn")
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm)
        .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
        .overlay(RoundedRectangle(cornerRadius: Radii.sm).stroke(DuskColors.lineSoft, lineWidth: 1))
    }

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Space.xs) {
                ForEach(tags, id: \.self) { tag in
                    HStack(spacing: Space.xs) {
                        Text(tag).font(Typo.ui(TypeScale.xs, .medium))
                        Image(systemName: "xmark").font(.system(size: TypeScale.xs))
                    }
                    .foregroundStyle(DuskColors.ink)
                    .padding(.horizontal, Space.sm)
                    .padding(.vertical, Space.xs)
                    .background(DuskColors.bgElev, in: Capsule())
                    .onTapGesture { onChange(tags.filter { $0 != tag }) }
                    .accessibilityIdentifier("settings-voice-add-tag-chip-\(tag)")
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

#Preview {
    VoiceTagField(tags: ["male", "calm"], disabled: false, onChange: { _ in })
        .padding(Space.lg)
        .background(DuskColors.bg)
        .preferredColorScheme(.dark)
}
