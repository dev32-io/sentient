import SwiftUI
@testable import SentientApp

enum VisualDiffMissingAuthorityReason: Equatable {
    case unknownComponent
    case unknownCase
    case stateNotApplicable
}

struct VisualDiffFixtureSkip: Equatable, CustomStringConvertible {
    let caseID: String
    let reason: VisualDiffMissingAuthorityReason

    var description: String {
        switch reason {
        case .stateNotApplicable:
            return "iPhone state is blocked or not applicable for \(caseID)"
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

enum VisualDiffFixtureRegistry {
    private static let components: [String: VisualDiffComponentRegistration] = [
        ActionButtonFixtureCatalog.registration.componentID: ActionButtonFixtureCatalog.registration,
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
