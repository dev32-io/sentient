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

    @State private var vm: VoiceFishViewModel

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        self.settings = settings
        self.onBack = onBack
        _vm = State(initialValue: VoiceFishViewModel(settings: settings))
    }

    var body: some View {
        SettingsPageScaffold(title: "Clone from Fish", screenId: "settings-voice-fish") {
            noticeBanner
            if vm.selected != nil {
                cloneEditor
            } else {
                searchField
                content
            }
        }
        .task { await vm.load() }
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
            if vm.entries.isEmpty {
                inlineMessage("No voices match your search.", id: "settings-voice-fish-empty")
            } else {
                entryList
            }
        }
    }

    private var entryList: some View {
        LazyVStack(spacing: Space.sm) {
            ForEach(vm.entries, id: \.id) { entry in
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
                    onSelect: { vm.select(entry) },
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
                Button("Cancel") { vm.cancelSelect() }
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
