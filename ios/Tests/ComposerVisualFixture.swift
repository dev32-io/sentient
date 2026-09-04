import MobileData
import SwiftUI
@testable import SentientApp

enum ComposerVisualFixtureState: String, Equatable {
    case idle
    case idleDesktop
    case textReady
    case textReadyDesktop
    case responding
    case respondingDesktop
    case focus
    case focusDesktop
    case multiline
    case multilineDesktop
    case ttsOffDesktop
    case hold
    case holdDesktop
    case holdReducedMotion
    case auto
    case autoDesktop
    case autoReducedMotion
    case autoResponding
    case autoRespondingDesktop
    case tasks
    case taskTravelOpen
    case taskDraftOpen
    case accessibilityAutoDraftResponding
    case rightToLeftHold

    static let authoritativeTaskItems = [
        TaskListItem(
            id: "travel",
            toolName: "Check travel",
            kind: "background",
            status: "running",
            argsPreview: "Friday evening · four people",
            startedAtMs: 1_000,
            endedAtMs: nil
        ),
        TaskListItem(
            id: "draft",
            toolName: "Prepare draft",
            kind: "foreground",
            status: "done",
            argsPreview: "Cozy seasonal menu",
            startedAtMs: 1_100,
            endedAtMs: 1_500
        ),
        TaskListItem(
            id: "calendar",
            toolName: "Update calendar",
            kind: "foreground",
            status: "error",
            argsPreview: "Shared family calendar",
            startedAtMs: 1_200,
            endedAtMs: 1_600
        ),
    ]

    var talkMode: TalkMode {
        switch self {
        case .hold, .holdDesktop, .holdReducedMotion, .rightToLeftHold:
            .hold
        case .auto, .autoDesktop, .autoReducedMotion, .autoResponding,
             .autoRespondingDesktop, .accessibilityAutoDraftResponding:
            .continuous
        default:
            .idle
        }
    }

    var draft: String {
        switch self {
        case .textReady, .textReadyDesktop:
            "Can you review tomorrow and prepare the safest adjustment?"
        case .multiline, .multilineDesktop:
            "Can you review tomorrow’s schedule?\nKeep the appointment in place, and move only the pickup."
        case .accessibilityAutoDraftResponding:
            "Please keep this draft while Auto listens."
        default:
            ""
        }
    }

    var canInterrupt: Bool {
        switch self {
        case .responding, .respondingDesktop, .autoResponding,
             .autoRespondingDesktop, .accessibilityAutoDraftResponding:
            true
        default:
            false
        }
    }

    var ttsEnabled: Bool { self != .ttsOffDesktop }

    var tasks: [TaskListItem] {
        switch self {
        case .tasks, .taskTravelOpen, .taskDraftOpen:
            Self.authoritativeTaskItems
        default:
            []
        }
    }

    var initiallyExpandedTaskId: String? {
        switch self {
        case .taskTravelOpen: "travel"
        case .taskDraftOpen: "draft"
        default: nil
        }
    }

    var isDesktop: Bool {
        switch self {
        case .idleDesktop, .textReadyDesktop, .respondingDesktop, .focusDesktop,
             .multilineDesktop, .ttsOffDesktop, .holdDesktop, .autoDesktop,
             .autoRespondingDesktop, .tasks, .taskTravelOpen, .taskDraftOpen:
            true
        default:
            false
        }
    }

    var composerWidth: CGFloat {
        switch self {
        case .accessibilityAutoDraftResponding, .rightToLeftHold: 320
        default: isDesktop ? 876 : 386
        }
    }

    var dynamicTypeSize: DynamicTypeSize {
        self == .accessibilityAutoDraftResponding ? .accessibility3 : .large
    }

    var layoutDirection: LayoutDirection {
        self == .rightToLeftHold ? .rightToLeft : .leftToRight
    }

    var reduceMotion: Bool {
        self == .holdReducedMotion || self == .autoReducedMotion
    }
}

struct ComposerVisualFixtureAdapter: VisualDiffNativeFixtureAdapter {
    let configurations: [String: ComposerVisualFixtureState]

    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView {
        guard let state = configurations[fixture.caseID] else {
            throw VisualDiffFixtureAdapterError.missingConfiguration(caseID: fixture.caseID)
        }
        return AnyView(ComposerVisualFixture(state: state))
    }
}

enum ComposerVisualFixtureCatalog {
    private static func fixtureCase(_ caseID: String) -> VisualDiffFixtureCase {
        let parts = caseID.split(separator: "--")
        return VisualDiffFixtureCase(
            caseID: caseID,
            componentID: "composer",
            variantID: parts.count > 1 ? String(parts[1]) : "default",
            stateID: parts.count > 2 ? String(parts[2]) : "compact"
        )
    }

    private static func definition(
        caseID: String,
        state: ComposerVisualFixtureState
    ) -> (VisualDiffFixtureRegistration, ComposerVisualFixtureState) {
        (
            VisualDiffFixtureRegistration(
                fixture: fixtureCase(caseID),
                applicability: .supported
            ),
            state
        )
    }

    private static func unavailable(
        _ caseID: String,
        reason: VisualDiffMissingAuthorityReason
    ) -> VisualDiffFixtureRegistration {
        VisualDiffFixtureRegistration(
            fixture: fixtureCase(caseID),
            applicability: .missingAuthority(reason)
        )
    }

    private static let supportedDefinitions = [
        definition(caseID: "composer--idle--compact", state: .idle),
        definition(caseID: "composer--idle--desktop", state: .idleDesktop),
        definition(caseID: "composer--text-ready--compact", state: .textReady),
        definition(caseID: "composer--text-ready--desktop", state: .textReadyDesktop),
        definition(caseID: "composer--responding--compact", state: .responding),
        definition(caseID: "composer--responding--desktop", state: .respondingDesktop),
        definition(caseID: "composer--focus--compact", state: .focus),
        definition(caseID: "composer--focus--desktop", state: .focusDesktop),
        definition(caseID: "composer--multiline--compact", state: .multiline),
        definition(caseID: "composer--multiline--desktop", state: .multilineDesktop),
        definition(caseID: "composer--tts-off--desktop", state: .ttsOffDesktop),
        definition(caseID: "composer--hold-send--compact", state: .hold),
        definition(caseID: "composer--hold-send--desktop", state: .holdDesktop),
        definition(caseID: "composer--hold--reduced-motion", state: .holdReducedMotion),
        definition(caseID: "composer--auto--compact", state: .auto),
        definition(caseID: "composer--auto--desktop", state: .autoDesktop),
        definition(caseID: "composer--auto--reduced-motion", state: .autoReducedMotion),
        definition(caseID: "composer--auto-responding--compact", state: .autoResponding),
        definition(caseID: "composer--auto-responding--desktop", state: .autoRespondingDesktop),
        definition(caseID: "composer--tasks--desktop", state: .tasks),
        definition(caseID: "composer--task-travel-open--desktop", state: .taskTravelOpen),
        definition(caseID: "composer--task-draft-open--desktop", state: .taskDraftOpen),
        definition(
            caseID: "composer--auto-draft-responding--accessibility-compact",
            state: .accessibilityAutoDraftResponding
        ),
        definition(caseID: "composer--hold-send--rtl-compact", state: .rightToLeftHold),
    ]

    private static let unavailableDefinitions = [
        // These targets exist only while a physical gesture is in flight. A
        // static snapshot must not add a test-only capture/gesture authority.
        unavailable("composer--hold-cancel--compact", reason: .stateRequiresInteraction),
        unavailable("composer--hold-cancel--desktop", reason: .stateRequiresInteraction),
        unavailable("composer--hold-auto--compact", reason: .stateRequiresInteraction),
        unavailable("composer--hold-auto--desktop", reason: .stateRequiresInteraction),
        // Permission review/result content is not represented by TaskListItem.
        unavailable("composer--task-permission-open--desktop", reason: .stateNotApplicable),
    ]

    static let renderConfigurations: [String: ComposerVisualFixtureState] =
        Dictionary(uniqueKeysWithValues: supportedDefinitions.map { registration, configuration in
            (registration.fixture.caseID, configuration)
        })

    static let registration = VisualDiffComponentRegistration(
        componentID: "composer",
        registrations: supportedDefinitions.map(\.0) + unavailableDefinitions,
        adapter: ComposerVisualFixtureAdapter(configurations: renderConfigurations)
    )
}

private struct ComposerVisualFixture: View {
    let state: ComposerVisualFixtureState

    var body: some View {
        ZStack(alignment: .top) {
            Color.clear
            Composer(
                tasks: state.tasks,
                ttsEnabled: state.ttsEnabled,
                talkMode: state.talkMode,
                micLevels: [
                    0.16, 0.38, 0.72, 0.46, 0.88, 0.3, 0.62, 0.94,
                    0.48, 0.74, 0.28, 0.58, 0.82, 0.36, 0.68, 0.42,
                ],
                voiceDisabled: false,
                canInterrupt: state.canInterrupt,
                initialDraft: state.draft,
                initiallyExpandedTaskId: state.initiallyExpandedTaskId,
                onSend: { _ in },
                onVoiceIntent: { _ in },
                onTtsToggle: {},
                onInterrupt: {},
                onFocusGained: {}
            )
            .environment(\.horizontalSizeClass, state.isDesktop ? .regular : .compact)
            .environment(\.dynamicTypeSize, state.dynamicTypeSize)
            .environment(\.layoutDirection, state.layoutDirection)
            .environment(\.composerReduceMotionOverride, state.reduceMotion ? true : nil)
            .frame(width: state.composerWidth)
            .padding(.top, 46)
        }
        .ignoresSafeArea()
    }
}
