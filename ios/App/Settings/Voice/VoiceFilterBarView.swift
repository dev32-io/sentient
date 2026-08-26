import SwiftUI

private let sourceOptions: [(value: String, label: String)] = [
    ("all", "All"),
    ("builtin", "Built-in"),
    ("user", "Yours"),
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
        SearchFilterRow(prompt: "Search voices", query: $query) {
            VStack(alignment: .leading, spacing: Space.md) {
                DesignSelect(
                    title: "Language",
                    options: languageOptions.map { (value: $0.code, label: $0.label) },
                    selection: Binding(get: { language }, set: onLanguage)
                )
                .accessibilityIdentifier("settings-voice-language")
                DesignSegmentedPicker(
                    title: "Source",
                    options: sourceOptions,
                    selection: Binding(get: { source }, set: onSource)
                )
                .accessibilityIdentifier("settings-voice-source")
                if !tagOptions.isEmpty {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: DesignMetrics.minimumTarget))], alignment: .leading, spacing: Space.xs) {
                        ForEach(tagOptions, id: \.self) { tag in
                            DesignChip(title: tag, selected: selectedTags.contains(tag)) { onToggleTag(tag) }
                                .accessibilityIdentifier("settings-voice-tag-\(tag)")
                        }
                    }
                }
            }
        }
        .accessibilityIdentifier("settings-voice-search")
    }
}

#Preview("Voice filters — accessibility size") {
    VoiceFilterBarView(
        query: .constant(""), source: "all", selectedTags: ["calm"],
        tagOptions: ["calm", "bright", "a deliberately long descriptive voice tag"],
        language: "en", languageOptions: [("", "All languages"), ("en", "🇺🇸 English")],
        onSource: { _ in }, onToggleTag: { _ in }, onLanguage: { _ in }
    )
    .padding(Space.lg)
    .background(DuskColors.bg)
    .environment(\.dynamicTypeSize, .accessibility3)
    .transaction { $0.disablesAnimations = true }
    .preferredColorScheme(.dark)
}
