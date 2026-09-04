import MobileData
import SwiftUI
@testable import SentientApp

enum ComposerVisualFixtureState: String, Equatable {
    case idle
    case textReady
    case responding
    case hold
    case auto
    case autoResponding
    case tasks

    var talkMode: TalkMode {
        switch self {
        case .hold: .hold
        case .auto, .autoResponding: .continuous
        default: .idle
        }
    }

    var draft: String {
        self == .textReady
            ? "Can you review tomorrow and prepare the safest adjustment?"
            : ""
    }

    var canInterrupt: Bool {
        self == .responding || self == .autoResponding
    }

    var tasks: [TaskListItem] {
        guard self == .tasks else { return [] }
        return [
            TaskListItem(
                id: "travel",
                toolName: "Check travel",
                kind: "background",
                status: "running",
                argsPreview: "Friday evening · four people",
                startedAtMs: 0,
                endedAtMs: nil
            ),
            TaskListItem(
                id: "draft",
                toolName: "Prepare draft",
                kind: "foreground",
                status: "done",
                argsPreview: "Cozy seasonal menu",
                startedAtMs: 0,
                endedAtMs: nil
            ),
            TaskListItem(
                id: "approval",
                toolName: "Approval needed",
                kind: "foreground",
                status: "permission",
                argsPreview: "Send the proposed itinerary",
                startedAtMs: 0,
                endedAtMs: nil
            ),
        ]
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
    private static func definition(
        caseID: String,
        state: ComposerVisualFixtureState
    ) -> (VisualDiffFixtureRegistration, ComposerVisualFixtureState) {
        let parts = caseID.split(separator: "--")
        let fixture = VisualDiffFixtureCase(
            caseID: caseID,
            componentID: "composer",
            variantID: parts.count > 1 ? String(parts[1]) : state.rawValue,
            stateID: parts.count > 2 ? String(parts[2]) : "compact"
        )
        return (
            VisualDiffFixtureRegistration(fixture: fixture, applicability: .supported),
            state
        )
    }

    private static let definitions = [
        definition(caseID: "composer--idle--compact", state: .idle),
        definition(caseID: "composer--text-ready--compact", state: .textReady),
        definition(caseID: "composer--responding--compact", state: .responding),
        definition(caseID: "composer--hold-send--compact", state: .hold),
        definition(caseID: "composer--auto--compact", state: .auto),
        definition(caseID: "composer--auto-responding--compact", state: .autoResponding),
        definition(caseID: "composer--tasks--desktop", state: .tasks),
    ]

    static let renderConfigurations: [String: ComposerVisualFixtureState] =
        Dictionary(uniqueKeysWithValues: definitions.map { registration, configuration in
            (registration.fixture.caseID, configuration)
        })

    static let registration = VisualDiffComponentRegistration(
        componentID: "composer",
        registrations: definitions.map(\.0),
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
                ttsEnabled: true,
                talkMode: state.talkMode,
                micLevels: [
                    0.16, 0.38, 0.72, 0.46, 0.88, 0.3, 0.62, 0.94,
                    0.48, 0.74, 0.28, 0.58, 0.82, 0.36, 0.68, 0.42,
                ],
                voiceDisabled: false,
                canInterrupt: state.canInterrupt,
                initialDraft: state.draft,
                onSend: { _ in },
                onVoiceIntent: { _ in },
                onTtsToggle: {},
                onInterrupt: {},
                onFocusGained: {}
            )
            .environment(\.horizontalSizeClass, state == .tasks ? .regular : .compact)
            .frame(width: state == .tasks ? 876 : 386)
            .padding(.top, 46)
        }
        .ignoresSafeArea()
    }
}
