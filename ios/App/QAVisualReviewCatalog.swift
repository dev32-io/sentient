#if DEBUG
import MobileData
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
    case history
    case chat
    case voice
    case notifications
    case calendar

    var title: String {
        switch self {
        case .foundation: "Foundation"
        case .controls: "Controls"
        case .forms: "Forms"
        case .feedback: "Feedback"
        case .composites: "Composites"
        case .history: "History"
        case .chat: "Chat"
        case .voice: "Voice + Rive"
        case .notifications: "Notifications"
        case .calendar: "Calendar"
        }
    }

    var subtitle: String {
        switch self {
        case .foundation: "Tokens, type, and native surface recipes"
        case .controls: "Actions, selection, and stateful controls"
        case .forms: "Native inputs with shared focus and error surfaces"
        case .feedback: "Loading, empty, error, success, and progress states"
        case .composites: "Reusable cards, identity, PIN, and page chrome"
        case .history: "Repeated real session rows and history feedback"
        case .chat: "Variable-height bubbles, composer, and task shelf"
        case .voice: "Voice pod states, waveform, and authored Rive identity"
        case .notifications: "Card face, tray, swipe, badge, and bulk clear"
        case .calendar: "Native viewport plus week and floating controls"
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
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("qa-specimen-\(stableID)")
    }

    private var stableID: String {
        title.lowercased().map { $0.isLetter || $0.isNumber ? $0 : "-" }.reduce(into: "") {
            if $1 != "-" || !$0.hasSuffix("-") { $0.append($1) }
        }
    }
}

/// Debug-only catalog for reviewing shipped iOS hybrid components without
/// entering an authenticated product flow. Fixtures pass synthetic values and
/// inert closures directly to production SwiftUI views.
struct QAFoundationCatalog: View {
    @State private var selectedSection: QAFoundationCatalogSection
    private let historyState: String

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        let requested = arguments.firstIndex(of: "--qa-foundation-family").flatMap { index in
            arguments.indices.contains(index + 1) ? QAFoundationCatalogSection(rawValue: arguments[index + 1]) : nil
        }
        let requestedCalendarView = arguments.firstIndex(of: "--qa-calendar-view").flatMap { index -> CalendarView? in
            guard arguments.indices.contains(index + 1) else { return nil }
            switch arguments[index + 1] {
            case "month": return .month
            case "week": return .week
            case "day": return .day
            default: return nil
            }
        }
        historyState = arguments.firstIndex(of: "--qa-history-state").flatMap { index in
            arguments.indices.contains(index + 1) ? arguments[index + 1] : nil
        } ?? "loaded"
        _selectedSection = State(initialValue: requested ?? .foundation)
        _historySearch = State(initialValue: historyState == "no-match" ? "missing fixture" : "")
        _calendarView = State(initialValue: requestedCalendarView ?? .day)
    }
    @State private var fieldText = "Ada Lovelace"
    @State private var secureText = "secret"
    @State private var maskedText = "1234"
    @State private var editorText = "A native multiline editor."
    @State private var toggle = true
    @State private var checkbox = true
    @State private var segment = "one"
    @State private var selection = "one"
    @State private var slider = 0.64
    @State private var date = Date(timeIntervalSince1970: 1_834_272_000)
    @State private var stepper = 2
    @State private var search = "voice"
    @State private var historySearch: String
    @State private var chipSelected = true
    @State private var selectableCardSelected = true
    @State private var disclosureExpanded = true
    @State private var pinCount = 2
    @State private var calendarView: CalendarView

    var body: some View {
        Group {
            if selectedSection == .history || selectedSection == .chat || selectedSection == .calendar {
                VStack(spacing: 0) {
                    sectionJumpBar
                        .padding(.horizontal, Space.lg)
                        .padding(.vertical, Space.sm)
                    selectedSectionBody
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Space.xl) {
                        header
                        sectionJumpBar
                        selectedSectionBody
                    }
                    .padding(.horizontal, Space.lg)
                    .padding(.top, Space.md)
                    .padding(.bottom, Space.xxxl)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
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
                    Text("iOS hybrid component catalog")
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
            Text("Real shipped primitives, wrappers, and product leaves. No prototype or live application state.")
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

    private var sectionJumpBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Space.sm) {
                ForEach(QAFoundationCatalogSection.allCases, id: \.self) { section in
                    DesignChip(
                        title: section.title,
                        selected: selectedSection == section,
                        accessibilityId: "qa-jump-\(section.rawValue)",
                        action: { selectedSection = section }
                    )
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .layoutPriority(1)
        .accessibilityIdentifier("qa-foundation-section-jump")
    }

    @ViewBuilder
    private var selectedSectionBody: some View {
        switch selectedSection {
        case .foundation: foundationSection
        case .controls: controlsSection
        case .forms: formsSection
        case .feedback: feedbackSection
        case .composites: compositesSection
        case .history: historySection
        case .chat: chatSection
        case .voice: voiceSection
        case .notifications: notificationsSection
        case .calendar: calendarSection
        }
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

            QACatalogSpecimen("Selectable and menu trigger", contract: "DesignSelectableButton · DesignMenuTriggerLabel") {
                HStack(spacing: Space.md) {
                    DesignSelectableButton(
                        accessibilityLabel: "Voice choice", state: .selected,
                        accessibilityId: "qa-selectable-button", action: {}
                    ) { Text("Selected voice").padding(.horizontal, Space.md) }
                    DesignMenuTriggerLabel(currentLabel: "Current option", isEnabled: true, width: .intrinsic)
                        .accessibilityIdentifier("qa-menu-trigger-label")
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
            QACatalogSpecimen("Text input states", contract: "DesignField") {
                VStack(spacing: Space.md) {
                    DesignField(title: "Filled", prompt: "Name", text: $fieldText, accessibilityId: "qa-field")
                    DesignField(title: "Empty", prompt: "Name", text: .constant(""), accessibilityId: "qa-field-empty")
                    DesignField(title: "Error", text: $fieldText, error: "Use a synthetic display name", accessibilityId: "qa-field-error")
                    DesignField(title: "Disabled", text: $fieldText, accessibilityId: "qa-field-disabled", isEnabled: false)
                }
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

            QACatalogSpecimen("Settings field wrappers", contract: "DesignSettingsSelectRow · DesignSettingsSliderRow") {
                DesignCard(bodyStyle: .settingsGroup) {
                    DesignSettingsSelectRow(
                        title: "Voice", detail: "Current synthetic choice",
                        options: [(value: "one", label: "One"), (value: "two", label: "Two")],
                        selection: $selection, accessibilityId: "qa-settings-select-row"
                    )
                    DesignSettingsSliderRow(
                        title: "Temperature", detail: "Synthetic model range", value: $slider,
                        range: 0...1, step: 0.01, format: { "\(Int(($0 * 100).rounded()))%" },
                        accessibilityId: "qa-settings-slider-row"
                    )
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
                    AsyncNotice(kind: .info, title: "Information", detail: "Synthetic informational state")
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

            QACatalogSpecimen("Settings loading and inline error", contract: "SoulLoadingRow · SoulInlineError") {
                VStack(spacing: Space.md) {
                    SoulLoadingRow()
                    SoulInlineError(message: "Synthetic settings failure")
                }
            }

            QACatalogSpecimen("Apply feedback and bars", contract: "DesignApplyFeedback · DesignApplyBar") {
                VStack(spacing: Space.sm) {
                    DesignApplyBar(
                        isDirty: true, state: .idle,
                        discardAccessibilityId: "qa-apply-discard", applyAccessibilityId: "qa-apply-dirty",
                        onDiscard: {}, onApply: {}
                    )
                    DesignApplyBar(
                        isDirty: true, state: .saving,
                        discardAccessibilityId: "qa-applying-discard", applyAccessibilityId: "qa-apply-applying",
                        onDiscard: {}, onApply: {}
                    )
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
            QACatalogSpecimen("Page header and chrome", contract: "DesignPageHeader · DesignPageChrome") {
                VStack(spacing: Space.md) {
                    DesignPageHeader(title: "Synthetic settings", subtitle: "Real shipped header", showsBack: false)
                    DesignPageChrome(title: "Synthetic detail", accessibilityId: "qa-page-chrome", showsBack: false) {
                        Text("Page chrome content").designText(.body)
                    }
                    .frame(height: 180)
                }
            }

            QACatalogSpecimen("Settings editor", contract: "DesignSettingsEditor") {
                DesignSettingsEditor(
                    title: "System prompt", detail: "Synthetic local draft", state: .unsaved,
                    content: { DesignMultilineEditor(title: "Prompt", text: $editorText, accessibilityId: "qa-settings-editor-field") },
                    actions: {
                        DesignActionButton(title: "Reset", role: .secondary, fillsWidth: false, action: {})
                        DesignActionButton(title: "Save", fillsWidth: false, action: {})
                    }
                )
            }

            QACatalogSpecimen("Update footer", contract: "UpdateFooter") {
                UpdateFooter(
                    status: UpdateStatusCheckFailed(reason: "synthetic"),
                    versionText: "1.5.0 (12)", accessibilityId: "qa-update-footer",
                    onCheck: { UpdateStatusUpToDate.shared }, onInstall: {}
                )
            }

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
                    DesignDisclosureGroup(isExpanded: disclosureExpanded) {
                        DesignDisclosureButton(
                            isExpanded: disclosureExpanded,
                            accessibilityLabel: "Advanced options",
                            accessibilityId: "qa-disclosure",
                            action: { disclosureExpanded.toggle() }
                        ) {
                            Text("Advanced options")
                                .font(Typo.ui(TypeScale.base, .medium))
                        }
                    } content: {
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

            QACatalogSpecimen("Identity card", contract: "dominant visual composite · avatar states") {
                VStack(spacing: Space.md) {
                    DesignDominantVisualCard(
                        title: "Ada Lovelace",
                        detail: "Terra identity",
                        accessibilityLabel: "Ada Lovelace",
                        accessibilityId: "qa-dominant-card",
                        action: {}
                    ) {
                        ElevatedUserAvatar(name: "Ada Lovelace", size: DesignMetrics.dominantAvatarSize, tint: .terra)
                    }
                    HStack(spacing: Space.xl) {
                        ElevatedUserAvatar(name: "Ada Lovelace", tint: .terra)
                        ElevatedUserAvatar(name: "Grace Hopper", tint: .sage, selected: true)
                        ElevatedUserAvatar(name: "Unknown", tint: .fallback, disabled: true, fallback: true)
                    }
                    .accessibilityIdentifier("qa-avatar-states")
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

    private var historySection: some View {
        HistorySidePanelContent(
            rows: ["empty", "error", "loading", "no-match"].contains(historyState)
                ? [] : qaMakeHistoryRows(count: qaFixtureCount(default: 50)),
            query: $historySearch,
            loading: historyState == "loading" || historyState == "stale-checking",
            hasLoaded: historyState != "loading",
            hasError: historyState == "error" || historyState == "stale",
            isSearching: historyState == "no-match" || !historySearch.isEmpty,
            nowMs: 1_800_000_000_000,
            userName: "Ada Lovelace",
            household: "Analytical Engine Household",
            activeSessionId: "qa-history-1",
            onSelect: { _ in }, onNewChat: {}, onSettings: {}, onRetry: {},
            onAskRename: { _ in }, onAskDelete: { _ in }
        )
        .accessibilityIdentifier("qa-foundation-section-history")
    }

    private var chatSection: some View {
        VStack(spacing: 0) {
            MessageList(
                messages: qaMakeChatMessages(count: qaFixtureCount(default: 150)),
                userName: "Ada"
            )
            qaComposer(draft: "", tasks: qaTaskItems)
                .padding(.horizontal, Space.lg)
                .padding(.bottom, Space.sm)
                .accessibilityIdentifier("qa-composer-tasks")
        }
        .accessibilityIdentifier("qa-foundation-section-chat")
    }

    private var voiceSection: some View {
        catalogSection(.voice) {
            QACatalogSpecimen("Voice pod states", contract: "VoiceCaptureSurface") {
                VStack(alignment: .trailing, spacing: Space.xl) {
                    qaVoiceSurface(.idle, target: .send)
                    qaVoiceSurface(.hold, target: .send)
                    qaVoiceSurface(.auto, target: .auto)
                    qaVoiceSurface(.denied, target: .cancel)
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
            }
            QACatalogSpecimen("Voice waveform", contract: "PttBigWave") {
                PttBigWave(levels: qaMicLevels, isActive: false)
                    .accessibilityIdentifier("qa-voice-waveform")
            }
            QACatalogSpecimen("Sentient identity states", contract: "RiveSentientIdentity") {
                HStack(spacing: Space.xl) {
                    ForEach(SentientIdentityState.allCases, id: \.self) { state in
                        VStack(spacing: Space.xs) {
                            RiveSentientIdentity(state: state, size: 72)
                            Text(state.statusLabel).font(Typo.ui(TypeScale.sm))
                        }
                        .accessibilityIdentifier("qa-rive-\(state.triggerName)")
                    }
                }
            }
        }
    }

    private var notificationsSection: some View {
        catalogSection(.notifications) {
            QACatalogSpecimen("Notification badge counts", contract: "DesignBadgedIconButton") {
                HStack(spacing: Space.xl) {
                    ForEach([0, 3, 100], id: \.self) { count in
                        DesignBadgedIconButton(
                            systemName: "bell",
                            label: "Messages",
                            count: count,
                            accessibilityId: "qa-notification-badge-\(count)",
                            action: {}
                        )
                    }
                }
            }
            QACatalogSpecimen("Notification card faces", contract: "DesignNotificationCardButton") {
                VStack(spacing: Space.md) {
                    qaNotificationFace(id: "normal", state: .normal, lines: 2)
                    qaNotificationFace(id: "disabled", state: .disabled, lines: 4)
                }
            }
            QACatalogSpecimen("Notification action trays", contract: "DesignNotificationActionTray") {
                VStack(spacing: Space.sm) {
                    DesignNotificationActionTray(
                        title: "Clear", showsIcon: true, isVisible: true, isEnabled: true,
                        accessibilityLabel: "Clear notification", accessibilityId: "qa-notification-tray", action: {}
                    )
                    .frame(height: 86)
                    DesignNotificationActionTray(
                        title: "Release to clear", showsIcon: false, isVisible: true, isEnabled: false,
                        accessibilityLabel: "Clear notification", accessibilityId: "qa-notification-tray-armed", action: {}
                    )
                    .frame(height: 110)
                }
            }
            QACatalogSpecimen("Notification swipe rows · repeated heights", contract: "ScheduledInboxSwipeRow") {
                LazyVStack(spacing: Space.md) {
                    ForEach(Array(qaMakeNotificationCards(count: qaFixtureCount(default: 24)).enumerated()), id: \.element.occurrenceId) { index, card in
                        QANotificationSwipeFixture(card: card, index: index)
                    }
                }
            }
            QACatalogSpecimen("Notification bulk clear", contract: "ScheduledInboxHeader") {
                VStack(spacing: Space.sm) {
                    ScheduledInboxHeader(canClearAll: true, onBack: {}, onClearAll: {})
                    ScheduledInboxHeader(canClearAll: false, onBack: {}, onClearAll: {})
                }
            }
        }
    }

    private var calendarSection: some View {
        VStack(spacing: 0) {
            FloatingViewBar(
                selected: calendarView,
                onSelect: { calendarView = $0 },
                onFilters: {},
                activeFilterCount: 3
            )
            .padding(.horizontal, Space.lg)
            .padding(.bottom, Space.sm)
            if calendarView == .month || calendarView == .year {
                CalendarMorphStage(
                    state: qaCalendarState(view: calendarView),
                    onSelectDate: { _ in },
                    onSelectMonth: { _, _ in }
                )
                .background(DuskColors.bgSunk)
                .accessibilityIdentifier("qa-calendar-native-month")
            } else {
                QACalendarAdjacentFixture(view: calendarView)
                    .id(calendarView)
            }
        }
        .accessibilityIdentifier("qa-foundation-section-calendar")
    }

    private func qaComposer(draft: String, tasks: [TaskListItem]) -> some View {
        Composer(
            tasks: tasks,
            ttsEnabled: true,
            talkMode: .idle,
            micLevels: qaMicLevels,
            voiceDisabled: false,
            canInterrupt: false,
            initialDraft: draft,
            initiallyExpandedTaskId: tasks.first?.id,
            onSend: { _ in }, onVoiceIntent: { _ in }, onTtsToggle: {},
            onInterrupt: {}, onFocusGained: {}
        )
    }

    private func qaVoiceSurface(_ state: VoiceCaptureState, target: VoiceCaptureTarget) -> some View {
        VoiceCaptureSurface(
            state: state,
            target: target,
            levels: qaMicLevels,
            disabled: false,
            physicallyPressed: false,
            announcement: state.rawValue,
            captureGesture: VoiceCaptureGesture(onBegin: { _ in }, onChange: { _ in }, onTerminate: { _, _ in }),
            onActivate: {}, onStartAccessibleHold: {}, onTarget: { _ in }
        )
    }

    private func qaNotificationFace(id: String, state: DesignControlState, lines: Int) -> some View {
        DesignNotificationCardButton(
            accessibilityLabel: "Synthetic scheduled result",
            accessibilityHint: "Opens chat",
            accessibilityId: "qa-notification-face-\(id)",
            state: state,
            action: {}
        ) {
            VStack(alignment: .leading, spacing: Space.sm) {
                Text("Sep 15, 2026 at 9:41 AM").designText(.caption).foregroundStyle(DuskColors.ink2)
                Text(Array(repeating: "Synthetic scheduled message completed.", count: lines).joined(separator: " "))
                    .designText(.body).foregroundStyle(DuskColors.ink)
            }
            .padding(Space.lg)
        }
    }
}

private struct QANotificationSwipeFixture: View {
    let card: ScheduledSessionCard
    let index: Int
    @State private var isRevealed: Bool

    init(card: ScheduledSessionCard, index: Int) {
        self.card = card
        self.index = index
        _isRevealed = State(initialValue: index == 1)
    }

    var body: some View {
        ScheduledInboxSwipeRow(
            card: card,
            isRevealed: isRevealed,
            disabled: index == 2,
            onBeginSwipe: {},
            onSetRevealed: { isRevealed = $0 },
            onClear: { isRevealed = false },
            onOpen: { isRevealed.toggle() }
        )
        .accessibilityIdentifier("qa-notification-swipe-\(index)")
    }
}

private struct QACalendarAdjacentFixture: View {
    let view: CalendarView
    @AccessibilityFocusState private var openerFocus: CalendarOverlayOrigin?
    @State private var current: CalendarAdjacentPageID
    @State private var periods: [CalendarAdjacentPageID]
    @State private var revision = 1

    init(view: CalendarView) {
        let anchor = CalendarViewportDate(date: "2028-02-16")!
        let current = CalendarAdjacentPageID(view: view, anchor: anchor)
        self.view = view
        _current = State(initialValue: current)
        _periods = State(initialValue: CalendarAdjacentPeriodWindow.starting(at: current))
    }

    var body: some View {
        CalendarAdjacentViewport(
            current: current,
            data: CalendarAdjacentViewportData(
                isActive: true,
                generation: "qa-adjacent-\(view)",
                revision: revision,
                pages: Dictionary(uniqueKeysWithValues: periods.map { ($0, qaCalendarPage($0)) }),
                semanticAnchor: current.anchor,
                selectedDate: current.anchor.date,
                todayDate: "2028-02-14"
            ),
            locale: qaCalendarLocale,
            openerFocus: $openerFocus,
            onRequest: { request in
                periods = request.periods
                    .prefix(CalendarAdjacentPeriodWindow.maximumPeriods + 1)
                    .map { CalendarAdjacentPageID(view: request.view, anchor: $0) }
                revision &+= 1
            },
            onBrowse: { current = CalendarAdjacentPageID(view: view, anchor: $0) },
            onEvent: { openerFocus = .event($0.actionIdentity.stableKey) },
            onSelectDate: { _, date in
                if let anchor = CalendarViewportDate(date: date) {
                    current = CalendarAdjacentPageID(view: view, anchor: anchor)
                }
            },
            onRetry: { revision &+= 1 }
        )
        .accessibilityIdentifier("qa-calendar-adjacent-\(view)")
    }
}

private let qaMicLevels: [Float] = [0.16, 0.38, 0.72, 0.46, 0.88, 0.30, 0.62, 0.94, 0.48, 0.74, 0.28]

private let qaTaskItems = [
    TaskListItem(id: "travel", toolName: "Check travel", kind: "background", status: "running", argsPreview: "Friday evening · four people", startedAtMs: 1_000, endedAtMs: nil),
    TaskListItem(id: "draft", toolName: "Prepare draft", kind: "foreground", status: "done", argsPreview: "Cozy seasonal menu", startedAtMs: 1_100, endedAtMs: 1_500),
    TaskListItem(id: "calendar", toolName: "Update calendar", kind: "foreground", status: "error", argsPreview: "Shared family calendar", startedAtMs: 1_200, endedAtMs: 1_600),
]

private func qaFixtureCount(default defaultCount: Int) -> Int {
    let arguments = ProcessInfo.processInfo.arguments
    guard let index = arguments.firstIndex(of: "--qa-fixture-count"),
          arguments.indices.contains(index + 1),
          let requested = Int(arguments[index + 1]) else { return defaultCount }
    return min(max(requested, 1), 1_000)
}

private func qaMakeChatMessages(count: Int) -> [ChatMessage] {
    (0..<count).map { index in
        let isUser = index.isMultiple(of: 4)
        let isStreaming = index % 37 == 9
        let cutoff = index % 41 == 13 ? "interrupt" : nil
        let content: String
        if isStreaming {
            content = index.isMultiple(of: 2) ? "" : "Streaming synthetic response is still arriving…"
        } else if index % 7 == 1 {
            content = """
            ## Household plan \(index)

            - [x] Confirm pickup
            - [ ] Pack **weather layers**
            - Keep [school calendar](https://example.invalid/calendar) unchanged

            | Time | Owner | Status |
            | --- | --- | --- |
            | 08:30 | Ada | Ready |
            | 15:10 | Grace | Pending |

            ```swift
            let fixture = "committed GFM"
            ```
            """
        } else {
            content = String(
                repeating: isUser ? "Please preserve this synthetic constraint. " : "Synthetic committed Markdown paragraph with **emphasis** and `inline code`. ",
                count: index % 9 + 1
            )
        }
        return ChatMessage(
            ts: 1_800_000_000_000 + Int64(index) * 3_600_000,
            role: isUser ? "user" : "assistant",
            content: content,
            streaming: isStreaming,
            cutoffKind: cutoff,
            turnId: "qa-turn-\(index / 4)",
            replyId: isUser ? nil : "qa-reply-\(index)",
            pendingId: nil,
            entryId: "qa-message-\(index)"
        )
    }
}

private func qaMakeHistoryRows(count: Int) -> [SessionRow] {
    (0..<count).map { index in
        let title = index.isMultiple(of: 3)
            ? "Long synthetic conversation title for truncation \(index)"
            : "Synthetic chat \(index)"
        return SessionRow(
            sessionId: "qa-history-\(index)", rootId: nil, title: title,
            startedAt: 1_799_900_000_000 - Int64(index) * 60_000,
            lastActiveAt: 1_799_900_000_000 - Int64(index) * 3_600_000,
            messageCount: Int32(index), isActive: index == 0
        )
    }
}

private func qaMakeNotificationCards(count: Int) -> [ScheduledSessionCard] {
    (0..<count).map { index in
        ScheduledSessionCard(
            sessionId: "qa-session-\(index)", scheduleId: "qa-schedule",
            occurrenceId: "qa-occurrence-\(index)", intendedAt: "2026-09-15T16:40:00Z",
            completedAt: "2026-09-15T16:41:00Z", status: .completed,
            preview: String(repeating: "Synthetic scheduled result \(index). ", count: index % 6 + 1)
        )
    }
}

private let qaCalendarDays = [
    CalendarCivilDay(date: "2028-02-13", number: 13, weekday: "Sun", label: "Sunday, February 13"),
    CalendarCivilDay(date: "2028-02-14", number: 14, weekday: "Mon", label: "Monday, February 14"),
    CalendarCivilDay(date: "2028-02-15", number: 15, weekday: "Tue", label: "Tuesday, February 15"),
    CalendarCivilDay(date: "2028-02-16", number: 16, weekday: "Wed", label: "Wednesday, February 16"),
    CalendarCivilDay(date: "2028-02-17", number: 17, weekday: "Thu", label: "Thursday, February 17"),
    CalendarCivilDay(date: "2028-02-18", number: 18, weekday: "Fri", label: "Friday, February 18"),
    CalendarCivilDay(date: "2028-02-19", number: 19, weekday: "Sat", label: "Saturday, February 19"),
]

private let qaCalendarLocale = CalendarLocale(
    languageTag: "en-US", timeZoneId: "UTC", weekStart: .sunday, hourCycle: .hour12
)

private func qaCalendarPage(_ period: CalendarAdjacentPageID) -> CalendarAdjacentPageData {
    let anchor = period.anchor.date
    let occurrence = CalendarProjectionOccurrence(
        eventId: "qa-event-\(anchor)", occurrenceId: "qa-occurrence-\(anchor)",
        originalStart: "\(anchor)T09:00:00Z", recurring: false, recurrence: nil, revision: 1,
        scope: .household,
        title: "Calendar planning with a variable-height synthetic title for \(anchor)",
        description: "Committed local fixture details.",
        start: "\(anchor)T09:00:00Z", end: "\(anchor)T10:30:00Z",
        visibility: .everyone, importance: .important,
        group: "Family", tags: ["Planning", "Synthetic"], persistedTimeZoneId: "UTC"
    )
    let projection = CalendarProjection().project(request: CalendarProjectionRequest(
        occurrences: [occurrence], anchorDate: anchor, view: period.view,
        selectedDate: "2028-02-16", todayDate: "2028-02-14", locale: qaCalendarLocale,
        filters: CalendarFilters(scope: .all, groups: [], tags: [], importance: nil, text: "")
    ))
    return CalendarAdjacentPageData(
        projection: projection,
        loading: CalendarLoadingState(phase: .idle),
        freshness: .fresh,
        offline: .online,
        error: nil
    )
}

private func qaCalendarState(view: CalendarView) -> CalendarUiState {
    let anchor = "2028-02-16"
    let projection = CalendarProjection().project(request: CalendarProjectionRequest(
        occurrences: [], anchorDate: anchor, view: view, selectedDate: anchor, todayDate: "2028-02-14",
        locale: qaCalendarLocale, filters: CalendarFilters(scope: .all, groups: [], tags: [], importance: nil, text: "")
    ))
    return CalendarUiState(CalendarExperienceState(
        anchorDate: anchor, view: view, selectedDate: anchor, filters: projection.filters,
        locale: qaCalendarLocale, todayDate: "2028-02-14", visibleInterval: projection.interval, selectedInterval: nil,
        authorizedOccurrences: [], projection: projection, facets: projection.facets,
        freshness: .fresh, loading: CalendarLoadingState(phase: .idle), offline: .online,
        error: nil, hasCompleteCache: true, cachedWindow: nil, persistedCachePreferences: nil,
        presentationReady: true,
        recovery: CalendarRecoveryState(phase: .idle, generation: 0, failureKind: nil),
        mutationAvailability: CalendarMutationAvailability(canCreate: true, canEdit: true, canDelete: true, reason: nil),
        mutation: CalendarMutationState(
            phase: .idle, preview: nil, editor: nil, deleteConfirmation: nil, pendingRequest: nil,
            error: nil, conflict: nil, outcome: nil, successorEventId: nil, affectedWindows: []
        )
    ))
}

#endif
