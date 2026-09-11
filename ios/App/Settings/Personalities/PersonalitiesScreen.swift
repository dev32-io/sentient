// ---------------------------------------------------------------------------
// PersonalitiesScreen — Soul-group "Personalities" category page. A grouped
// personality disclosure list (body preview + Activate + Delete-with-confirm) and a Create
// sheet (name + instructions; the name is immutable after create). Every action
// is imperative — its own apply-with-restart FSM run, surfaced by the banner —
// so there is no page-level Save. No dirty draft on the list, so the page keeps
// the system back button (native interactive edge-swipe pop); `onBack` stays a
// host-contract param (mirrors AccountScreen) but the pushed page never renders
// a custom back.
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
                AsyncNotice(kind: .error, title: "Couldn't load personalities", detail: message) {
                    Task { await vm.load() }
                }
            case .ready:
                opBanner
                activeIdentity
                if vm.personalities.isEmpty {
                    AsyncNotice(
                        kind: .empty,
                        title: "No personalities yet",
                        detail: "Create one to give the assistant a different style."
                    )
                    .accessibilityIdentifier("settings-personalities-empty")
                } else {
                    personalitiesCard
                }
                createButton
            }
        }
        .task { await vm.load() }
        .sheet(isPresented: $showCreate) {
            PersonalityCreateSheet(isBusy: vm.isBusy, error: vm.operationError) { name, body in
                if await vm.create(name: name, body: body) { showCreate = false }
            }
        }
        .confirmationDialog(
            deleteTarget.map { "Delete \($0)?" } ?? "Delete this personality?",
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

    private var opBanner: some View {
        DesignApplyFeedback(state: applyState)
    }

    private var applyState: DesignApplyState {
        switch vm.op {
        case .idle: .idle
        case .saving: .saving
        case .restarting: .restarting
        case .alreadyApplying: .alreadyApplying
        case .applied: .applied
        case .failed(let message): .failed(message)
        }
    }

    private var activeIdentity: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            Text("Active personality")
                .designText(.label)
                .foregroundStyle(DuskColors.ink2)
            Text(vm.activeName ?? "No active personality")
                .designText(.title)
                .foregroundStyle(DuskColors.ink)
                .fixedSize(horizontal: false, vertical: true)
            Text("Compare instructions below. Creating, activating, or deleting a personality saves the change and applies configuration.")
                .designText(.supporting)
                .foregroundStyle(DuskColors.ink2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var createButton: some View {
        DesignActionButton(
            title: "New personality",
            role: .quiet,
            state: vm.isBusy ? .disabled : .normal,
            accessibilityId: "settings-personalities-create",
            action: { showCreate = true }
        )
    }

    private var personalitiesCard: some View {
        DesignCard(
            title: "Available personalities",
            detail: "Open a personality for full instructions and actions.",
            headerStyle: .quiet
        ) {
            ForEach(Array(vm.personalities.enumerated()), id: \.element.name) { index, personality in
                personalityRow(personality)
                if index < vm.personalities.count - 1 { DesignDivider() }
            }
        }
    }

    private func personalityRow(_ personality: Personality) -> some View {
        let isActive = personality.name == vm.activeName
        let isOpen = expanded.contains(personality.name)
        return DesignDisclosureGroup(isExpanded: isOpen) {
            DesignDisclosureButton(
                isExpanded: isOpen,
                accessibilityLabel: "\(isOpen ? "Collapse" : "Expand") \(personality.name)\(isActive ? ", active" : "")",
                accessibilityId: "settings-personalities-card-\(personality.name)",
                action: { toggle(personality.name) }
            ) {
                VStack(alignment: .leading, spacing: Space.sm) {
                    personalityName(personality.name)
                    if isActive { activeBadge }
                    Text(personality.body.isEmpty ? "No instructions." : personality.body)
                        .designText(.body)
                        .foregroundStyle(DuskColors.ink2)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                .padding(.vertical, Space.sm)
            }
        } content: {
            cardBody(personality, isActive: isActive)
        }
    }

    private func personalityName(_ name: String) -> some View {
        Text(name)
            .designText(.label)
            .fontWeight(.semibold)
            .foregroundStyle(DuskColors.ink)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func cardBody(_ personality: Personality, isActive: Bool) -> some View {
        DesignDivider()
        Text(personality.body.isEmpty ? "No instructions." : personality.body)
            .designText(.body)
            .foregroundStyle(DuskColors.ink2)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, Space.sm)
        HStack(spacing: Space.md) {
            if !isActive {
                DesignTextButton(
                    title: "Activate",
                    role: .action,
                    state: vm.isBusy ? .disabled : .normal,
                    accessibilityId: "settings-personalities-activate-\(personality.name)",
                    action: { Task { await vm.activate(personality.name) } }
                )
            }
            Spacer()
            DesignTextButton(
                title: "Delete",
                role: .destructive,
                state: vm.isBusy ? .disabled : .normal,
                accessibilityId: "settings-personalities-delete-\(personality.name)",
                action: { deleteTarget = personality.name }
            )
        }
        .padding(.bottom, Space.sm)
    }

    private var activeBadge: some View {
        DesignStatusBadge(title: "Active")
    }

    private func toggle(_ name: String) {
        if expanded.contains(name) { expanded.remove(name) } else { expanded.insert(name) }
    }
}

#Preview("ready") {
    NavigationStack {
        SettingsPageScaffold(title: "Personalities", screenId: "settings-personalities-screen") {
            DesignCard {
                DesignDisclosureButton(
                    isExpanded: false,
                    accessibilityLabel: "Expand Default",
                    accessibilityId: "settings-personalities-preview-card",
                    action: {}
                ) {
                    HStack(spacing: Space.sm) {
                        Text("Default").designText(.label).fontWeight(.semibold).foregroundStyle(DuskColors.ink)
                        DesignStatusBadge(title: "Active")
                    }
                }
            }
        }
    }
    .preferredColorScheme(.dark)
}
