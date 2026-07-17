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
        .alert(deleteTitle, isPresented: deleteAlertBinding) {
            Button("Cancel", role: .cancel) { vm.pendingDelete = nil }
            Button("Delete", role: .destructive) { vm.confirmDelete() }
        } message: {
            Text("This voice pack will be permanently deleted.")
        }
    }

    @ViewBuilder
    private var content: some View {
        switch vm.phase {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.vertical, Space.xl)
                .accessibilityIdentifier("settings-voice-loading")
        case .failed:
            errorState
        case .loaded:
            if vm.shownVoices.isEmpty {
                Text("No voices match — clear filters or add your own.")
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink3)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, Space.xl)
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
        VStack(spacing: Space.sm) {
            entryButton(title: "Add voice", icon: "plus", id: "settings-voice-add-nav") {
                onOpen(.settingsVoiceAdd)
            }
            if vm.fishBrowseEnabled {
                entryButton(title: "Clone from Fish", icon: "square.and.arrow.down", id: "settings-voice-fish-nav") {
                    onOpen(.settingsVoiceFish)
                }
            }
        }
    }

    private func entryButton(title: String, icon: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: Space.sm) {
                Image(systemName: icon)
                Text(title).font(Typo.ui(TypeScale.sm, .semibold))
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: TypeScale.xs)).foregroundStyle(DuskColors.ink3)
            }
            .foregroundStyle(DuskColors.ink)
            .padding(Space.md)
            .background(DuskColors.paper, in: RoundedRectangle(cornerRadius: Radii.md))
            .overlay(RoundedRectangle(cornerRadius: Radii.md).stroke(DuskColors.lineSoft, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
    }

    private var errorState: some View {
        VStack(spacing: Space.md) {
            Text("Couldn't load voices.")
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink2)
            Button("Retry") { Task { await vm.load() } }
                .font(Typo.ui(TypeScale.sm, .semibold))
                .foregroundStyle(DuskColors.accent)
                .accessibilityIdentifier("settings-voice-retry")
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Space.xl)
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
