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
        VStack(alignment: .leading, spacing: Space.sm) {
            DesignSearchField(
                prompt: "Search voices", query: $query,
                accessibilityId: "settings-voice-search",
                onClear: { query = "" }, showsTitle: false, showsSearchIcon: true
            )
            CenteredFlowLayout(spacing: Space.sm, alignment: .leading) {
                DesignMenuButton(
                    accessibilityLabel: source == "all" ? "Source" : "Source: \(sourceLabel)",
                    accessibilityId: "settings-voice-source"
                ) {
                    ForEach(visibleSources, id: \.value) { option in
                        Button { onSource(option.value) } label: {
                            menuOption(option.label, selected: source == option.value)
                        }
                    }
                } label: {
                    VoiceLibraryMenuLabel(title: source == "all" ? "Source" : "Source: \(sourceLabel)", selected: source != "all")
                }

                DesignMenuButton(
                    accessibilityLabel: language.isEmpty ? "Language" : "Language: \(VoiceLanguages.label(for: language))",
                    accessibilityId: "settings-voice-language"
                ) {
                    ForEach(visibleLanguages, id: \.code) { option in
                        Button { onLanguage(option.code) } label: {
                            menuOption(option.label, selected: language == option.code)
                        }
                    }
                } label: {
                    VoiceLibraryMenuLabel(title: language.isEmpty ? "Language" : "Language: \(VoiceLanguages.label(for: language))", selected: !language.isEmpty)
                }

                DesignMenuButton(
                    accessibilityLabel: selectedTags.isEmpty ? "Tags" : "Tags: \(selectedTags.count)",
                    accessibilityId: "settings-voice-tags"
                ) {
                    ForEach(visibleTags, id: \.self) { tag in
                        Button { onToggleTag(tag) } label: {
                            menuOption(tag.replacingOccurrences(of: "-", with: " "), selected: selectedTags.contains(tag))
                        }
                        .accessibilityIdentifier("settings-voice-tag-\(tag)")
                    }
                } label: {
                    VoiceLibraryMenuLabel(title: selectedTags.isEmpty ? "Tags" : "Tags: \(selectedTags.count)", selected: !selectedTags.isEmpty)
                }
                .disabled(visibleTags.isEmpty)
            }
            .buttonStyle(DesignButtonStyle(role: .quiet, horizontalPadding: Space.sm))

            if selectedCount > 0 || !query.isEmpty {
                HStack(spacing: Space.sm) {
                    Text(selectedCount == 0 ? "Search applied" : "\(selectedCount) filters selected")
                        .font(DesignTextRole.supporting.font)
                        .foregroundStyle(DuskColors.ink2)
                    Spacer(minLength: Space.sm)
                    DesignActionButton(
                        title: "Clear all", role: .quiet,
                        accessibilityId: "settings-voice-clear-filters",
                        fillsWidth: false, action: clearAll
                    )
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func menuOption(_ title: String, selected: Bool) -> some View {
        if selected { Label(title, systemImage: "checkmark") }
        else { Text(title) }
    }

    private var visibleSources: [(value: String, label: String)] {
        guard !sourceOptions.contains(where: { $0.value == source }) else { return sourceOptions }
        return sourceOptions + [(value: source, label: source)]
    }

    private var sourceLabel: String {
        sourceOptions.first { $0.value == source }?.label ?? source
    }

    private var selectedCount: Int {
        selectedTags.count + (source == "all" ? 0 : 1) + (language.isEmpty ? 0 : 1)
    }

    private var visibleLanguages: [(code: String, label: String)] {
        guard !language.isEmpty, !languageOptions.contains(where: { $0.code == language }) else { return languageOptions }
        return languageOptions + [(code: language, label: VoiceLanguages.label(for: language))]
    }

    private func clearAll() {
        query = ""
        onSource("all")
        onLanguage("")
        for tag in selectedTags { onToggleTag(tag) }
    }

    private var visibleTags: [String] {
        Array(Set(tagOptions).union(selectedTags)).sorted {
            $0.localizedCaseInsensitiveCompare($1) == .orderedAscending
        }
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
