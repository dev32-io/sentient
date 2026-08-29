import SwiftUI
import UIKit
@testable import SentientApp

enum VisualDiffMissingAuthorityReason: Equatable {
    case unknownComponent
    case unknownCase
    case stateNotApplicable
    case stateRequiresInteraction
}

struct VisualDiffFixtureSkip: Equatable, CustomStringConvertible {
    let caseID: String
    let reason: VisualDiffMissingAuthorityReason

    var description: String {
        switch reason {
        case .stateNotApplicable:
            return "iPhone state is blocked or not applicable for \(caseID)"
        case .stateRequiresInteraction:
            return "iPhone static capture cannot hold native interaction state for \(caseID)"
        case .unknownComponent, .unknownCase:
            return "No iOS visual capture fixture exists yet for \(caseID)"
        }
    }
}

enum VisualDiffFixtureApplicability: Equatable {
    case supported
    case missingAuthority(VisualDiffMissingAuthorityReason)
}

struct VisualDiffFixtureCase: Equatable {
    let caseID: String
    let componentID: String
    let variantID: String
    let stateID: String
}

struct VisualDiffFixtureRegistration: Equatable {
    let fixture: VisualDiffFixtureCase
    let applicability: VisualDiffFixtureApplicability
}

protocol VisualDiffNativeFixtureAdapter {
    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView
}

enum VisualDiffFixtureAdapterError: Error, CustomStringConvertible {
    case missingConfiguration(caseID: String)

    var description: String {
        switch self {
        case .missingConfiguration(let caseID):
            return "The iOS visual fixture adapter has no configuration for \(caseID)"
        }
    }
}

struct VisualDiffComponentRegistration {
    let componentID: String
    let cases: [String: VisualDiffFixtureRegistration]
    let adapter: any VisualDiffNativeFixtureAdapter

    init(
        componentID: String,
        registrations: [VisualDiffFixtureRegistration],
        adapter: any VisualDiffNativeFixtureAdapter
    ) {
        self.componentID = componentID
        self.cases = Dictionary(uniqueKeysWithValues: registrations.map { ($0.fixture.caseID, $0) })
        self.adapter = adapter
    }
}

enum VisualDiffFixtureResolution {
    case supported(adapter: any VisualDiffNativeFixtureAdapter, fixture: VisualDiffFixtureCase)
    case missingAuthority(VisualDiffFixtureSkip)
}

struct VisualDiffActionButtonRenderConfiguration {
    let roleID: String
    let role: DesignButtonRole
    let title: String
    let state: DesignControlState
    let fillsWidth: Bool
    let visualHeight: CGFloat
}

struct VisualDiffPlateRenderConfiguration {
    let compact: Bool
    let horizontalPadding: CGFloat
}

struct VisualDiffIconButtonRenderConfiguration {
    let roleID: String
    let role: DesignButtonRole
    let systemName: String
    let label: String
    let state: DesignControlState
    let compact: Bool
}

struct VisualDiffUserAvatarRenderConfiguration {
    let name: String
    let initial: String
    let size: CGFloat
    let tint: DesignUserAvatarTint
    let selected: Bool
    let disabled: Bool
    let fallback: Bool
}

struct VisualDiffCheckboxRenderConfiguration {
    let title: String
    let isOn: Bool
    let isEnabled: Bool
}

struct VisualDiffTextFieldRenderConfiguration {
    let title: String
    let value: String
    let shouldFocus: Bool
}

struct VisualDiffTextAreaRenderConfiguration {
    let title: String
    let text: String
    let shouldFocus: Bool
}

struct VisualDiffChipRenderConfiguration {
    let title: String
    let selected: Bool
    let compact: Bool
}

struct VisualDiffSliderRenderConfiguration {
    let title: String
    let value: Double
    let range: ClosedRange<Double>
    let step: Double
    let format: (Double) -> String
    let isEnabled: Bool
}

enum VisualDiffFixtureRegistry {
    private static let components: [String: VisualDiffComponentRegistration] = [
        ActionButtonFixtureCatalog.registration.componentID: ActionButtonFixtureCatalog.registration,
        IconButtonFixtureCatalog.registration.componentID: IconButtonFixtureCatalog.registration,
        CheckboxFixtureCatalog.registration.componentID: CheckboxFixtureCatalog.registration,
        PlateFixtureCatalog.registration.componentID: PlateFixtureCatalog.registration,
        UserAvatarFixtureCatalog.registration.componentID: UserAvatarFixtureCatalog.registration,
        TextFieldFixtureCatalog.registration.componentID: TextFieldFixtureCatalog.registration,
        TextAreaFixtureCatalog.registration.componentID: TextAreaFixtureCatalog.registration,
        ChipFixtureCatalog.registration.componentID: ChipFixtureCatalog.registration,
        RangeFixtureCatalog.registration.componentID: RangeFixtureCatalog.registration,
    ]

    static func resolve(caseID: String) -> VisualDiffFixtureResolution {
        guard let componentID = caseID
            .split(separator: "--", maxSplits: 1, omittingEmptySubsequences: false)
            .first
            .map(String.init),
            !componentID.isEmpty,
            let component = components[componentID]
        else {
            return .missingAuthority(
                VisualDiffFixtureSkip(caseID: caseID, reason: .unknownComponent)
            )
        }

        guard let registration = component.cases[caseID] else {
            return .missingAuthority(
                VisualDiffFixtureSkip(caseID: caseID, reason: .unknownCase)
            )
        }

        switch registration.applicability {
        case .supported:
            return .supported(adapter: component.adapter, fixture: registration.fixture)
        case .missingAuthority(let reason):
            return .missingAuthority(
                VisualDiffFixtureSkip(caseID: caseID, reason: reason)
            )
        }
    }

    static func registrations(for componentID: String) -> [VisualDiffFixtureRegistration] {
        components[componentID]?.cases.values.sorted {
            $0.fixture.caseID < $1.fixture.caseID
        } ?? []
    }

    static func actionButtonRenderConfiguration(
        for caseID: String
    ) -> VisualDiffActionButtonRenderConfiguration? {
        ActionButtonFixtureCatalog.renderConfigurations[caseID]
    }

    static func plateRenderConfiguration(
        for caseID: String
    ) -> VisualDiffPlateRenderConfiguration? {
        PlateFixtureCatalog.renderConfigurations[caseID]
    }

    static func iconButtonRenderConfiguration(
        for caseID: String
    ) -> VisualDiffIconButtonRenderConfiguration? {
        IconButtonFixtureCatalog.renderConfigurations[caseID]
    }

    static func userAvatarRenderConfiguration(
        for caseID: String
    ) -> VisualDiffUserAvatarRenderConfiguration? {
        UserAvatarFixtureCatalog.renderConfigurations[caseID]
    }

    static func checkboxRenderConfiguration(
        for caseID: String
    ) -> VisualDiffCheckboxRenderConfiguration? {
        CheckboxFixtureCatalog.renderConfigurations[caseID]
    }

    static func textFieldRenderConfiguration(
        for caseID: String
    ) -> VisualDiffTextFieldRenderConfiguration? {
        TextFieldFixtureCatalog.renderConfigurations[caseID]
    }

    static func textAreaRenderConfiguration(
        for caseID: String
    ) -> VisualDiffTextAreaRenderConfiguration? {
        TextAreaFixtureCatalog.renderConfigurations[caseID]
    }

    static func chipRenderConfiguration(
        for caseID: String
    ) -> VisualDiffChipRenderConfiguration? {
        ChipFixtureCatalog.renderConfigurations[caseID]
    }

    static func sliderRenderConfiguration(
        for caseID: String
    ) -> VisualDiffSliderRenderConfiguration? {
        RangeFixtureCatalog.renderConfigurations[caseID]
    }
}

private struct ActionButtonVariantDefinition {
    let id: String
    let roleID: String
    let role: DesignButtonRole
    let title: String
    let states: [ActionButtonStateDefinition]
}

private struct ActionButtonStateDefinition {
    let id: String
    let applicability: VisualDiffFixtureApplicability
    let titleOverride: String?
    let state: DesignControlState?
    let visualHeight: CGFloat?

    static func supported(
        _ id: String,
        state: DesignControlState = .normal,
        titleOverride: String? = nil,
        visualHeight: CGFloat = DesignMetrics.actionButtonVisualHeight
    ) -> Self {
        Self(
            id: id,
            applicability: .supported,
            titleOverride: titleOverride,
            state: state,
            visualHeight: visualHeight
        )
    }

    static func compactRest() -> Self {
        supported("compact-rest", visualHeight: DesignMetrics.minimumTarget)
    }

    static func missingAuthority(_ id: String) -> Self {
        Self(
            id: id,
            applicability: .missingAuthority(.stateNotApplicable),
            titleOverride: nil,
            state: nil,
            visualHeight: nil
        )
    }
}

private struct ActionButtonFixtureDefinition {
    let registration: VisualDiffFixtureRegistration
    let renderConfiguration: VisualDiffActionButtonRenderConfiguration?
}

private struct ActionButtonFixtureAdapter: VisualDiffNativeFixtureAdapter {
    let configurations: [String: VisualDiffActionButtonRenderConfiguration]

    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView {
        guard let configuration = configurations[fixture.caseID] else {
            throw VisualDiffFixtureAdapterError.missingConfiguration(caseID: fixture.caseID)
        }

        return AnyView(
            ZStack {
                Color.clear
                DesignActionButton(
                    title: configuration.title,
                    role: configuration.role,
                    state: configuration.state,
                    fillsWidth: configuration.fillsWidth,
                    action: {},
                    visualHeight: configuration.visualHeight
                )
            }
        )
    }
}

private struct ChipFixtureAdapter: VisualDiffNativeFixtureAdapter {
    let configurations: [String: VisualDiffChipRenderConfiguration]

    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView {
        guard let configuration = configurations[fixture.caseID] else {
            throw VisualDiffFixtureAdapterError.missingConfiguration(caseID: fixture.caseID)
        }

        return AnyView(
            ZStack {
                Color.clear
                DesignChip(
                    title: configuration.title,
                    selected: configuration.selected,
                    action: {}
                )
            }
        )
    }
}

private enum ChipFixtureCatalog {
    private struct Variant {
        let id: String
        let title: String
        let selected: Bool
    }

    private struct State {
        let id: String
        let applicability: VisualDiffFixtureApplicability
        let compact: Bool

        static func supported(_ id: String, compact: Bool = false) -> Self {
            Self(id: id, applicability: .supported, compact: compact)
        }

        static func unavailable(_ id: String, reason: VisualDiffMissingAuthorityReason) -> Self {
            Self(id: id, applicability: .missingAuthority(reason), compact: id == "compact-rest")
        }
    }

    private static let variants = [
        Variant(id: "selected", title: "Family", selected: true),
        Variant(id: "unselected", title: "School", selected: false),
    ]

    private static let states = [
        State.supported("compact-rest", compact: true),
        State.supported("rest"),
        State.unavailable("focus", reason: .stateRequiresInteraction),
        State.unavailable("hover", reason: .stateNotApplicable),
        State.unavailable("pressed", reason: .stateRequiresInteraction),
    ]

    private static let definitions: [(VisualDiffFixtureRegistration, VisualDiffChipRenderConfiguration?)] =
        variants.flatMap { variant in
            states.map { state in
                let fixture = VisualDiffFixtureCase(
                    caseID: "chip--\(variant.id)--\(state.id)",
                    componentID: "chip",
                    variantID: variant.id,
                    stateID: state.id
                )
                let configuration: VisualDiffChipRenderConfiguration? = state.applicability == .supported
                    ? VisualDiffChipRenderConfiguration(
                        title: variant.title,
                        selected: variant.selected,
                        compact: state.compact
                    )
                    : nil
                return (
                    VisualDiffFixtureRegistration(
                        fixture: fixture,
                        applicability: state.applicability
                    ),
                    configuration
                )
            }
        }

    static let renderConfigurations: [String: VisualDiffChipRenderConfiguration] =
        Dictionary(uniqueKeysWithValues: definitions.compactMap { registration, configuration in
            guard let configuration else { return nil }
            return (registration.fixture.caseID, configuration)
        })

    static let registration = VisualDiffComponentRegistration(
        componentID: "chip",
        registrations: definitions.map(\.0),
        adapter: ChipFixtureAdapter(configurations: renderConfigurations)
    )
}

private struct RangeFixtureAdapter: VisualDiffNativeFixtureAdapter {
    let configurations: [String: VisualDiffSliderRenderConfiguration]

    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView {
        guard let configuration = configurations[fixture.caseID] else {
            throw VisualDiffFixtureAdapterError.missingConfiguration(caseID: fixture.caseID)
        }

        return AnyView(
            ZStack {
                Color.clear
                DesignSlider(
                    title: configuration.title,
                    value: .constant(configuration.value),
                    range: configuration.range,
                    step: configuration.step,
                    format: configuration.format,
                    isEnabled: configuration.isEnabled
                )
                .padding(.horizontal, Space.md * 2)
            }
        )
    }
}

private enum RangeFixtureCatalog {
    private static let definitions: [(VisualDiffFixtureRegistration, VisualDiffSliderRenderConfiguration?)] = [
        (fixture("rest"), configuration(isEnabled: true)),
        (fixture("hover", applicability: .missingAuthority(.stateNotApplicable)), nil),
        (fixture("focus", applicability: .missingAuthority(.stateRequiresInteraction)), nil),
        (fixture("disabled"), configuration(isEnabled: false)),
    ]

    private static func fixture(
        _ stateID: String,
        applicability: VisualDiffFixtureApplicability = .supported
    ) -> VisualDiffFixtureRegistration {
        VisualDiffFixtureRegistration(
            fixture: VisualDiffFixtureCase(
                caseID: "range--62--\(stateID)",
                componentID: "range",
                variantID: "62",
                stateID: stateID
            ),
            applicability: applicability
        )
    }

    private static func configuration(isEnabled: Bool) -> VisualDiffSliderRenderConfiguration {
        VisualDiffSliderRenderConfiguration(
            title: "Interface scale",
            value: 62,
            range: 0...100,
            step: 1,
            format: { "\(Int($0.rounded()))%" },
            isEnabled: isEnabled
        )
    }

    static let renderConfigurations: [String: VisualDiffSliderRenderConfiguration] =
        Dictionary(uniqueKeysWithValues: definitions.compactMap { registration, configuration in
            guard let configuration else { return nil }
            return (registration.fixture.caseID, configuration)
        })

    static let registration = VisualDiffComponentRegistration(
        componentID: "range",
        registrations: definitions.map(\.0),
        adapter: RangeFixtureAdapter(configurations: renderConfigurations)
    )
}

private struct TextFieldFixtureAdapter: VisualDiffNativeFixtureAdapter {
    let configurations: [String: VisualDiffTextFieldRenderConfiguration]

    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView {
        guard let configuration = configurations[fixture.caseID] else {
            throw VisualDiffFixtureAdapterError.missingConfiguration(caseID: fixture.caseID)
        }
        return AnyView(TextFieldFixture(configuration: configuration))
    }
}

private struct TextFieldFixture: View {
    let configuration: VisualDiffTextFieldRenderConfiguration
    @State private var text: String
    @FocusState private var focused: Bool

    init(configuration: VisualDiffTextFieldRenderConfiguration) {
        self.configuration = configuration
        _text = State(initialValue: configuration.value)
    }

    var body: some View {
        ZStack {
            Color.clear
            DesignField(
                title: configuration.title,
                text: $text,
                accessibilityId: "visual-diff-text-field",
                focused: $focused
            )
            // The approved handoff's 736px canvas and the web fixture both use
            // a 320pt logical field. The native field retains its 44pt target.
            .frame(width: 320)
        }
        // Native focus may present a keyboard, but the capture harness owns the
        // fixed review canvas and requests focus after the native field mounts.
        .ignoresSafeArea()
    }
}

private enum TextFieldFixtureCatalog {
    private struct StateDefinition {
        let id: String
        let applicability: VisualDiffFixtureApplicability
        let shouldFocus: Bool

        static func supported(_ id: String, shouldFocus: Bool = false) -> Self {
            Self(id: id, applicability: .supported, shouldFocus: shouldFocus)
        }

        static func missingAuthority(
            _ id: String,
            reason: VisualDiffMissingAuthorityReason = .stateNotApplicable
        ) -> Self {
            Self(id: id, applicability: .missingAuthority(reason), shouldFocus: false)
        }
    }

    private static let states: [StateDefinition] = [
        .supported("rest"),
        .missingAuthority("hover"),
        .supported("focus", shouldFocus: true),
        .missingAuthority("empty"),
        .missingAuthority("error"),
        .missingAuthority("disabled"),
        .missingAuthority("loading"),
        .missingAuthority("pressed"),
        .missingAuthority("selected"),
    ]

    private static let definitions: [(VisualDiffFixtureRegistration, VisualDiffTextFieldRenderConfiguration?)] =
        states.map { state in
            let fixture = VisualDiffFixtureCase(
                caseID: "text-field--filled--\(state.id)",
                componentID: "text-field",
                variantID: "filled",
                stateID: state.id
            )
            let configuration = state.applicability == .supported
                ? VisualDiffTextFieldRenderConfiguration(
                    title: "Display name",
                    value: "Maya Chen",
                    shouldFocus: state.shouldFocus
                )
                : nil
            return (
                VisualDiffFixtureRegistration(
                    fixture: fixture,
                    applicability: state.applicability
                ),
                configuration
            )
        }

    static let renderConfigurations: [String: VisualDiffTextFieldRenderConfiguration] =
        Dictionary(uniqueKeysWithValues: definitions.compactMap { registration, configuration in
            guard let configuration else { return nil }
            return (registration.fixture.caseID, configuration)
        })

    static let registration = VisualDiffComponentRegistration(
        componentID: "text-field",
        registrations: definitions.map(\.0),
        adapter: TextFieldFixtureAdapter(configurations: renderConfigurations)
    )
}

private struct TextAreaFixtureAdapter: VisualDiffNativeFixtureAdapter {
    let configurations: [String: VisualDiffTextAreaRenderConfiguration]

    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView {
        guard let configuration = configurations[fixture.caseID] else {
            throw VisualDiffFixtureAdapterError.missingConfiguration(caseID: fixture.caseID)
        }
        return AnyView(TextAreaFixture(configuration: configuration))
    }
}

private struct TextAreaFixture: View {
    let configuration: VisualDiffTextAreaRenderConfiguration
    @State private var text: String
    @FocusState private var focused: Bool

    init(configuration: VisualDiffTextAreaRenderConfiguration) {
        self.configuration = configuration
        _text = State(initialValue: configuration.text)
    }

    var body: some View {
        ZStack {
            Color.clear
            DesignMultilineEditor(
                title: configuration.title,
                text: $text,
                accessibilityId: "visual-diff-text-area",
                focused: $focused
            )
            .frame(width: 320)
        }
        .ignoresSafeArea()
        .task {
            if configuration.shouldFocus { focused = true }
        }
    }
}

private enum TextAreaFixtureCatalog {
    private struct StateDefinition {
        let id: String
        let applicability: VisualDiffFixtureApplicability
        let shouldFocus: Bool

        static func supported(_ id: String, shouldFocus: Bool = false) -> Self {
            Self(id: id, applicability: .supported, shouldFocus: shouldFocus)
        }

        static func unavailable(
            _ id: String,
            reason: VisualDiffMissingAuthorityReason
        ) -> Self {
            Self(id: id, applicability: .missingAuthority(reason), shouldFocus: false)
        }
    }

    private static let states = [
        StateDefinition.supported("rest"),
        StateDefinition.unavailable("hover", reason: .stateNotApplicable),
        StateDefinition.supported("focus", shouldFocus: true),
    ]

    private static let definitions: [(VisualDiffFixtureRegistration, VisualDiffTextAreaRenderConfiguration?)] =
        states.map { state in
            let fixture = VisualDiffFixtureCase(
                caseID: "text-area--filled--\(state.id)",
                componentID: "text-area",
                variantID: "filled",
                stateID: state.id
            )
            let configuration = state.applicability == .supported
                ? VisualDiffTextAreaRenderConfiguration(
                    title: "Description",
                    text: "Add supporting details.",
                    shouldFocus: state.shouldFocus
                )
                : nil
            return (
                VisualDiffFixtureRegistration(
                    fixture: fixture,
                    applicability: state.applicability
                ),
                configuration
            )
        }

    static let renderConfigurations: [String: VisualDiffTextAreaRenderConfiguration] =
        Dictionary(uniqueKeysWithValues: definitions.compactMap { registration, configuration in
            guard let configuration else { return nil }
            return (registration.fixture.caseID, configuration)
        })

    static let registration = VisualDiffComponentRegistration(
        componentID: "text-area",
        registrations: definitions.map(\.0),
        adapter: TextAreaFixtureAdapter(configurations: renderConfigurations)
    )
}

private struct IconButtonFixtureAdapter: VisualDiffNativeFixtureAdapter {
    let configurations: [String: VisualDiffIconButtonRenderConfiguration]

    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView {
        guard let configuration = configurations[fixture.caseID] else {
            throw VisualDiffFixtureAdapterError.missingConfiguration(caseID: fixture.caseID)
        }
        return AnyView(IconButtonFixture(configuration: configuration))
    }
}

private struct IconButtonFixture: View {
    let configuration: VisualDiffIconButtonRenderConfiguration

    var body: some View {
        ZStack {
            Color.clear
            if configuration.compact {
                DesignCompactIconButton(
                    systemName: configuration.systemName,
                    label: configuration.label,
                    role: configuration.role,
                    state: configuration.state,
                    action: {}
                )
            } else {
                standardButton
            }
        }
    }

    private var standardButton: some View {
        DesignIconButton(
            systemName: configuration.systemName,
            label: configuration.label,
            role: configuration.role,
            state: configuration.state,
            action: {}
        )
    }
}

private enum IconButtonFixtureCatalog {
    private struct Variant {
        let id: String
        let roleID: String
        let role: DesignButtonRole
        let systemName: String
        let label: String
        let states: [State]
    }

    private struct State {
        let id: String
        let applicability: VisualDiffFixtureApplicability
        let controlState: DesignControlState?
        let compact: Bool

        static func supported(
            _ id: String,
            state: DesignControlState = .normal,
            compact: Bool = false
        ) -> Self {
            Self(
                id: id,
                applicability: .supported,
                controlState: state,
                compact: compact
            )
        }

        static func compactRest() -> Self {
            supported("compact-rest", compact: true)
        }

        static func compactDisabled() -> Self {
            supported("compact-disabled", state: .disabled, compact: true)
        }

        static func unavailable(_ id: String, reason: VisualDiffMissingAuthorityReason) -> Self {
            Self(
                id: id,
                applicability: .missingAuthority(reason),
                controlState: nil,
                compact: id.hasPrefix("compact-")
            )
        }
    }

    private static let variants: [Variant] = [
        Variant(
            id: "default",
            roleID: "default",
            role: .secondary,
            systemName: "plus",
            label: "Add item",
            // iPhone has no pointer hover. Focus and press are native
            // interaction states, but this static XCTest path cannot hold
            // them without a test-only gesture/focus seam.
            states: [
                .supported("rest"),
                .compactRest(),
                .supported("disabled", state: .disabled),
                .compactDisabled(),
                .unavailable("focus", reason: .stateRequiresInteraction),
                .unavailable("hover", reason: .stateNotApplicable),
                .unavailable("pressed", reason: .stateRequiresInteraction),
            ]
        ),
        Variant(
            id: "quiet",
            roleID: "quiet",
            role: .quiet,
            systemName: "ellipsis",
            label: "More options",
            states: [
                .supported("rest"),
                .compactRest(),
                .unavailable("focus", reason: .stateRequiresInteraction),
                .unavailable("hover", reason: .stateNotApplicable),
                .unavailable("pressed", reason: .stateRequiresInteraction),
            ]
        ),
        Variant(
            id: "destructive",
            roleID: "destructive",
            role: .destructive,
            systemName: "multiply",
            label: "Delete item",
            states: [
                .supported("rest"),
                .compactRest(),
                .unavailable("focus", reason: .stateRequiresInteraction),
                .unavailable("hover", reason: .stateNotApplicable),
                .unavailable("pressed", reason: .stateRequiresInteraction),
            ]
        ),
    ]

    private static let definitions: [(VisualDiffFixtureRegistration, VisualDiffIconButtonRenderConfiguration?)] =
        variants.flatMap { variant in
            variant.states.map { state in
                let fixture = VisualDiffFixtureCase(
                    caseID: "icon-button--\(variant.id)--\(state.id)",
                    componentID: "icon-button",
                    variantID: variant.id,
                    stateID: state.id
                )
                let configuration = state.controlState.map {
                    VisualDiffIconButtonRenderConfiguration(
                        roleID: variant.roleID,
                        role: variant.role,
                        systemName: $0 == .disabled ? "minus" : variant.systemName,
                        label: $0 == .disabled ? "Unavailable action" : variant.label,
                        state: $0,
                        compact: state.compact
                    )
                }
                return (
                    VisualDiffFixtureRegistration(
                        fixture: fixture,
                        applicability: state.applicability
                    ),
                    configuration
                )
            }
        }

    static let renderConfigurations: [String: VisualDiffIconButtonRenderConfiguration] =
        Dictionary(uniqueKeysWithValues: definitions.compactMap { registration, configuration in
            guard let configuration else { return nil }
            return (registration.fixture.caseID, configuration)
        })

    static let registration = VisualDiffComponentRegistration(
        componentID: "icon-button",
        registrations: definitions.map(\.0),
        adapter: IconButtonFixtureAdapter(configurations: renderConfigurations)
    )
}

private struct CheckboxFixtureAdapter: VisualDiffNativeFixtureAdapter {
    let configurations: [String: VisualDiffCheckboxRenderConfiguration]

    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView {
        guard let configuration = configurations[fixture.caseID] else {
            throw VisualDiffFixtureAdapterError.missingConfiguration(caseID: fixture.caseID)
        }
        return AnyView(CheckboxFixture(configuration: configuration))
    }
}

private struct CheckboxFixture: View {
    let configuration: VisualDiffCheckboxRenderConfiguration
    @State private var isOn: Bool

    init(configuration: VisualDiffCheckboxRenderConfiguration) {
        self.configuration = configuration
        _isOn = State(initialValue: configuration.isOn)
    }

    var body: some View {
        ZStack {
            Color.clear
            DesignCheckbox(
                title: configuration.title,
                isOn: $isOn,
                isEnabled: configuration.isEnabled
            )
        }
    }
}

private enum CheckboxFixtureCatalog {
    private struct Variant {
        let id: String
        let title: String
        let isOn: Bool
        let isEnabled: Bool
        let states: [State]
    }

    private struct State {
        let id: String
        let applicability: VisualDiffFixtureApplicability

        static func supported(_ id: String) -> Self {
            Self(id: id, applicability: .supported)
        }

        static func unavailable(
            _ id: String,
            reason: VisualDiffMissingAuthorityReason
        ) -> Self {
            Self(id: id, applicability: .missingAuthority(reason))
        }
    }

    private static let variants: [Variant] = [
        Variant(
            id: "checked",
            title: "Selected",
            isOn: true,
            isEnabled: true,
            states: [
                .supported("rest"),
                .unavailable("focus", reason: .stateRequiresInteraction),
                .unavailable("hover", reason: .stateNotApplicable),
                .unavailable("pressed", reason: .stateRequiresInteraction),
            ]
        ),
        Variant(
            id: "unchecked",
            title: "Not selected",
            isOn: false,
            isEnabled: true,
            states: [
                .supported("rest"),
                .unavailable("focus", reason: .stateRequiresInteraction),
                .unavailable("hover", reason: .stateNotApplicable),
                .unavailable("pressed", reason: .stateRequiresInteraction),
            ]
        ),
        Variant(
            id: "mixed",
            title: "Mixed",
            isOn: false,
            isEnabled: true,
            // iOS has no authoritative mixed value in the current product
            // model. Keep these handoff cases explicit rather than rendering
            // a fabricated state through the binary native Toggle API.
            states: [
                .unavailable("rest", reason: .stateNotApplicable),
                .unavailable("focus", reason: .stateNotApplicable),
                .unavailable("hover", reason: .stateNotApplicable),
                .unavailable("pressed", reason: .stateNotApplicable),
            ]
        ),
        Variant(
            id: "disabled",
            title: "Unavailable",
            isOn: false,
            isEnabled: false,
            states: [.supported("rest")]
        ),
    ]

    private static let definitions: [(VisualDiffFixtureRegistration, VisualDiffCheckboxRenderConfiguration?)] =
        variants.flatMap { variant in
            variant.states.map { state in
                let fixture = VisualDiffFixtureCase(
                    caseID: "checkbox--\(variant.id)--\(state.id)",
                    componentID: "checkbox",
                    variantID: variant.id,
                    stateID: state.id
                )
                let configuration = state.applicability == .supported
                    ? VisualDiffCheckboxRenderConfiguration(
                        title: variant.title,
                        isOn: variant.isOn,
                        isEnabled: variant.isEnabled
                    )
                    : nil
                return (
                    VisualDiffFixtureRegistration(
                        fixture: fixture,
                        applicability: state.applicability
                    ),
                    configuration
                )
            }
        }

    static let renderConfigurations: [String: VisualDiffCheckboxRenderConfiguration] =
        Dictionary(uniqueKeysWithValues: definitions.compactMap { registration, configuration in
            guard let configuration else { return nil }
            return (registration.fixture.caseID, configuration)
        })

    static let registration = VisualDiffComponentRegistration(
        componentID: "checkbox",
        registrations: definitions.map(\.0),
        adapter: CheckboxFixtureAdapter(configurations: renderConfigurations)
    )
}

private enum PlateFixtureMetrics {
    // These values follow the immutable plate CSS rather than compensating
    // for a particular renderer: `.snt-plate__head` is 14px / 12px and the
    // card subtitle's margin is 3px.
    static let titleLineHeight = DesignMetrics.controlLabelSize * 1.35
    static let subtitleLineHeight = TypeScale.sm * 1.5
    static let bodyLineHeight = TypeScale.base * CGFloat(DesignV2.Typography.lineNormal)
    static let subtitleMargin: CGFloat = 3

    // SwiftUI's overlay border does not consume layout. These insets preserve
    // the CSS border-box before applying the source padding values.
    static let borderInset = DesignMetrics.hairline
    static let canvasInset = Space.md * 2
    static let headerTopPadding = 14 + borderInset
    // SwiftUI rounds this fractional line box at the 2x handoff scale;
    // retaining the half-point leading keeps the divider in the same physical
    // row as the CSS border-box.
    static let headerBottomPadding = 12 + borderInset + borderInset / 2
    static let bodyTopPadding = Space.lg + borderInset
    static let bodyBottomPadding = Space.lg - borderInset / 2

    // The handoff captures fixed CSS px at the default accessibility size. Use
    // the bundled faces directly so SwiftUI's relative text scaling does not
    // change the isolated reference geometry.
    static let titleFont = Font(
        UIFont(name: "DMSans-SemiBold", size: DesignMetrics.controlLabelSize)!
    )
    static let subtitleFont = Font(
        UIFont(name: "DMSans-Regular", size: TypeScale.sm)!
    )
    static let bodyFont = Font(
        UIFont(name: "DMSans-Regular", size: TypeScale.base)!
    )

    static func horizontalPadding(_ prototypePadding: CGFloat) -> CGFloat {
        prototypePadding + borderInset
    }
}

private struct PlateFixtureAdapter: VisualDiffNativeFixtureAdapter {
    let configurations: [String: VisualDiffPlateRenderConfiguration]

    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView {
        guard let configuration = configurations[fixture.caseID] else {
            throw VisualDiffFixtureAdapterError.missingConfiguration(caseID: fixture.caseID)
        }

        return AnyView(
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: PlateFixtureMetrics.subtitleMargin) {
                    Text("Foundation plate")
                        .font(PlateFixtureMetrics.titleFont)
                        // Mirrors `.snt-card-title { letter-spacing: -.005em; }`.
                        .kerning(-DesignMetrics.controlLabelSize * 0.005)
                        .foregroundStyle(DuskColors.ink)
                        // Keep each native text run in one render-time
                        // compositing pass; this is not output post-processing.
                        .drawingGroup()
                        .frame(minHeight: PlateFixtureMetrics.titleLineHeight, alignment: .topLeading)
                    Text("Stable low-elevation surface.")
                        .font(PlateFixtureMetrics.subtitleFont)
                        // CoreText places this face one half-point higher than
                        // the CSS line box; keep the baseline in that box.
                        .baselineOffset(-PlateFixtureMetrics.borderInset / 2)
                        .foregroundStyle(DuskColors.ink2)
                        .drawingGroup()
                        .frame(minHeight: PlateFixtureMetrics.subtitleLineHeight, alignment: .topLeading)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, PlateFixtureMetrics.headerTopPadding)
                .padding(.horizontal, PlateFixtureMetrics.horizontalPadding(configuration.horizontalPadding))
                .padding(.bottom, PlateFixtureMetrics.headerBottomPadding)
                .background(
                    LinearGradient(
                        colors: [
                            DuskColors.bgElev,
                            DuskColors.bgElev.overlaying(DuskColors.paper, opacity: 0.60),
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .overlay(alignment: .bottom) {
                    Rectangle()
                        .fill(DuskColors.lineSoft)
                        .frame(height: DesignMetrics.hairline)
                }

                Text("Grouped content rests on a quiet slate.")
                    .font(PlateFixtureMetrics.bodyFont)
                    .foregroundStyle(DuskColors.ink2)
                    .drawingGroup()
                    .frame(minHeight: PlateFixtureMetrics.bodyLineHeight, alignment: .topLeading)
                    .padding(.horizontal, PlateFixtureMetrics.horizontalPadding(configuration.horizontalPadding))
                    .padding(.top, PlateFixtureMetrics.bodyTopPadding)
                    .padding(.bottom, PlateFixtureMetrics.bodyBottomPadding)
            }
            .designPlate()
            .padding(PlateFixtureMetrics.canvasInset)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        )
    }
}

private enum PlateFixtureCatalog {
    private static let supportedCases: [(String, Bool)] = [
        ("rest", false),
        ("compact-rest", true),
    ]
    private static let notApplicableStates = [
        "hover",
        "focus",
        "pressed",
        "selected",
        "disabled",
        "loading",
        "error",
    ]

    private static let definitions: [VisualDiffFixtureRegistration] =
        supportedCases.map { stateID, _ in
            VisualDiffFixtureRegistration(
                fixture: VisualDiffFixtureCase(
                    caseID: "plate--default--\(stateID)",
                    componentID: "plate",
                    variantID: "default",
                    stateID: stateID
                ),
                applicability: .supported
            )
        }
        + notApplicableStates.map { stateID in
            VisualDiffFixtureRegistration(
                fixture: VisualDiffFixtureCase(
                    caseID: "plate--default--\(stateID)",
                    componentID: "plate",
                    variantID: "default",
                    stateID: stateID
                ),
                applicability: .missingAuthority(.stateNotApplicable)
            )
        }

    static let renderConfigurations: [String: VisualDiffPlateRenderConfiguration] =
        Dictionary(uniqueKeysWithValues: supportedCases.map { stateID, compact in
            (
                "plate--default--\(stateID)",
                VisualDiffPlateRenderConfiguration(
                    compact: compact,
                    horizontalPadding: compact ? 14 : Space.lg
                )
            )
        })

    static let registration = VisualDiffComponentRegistration(
        componentID: "plate",
        registrations: definitions,
        adapter: PlateFixtureAdapter(configurations: renderConfigurations)
    )
}

private struct UserAvatarFixtureAdapter: VisualDiffNativeFixtureAdapter {
    let configurations: [String: VisualDiffUserAvatarRenderConfiguration]

    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView {
        guard let configuration = configurations[fixture.caseID] else {
            throw VisualDiffFixtureAdapterError.missingConfiguration(caseID: fixture.caseID)
        }

        return AnyView(
            ZStack {
                Color.clear
                ElevatedUserAvatar(
                    name: configuration.name,
                    size: configuration.size,
                    tint: configuration.tint,
                    selected: configuration.selected,
                    disabled: configuration.disabled,
                    fallback: configuration.fallback,
                    initial: configuration.initial
                )
            }
        )
    }
}

private enum UserAvatarFixtureCatalog {
    private static let definitions: [(VisualDiffFixtureRegistration, VisualDiffUserAvatarRenderConfiguration)] = [
        (definition("amber-44"), configuration(size: 44, tint: .amber, name: "Jordan Chen", initial: "J")),
        (definition("clay-44"), configuration(size: 44, tint: .clay, name: "Riley Chen", initial: "R")),
        (definition("fallback-44"), configuration(size: 44, tint: .fallback, name: "Unknown user", initial: "?", fallback: true)),
        (definition("sage-44"), configuration(size: 44, tint: .sage, name: "Alex Chen", initial: "A")),
        (definition("terra-28"), configuration(size: 28, tint: .terra, name: "Maya Chen", initial: "M")),
        (definition("terra-44", stateID: "disabled"), configuration(size: 44, tint: .terra, name: "Maya Chen", initial: "M", disabled: true)),
        (definition("terra-44"), configuration(size: 44, tint: .terra, name: "Maya Chen", initial: "M")),
        (definition("terra-44", stateID: "selected"), configuration(size: 44, tint: .terra, name: "Maya Chen", initial: "M", selected: true)),
        (definition("terra-56"), configuration(size: 56, tint: .terra, name: "Maya Chen", initial: "M")),
    ]

    static let renderConfigurations: [String: VisualDiffUserAvatarRenderConfiguration] =
        Dictionary(uniqueKeysWithValues: definitions.map { registration, configuration in
            (registration.fixture.caseID, configuration)
        })

    static let registration = VisualDiffComponentRegistration(
        componentID: "user-avatar",
        registrations: definitions.map(\.0),
        adapter: UserAvatarFixtureAdapter(configurations: renderConfigurations)
    )

    private static func definition(
        _ variantID: String,
        stateID: String = "rest"
    ) -> VisualDiffFixtureRegistration {
        let caseID = "user-avatar--\(variantID)--\(stateID)"
        return VisualDiffFixtureRegistration(
            fixture: VisualDiffFixtureCase(
                caseID: caseID,
                componentID: "user-avatar",
                variantID: variantID,
                stateID: stateID
            ),
            applicability: .supported
        )
    }

    private static func configuration(
        size: CGFloat,
        tint: DesignUserAvatarTint,
        name: String,
        initial: String,
        selected: Bool = false,
        disabled: Bool = false,
        fallback: Bool = false
    ) -> VisualDiffUserAvatarRenderConfiguration {
        VisualDiffUserAvatarRenderConfiguration(
            name: name,
            initial: initial,
            size: size,
            tint: tint,
            selected: selected,
            disabled: disabled,
            fallback: fallback
        )
    }
}

private enum ActionButtonFixtureCatalog {
    private static let variants: [ActionButtonVariantDefinition] = [
        ActionButtonVariantDefinition(
            id: "primary",
            roleID: "primary",
            role: .action,
            title: "Allow once",
            states: [
                .supported("rest"),
                .compactRest(),
                .missingAuthority("focus"),
                .missingAuthority("hover"),
                .missingAuthority("pressed"),
            ]
        ),
        ActionButtonVariantDefinition(
            id: "secondary",
            roleID: "secondary",
            role: .secondary,
            title: "Always allow",
            states: [
                .supported("rest"),
                .compactRest(),
                .supported(
                    "disabled",
                    state: .disabled,
                    titleOverride: "Unavailable"
                ),
                .supported(
                    "compact-disabled",
                    state: .disabled,
                    titleOverride: "Unavailable",
                    visualHeight: DesignMetrics.minimumTarget
                ),
                .missingAuthority("focus"),
                .missingAuthority("hover"),
                .missingAuthority("pressed"),
            ]
        ),
        ActionButtonVariantDefinition(
            id: "quiet",
            roleID: "quiet",
            role: .quiet,
            title: "Not now",
            states: [
                .supported("rest"),
                .compactRest(),
                .missingAuthority("focus"),
                .missingAuthority("hover"),
                .missingAuthority("pressed"),
            ]
        ),
        ActionButtonVariantDefinition(
            id: "destructive",
            roleID: "destructive",
            role: .destructive,
            title: "Stop",
            states: [
                .supported("rest"),
                .compactRest(),
                .missingAuthority("focus"),
                .missingAuthority("hover"),
                .missingAuthority("pressed"),
            ]
        ),
    ]

    private static let definitions: [ActionButtonFixtureDefinition] = variants.flatMap { variant in
        variant.states.map { state in
            let fixture = VisualDiffFixtureCase(
                caseID: "action-button--\(variant.id)--\(state.id)",
                componentID: "action-button",
                variantID: variant.id,
                stateID: state.id
            )
            let renderConfiguration: VisualDiffActionButtonRenderConfiguration?
            if let controlState = state.state, let visualHeight = state.visualHeight {
                renderConfiguration = VisualDiffActionButtonRenderConfiguration(
                    roleID: variant.roleID,
                    role: variant.role,
                    title: state.titleOverride ?? variant.title,
                    state: controlState,
                    fillsWidth: false,
                    visualHeight: visualHeight
                )
            } else {
                renderConfiguration = nil
            }
            return ActionButtonFixtureDefinition(
                registration: VisualDiffFixtureRegistration(
                    fixture: fixture,
                    applicability: state.applicability
                ),
                renderConfiguration: renderConfiguration
            )
        }
    }

    static let renderConfigurations: [String: VisualDiffActionButtonRenderConfiguration] =
        Dictionary(uniqueKeysWithValues: definitions.compactMap { definition in
            guard let configuration = definition.renderConfiguration else { return nil }
            return (definition.registration.fixture.caseID, configuration)
        })

    static let registration: VisualDiffComponentRegistration = VisualDiffComponentRegistration(
        componentID: "action-button",
        registrations: definitions.map(\.registration),
        adapter: ActionButtonFixtureAdapter(configurations: renderConfigurations)
    )
}
