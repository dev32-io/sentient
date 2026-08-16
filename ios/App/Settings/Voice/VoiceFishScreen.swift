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
            ProgressView().frame(maxWidth: .infinity).padding(.vertical, Space.xl)
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
                Button { vm.loadMore() } label: {
                    Text(vm.loadingMore ? "Loading…" : "Load more")
                        .font(Typo.ui(TypeScale.sm, .semibold))
                        .foregroundStyle(DuskColors.accent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Space.sm)
                }
                .buttonStyle(.plain)
                .disabled(vm.loadingMore)
                .accessibilityIdentifier("settings-voice-fish-loadmore")
            }
        }
    }

    private var filterControls: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            RowSelect(label: "Language", options: [SelectOption(id: "", label: "All languages")] + vm.filterLanguages.map { SelectOption(id: $0, label: VoiceLanguages.label(for: $0)) }, selectedId: vm.languageFilter, accessibilityId: "settings-voice-fish-language", onSelect: { vm.languageFilter = $0 })
            RowSelect(label: "Sort", options: [SelectOption(id: "popular", label: "Popular"), SelectOption(id: "recent", label: "Recent"), SelectOption(id: "az", label: "A–Z")], selectedId: vm.sort.rawValue, accessibilityId: "settings-voice-fish-sort", onSelect: { vm.sort = VoiceFishViewModel.Sort(rawValue: $0) ?? .popular })
            facetRow("Gender", vm.filterGenders, vm.selectedGenders) { vm.toggleGender($0) }
            facetRow("Age", vm.filterAges, vm.selectedAges) { vm.toggleAge($0) }
            facetRow("Vibe", vm.filterVibes, vm.selectedVibes) { vm.toggleVibe($0) }
            if vm.filterActive { Button("Clear filters", action: vm.resetFilters).accessibilityIdentifier("settings-voice-fish-clear-filters") }
        }
    }

    private func facetRow(_ label: String, _ options: [String], _ selected: [String], _ action: @escaping (String) -> Void) -> some View {
        if options.isEmpty { return AnyView(EmptyView()) }
        return AnyView(VStack(alignment: .leading, spacing: Space.xs) {
            Text(label).font(Typo.ui(TypeScale.xs, .medium)).foregroundStyle(DuskColors.ink2)
            ScrollView(.horizontal, showsIndicators: false) { HStack(spacing: Space.xs) { ForEach(options, id: \.self) { value in Button(value) { action(value) }.buttonStyle(.borderedProminent).tint(selected.contains(value) ? DuskColors.accent : DuskColors.bgElev).accessibilityIdentifier("settings-voice-fish-\(label.lowercased())-\(value)") } } }
        })
    }

    private var cloneEditor: some View {
        VStack(alignment: .leading, spacing: Space.lg) {
            Text("Clone this voice")
                .font(Typo.ui(TypeScale.base, .semibold))
                .foregroundStyle(DuskColors.ink)
            VStack(alignment: .leading, spacing: Space.xs) {
                Text("Name").font(Typo.ui(TypeScale.sm, .medium)).foregroundStyle(DuskColors.ink)
                TextField("Voice name", text: Binding(get: { vm.cloneName }, set: { vm.setCloneName($0) }))
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink)
                    .padding(.horizontal, Space.md).padding(.vertical, Space.sm)
                    .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
                    .overlay(RoundedRectangle(cornerRadius: Radii.sm).stroke(DuskColors.lineSoft, lineWidth: 1))
                    .accessibilityIdentifier("settings-voice-fish-clone-name")
            }
            RowSelect(
                label: "Language",
                options: VoiceLanguages.formOptions.map { SelectOption(id: $0.code, label: $0.label) },
                selectedId: vm.cloneLanguage,
                accessibilityId: "settings-voice-fish-clone-language",
                onSelect: { vm.cloneLanguage = $0 }
            )
            HStack(spacing: Space.sm) {
                Button("Cancel") { editorEntry == nil ? vm.cancelSelect() : onBack() }
                    .font(Typo.ui(TypeScale.sm, .semibold))
                    .foregroundStyle(DuskColors.ink2)
                    .accessibilityIdentifier("settings-voice-fish-clone-cancel")
                Spacer()
                Button { vm.clone() } label: {
                    Text(vm.cloning ? "Cloning…" : "Clone voice")
                        .font(.system(size: TypeScale.base, weight: .semibold))
                        .foregroundStyle(vm.canClone ? DuskColors.bg : DuskColors.ink4)
                        .padding(.horizontal, Space.lg).padding(.vertical, Space.sm)
                        .background(vm.canClone ? DuskColors.accent : DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.md))
                }
                .buttonStyle(.plain)
                .disabled(!vm.canClone)
                .accessibilityIdentifier("settings-voice-fish-clone-submit")
            }
        }
    }

    private var searchField: some View {
        HStack(spacing: Space.sm) {
            Image(systemName: "magnifyingglass").font(.system(size: TypeScale.sm)).foregroundStyle(DuskColors.ink3)
            TextField("Search the Fish library", text: $vm.query)
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("settings-voice-fish-search")
        }
        .padding(.horizontal, Space.md).padding(.vertical, Space.sm)
        .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
        .overlay(RoundedRectangle(cornerRadius: Radii.sm).stroke(DuskColors.lineSoft, lineWidth: 1))
    }

    private var failureState: some View {
        VStack(spacing: Space.md) {
            Text("Couldn't reach the Fish library.")
                .font(Typo.ui(TypeScale.sm)).foregroundStyle(DuskColors.ink2)
            Button("Retry") { Task { await vm.load() } }
                .font(Typo.ui(TypeScale.sm, .semibold))
                .foregroundStyle(DuskColors.accent)
                .accessibilityIdentifier("settings-voice-fish-retry")
        }
        .frame(maxWidth: .infinity).padding(.vertical, Space.xl)
    }

    private func inlineMessage(_ text: String, id: String) -> some View {
        Text(text)
            .font(Typo.ui(TypeScale.sm))
            .foregroundStyle(DuskColors.ink3)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, Space.xl)
            .accessibilityIdentifier(id)
    }

    @ViewBuilder
    private var noticeBanner: some View {
        if let notice = vm.notice {
            Button { vm.notice = nil } label: {
                Text(notice)
                    .font(Typo.ui(TypeScale.xs, .medium))
                    .foregroundStyle(DuskColors.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Space.sm)
                    .background(DuskColors.bgElev, in: RoundedRectangle(cornerRadius: Radii.sm))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("settings-voice-fish-notice")
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
