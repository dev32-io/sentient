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

    init(settings: SettingsComponent, onBack: @escaping () -> Void, onOpenEditor: ((FishVoiceEntry) -> Void)? = nil, editorEntry: FishVoiceEntry? = nil) {
        self.settings = settings
        self.onBack = onBack
        self.onOpenEditor = onOpenEditor
        self.editorEntry = editorEntry
        _vm = State(initialValue: VoiceFishViewModel(settings: settings))
    }

    var body: some View {
        SettingsPageScaffold(title: "Clone from Fish", screenId: "settings-voice-fish") {
            noticeBanner
            if vm.selected != nil || editorEntry != nil {
                cloneEditor
            } else {
                searchField
                filterControls
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
                    description: entry.description_,
                    tags: entry.tags,
                    isPlaying: vm.playingId == entry.id,
                    playDisabled: entry.previewAudioUrl == nil,
                    accessory: .none,
                    accessibilityId: "settings-voice-fish-row-\(entry.id)",
                    onSelect: {
                        vm.select(entry)
                        onOpenEditor?(entry)
                    },
                    onPlay: { vm.toggleSample(entry) }
                )
            }
            if vm.hasMore {
                DesignActionButton(
                    title: "Load more", role: .quiet,
                    state: vm.loadingMore ? .loading : .normal,
                    accessibilityId: "settings-voice-fish-loadmore",
                    action: vm.loadMore
                )
            }
        }
    }

    private var filterControls: some View {
        DesignPane(title: "Filters") {
            DesignSelect(
                title: "Language",
                options: [(value: "", label: "All languages")] + vm.filterLanguages.map { (value: $0, label: VoiceLanguages.label(for: $0)) },
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
            if vm.filterActive {
                DesignActionButton(title: "Clear filters", role: .quiet, accessibilityId: "settings-voice-fish-clear-filters", action: vm.resetFilters)
            }
        }
    }

    @ViewBuilder
    private func facetRow(_ label: String, _ options: [String], _ selected: [String], _ action: @escaping (String) -> Void) -> some View {
        if !options.isEmpty {
            VStack(alignment: .leading, spacing: Space.xs) {
                DesignGroupHeader(title: label)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: DesignMetrics.minimumTarget))], alignment: .leading, spacing: Space.xs) {
                    ForEach(options, id: \.self) { value in
                        DesignChip(title: value, selected: selected.contains(value)) { action(value) }
                            .accessibilityIdentifier("settings-voice-fish-\(label.lowercased())-\(value)")
                    }
                }
            }
        }
    }

    private var cloneEditor: some View {
        DesignPane(title: "Clone this voice") {
            DesignField(
                title: "Name", prompt: "Voice name",
                text: Binding(get: { vm.cloneName }, set: { vm.setCloneName($0) }),
                accessibilityId: "settings-voice-fish-clone-name"
            )
            DesignSelect(
                title: "Language",
                options: VoiceLanguages.formOptions.map { (value: $0.code, label: $0.label) },
                selection: $vm.cloneLanguage
            )
            .accessibilityIdentifier("settings-voice-fish-clone-language")
            DesignActionButton(
                title: "Clone voice",
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
