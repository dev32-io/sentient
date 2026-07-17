// ---------------------------------------------------------------------------
// PersonalitiesScreen — Soul-group "Personalities" category page. Expandable
// personality cards (body preview + Activate + Delete-with-confirm) and a Create
// sheet (name + instructions; the name is immutable after create). Every action
// is imperative — its own apply-with-restart FSM run, surfaced by the banner —
// so there is no page-level Save. Back pops directly (no dirty draft on the list).
// ---------------------------------------------------------------------------
import SwiftUI
import MobileData

struct PersonalitiesScreen: View {
    let settings: SettingsComponent
    let onBack: () -> Void

    @State private var vm: PersonalitiesViewModel
    @State private var expanded: Set<String> = []
    @State private var showCreate = false
    @State private var deleteTarget: String?

    init(settings: SettingsComponent, onBack: @escaping () -> Void) {
        self.settings = settings
        self.onBack = onBack
        _vm = State(initialValue: PersonalitiesViewModel(settings: settings))
    }

    var body: some View {
        SettingsPageScaffold(title: "Personalities", screenId: "settings-personalities-screen") {
            switch vm.phase {
            case .loading:
                SoulLoadingRow()
            case .failed(let message):
                SoulInlineError(message: message)
            case .ready:
                opBanner
                createButton
                ForEach(vm.personalities, id: \.name) { personality in
                    card(personality)
                }
            }
        }
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .navigation) {
                SoulBackButton(accessibilityId: "settings-personalities-back", action: onBack)
            }
        }
        .task { await vm.load() }
        .sheet(isPresented: $showCreate) {
            PersonalityCreateSheet(isBusy: vm.isBusy) { name, body in
                if await vm.create(name: name, body: body) { showCreate = false }
            }
        }
        .confirmationDialog(
            "Delete this personality?",
            isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let name = deleteTarget { Task { await vm.delete(name) } }
                deleteTarget = nil
            }
            Button("Cancel", role: .cancel) { deleteTarget = nil }
        }
    }

    @ViewBuilder
    private var opBanner: some View {
        switch vm.op {
        case .idle: EmptyView()
        case .saving: SoulApplyingBanner(text: "Saving…")
        case .restarting: SoulApplyingBanner(text: "Applying — assistant restarting…")
        case .alreadyApplying: SoulNoticeBanner(text: soulAlreadyApplyingText)
        case .failed(let message): SoulInlineError(message: message)
        }
    }

    private var createButton: some View {
        Button(action: { showCreate = true }) {
            HStack(spacing: Space.sm) {
                Image(systemName: "plus")
                Text("New personality").font(Typo.ui(TypeScale.sm, .semibold))
            }
            .foregroundStyle(DuskColors.accent)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Space.sm)
            .overlay(RoundedRectangle(cornerRadius: Radii.md).stroke(DuskColors.accent, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(vm.isBusy)
        .accessibilityIdentifier("settings-personalities-create")
    }

    private func card(_ personality: Personality) -> some View {
        let isActive = personality.name == vm.activeName
        let isOpen = expanded.contains(personality.name)
        return SettingsCard {
            Button(action: { toggle(personality.name) }) {
                HStack {
                    Text(personality.name)
                        .font(Typo.ui(TypeScale.sm, .semibold))
                        .foregroundStyle(DuskColors.ink)
                    if isActive { activeBadge }
                    Spacer()
                    Image(systemName: isOpen ? "chevron.down" : "chevron.right")
                        .font(.system(size: TypeScale.xs, weight: .semibold))
                        .foregroundStyle(DuskColors.ink3)
                }
                .padding(.vertical, Space.sm)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("settings-personalities-card-\(personality.name)")
            if isOpen { cardBody(personality, isActive: isActive) }
        }
    }

    @ViewBuilder
    private func cardBody(_ personality: Personality, isActive: Bool) -> some View {
        Divider().background(DuskColors.lineSoft)
        Text(personality.body.isEmpty ? "No instructions." : personality.body)
            .font(Typo.mono(TypeScale.xs))
            .foregroundStyle(personality.body.isEmpty ? DuskColors.ink4 : DuskColors.ink2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, Space.sm)
        HStack(spacing: Space.md) {
            if !isActive {
                Button("Activate") { Task { await vm.activate(personality.name) } }
                    .font(Typo.ui(TypeScale.sm, .semibold))
                    .foregroundStyle(DuskColors.accent)
                    .disabled(vm.isBusy)
                    .accessibilityIdentifier("settings-personalities-activate-\(personality.name)")
            }
            Spacer()
            Button("Delete") { deleteTarget = personality.name }
                .font(Typo.ui(TypeScale.sm, .semibold))
                .foregroundStyle(DuskColors.stop)
                .disabled(vm.isBusy)
                .accessibilityIdentifier("settings-personalities-delete-\(personality.name)")
        }
        .padding(.bottom, Space.sm)
    }

    private var activeBadge: some View {
        Text("Active")
            .font(Typo.ui(TypeScale.xs, .semibold))
            .foregroundStyle(DuskColors.bg)
            .padding(.horizontal, Space.sm)
            .padding(.vertical, 2)
            .background(DuskColors.accent, in: RoundedRectangle(cornerRadius: Radii.pill))
    }

    private func toggle(_ name: String) {
        if expanded.contains(name) { expanded.remove(name) } else { expanded.insert(name) }
    }
}

#Preview("ready") {
    NavigationStack {
        SettingsPageScaffold(title: "Personalities", screenId: "settings-personalities-screen") {
            SettingsCard {
                HStack {
                    Text("Default").font(Typo.ui(TypeScale.sm, .semibold)).foregroundStyle(DuskColors.ink)
                    Text("Active")
                        .font(Typo.ui(TypeScale.xs, .semibold)).foregroundStyle(DuskColors.bg)
                        .padding(.horizontal, Space.sm).padding(.vertical, 2)
                        .background(DuskColors.accent, in: RoundedRectangle(cornerRadius: Radii.pill))
                    Spacer()
                    Image(systemName: "chevron.right").foregroundStyle(DuskColors.ink3)
                }
                .padding(.vertical, Space.sm)
            }
        }
    }
    .preferredColorScheme(.dark)
}
