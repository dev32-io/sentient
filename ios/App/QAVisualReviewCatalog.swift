#if DEBUG
import SwiftUI

struct QAVisualReviewCatalog: View {
    private let pageSize = 3
    private var page: Int {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "--qa-visual-page"), args.indices.contains(index + 1) else { return 0 }
        return max(0, Int(args[index + 1]) ?? 0)
    }
    private var config: String {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "--qa-visual-config"), args.indices.contains(index + 1) else { return "ios-iphone-standard" }
        return args[index + 1]
    }
    private var rows: ArraySlice<QAVisualReviewRow> {
        let start = min(page * pageSize, qaVisualReviewRows.count)
        let end = min(start + pageSize, qaVisualReviewRows.count)
        return qaVisualReviewRows[start..<end]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack {
                Text("Design refresh · iOS").font(Typo.display(TypeScale.lg))
                Spacer()
                Text("\(config) · \(page + 1)").font(Typo.ui(TypeScale.sm)).foregroundStyle(DuskColors.ink2)
            }
            ForEach(Array(rows), id: \.id) { row in
                QAVisualReviewSpecimen(row: row)
            }
            Spacer(minLength: 0)
        }
        .padding(Space.md)
        .background(DuskColors.bg.ignoresSafeArea())
        .transaction { transaction in
            if config == "ios-reduced-motion" { transaction.disablesAnimations = true }
        }
        .accessibilityIdentifier("qa-visual-review-page-\(page)")
    }
}

private struct QAVisualReviewSpecimen: View {
    let row: QAVisualReviewRow
    @State private var text = "Fixture value"

    private var kind: DesignNoticeKind {
        let value = row.state.lowercased()
        if value.range(of: "loading|saving|applying|submitting|installing|checking|running|thinking|transitioning", options: .regularExpression) != nil { return .loading }
        if value.range(of: "empty|no sessions|no match", options: .regularExpression) != nil { return .empty }
        if value.range(of: "error|failed|denied|conflict|unavailable|offline|stale", options: .regularExpression) != nil { return .error }
        if value.range(of: "success|saved|applied|sent", options: .regularExpression) != nil { return .success }
        return .warning
    }

    var body: some View {
        HStack(alignment: .center, spacing: Space.md) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(row.id).font(Typo.mono(TypeScale.xs)).foregroundStyle(DuskColors.accent)
                    .lineLimit(2)
                Text(row.state).font(Typo.ui(TypeScale.sm)).foregroundStyle(DuskColors.ink2)
                    .lineLimit(2)
            }
            .frame(maxWidth: 150, alignment: .leading)
            if kind == .loading || kind == .empty || kind == .error {
                AsyncNotice(kind: kind, title: "Synthetic \(kind == .error ? "error" : kind == .empty ? "empty" : "loading") state", detail: row.state, retry: kind == .error ? {} : nil)
            } else {
                VStack(spacing: Space.xs) {
                    DesignField(title: "Synthetic field", text: $text, accessibilityId: "qa-field-\(row.id)")
                    DesignActionButton(title: "Review action", state: row.state.lowercased().contains("disabled") ? .disabled : .normal, accessibilityId: "qa-action-\(row.id)", action: {})
                }
            }
        }
        .padding(Space.sm)
        .frame(maxWidth: .infinity, minHeight: 118, alignment: .leading)
        .designPlate()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("qa-row-\(row.id)")
    }
}

private enum QAFoundationCatalogSection: String, CaseIterable, Hashable {
    case foundation
    case controls
    case forms
    case feedback
    case composites

    var title: String {
        switch self {
        case .foundation: "Foundation"
        case .controls: "Controls"
        case .forms: "Forms"
        case .feedback: "Feedback"
        case .composites: "Composites"
        }
    }

    var subtitle: String {
        switch self {
        case .foundation: "Tokens, type, and native surface recipes"
        case .controls: "Actions, selection, and stateful controls"
        case .forms: "Native inputs with shared focus and error surfaces"
        case .feedback: "Loading, empty, error, success, and progress states"
        case .composites: "Reusable cards, identity, PIN, and page chrome"
        }
    }
}

private struct QACatalogSpecimen<Content: View>: View {
    let title: String
    let contract: String?
    @ViewBuilder let content: () -> Content

    init(
        _ title: String,
        contract: String? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.contract = contract
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
                Text(title)
                    .font(Typo.mono(TypeScale.xs))
                    .foregroundStyle(DuskColors.accent)
                Spacer(minLength: Space.sm)
                if let contract {
                    Text(contract)
                        .font(Typo.mono(TypeScale.xs))
                        .foregroundStyle(DuskColors.ink4)
                }
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Debug-only catalog for reviewing the actual iOS foundation and common
/// composites without entering an authenticated product flow. It deliberately
/// uses the same public SwiftUI views as the app; it is not a prototype renderer.
struct QAFoundationCatalog: View {
    @State private var selectedSection: QAFoundationCatalogSection = .foundation
    @State private var fieldText = "Ada Lovelace"
    @State private var secureText = "secret"
    @State private var maskedText = "1234"
    @State private var editorText = "A native multiline editor."
    @State private var toggle = true
    @State private var checkbox = true
    @State private var segment = "one"
    @State private var selection = "one"
    @State private var slider = 0.64
    @State private var date = Date()
    @State private var stepper = 2
    @State private var search = "voice"
    @State private var chipSelected = true
    @State private var selectableCardSelected = true
    @State private var disclosureExpanded = true
    @State private var pinCount = 2

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: Space.xl) {
                    header
                    sectionJumpBar(proxy: proxy)
                    foundationSection
                    controlsSection
                    formsSection
                    feedbackSection
                    compositesSection
                }
                .padding(.horizontal, Space.lg)
                .padding(.top, Space.md)
                .padding(.bottom, Space.xxxl)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
            .onChange(of: selectedSection) { _, value in
                withAnimation(.easeInOut(duration: DesignV2.Motion.feedback)) {
                    proxy.scrollTo(value, anchor: .top)
                }
            }
        }
        .background(DuskColors.bg.ignoresSafeArea())
        .duskTheme()
        .accessibilityIdentifier("qa-foundation-catalog")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Space.sm) {
            HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text("Foundation + composites")
                        .font(Typo.display(TypeScale.lg, .medium))
                        .foregroundStyle(DuskColors.ink)
                    Text("One specimen at a time")
                        .font(Typo.ui(TypeScale.base))
                        .foregroundStyle(DuskColors.ink2)
                }
                Spacer(minLength: Space.sm)
                Text("DEBUG")
                    .font(Typo.mono(TypeScale.xs))
                    .foregroundStyle(DuskColors.accent)
            }
            Text("Real iOS primitives and shared composites. No prototype code, no product-page wrappers.")
                .font(Typo.ui(TypeScale.sm))
                .foregroundStyle(DuskColors.ink3)
            HStack(spacing: Space.sm) {
                Text("KMP v\(DesignV2.version)")
                Text("·")
                Text("Tap, type, toggle, and compare")
                Spacer(minLength: 0)
            }
            .font(Typo.mono(TypeScale.xs))
            .foregroundStyle(DuskColors.ink4)
        }
        .padding(Space.lg)
        .designFloat()
        .accessibilityElement(children: .combine)
    }

    private func sectionJumpBar(proxy: ScrollViewProxy) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Space.sm) {
                ForEach(QAFoundationCatalogSection.allCases, id: \.self) { section in
                    DesignChip(
                        title: section.title,
                        selected: selectedSection == section,
                        accessibilityId: "qa-jump-\(section.rawValue)",
                        action: {
                            selectedSection = section
                            withAnimation(.easeInOut(duration: DesignV2.Motion.feedback)) {
                                proxy.scrollTo(section, anchor: .top)
                            }
                        }
                    )
                }
            }
        }
        .accessibilityIdentifier("qa-foundation-section-jump")
    }

    @ViewBuilder
    private func catalogSection<Content: View>(
        _ section: QAFoundationCatalogSection,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: Space.md) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text(section.title)
                    .font(Typo.display(TypeScale.xl, .medium))
                    .foregroundStyle(DuskColors.ink)
                Text(section.subtitle)
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink3)
            }
            content()
        }
        .id(section)
        .accessibilityIdentifier("qa-foundation-section-\(section.rawValue)")
    }

    private var colorSwatches: [(String, Color)] {
        [
            ("bg", DuskColors.bg),
            ("elevated", DuskColors.bgElev),
            ("sunk", DuskColors.bgSunk),
            ("paper", DuskColors.paper),
            ("line", DuskColors.line),
            ("lineSoft", DuskColors.lineSoft),
            ("ink", DuskColors.ink),
            ("ink2", DuskColors.ink2),
            ("ink3", DuskColors.ink3),
            ("ember", DuskColors.accent),
            ("amber", DuskColors.amber),
            ("sage", DuskColors.sage),
            ("clay", DuskColors.clay),
            ("ok", DuskColors.ok),
            ("warn", DuskColors.warn),
            ("stop", DuskColors.stop),
        ]
    }

    private var foundationSection: some View {
        catalogSection(.foundation) {
            QACatalogSpecimen("Color roles", contract: "DesignV2.ColorToken") {
                LazyVGrid(
                    columns: Array(repeating: GridItem(.flexible(), spacing: Space.sm), count: 4),
                    spacing: Space.sm
                ) {
                    ForEach(Array(colorSwatches.enumerated()), id: \.offset) { entry in
                        VStack(alignment: .leading, spacing: Space.xs) {
                            RoundedRectangle(cornerRadius: Radii.sm, style: .continuous)
                                .fill(entry.element.1)
                                .frame(height: 34)
                                .overlay {
                                    RoundedRectangle(cornerRadius: Radii.sm, style: .continuous)
                                        .stroke(DuskColors.lineSoft, lineWidth: DesignMetrics.hairline)
                                }
                            Text(entry.element.0)
                                .font(Typo.mono(TypeScale.xs))
                                .foregroundStyle(DuskColors.ink3)
                        }
                    }
                }
            }

            QACatalogSpecimen("Typography", contract: "Fraunces · DM Sans · JetBrains Mono") {
                VStack(alignment: .leading, spacing: Space.sm) {
                    Text("Display / Fraunces 22").font(Typo.display(TypeScale.xl, .medium))
                    Text("Body / DM Sans 15").font(Typo.ui(TypeScale.base))
                    Text("Supporting / DM Sans 12.5").font(Typo.ui(TypeScale.sm)).foregroundStyle(DuskColors.ink2)
                    Text("Telemetry / JetBrains Mono 11").font(Typo.mono(TypeScale.xs)).foregroundStyle(DuskColors.accent)
                }
            }

            QACatalogSpecimen("Native material recipes", contract: "plate · float · well · slate") {
                HStack(alignment: .top, spacing: Space.md) {
                    VStack(spacing: Space.xs) {
                        Text("plate").font(Typo.mono(TypeScale.xs)).foregroundStyle(DuskColors.ink3)
                        Text("Paper")
                            .font(Typo.ui(TypeScale.sm))
                            .frame(maxWidth: .infinity, minHeight: 62)
                            .designPlate()
                    }
                    VStack(spacing: Space.xs) {
                        Text("float").font(Typo.mono(TypeScale.xs)).foregroundStyle(DuskColors.ink3)
                        Text("Elevated")
                            .font(Typo.ui(TypeScale.sm))
                            .frame(maxWidth: .infinity, minHeight: 62)
                            .designFloat()
                    }
                }
                Text("Well")
                    .font(Typo.ui(TypeScale.sm))
                    .frame(maxWidth: .infinity, minHeight: 58)
                    .designWell()
                HStack(spacing: Space.sm) {
                    DesignActionButton(title: "Action", fillsWidth: false, action: {})
                    DesignActionButton(title: "Secondary", role: .secondary, fillsWidth: false, action: {})
                }
            }
        }
    }

    private var controlsSection: some View {
        catalogSection(.controls) {
            QACatalogSpecimen("Action buttons", contract: "DesignActionButton") {
                VStack(spacing: Space.sm) {
                    HStack(spacing: Space.sm) {
                        DesignActionButton(title: "Primary", fillsWidth: false, action: {})
                        DesignActionButton(title: "Secondary", role: .secondary, fillsWidth: false, action: {})
                    }
                    DesignActionButton(title: "Destructive", role: .destructive, action: {})
                    HStack(spacing: Space.sm) {
                        DesignActionButton(title: "Loading", state: .loading, action: {})
                        DesignActionButton(title: "Disabled", state: .disabled, action: {})
                    }
                }
            }

            QACatalogSpecimen("Icon, compact, text, and toolbar actions", contract: "shared action states") {
                VStack(alignment: .leading, spacing: Space.sm) {
                    HStack(spacing: Space.sm) {
                        DesignIconButton(systemName: "plus", label: "Add", action: {})
                        DesignIconButton(systemName: "trash", label: "Delete", role: .destructive, action: {})
                        DesignCompactIconButton(systemName: "xmark", label: "Close", action: {})
                    }
                    HStack(spacing: Space.sm) {
                        DesignCompactButton(accessibilityLabel: "Compact", action: {}) { Text("Compact") }
                        DesignCompactButton(accessibilityLabel: "Selected compact", state: .selected, action: {}) { Text("Selected") }
                    }
                    HStack(spacing: Space.md) {
                        DesignTextButton(title: "Text action", role: .action, action: {})
                        DesignTextButton(title: "Delete", role: .destructive, action: {})
                        DesignToolbarButton(title: "Save", accessibilityId: "qa-toolbar-save", action: {})
                    }
                }
            }

            QACatalogSpecimen("Selection controls", contract: "segment · chip · checkbox") {
                VStack(alignment: .leading, spacing: Space.md) {
                    DesignSegmentedPicker(
                        title: "Mode",
                        options: [(value: "one", label: "One"), (value: "two", label: "Two"), (value: "three", label: "Three")],
                        selection: $segment,
                        accessibilityId: "qa-segment"
                    )
                    HStack(spacing: Space.sm) {
                        DesignChip(title: "Selected", selected: chipSelected, action: { chipSelected.toggle() })
                        DesignChip(title: "Disabled", isEnabled: false, action: {})
                    }
                    DesignCheckbox(title: "Remember this choice", isOn: $checkbox, accessibilityId: "qa-checkbox")
                }
            }

            QACatalogSpecimen("Supporting controls", contract: "toggle · select · slider") {
                VStack(alignment: .leading, spacing: Space.md) {
                    DesignToggleRow(title: "Enabled", detail: "Native toggle track and knob", isOn: $toggle, accessibilityId: "qa-toggle-row")
                    DesignToggleSwitch(label: "Compact switch", isOn: $toggle, accessibilityId: "qa-toggle")
                    DesignSelect(
                        title: "Voice",
                        detail: "Native Menu surface",
                        options: [(value: "one", label: "One"), (value: "two", label: "Two")],
                        selection: $selection,
                        accessibilityId: "qa-select"
                    )
                    DesignSlider(title: "Temperature", value: $slider, range: 0...1, step: 0.01, format: { "\(Int(($0 * 100).rounded()))%" }, accessibilityId: "qa-slider")
                }
            }
        }
    }

    private var formsSection: some View {
        catalogSection(.forms) {
            QACatalogSpecimen("Text input", contract: "DesignField") {
                DesignField(title: "Display name", prompt: "Name", text: $fieldText, accessibilityId: "qa-field")
            }

            QACatalogSpecimen("Secure and masked input", contract: "native reveal + write-only") {
                VStack(spacing: Space.md) {
                    DesignSecureField(title: "Secret", prompt: "Value", text: $secureText, accessibilityId: "qa-secure")
                    DesignMaskedField(title: "PIN", prompt: "Four digits", text: $maskedText, accessibilityId: "qa-masked", keyboard: .numberPad)
                }
            }

            QACatalogSpecimen("Multiline editor", contract: "mono editor · counter · error") {
                DesignMultilineEditor(
                    title: "System prompt",
                    text: $editorText,
                    placeholder: "Write a prompt…",
                    maxLength: 240,
                    error: editorText.isEmpty ? "Required" : nil,
                    accessibilityId: "qa-editor"
                )
            }

            QACatalogSpecimen("Date, stepper, and search", contract: "native behavior retained") {
                VStack(spacing: Space.md) {
                    DesignDatePicker(title: "Start", selection: $date, displayedComponents: [.date, .hourAndMinute], accessibilityId: "qa-date")
                    DesignStepper(title: "Retries", value: $stepper, range: 0...5, accessibilityId: "qa-stepper")
                    DesignSearchField(prompt: "Search voices", query: $search, accessibilityId: "qa-search", onClear: { search = "" })
                }
            }

            QACatalogSpecimen("Compatibility form composites", contract: "validated · identity · secret") {
                VStack(spacing: Space.md) {
                    ValidatedField(title: "Validated", text: $fieldText, validate: { $0.isEmpty ? "Required" : nil })
                    SecretValueField(title: "Secret value", value: $secureText)
                    IdentityFieldGroup(displayName: $fieldText, pin: $maskedText)
                }
            }
        }
    }

    private var feedbackSection: some View {
        catalogSection(.feedback) {
            QACatalogSpecimen("Notice states", contract: "AsyncNotice") {
                VStack(spacing: Space.sm) {
                    AsyncNotice(kind: .loading, title: "Loading", detail: "Fetching the latest state")
                    AsyncNotice(kind: .empty, title: "Nothing here", detail: "No matching records")
                    AsyncNotice(kind: .error, title: "Could not load", detail: "The local service is unavailable", retry: {})
                    AsyncNotice(kind: .success, title: "Saved", detail: "Changes are ready")
                    AsyncNotice(kind: .warning, title: "Needs attention", detail: "Review this setting")
                }
            }

            QACatalogSpecimen("Progress and status", contract: "progress · badge · divider") {
                VStack(alignment: .leading, spacing: Space.md) {
                    DesignProgress(title: "Uploading", value: 0.64, accessibilityId: "qa-progress")
                    DesignProgress(title: "Working", accessibilityId: "qa-progress-indeterminate")
                    HStack(spacing: Space.sm) {
                        DesignStatusBadge(title: "Active", tint: DuskColors.ok)
                        DesignStatusBadge(title: "Review", tint: DuskColors.warn)
                        DesignStatusBadge(title: "Stopped", tint: DuskColors.stop)
                    }
                    DesignDivider()
                }
            }

            QACatalogSpecimen("Apply feedback", contract: "shared save lifecycle") {
                VStack(spacing: Space.sm) {
                    DesignApplyFeedback(state: .saving)
                    DesignApplyFeedback(state: .restarting)
                    DesignApplyFeedback(state: .alreadyApplying)
                    DesignApplyFeedback(state: .applied, successMessage: "Changes applied")
                    DesignApplyFeedback(state: .failed("The change could not be applied"))
                    SaveApplyFeedback(state: .normal, successMessage: "Saved")
                }
            }
        }
    }

    private var compositesSection: some View {
        catalogSection(.composites) {
            QACatalogSpecimen("Cards and rows", contract: "plate-owned layout") {
                VStack(spacing: Space.md) {
                    DesignCard(title: "Elevated card", detail: "Header and rows") {
                        DesignSettingsRow(title: "Voice", detail: "Sentient", accessibilityId: "qa-row") {
                            DesignStatusBadge(title: "Ready")
                        }
                        DesignDivider()
                        DesignSettingsRow(title: "Notifications") {
                            DesignToggleSwitch(label: "Notifications", isOn: $toggle)
                        }
                    }
                    DesignPane(title: "Quiet pane", detail: "Padded body") {
                        Text("Pane content")
                            .font(Typo.ui(TypeScale.base))
                            .foregroundStyle(DuskColors.ink)
                    }
                    DesignGroupHeader(title: "Group header")
                    DesignCategoryRow(icon: .calendar, title: "Calendar", accessibilityId: "qa-category") {}
                }
            }

            QACatalogSpecimen("Disclosure, menu, and selectable card", contract: "native interaction surfaces") {
                VStack(spacing: Space.md) {
                    DesignDisclosureButton(
                        isExpanded: disclosureExpanded,
                        accessibilityLabel: "Advanced options",
                        accessibilityId: "qa-disclosure",
                        action: { disclosureExpanded.toggle() }
                    ) {
                        Text("Advanced options")
                            .font(Typo.ui(TypeScale.base, .medium))
                    }
                    if disclosureExpanded {
                        Text("Expanded content stays in the same native layout.")
                            .font(Typo.ui(TypeScale.sm))
                            .foregroundStyle(DuskColors.ink2)
                    }
                    DesignMenuButton(accessibilityLabel: "More actions", accessibilityId: "qa-menu", menu: {
                        Button("Rename") {}
                        Button("Delete", role: .destructive) {}
                    }) {
                        HStack(spacing: Space.sm) {
                            Image(systemName: "ellipsis.circle")
                            Text("More actions")
                        }
                        .font(Typo.ui(TypeScale.base, .medium))
                        .foregroundStyle(DuskColors.ink)
                        .frame(maxWidth: .infinity, minHeight: DesignMetrics.minimumTarget)
                        .designWell()
                    }
                    DesignSelectableCard(
                        isSelected: selectableCardSelected,
                        accessibilityLabel: "Selectable card",
                        accessibilityId: "qa-selectable-card",
                        action: { selectableCardSelected.toggle() }
                    ) {
                        VStack(alignment: .leading, spacing: Space.xs) {
                            Text("Selectable card")
                                .font(Typo.ui(TypeScale.base, .semibold))
                            Text(selectableCardSelected ? "Selected" : "Not selected")
                                .font(Typo.ui(TypeScale.sm))
                                .foregroundStyle(DuskColors.ink2)
                        }
                    }
                }
            }

            QACatalogSpecimen("Search and filter row", contract: "query + product filters") {
                SearchFilterRow(prompt: "Filter settings", query: $search, accessibilityId: "qa-search-filter") {
                    HStack(spacing: Space.sm) {
                        DesignChip(title: "All", selected: true, action: {})
                        DesignChip(title: "Favorites", action: {})
                    }
                }
            }

            QACatalogSpecimen("Identity card", contract: "dominant visual composite") {
                DesignDominantVisualCard(
                    title: "Ada Lovelace",
                    detail: "Terra identity",
                    accessibilityLabel: "Ada Lovelace",
                    accessibilityId: "qa-dominant-card",
                    action: {}
                ) {
                    ElevatedUserAvatar(name: "Ada Lovelace", size: DesignMetrics.dominantAvatarSize, tint: .terra)
                }
            }

            QACatalogSpecimen("PIN keypad", contract: "DesignPinKeypad") {
                DesignPinKeypad(
                    entered: pinCount,
                    statusAccessibilityId: "qa-pin-status",
                    onDigit: { _ in pinCount = min(4, pinCount + 1) },
                    onDelete: { pinCount = max(0, pinCount - 1) }
                )
                .padding(Space.md)
                .frame(maxWidth: .infinity)
                .designPlate()
            }

            QACatalogSpecimen("Dismissible notice and footer", contract: "composite action ownership") {
                VStack(spacing: Space.md) {
                    DesignDismissibleNotice(
                        kind: .warning,
                        title: "Dismissible notice",
                        detail: "Tap the notice to exercise its action surface.",
                        accessibilityId: "qa-dismissible",
                        onDismiss: {}
                    )
                    DesignActionFooter(
                        leading: {
                            Text("Unsaved changes")
                                .font(Typo.ui(TypeScale.sm))
                                .foregroundStyle(DuskColors.ink2)
                        },
                        actionTitle: "Save",
                        action: {}
                    )
                }
            }
        }
    }
}

#endif
