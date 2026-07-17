// ---------------------------------------------------------------------------
// VoiceFilterBarView — the Voice list filter row: search field + language select
// + source segmented control + tag chips. Mirrors the webui `VoiceFilterBar`
// (search / language Select / source Segmented / tag Chips). Reuses the settings
// `RowSegmented` + `RowSelect` primitives; the search field and tag chips are
// small local controls (no shared SearchField/Chip primitive exists on iOS yet).
//
// Stateless-ish leaf: a `query` Binding plus values + closures in, no VM, no I/O.
// ---------------------------------------------------------------------------
import SwiftUI

private let sourceOptions: [SegmentOption] = [
    SegmentOption(id: "all", label: "All"),
    SegmentOption(id: "builtin", label: "Built-in"),
    SegmentOption(id: "user", label: "Yours"),
]

struct VoiceFilterBarView: View {
    @Binding var query: String
    let source: String
    let selectedTags: [String]
    let tagOptions: [String]
    let language: String
    let languageOptions: [(code: String, label: String)]
    let onSource: (String) -> Void
    let onToggleTag: (String) -> Void
    let onLanguage: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            searchField
            RowSelect(
                label: "Language",
                options: languageOptions.map { SelectOption(id: $0.code, label: $0.label) },
                selectedId: language,
                accessibilityId: "settings-voice-language",
                onSelect: onLanguage
            )
            RowSegmented(
                options: sourceOptions,
                selectedId: source,
                accessibilityId: "settings-voice-source",
                onSelect: onSource
            )
            if !tagOptions.isEmpty {
                tagChips
            }
        }
    }

    private var searchField: some View {
        HStack(spacing: Space.sm) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: TypeScale.sm))
                .foregroundStyle(DuskColors.ink3)
            TextField("Search voices", text: $query)
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("settings-voice-search")
        }
        .padding(.horizontal, Space.md)
        .padding(.vertical, Space.sm)
        .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
        .overlay(RoundedRectangle(cornerRadius: Radii.sm).stroke(DuskColors.lineSoft, lineWidth: 1))
    }

    private var tagChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Space.xs) {
                ForEach(tagOptions, id: \.self) { tag in
                    let isOn = selectedTags.contains(tag)
                    Button { onToggleTag(tag) } label: {
                        Text(tag)
                            .font(Typo.ui(TypeScale.xs, .medium))
                            .foregroundStyle(isOn ? DuskColors.bg : DuskColors.ink2)
                            .padding(.horizontal, Space.sm)
                            .padding(.vertical, Space.xs)
                            .background(isOn ? DuskColors.accent : DuskColors.bgElev, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("settings-voice-tag-\(tag)")
                }
            }
        }
    }
}

#Preview {
    VoiceFilterBarView(
        query: .constant(""),
        source: "all",
        selectedTags: ["male"],
        tagOptions: ["male", "female", "calm", "bright"],
        language: "en",
        languageOptions: [("", "All languages"), ("en", "🇺🇸 English"), ("zh", "🇨🇳 Chinese")],
        onSource: { _ in },
        onToggleTag: { _ in },
        onLanguage: { _ in }
    )
    .padding(Space.lg)
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
