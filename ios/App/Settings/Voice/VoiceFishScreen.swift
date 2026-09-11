// ---------------------------------------------------------------------------
// VoiceFishScreen — Voice sub-page "Clone from Fish", pushed from VoiceScreen only
// when `fishBrowseEnabled`. Title search + paged browse of the Fish library, play a
// remote sample, pick an entry to reveal a clone editor (name prefilled from the
// title), Clone → the VM posts `.voiceLibraryChanged` and this page pops. Mirrors
// the webui FishClonePanel; FeatureDisabled / upstream failures render inline.
//
// Screen-level view: owns its `VoiceFishViewModel` (rebuilt per route entry), reads
// state, dispatches actions. `onBack` pops; the host / Route.swift are untouched.
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct VoiceFishScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void
    let onOpenEditor: ((FishVoiceEntry) -> Void)?
    let editorEntry: FishVoiceEntry?

    @State private var vm: VoiceFishViewModel
    @State private var filtersExpanded = false

    init(settings: SettingsComponent, onBack: @escaping () -> Void, onOpenEditor: ((FishVoiceEntry) -> Void)? = nil, editorEntry: FishVoiceEntry? = nil) {
        self.settings = settings
        self.onBack = onBack
        self.onOpenEditor = onOpenEditor
        self.editorEntry = editorEntry
        _vm = State(initialValue: VoiceFishViewModel(settings: settings))
    }

    var body: some View {
        SettingsPageScaffold(
            title: "Clone from Fish", screenId: "settings-voice-fish",
            onBack: onBack, backAccessibilityId: "settings-voice-fish-back"
        ) {
            noticeBanner
            if vm.phase == .disabled {
                content
            } else if vm.selected != nil || editorEntry != nil {
                cloneEditor
            } else {
                browseHeader
                searchField
                filterDisclosure
                content
            }
        }
        .task {
            if let editorEntry { vm.select(editorEntry) }
            else { await vm.load() }
        }
        .onChange(of: vm.done) { _, done in if done { onBack() } }
        .onDisappear { vm.teardown() }
    }

    @ViewBuilder
    private var content: some View {
        switch vm.phase {
        case .loading:
            AsyncNotice(kind: .loading, title: "Loading the Fish library")
                .accessibilityIdentifier("settings-voice-fish-loading")
        case .disabled:
            inlineMessage("Cloning from Fish isn't available on this gateway.", id: "settings-voice-fish-disabled")
        case .failed:
            failureState
        case .loaded:
            if vm.filteredEntries.isEmpty {
                inlineMessage("No voices match your search.", id: "settings-voice-fish-empty")
                if vm.filterActive || vm.sort != .popular {
                    DesignActionButton(title: "Clear search and filters", role: .quiet, action: vm.resetFilters)
                }
                if vm.hasMore { loadMoreButton }
            } else {
                entryList
            }
        }
    }

    private var entryList: some View {
        LazyVStack(spacing: Space.sm) {
            ForEach(vm.filteredEntries, id: \.id) { entry in
                VoiceRowView(
                    name: entry.title,
                    lang: entry.languages.first ?? "",
                    source: nil,
                    facts: fishFacts(entry.tags),
                    description: entry.description_,
                    tags: fishVibes(entry.tags),
                    isPlaying: vm.playingId == entry.id,
                    playDisabled: entry.previewAudioUrl == nil,
                    accessory: .none,
                    accessibilityId: "settings-voice-fish-row-\(entry.id)",
                    onSelect: {
                        if let onOpenEditor {
                            onOpenEditor(entry)
                        } else {
                            vm.select(entry)
                        }
                    },
                    onPlay: { vm.toggleSample(entry) }
                )
            }
            if vm.hasMore { loadMoreButton }
        }
    }

    private var loadMoreButton: some View {
        DesignActionButton(
            title: "Load more", loadingTitle: "Loading more…", role: .quiet,
            state: vm.loadingMore ? .loading : .normal,
            accessibilityId: "settings-voice-fish-loadmore",
            action: vm.loadMore
        )
    }

    private var browseHeader: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text("Find a voice")
                .designText(.body)
                .fontWeight(.semibold)
                .foregroundStyle(DuskColors.ink)
                .accessibilityAddTraits(.isHeader)
            Text("Listen to a sample, then choose a voice to name and clone.")
                .designText(.caption)
                .foregroundStyle(DuskColors.ink2)
            if vm.phase == .loaded {
                Text("\(vm.filteredEntries.count) voices shown\(vm.hasMore ? " · More available" : "")")
                    .designText(.caption)
                    .foregroundStyle(DuskColors.ink2)
            }
        }
    }

    private var filterDisclosure: some View {
        DesignDisclosureGroup(isExpanded: filtersExpanded) {
            DesignDisclosureButton(
                isExpanded: filtersExpanded,
                accessibilityLabel: "Filters and sort",
                accessibilityId: "settings-voice-fish-filters",
                action: { filtersExpanded.toggle() }
            ) {
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text("Filters and sort").designText(.body).foregroundStyle(DuskColors.ink)
                    Text(vm.filterActive || vm.sort != .popular ? "Custom view" : "All languages · Popular first")
                        .designText(.caption).foregroundStyle(DuskColors.ink2)
                }
            }
        } content: {
            filterControls
        }
    }

    private var filterControls: some View {
        VStack(alignment: .leading, spacing: Space.md) {
            DesignSelect(
                title: "Language",
                options: VoiceLanguages.filterOptions(present: vm.filterLanguages + [vm.languageFilter])
                    .map { (value: $0.code, label: $0.label) },
                selection: $vm.languageFilter
            )
            .accessibilityIdentifier("settings-voice-fish-language")
            DesignSelect(
                title: "Sort",
                options: [(.popular, "Popular"), (.recent, "Recent"), (.az, "A–Z")],
                selection: $vm.sort
            )
            .accessibilityIdentifier("settings-voice-fish-sort")
            facetRow("Gender", vm.filterGenders, vm.selectedGenders, vm.toggleGender)
            facetRow("Age", vm.filterAges, vm.selectedAges, vm.toggleAge)
            facetRow("Vibe", vm.filterVibes, vm.selectedVibes, vm.toggleVibe)
            if vm.filterActive || vm.sort != .popular {
                DesignActionButton(title: "Clear filters", role: .quiet, accessibilityId: "settings-voice-fish-clear-filters", action: vm.resetFilters)
            }
        }
    }

    @ViewBuilder
    private func facetRow(_ label: String, _ options: [String], _ selected: [String], _ action: @escaping (String) -> Void) -> some View {
        let visibleOptions = Array(Set(options).union(selected)).sorted {
            $0.localizedCaseInsensitiveCompare($1) == .orderedAscending
        }
        if !visibleOptions.isEmpty {
            VStack(alignment: .leading, spacing: Space.xs) {
                DesignGroupHeader(title: label)
                CenteredFlowLayout(spacing: Space.xs, alignment: .leading) {
                    ForEach(visibleOptions, id: \.self) { value in
                        DesignChip(title: facetLabel(value), selected: selected.contains(value)) { action(value) }
                            .accessibilityIdentifier("settings-voice-fish-\(label.lowercased())-\(value)")
                    }
                }
            }
        }
    }

    private func facetLabel(_ value: String) -> String {
        let words = value.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
        return words.prefix(1).uppercased() + String(words.dropFirst())
    }

    private func fishFacts(_ tags: [String]) -> [String] {
        tags.filter { fishFactKeys.contains($0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) }.map(facetLabel)
    }

    private func fishVibes(_ tags: [String]) -> [String] {
        tags.filter { !fishFactKeys.contains($0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) }.map(facetLabel)
    }

    private var fishFactKeys: Set<String> {
        ["male", "female", "young", "middle-aged", "old"]
    }

    private var cloneEditor: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            if let entry = vm.selected ?? editorEntry {
                DesignPane(title: "Chosen voice", detail: "From the Fish library") {
                    Text(entry.title)
                        .designText(.body).fontWeight(.semibold).foregroundStyle(DuskColors.ink)
                    if !entry.description_.isEmpty {
                        Text(entry.description_).designText(.caption).foregroundStyle(DuskColors.ink2)
                    }
                    if !entry.languages.isEmpty {
                        Text(entry.languages.map { VoiceLanguages.label(for: $0) }.joined(separator: " · "))
                            .designText(.caption).foregroundStyle(DuskColors.ink2)
                    }
                }
            }
            DesignPane(title: "Make it yours", detail: "Choose how this voice appears in your library.") {
                DesignField(
                    title: "Name", prompt: "Voice name",
                    text: Binding(get: { vm.cloneName }, set: { vm.setCloneName($0) }),
                    accessibilityId: "settings-voice-fish-clone-name",
                    isEnabled: !vm.cloning
                )
                DesignSelect(
                    title: "Language",
                    options: VoiceLanguages.formOptions.map { (value: $0.code, label: $0.label) },
                    selection: $vm.cloneLanguage,
                    isEnabled: !vm.cloning
                )
                .accessibilityIdentifier("settings-voice-fish-clone-language")
            }
            DesignActionButton(
                title: "Clone voice",
                loadingTitle: "Cloning voice…",
                state: vm.cloning ? .loading : vm.canClone ? .normal : .disabled,
                accessibilityId: "settings-voice-fish-clone-submit",
                action: vm.clone
            )
            DesignActionButton(title: "Cancel", role: .quiet, accessibilityId: "settings-voice-fish-clone-cancel") {
                editorEntry == nil ? vm.cancelSelect() : onBack()
            }
        }
    }

    private var searchField: some View {
        SearchFilterRow(prompt: "Search the Fish library", query: $vm.query) { EmptyView() }
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityIdentifier("settings-voice-fish-search")
    }

    private var failureState: some View {
        VStack(spacing: Space.sm) {
            AsyncNotice(kind: .error, title: "Couldn't reach the Fish library")
            DesignActionButton(title: "Retry", role: .quiet, accessibilityId: "settings-voice-fish-retry") {
                Task { await vm.load() }
            }
        }
    }

    private func inlineMessage(_ text: String, id: String) -> some View {
        AsyncNotice(kind: .empty, title: text).accessibilityIdentifier(id)
    }

    @ViewBuilder
    private var noticeBanner: some View {
        if let notice = vm.notice {
            DesignDismissibleNotice(
                kind: .warning,
                title: notice,
                accessibilityId: "settings-voice-fish-notice",
                onDismiss: { vm.notice = nil }
            )
        }
    }
}

#Preview {
    NavigationStack {
        Text("VoiceFishScreen requires a live SettingsComponent")
            .font(Typo.ui(TypeScale.sm))
            .foregroundStyle(DuskColors.ink3)
            .padding(Space.lg)
    }
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
