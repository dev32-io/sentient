import SwiftUI
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

enum VisualDiffFixtureRegistry {
    private static let components: [String: VisualDiffComponentRegistration] = [
        ActionButtonFixtureCatalog.registration.componentID: ActionButtonFixtureCatalog.registration,
        IconButtonFixtureCatalog.registration.componentID: IconButtonFixtureCatalog.registration,
        PlateFixtureCatalog.registration.componentID: PlateFixtureCatalog.registration,
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

private enum PlateFixtureMetrics {
    // These values follow the immutable plate CSS rather than compensating
    // for a particular renderer: `.snt-plate__head` is 14px / 12px and the
    // card subtitle's margin is 3px.
    static let subtitleMargin: CGFloat = 3
    static let canvasInset = Space.md * 2
    static let headerTopPadding: CGFloat = 14
    static let headerBottomPadding: CGFloat = 12
    static let bodyVerticalPadding = Space.lg

    // Use the same project typography adapter as native production surfaces.
    static let titleFont = Typo.ui(DesignMetrics.controlLabelSize, .semibold)
    static let subtitleFont = Typo.ui(TypeScale.sm)
    static let bodyFont = Typo.ui(TypeScale.base)
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
                    Text("Stable low-elevation surface.")
                        .font(PlateFixtureMetrics.subtitleFont)
                        .foregroundStyle(DuskColors.ink2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, PlateFixtureMetrics.headerTopPadding)
                .padding(.horizontal, configuration.horizontalPadding)
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
                    .padding(.horizontal, configuration.horizontalPadding)
                    .padding(.vertical, PlateFixtureMetrics.bodyVerticalPadding)
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
