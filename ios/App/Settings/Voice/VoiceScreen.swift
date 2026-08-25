// ---------------------------------------------------------------------------
// VoiceScreen — Soul-group "Voice" category page. Filter (search / tags / language)
// over the voice library, a pack list with per-row Play preview / Pick active /
// Delete, and the two sub-page entries: "Add voice" (always) and "Clone from Fish"
// (only when `fishBrowseEnabled`). Mirrors the webui VoicesPanel.
//
// Screen-level view: owns its `VoiceViewModel` (rebuilt per route entry — the
// nav boundary is the cleanup boundary), reads its state, dispatches actions.
// `onOpen` pushes the sub-routes (already registered); Route.swift / the host are
// untouched. Delete is gated to user packs + confirmed; a deleted active pack
// falls back to the server default (the VM re-seeds the badge).
// ---------------------------------------------------------------------------
import Combine
import SwiftUI
import MobileData

struct VoiceScreen: View {
    let settings: SettingsComponent
    /// Push a settings sub-route (Add Voice / Clone from Fish).
    let onOpen: (Route) -> Void
    let onBack: () -> Void

    @State private var vm: VoiceViewModel

    init(settings: SettingsComponent, onOpen: @escaping (Route) -> Void, onBack: @escaping () -> Void) {
        self.settings = settings
        self.onOpen = onOpen
        self.onBack = onBack
        _vm = State(initialValue: VoiceViewModel(settings: settings))
    }

    var body: some View {
        SettingsPageScaffold(title: "Voice", screenId: "settings-voice") {
            noticeBanner
            VoiceFilterBarView(
                query: $vm.query,
                source: vm.source,
                selectedTags: vm.selectedTags,
                tagOptions: vm.tagOptions,
                language: vm.language,
                languageOptions: vm.languageOptions,
                onSource: { vm.source = $0 },
                onToggleTag: { vm.toggleTag($0) },
                onLanguage: { vm.language = $0 }
            )
            entryButtons
            content
        }
        .task { await vm.load() }
        .onReceive(NotificationCenter.default.publisher(for: .voiceLibraryChanged)) { _ in
            Task { await vm.onLibraryChanged() }
        }
        .onDisappear { vm.teardown() }
        .confirmationDialog(deleteTitle, isPresented: deleteAlertBinding, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { vm.confirmDelete() }
            Button("Cancel", role: .cancel) { vm.pendingDelete = nil }
        } message: {
            Text("This voice pack will be permanently deleted.")
        }
    }

    @ViewBuilder
    private var content: some View {
        switch vm.phase {
        case .loading:
            AsyncNotice(kind: .loading, title: "Loading voices")
                .accessibilityIdentifier("settings-voice-loading")
        case .failed:
            errorState
        case .loaded:
            if vm.shownVoices.isEmpty {
                AsyncNotice(kind: .empty, title: "No voices match", detail: "Clear filters or add your own.")
                    .accessibilityIdentifier("settings-voice-empty")
            } else {
                voiceList
            }
        }
    }

    private var voiceList: some View {
        LazyVStack(spacing: Space.sm) {
            ForEach(vm.shownVoices, id: \.voiceId) { pack in
                VoiceRowView(
                    name: pack.name,
                    lang: pack.language,
                    source: pack.source == "builtin" ? "Built-in" : "Yours",
                    description: pack.description_,
                    tags: pack.tags,
                    isPlaying: vm.previewingId == pack.voiceId,
                    isLoading: vm.previewLoadingId == pack.voiceId,
                    isSelected: vm.activeVoiceId == pack.voiceId,
                    accessory: vm.activeVoiceId == pack.voiceId ? .activePill : .none,
                    accessibilityId: "settings-voice-row-\(pack.voiceId)",
                    onSelect: { vm.pick(pack) },
                    onPlay: { vm.togglePreview(pack) },
                    onDelete: pack.source == "user" ? { vm.pendingDelete = pack } : nil
                )
            }
        }
    }

    private var entryButtons: some View {
        DesignPane(title: "Create") {
            DesignActionButton(title: "Add voice", accessibilityId: "settings-voice-add-nav") {
                onOpen(.settingsVoiceAdd)
            }
            if vm.fishBrowseEnabled {
                DesignActionButton(title: "Clone from Fish", role: .quiet, accessibilityId: "settings-voice-fish-nav") {
                    onOpen(.settingsVoiceFish)
                }
            }
        }
    }

    private var errorState: some View {
        VStack(spacing: Space.sm) {
            AsyncNotice(kind: .error, title: "Couldn't load voices")
            DesignActionButton(title: "Retry", role: .quiet, accessibilityId: "settings-voice-retry") {
                Task { await vm.load() }
            }
        }
    }

    @ViewBuilder
    private var noticeBanner: some View {
        if let notice = vm.notice {
            Button { vm.notice = nil } label: {
                AsyncNotice(kind: .warning, title: notice)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss notice")
            .accessibilityIdentifier("settings-voice-notice")
        }
    }

    private var deleteAlertBinding: Binding<Bool> {
        Binding(get: { vm.pendingDelete != nil }, set: { if !$0 { vm.pendingDelete = nil } })
    }

    private var deleteTitle: String {
        vm.pendingDelete.map { "Delete \"\($0.name)\"?" } ?? "Delete voice?"
    }
}

#Preview {
    NavigationStack {
        Text("VoiceScreen requires a live SettingsComponent")
            .font(Typo.ui(TypeScale.sm))
            .foregroundStyle(DuskColors.ink3)
            .padding(Space.lg)
    }
    .background(DuskColors.bg)
    .preferredColorScheme(.dark)
}
