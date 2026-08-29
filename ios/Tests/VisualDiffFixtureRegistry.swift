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

@MainActor
protocol VisualDiffNativeFixtureAdapter {
    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView
}

enum VisualDiffFixtureAdapterError: Error, CustomStringConvertible {
    case missingConfiguration(caseID: String)
    case riveViewUnavailable(caseID: String)

    var description: String {
        switch self {
        case .missingConfiguration(let caseID):
            return "The iOS visual fixture adapter has no configuration for \(caseID)"
        case .riveViewUnavailable(let caseID):
            return "The iOS visual fixture adapter could not mount Rive for \(caseID)"
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

struct VisualDiffValidatedFieldRenderConfiguration {
    let title: String
    let value: String
    let status: ValidatedFieldStatus?
    let counter: ValidatedFieldCounter?
    let multiline: Bool
    let maxLength: Int?
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

struct VisualDiffSearchFieldRenderConfiguration {
    let title: String
    let prompt: String
    let value: String
    let shouldFocus: Bool
}

struct VisualDiffPinRenderConfiguration {
    let entered: Int
    let isSubmitting: Bool
    let success: String?
    let reducedMotion: Bool
}

struct VisualDiffLoadingStateRenderConfiguration {
    let title: String
    let detail: String
    let reducedMotion: Bool
}

struct VisualDiffSegmentOptionConfiguration {
    let value: String
    let label: String
}

struct VisualDiffSegmentedRenderConfiguration {
    let title: String
    let options: [VisualDiffSegmentOptionConfiguration]
    let selection: String
    let visualHeight: CGFloat
}

struct VisualDiffSegmentedMotionRenderConfiguration {
    let title: String
    let options: [VisualDiffSegmentOptionConfiguration]
    let initialSelection: String
    let targetSelection: String
    let visualHeight: CGFloat
    let frameTime: TimeInterval
}

enum VisualDiffSettingRowControl {
    case toggle(isOn: Bool)
    case segmented(options: [VisualDiffSegmentOptionConfiguration], selection: String)
    case select(options: [VisualDiffSegmentOptionConfiguration], selection: String)
    case range(value: Double)
}

struct VisualDiffSettingRowRenderConfiguration {
    let title: String
    let detail: String
    let control: VisualDiffSettingRowControl
}

enum VisualDiffDisclosureBody: Equatable {
    case toggle
    case paragraph
}

struct VisualDiffDisclosureRenderConfiguration: Equatable {
    let title: String
    let description: String
    let body: VisualDiffDisclosureBody
    let initiallyExpanded: Bool
}

struct VisualDiffDisclosureMotionRenderConfiguration: Equatable {
    let configuration: VisualDiffDisclosureRenderConfiguration
    let frameTime: TimeInterval
}

struct VisualDiffSentientIdentityRenderConfiguration: Equatable {
    let initialState: SentientIdentityState
    let targetState: SentientIdentityState?
    let reducedMotion: Bool
    let timeMs: Int
}

struct VisualDiffNoticeRenderConfiguration {
    let kind: DesignNoticeKind
    let title: String
    let detail: String
    let actionTitle: String?
    let compact: Bool
}

/// Capture controller for the identity fixture. It pauses the real Rive view
/// and advances the authored state machine by explicit elapsed intervals; it
/// does not synthesize artwork or replace the production view.
@MainActor
final class VisualDiffSentientIdentityCapture {
    let configuration: VisualDiffSentientIdentityRenderConfiguration
    let model: RiveIdentityModel
    private(set) var didPrepare = false
    private(set) var preparationError: Error?

    init(configuration: VisualDiffSentientIdentityRenderConfiguration) {
        self.configuration = configuration
        model = RiveIdentityModel(
            initialState: configuration.initialState,
            reducedMotion: configuration.reducedMotion,
            autoPlay: false
        )
    }

    func makeFixture(size: CGFloat) -> AnyView {
        AnyView(
            ZStack {
                Color.clear
                RiveSentientIdentity(
                    state: configuration.initialState,
                    size: size,
                    model: model,
                    reducedMotionOverride: configuration.reducedMotion
                )
                .onAppear { self.prepareForSnapshot() }
            }
            .ignoresSafeArea()
        )
    }

    private func prepareForSnapshot() {
        guard !didPrepare else { return }
        do {
            try prepare()
            if configuration.targetState != nil {
                try beginTransition()
            }
            try advance(to: configuration.timeMs)
            didPrepare = true
        } catch {
            preparationError = error
        }
    }

    private func prepare() throws {
        guard let rive = model.riveViewModel?.riveView else {
            throw VisualDiffFixtureAdapterError.riveViewUnavailable(caseID: "sentient-identity")
        }
        model.riveViewModel?.pause()
        rive.advance(delta: 0)
    }

    private func beginTransition() throws {
        guard let targetState = configuration.targetState,
              let rive = model.riveViewModel?.riveView
        else {
            throw VisualDiffFixtureAdapterError.riveViewUnavailable(caseID: "sentient-identity-transition")
        }
        model.controller.request(targetState)
        model.riveViewModel?.pause()
        rive.advance(delta: 0)
    }

    private func advance(to timeMs: Int) throws {
        guard let rive = model.riveViewModel?.riveView else {
            throw VisualDiffFixtureAdapterError.riveViewUnavailable(caseID: "sentient-identity")
        }
        model.riveViewModel?.pause()
        rive.advance(delta: Double(timeMs) / 1_000)
    }
}

enum VisualDiffFixtureRegistry {
    private static let components: [String: VisualDiffComponentRegistration] = [
        ActionButtonFixtureCatalog.registration.componentID: ActionButtonFixtureCatalog.registration,
        IconButtonFixtureCatalog.registration.componentID: IconButtonFixtureCatalog.registration,
        CheckboxFixtureCatalog.registration.componentID: CheckboxFixtureCatalog.registration,
        PlateFixtureCatalog.registration.componentID: PlateFixtureCatalog.registration,
        UserAvatarFixtureCatalog.registration.componentID: UserAvatarFixtureCatalog.registration,
        MediaActionCardFixtureCatalog.registration.componentID: MediaActionCardFixtureCatalog.registration,
        TextFieldFixtureCatalog.registration.componentID: TextFieldFixtureCatalog.registration,
        TextAreaFixtureCatalog.registration.componentID: TextAreaFixtureCatalog.registration,
        ValidatedFieldFixtureCatalog.registration.componentID: ValidatedFieldFixtureCatalog.registration,
        ChipFixtureCatalog.registration.componentID: ChipFixtureCatalog.registration,
        RangeFixtureCatalog.registration.componentID: RangeFixtureCatalog.registration,
        SearchFieldFixtureCatalog.registration.componentID: SearchFieldFixtureCatalog.registration,
        SegmentedControlFixtureCatalog.registration.componentID: SegmentedControlFixtureCatalog.registration,
        SettingRowFixtureCatalog.registration.componentID: SettingRowFixtureCatalog.registration,
        DisclosureFixtureCatalog.registration.componentID: DisclosureFixtureCatalog.registration,
        SentientIdentityFixtureCatalog.registration.componentID: SentientIdentityFixtureCatalog.registration,
        PinEntryFixtureCatalog.registration.componentID: PinEntryFixtureCatalog.registration,
        NoticeFixtureCatalog.registration.componentID: NoticeFixtureCatalog.registration,
        LoadingStateFixtureCatalog.registration.componentID: LoadingStateFixtureCatalog.registration,
        NoResultsFixtureCatalog.registration.componentID: NoResultsFixtureCatalog.registration,
    ]

    static func resolve(caseID: String) -> VisualDiffFixtureResolution {
        let componentID = caseID
            .split(separator: "--", maxSplits: 1, omittingEmptySubsequences: false)
            .first
            .map(String.init)
        let component = componentID.flatMap { components[$0] }
            ?? components.values.first { $0.cases[caseID] != nil }
        guard let component else {
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

    static func mediaActionCardRenderConfiguration(
        for caseID: String
    ) -> VisualDiffMediaActionCardRenderConfiguration? {
        MediaActionCardFixtureCatalog.renderConfigurations[caseID]
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

    static func validatedFieldRenderConfiguration(
        for caseID: String
    ) -> VisualDiffValidatedFieldRenderConfiguration? {
        ValidatedFieldFixtureCatalog.renderConfigurations[caseID]
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

    static func searchFieldRenderConfiguration(
        for caseID: String
    ) -> VisualDiffSearchFieldRenderConfiguration? {
        SearchFieldFixtureCatalog.renderConfigurations[caseID]
    }

    static func loadingStateRenderConfiguration(
        for caseID: String
    ) -> VisualDiffLoadingStateRenderConfiguration? {
        LoadingStateFixtureCatalog.renderConfigurations[caseID]
    }

    static func segmentedControlRenderConfiguration(
        for caseID: String
    ) -> VisualDiffSegmentedRenderConfiguration? {
        SegmentedControlFixtureCatalog.renderConfigurations[caseID]
    }

    static func segmentedControlCaptureTime(for caseID: String) -> TimeInterval? {
        SegmentedControlFixtureCatalog.captureTime(for: caseID)
    }

    static func settingRowRenderConfiguration(
        for caseID: String
    ) -> VisualDiffSettingRowRenderConfiguration? {
        SettingRowFixtureCatalog.renderConfigurations[caseID]
    }

    static func disclosureRenderConfiguration(
        for caseID: String
    ) -> VisualDiffDisclosureRenderConfiguration? {
        DisclosureFixtureCatalog.renderConfigurations[caseID]
    }

    static func disclosureCaptureTime(for caseID: String) -> TimeInterval? {
        DisclosureFixtureCatalog.captureTime(for: caseID)
    }

    static func pinRenderConfiguration(
        for caseID: String
    ) -> VisualDiffPinRenderConfiguration? {
        PinEntryFixtureCatalog.renderConfigurations[caseID]
    }

    static func sentientIdentityRenderConfiguration(
        for caseID: String
    ) -> VisualDiffSentientIdentityRenderConfiguration? {
        SentientIdentityFixtureCatalog.renderConfigurations[caseID]
    }

    static func noticeRenderConfiguration(
        for caseID: String
    ) -> VisualDiffNoticeRenderConfiguration? {
        NoticeFixtureCatalog.renderConfigurations[caseID]
    }

    @MainActor
    static func sentientIdentityCapture(
        for caseID: String
    ) -> VisualDiffSentientIdentityCapture? {
        guard let configuration = sentientIdentityRenderConfiguration(for: caseID) else {
            return nil
        }
        return VisualDiffSentientIdentityCapture(configuration: configuration)
    }
}

private enum NoticeFixtureMetrics {
    // The reviewed notice artboards use the same transparent framing as the
    // approved Web fixture: 52pt leading/top and 76pt trailing inset.
    static let topPadding: CGFloat = 52
    static let leadingPadding: CGFloat = 52
    static let trailingPadding: CGFloat = 76
}

private struct NoticeFixture: View {
    let configuration: VisualDiffNoticeRenderConfiguration

    private var retry: (() -> Void)? {
        configuration.actionTitle == nil ? nil : {}
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear
            AsyncNotice(
                kind: configuration.kind,
                title: configuration.title,
                detail: configuration.detail,
                retry: retry,
                accessibilityId: "visual-diff-notice",
                actionTitle: configuration.actionTitle ?? "Retry"
            )
            .padding(.top, NoticeFixtureMetrics.topPadding)
            .padding(.leading, NoticeFixtureMetrics.leadingPadding)
            .padding(.trailing, NoticeFixtureMetrics.trailingPadding)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .ignoresSafeArea()
    }
}

private struct NoticeFixtureAdapter: VisualDiffNativeFixtureAdapter {
    let configurations: [String: VisualDiffNoticeRenderConfiguration]

    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView {
        guard let configuration = configurations[fixture.caseID] else {
            throw VisualDiffFixtureAdapterError.missingConfiguration(caseID: fixture.caseID)
        }
        return AnyView(NoticeFixture(configuration: configuration))
    }
}

private enum NoticeFixtureCatalog {
    private static func definition(
        variantID: String,
        stateID: String,
        kind: DesignNoticeKind,
        title: String,
        detail: String,
        actionTitle: String? = nil
    ) -> (VisualDiffFixtureRegistration, VisualDiffNoticeRenderConfiguration) {
        let caseID = "notice--\(variantID)--\(stateID)"
        let fixture = VisualDiffFixtureCase(
            caseID: caseID,
            componentID: "notice",
            variantID: variantID,
            stateID: stateID
        )
        return (
            VisualDiffFixtureRegistration(fixture: fixture, applicability: .supported),
            VisualDiffNoticeRenderConfiguration(
                kind: kind,
                title: title,
                detail: detail,
                actionTitle: actionTitle,
                compact: stateID == "compact"
            )
        )
    }

    private static let definitions = [
        definition(
            variantID: "info",
            stateID: "rest",
            kind: .info,
            title: "Changes apply to this device",
            detail: "Other household devices keep their current preference."
        ),
        definition(
            variantID: "warning",
            stateID: "rest",
            kind: .warning,
            title: "Permission required",
            detail: "Review the requested scope before continuing.",
            actionTitle: "Review"
        ),
        definition(
            variantID: "warning",
            stateID: "compact",
            kind: .warning,
            title: "Permission required",
            detail: "Review the requested scope before continuing.",
            actionTitle: "Review"
        ),
        definition(
            variantID: "error",
            stateID: "rest",
            kind: .error,
            title: "Couldn’t save changes",
            detail: "Your edits are still here. Try again when the connection returns.",
            actionTitle: "Retry"
        ),
        definition(
            variantID: "error",
            stateID: "compact",
            kind: .error,
            title: "Couldn’t save changes",
            detail: "Your edits are still here. Try again when the connection returns.",
            actionTitle: "Retry"
        ),
    ]

    static let renderConfigurations: [String: VisualDiffNoticeRenderConfiguration] =
        Dictionary(uniqueKeysWithValues: definitions.map { registration, configuration in
            (registration.fixture.caseID, configuration)
        })

    static let registration = VisualDiffComponentRegistration(
        componentID: "notice",
        registrations: definitions.map(\.0),
        adapter: NoticeFixtureAdapter(configurations: renderConfigurations)
    )
}

private struct NoResultsFixtureAdapter: VisualDiffNativeFixtureAdapter {
    nonisolated init() {}

    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView {
        guard fixture.caseID == "no-results--empty" else {
            throw VisualDiffFixtureAdapterError.missingConfiguration(caseID: fixture.caseID)
        }
        return AnyView(
            ZStack {
                Color.clear
                HistorySearchNoMatchState()
                    .frame(width: NoResultsFixtureMetrics.contentWidth)
            }
        )
    }
}

private enum NoResultsFixtureMetrics {
    // The reference's 468pt fixture wrapper leaves the source 14pt side
    // margins around the 440pt no-results surface.
    static let contentWidth: CGFloat = 468
}

private enum NoResultsFixtureCatalog {
    static let registration = VisualDiffComponentRegistration(
        componentID: "no-results",
        registrations: [
            VisualDiffFixtureRegistration(
                fixture: VisualDiffFixtureCase(
                    caseID: "no-results--empty",
                    componentID: "no-results",
                    variantID: "default",
                    stateID: "empty"
                ),
                applicability: .supported
            ),
        ],
        adapter: NoResultsFixtureAdapter()
    )
}

enum SentientIdentityFixtureMetrics {
    // The handoff uses a 208px 2x canvas around the 56px identity specimen;
    // the surrounding 104pt fixture remains owned by the capture test.
    static let size: CGFloat = 56
}

private struct SentientIdentityFixtureAdapter: VisualDiffNativeFixtureAdapter {
    let configurations: [String: VisualDiffSentientIdentityRenderConfiguration]

    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView {
        guard let configuration = configurations[fixture.caseID] else {
            throw VisualDiffFixtureAdapterError.missingConfiguration(caseID: fixture.caseID)
        }
        return VisualDiffSentientIdentityCapture(configuration: configuration)
            .makeFixture(size: SentientIdentityFixtureMetrics.size)
    }
}

private struct LoadingStateFixtureAdapter: VisualDiffNativeFixtureAdapter {
    let configurations: [String: VisualDiffLoadingStateRenderConfiguration]

    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView {
        guard let configuration = configurations[fixture.caseID] else {
            throw VisualDiffFixtureAdapterError.missingConfiguration(caseID: fixture.caseID)
        }

        return AnyView(
            AsyncNotice(kind: .loading, title: configuration.title, detail: configuration.detail)
                .frame(width: LoadingStateFixtureMetrics.width)
                .padding(LoadingStateFixtureMetrics.canvasInset)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        )
    }
}

private enum LoadingStateFixtureMetrics {
    // The Web fixture maps the source's 52px logical inset directly. Keep the
    // same isolated canvas placement without shifting or cropping the native view.
    static let canvasInset: CGFloat = 52
    static let width: CGFloat = 260
}

private enum LoadingStateFixtureCatalog {
    private static let cases: [(String, Bool)] = [
        ("loading-state--settings--active", false),
        ("loading-state--settings--reduced-motion", true),
    ]

    static let renderConfigurations: [String: VisualDiffLoadingStateRenderConfiguration] =
        Dictionary(uniqueKeysWithValues: cases.map { caseID, reducedMotion in
            (
                caseID,
                VisualDiffLoadingStateRenderConfiguration(
                    title: "Loading",
                    detail: "Fetching current settings…",
                    reducedMotion: reducedMotion
                )
            )
        })

    private static let definitions = cases.map { caseID, reducedMotion in
        VisualDiffFixtureRegistration(
            fixture: VisualDiffFixtureCase(
                caseID: caseID,
                componentID: "loading-state",
                variantID: "settings",
                stateID: reducedMotion ? "reduced-motion" : "active"
            ),
            applicability: .supported
        )
    }

    static let registration = VisualDiffComponentRegistration(
        componentID: "loading-state",
        registrations: definitions,
        adapter: LoadingStateFixtureAdapter(configurations: renderConfigurations)
    )
}

private enum SentientIdentityFixtureCatalog {
    private static let transitionFrames = [
        ("frame-000--0000ms", 0),
        ("frame-001--0120ms", 120),
        ("frame-002--0138ms", 138),
        ("frame-003--0250ms", 250),
    ]

    private static let thinkingLoopFrames = [
        ("frame-000--0000ms", 0),
        ("frame-001--0270ms", 270),
        ("frame-002--0540ms", 540),
        ("frame-003--0810ms", 810),
        ("frame-004--1080ms", 1_080),
        ("frame-005--1350ms", 1_350),
    ]

    private static let respondingLoopFrames = [
        ("frame-000--0000ms", 0),
        ("frame-001--0310ms", 310),
        ("frame-002--0620ms", 620),
        ("frame-003--0930ms", 930),
        ("frame-004--1240ms", 1_240),
        ("frame-005--1550ms", 1_550),
    ]

    private static func entry(
        variantID: String,
        stateID: String,
        initialState: SentientIdentityState,
        targetState: SentientIdentityState? = nil,
        reducedMotion: Bool = false,
        timeMs: Int
    ) -> (VisualDiffFixtureRegistration, VisualDiffSentientIdentityRenderConfiguration) {
        let caseID = "sentient-identity--\(variantID)--\(stateID)"
        let fixture = VisualDiffFixtureCase(
            caseID: caseID,
            componentID: "sentient-identity",
            variantID: variantID,
            stateID: stateID
        )
        return (
            VisualDiffFixtureRegistration(fixture: fixture, applicability: .supported),
            VisualDiffSentientIdentityRenderConfiguration(
                initialState: initialState,
                targetState: targetState,
                reducedMotion: reducedMotion,
                timeMs: timeMs
            )
        )
    }

    private static let definitions: [(VisualDiffFixtureRegistration, VisualDiffSentientIdentityRenderConfiguration)] = {
        var definitions = [
            entry(variantID: "idle", stateID: "rest", initialState: .idle, timeMs: 0),
            entry(variantID: "idle", stateID: "reduced-motion", initialState: .idle, reducedMotion: true, timeMs: 0),
            entry(variantID: "thinking", stateID: "rest", initialState: .thinking, timeMs: 1_000),
            entry(variantID: "thinking", stateID: "reduced-motion", initialState: .thinking, reducedMotion: true, timeMs: 0),
            entry(variantID: "responding", stateID: "rest", initialState: .responding, timeMs: 2_000),
            entry(variantID: "responding", stateID: "reduced-motion", initialState: .responding, reducedMotion: true, timeMs: 0),
        ]

        for (variantID, initialState, targetState) in [
            ("idle-to-thinking", SentientIdentityState.idle, SentientIdentityState.thinking),
            ("thinking-to-responding", SentientIdentityState.thinking, SentientIdentityState.responding),
            ("responding-to-idle", SentientIdentityState.responding, SentientIdentityState.idle),
        ] {
            definitions += transitionFrames.map { stateID, timeMs in
                entry(
                    variantID: variantID,
                    stateID: stateID,
                    initialState: initialState,
                    targetState: targetState,
                    timeMs: timeMs
                )
            }
        }

        definitions += thinkingLoopFrames.map { stateID, timeMs in
            entry(
                variantID: "thinking-loop",
                stateID: stateID,
                initialState: .thinking,
                timeMs: timeMs
            )
        }
        definitions += respondingLoopFrames.map { stateID, timeMs in
            entry(
                variantID: "responding-loop",
                stateID: stateID,
                initialState: .responding,
                timeMs: timeMs
            )
        }
        return definitions
    }()

    static let renderConfigurations: [String: VisualDiffSentientIdentityRenderConfiguration] =
        Dictionary(uniqueKeysWithValues: definitions.map { registration, configuration in
            (registration.fixture.caseID, configuration)
        })

    static let registration = VisualDiffComponentRegistration(
        componentID: "sentient-identity",
        registrations: definitions.map(\.0),
        adapter: SentientIdentityFixtureAdapter(configurations: renderConfigurations)
    )
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

private struct SettingRowFixtureAdapter: VisualDiffNativeFixtureAdapter {
    let configurations: [String: VisualDiffSettingRowRenderConfiguration]

    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView {
        guard let configuration = configurations[fixture.caseID] else {
            throw VisualDiffFixtureAdapterError.missingConfiguration(caseID: fixture.caseID)
        }

        return AnyView(
            ZStack(alignment: .topLeading) {
                Color.clear
                SettingRowFixture(configuration: configuration)
                    .frame(width: SettingRowFixtureMetrics.contentWidth)
                    .padding(.leading, SettingRowFixtureMetrics.canvasInset)
                    .padding(.top, SettingRowFixtureMetrics.canvasInset)
            }
        )
    }
}

private enum SettingRowFixtureMetrics {
    // The approved 2x row captures retain a 52pt transparent inset around a
    // 600pt-wide plate inside their 728pt logical canvas.
    static let canvasInset = Space.xxxl + Space.md
    static let contentWidth: CGFloat = 600
}

private struct SettingRowFixture: View {
    let configuration: VisualDiffSettingRowRenderConfiguration

    var body: some View {
        DesignCard(bodyStyle: .rows) {
            settingContent
        }
    }

    @ViewBuilder
    private var settingContent: some View {
        switch configuration.control {
        case .toggle(let isOn):
            DesignSettingsRow(title: configuration.title, detail: configuration.detail) {
                DesignToggleSwitch(
                    label: "",
                    isOn: .constant(isOn),
                    accessibilityId: "visual-diff-setting-row-control"
                )
                .accessibilityLabel(configuration.title)
                .accessibilityHint(configuration.detail)
            }
        case .segmented(let options, let selection):
            DesignSettingsRow(title: configuration.title, detail: configuration.detail) {
                DesignSegmentedPicker(
                    title: configuration.title,
                    options: options.map { (value: $0.value, label: $0.label) },
                    selection: .constant(selection),
                    visualHeight: DesignMetrics.actionButtonVisualHeight
                )
                .fixedSize(horizontal: true, vertical: false)
            }
        case .select(let options, let selection):
            // DesignSelect is the reachable iOS owner for a native menu row;
            // its Menu remains the platform-owned control and is not opened
            // by the static visual capture path.
            DesignSelect(
                title: configuration.title,
                detail: configuration.detail,
                options: options.map { (value: $0.value, label: $0.label) },
                selection: .constant(selection),
                accessibilityId: "visual-diff-setting-row-control"
            )
        case .range(let value):
            // DesignSlider is the reachable iOS owner for a native range row.
            // Its displayed value and native Slider remain production-owned.
            DesignSlider(
                title: configuration.title,
                value: .constant(value),
                range: 0...100,
                format: { "\(Int($0.rounded()))%" },
                accessibilityId: "visual-diff-setting-row-control"
            )
        }
    }
}

private enum SettingRowFixtureCatalog {
    private static let languageOptions = [
        VisualDiffSegmentOptionConfiguration(value: "english", label: "English"),
        VisualDiffSegmentOptionConfiguration(value: "spanish", label: "Spanish"),
        VisualDiffSegmentOptionConfiguration(value: "french", label: "French"),
    ]
    private static let detailOptions = [
        VisualDiffSegmentOptionConfiguration(value: "default", label: "Default"),
        VisualDiffSegmentOptionConfiguration(value: "expert", label: "Expert"),
    ]

    private static func supported(
        _ variantID: String,
        _ stateID: String,
        configuration: VisualDiffSettingRowRenderConfiguration
    ) -> (VisualDiffFixtureRegistration, VisualDiffSettingRowRenderConfiguration) {
        let fixture = VisualDiffFixtureCase(
            caseID: "setting-row--\(variantID)--\(stateID)",
            componentID: "setting-row",
            variantID: variantID,
            stateID: stateID
        )
        return (
            VisualDiffFixtureRegistration(fixture: fixture, applicability: .supported),
            configuration
        )
    }

    private static func unavailable(
        _ variantID: String,
        _ stateID: String,
        reason: VisualDiffMissingAuthorityReason
    ) -> VisualDiffFixtureRegistration {
        VisualDiffFixtureRegistration(
            fixture: VisualDiffFixtureCase(
                caseID: "setting-row--\(variantID)--\(stateID)",
                componentID: "setting-row",
                variantID: variantID,
                stateID: stateID
            ),
            applicability: .missingAuthority(reason)
        )
    }

    private static let supportedDefinitions: [(VisualDiffFixtureRegistration, VisualDiffSettingRowRenderConfiguration)] = [
        supported(
            "toggle",
            "off",
            configuration: VisualDiffSettingRowRenderConfiguration(
                title: "Automatic updates",
                detail: "Install trusted updates when the household is idle.",
                control: .toggle(isOn: false)
            )
        ),
        supported(
            "toggle",
            "on",
            configuration: VisualDiffSettingRowRenderConfiguration(
                title: "Automatic updates",
                detail: "Install trusted updates when the household is idle.",
                control: .toggle(isOn: true)
            )
        ),
        supported(
            "segmented",
            "default-selected",
            configuration: VisualDiffSettingRowRenderConfiguration(
                title: "Detail level",
                detail: "Choose how much supporting information appears.",
                control: .segmented(options: detailOptions, selection: "default")
            )
        ),
        supported(
            "segmented",
            "expert-selected",
            configuration: VisualDiffSettingRowRenderConfiguration(
                title: "Detail level",
                detail: "Choose how much supporting information appears.",
                control: .segmented(options: detailOptions, selection: "expert")
            )
        ),
        supported(
            "select",
            "english-closed",
            configuration: VisualDiffSettingRowRenderConfiguration(
                title: "Language",
                detail: "Used for interface labels and spoken responses.",
                control: .select(options: languageOptions, selection: "english")
            )
        ),
        supported(
            "select",
            "spanish-selected",
            configuration: VisualDiffSettingRowRenderConfiguration(
                title: "Language",
                detail: "Used for interface labels and spoken responses.",
                control: .select(options: languageOptions, selection: "spanish")
            )
        ),
        supported(
            "range",
            "62",
            configuration: VisualDiffSettingRowRenderConfiguration(
                title: "Interface scale",
                detail: "Preview changes before applying them.",
                control: .range(value: 62)
            )
        ),
    ]

    private static let unavailableDefinitions = [
        unavailable("select", "english-open", reason: .stateNotApplicable),
    ]

    private static let definitions: [VisualDiffFixtureRegistration] =
        supportedDefinitions.map(\.0) + unavailableDefinitions

    static let renderConfigurations: [String: VisualDiffSettingRowRenderConfiguration] =
        Dictionary(uniqueKeysWithValues: supportedDefinitions.map { registration, configuration in
            (registration.fixture.caseID, configuration)
        })

    static let registration = VisualDiffComponentRegistration(
        componentID: "setting-row",
        registrations: definitions,
        adapter: SettingRowFixtureAdapter(configurations: renderConfigurations)
    )
}

private struct SearchFieldFixtureAdapter: VisualDiffNativeFixtureAdapter {
    let configurations: [String: VisualDiffSearchFieldRenderConfiguration]

    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView {
        guard let configuration = configurations[fixture.caseID] else {
            throw VisualDiffFixtureAdapterError.missingConfiguration(caseID: fixture.caseID)
        }
        return AnyView(SearchFieldFixture(configuration: configuration))
    }
}

private struct SearchFieldFixture: View {
    let configuration: VisualDiffSearchFieldRenderConfiguration
    @State private var query: String
    @FocusState private var focused: Bool

    init(configuration: VisualDiffSearchFieldRenderConfiguration) {
        self.configuration = configuration
        _query = State(initialValue: configuration.value)
    }

    var body: some View {
        ZStack {
            Color.clear
            DesignSearchField(
                prompt: configuration.prompt,
                query: $query,
                title: configuration.title,
                focused: $focused
            )
            .frame(width: 320)
        }
        .task {
            // Request focus through the native FocusState so the approved
            // focus fixture exercises the same responder path as production.
            if configuration.shouldFocus { focused = true }
        }
    }
}

private enum SearchFieldFixtureCatalog {
    private struct State {
        let id: String
        let applicability: VisualDiffFixtureApplicability
        let shouldFocus: Bool

        static func supported(_ id: String, shouldFocus: Bool = false) -> Self {
            Self(id: id, applicability: .supported, shouldFocus: shouldFocus)
        }

        static func missingAuthority(_ id: String) -> Self {
            Self(id: id, applicability: .missingAuthority(.stateNotApplicable), shouldFocus: false)
        }
    }

    private static let states: [State] = [
        .supported("rest"),
        .missingAuthority("hover"),
        .supported("focus", shouldFocus: true),
        .missingAuthority("filled"),
        .missingAuthority("clear"),
        .missingAuthority("disabled"),
        .missingAuthority("error"),
        .missingAuthority("loading"),
        .missingAuthority("pressed"),
        .missingAuthority("reduced-motion"),
        .missingAuthority("selected"),
    ]

    private static let definitions: [(VisualDiffFixtureRegistration, VisualDiffSearchFieldRenderConfiguration?)] =
        states.map { state in
            let fixture = VisualDiffFixtureCase(
                caseID: "search-field--placeholder--\(state.id)",
                componentID: "search-field",
                variantID: "placeholder",
                stateID: state.id
            )
            let configuration = state.applicability == .supported
                ? VisualDiffSearchFieldRenderConfiguration(
                    title: "Search",
                    prompt: "Search conversations",
                    value: "",
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

    static let renderConfigurations: [String: VisualDiffSearchFieldRenderConfiguration] =
        Dictionary(uniqueKeysWithValues: definitions.compactMap { registration, configuration in
            guard let configuration else { return nil }
            return (registration.fixture.caseID, configuration)
        })

    static let registration = VisualDiffComponentRegistration(
        componentID: "search-field",
        registrations: definitions.map(\.0),
        adapter: SearchFieldFixtureAdapter(configurations: renderConfigurations)
    )
}

private enum DisclosureFixtureMetrics {
    // The common-composites visual-diff fixture uses the approved 540pt
    // disclosure width and 52pt canvas inset. These are fixture placement
    // values, not production layout constants.
    static let width: CGFloat = 540
    static let canvasInset: CGFloat = 52
    static let bodyMinimumHeight: CGFloat = 68
    static let bodyHorizontalPadding = Space.md + DesignMetrics.hairline
}

private struct DisclosureFixtureBodySurface<Content: View>: View {
    let minimumHeight: CGFloat
    let verticalPadding: CGFloat
    @ViewBuilder let content: () -> Content

    init(
        minimumHeight: CGFloat = 0,
        verticalPadding: CGFloat = 14,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.minimumHeight = minimumHeight
        self.verticalPadding = verticalPadding
        self.content = content
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radii.sm, style: .continuous)
        content()
            .padding(.horizontal, DisclosureFixtureMetrics.bodyHorizontalPadding)
            .padding(.vertical, verticalPadding)
            .frame(
                maxWidth: .infinity,
                minHeight: minimumHeight,
                alignment: .leading
            )
            .background {
                designSlateFace(
                    role: .secondary,
                    muted: false,
                    hovered: false,
                    baseOverride: DuskColors.paper
                )
            }
            .clipShape(shape)
            .overlay {
                shape.stroke(DuskColors.lineSoft, lineWidth: DesignMetrics.hairline)
            }
            .overlay {
                DesignTopEdgeLight(
                    shape: shape,
                    color: DuskColors.ink.opacity(DesignMaterialAdapter.slateTopLightOpacity)
                )
            }
            .background {
                ZStack {
                    DesignSpreadShadow(
                        shape: shape,
                        color: .black.opacity(DesignMaterialAdapter.slateRestBlack),
                        geometry: DesignMaterialShadowGeometry.slateRest
                    )
                    DesignSpreadShadow(
                        shape: shape,
                        color: DuskColors.bgSunk.overlaying(
                            DuskColors.line,
                            opacity: DesignMaterialAdapter.plateRestContactMix
                        ),
                        geometry: DesignDropShadowGeometry(radius: 0, y: 2, sourceInset: 1)
                    )
                }
            }
    }
}

private struct DisclosureFixture: View {
    let configuration: VisualDiffDisclosureRenderConfiguration
    let transitionFrameTime: TimeInterval?
    @State private var expanded: Bool
    @State private var diagnostics = false
    @State private var transitionStarted = false

    init(
        configuration: VisualDiffDisclosureRenderConfiguration,
        transitionFrameTime: TimeInterval? = nil
    ) {
        self.configuration = configuration
        self.transitionFrameTime = transitionFrameTime
        _expanded = State(initialValue: configuration.initiallyExpanded)
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear
            DesignCard {
                DesignDisclosureGroup(isExpanded: expanded) {
                    DesignDisclosureButton(
                        isExpanded: expanded,
                        accessibilityLabel: "\(expanded ? "Collapse" : "Expand") \(configuration.title)",
                        accessibilityId: "visual-diff-disclosure",
                        action: { expanded.toggle() }
                    ) {
                        VStack(alignment: .leading, spacing: Space.xs) {
                            Text(configuration.title)
                                .font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
                                .foregroundStyle(DuskColors.ink)
                            Text(configuration.description)
                                .font(Typo.ui(TypeScale.sm))
                                .foregroundStyle(DuskColors.ink2)
                        }
                    }
                } content: {
                    bodyContent
                }
            }
            .frame(width: DisclosureFixtureMetrics.width)
            .padding(.leading, DisclosureFixtureMetrics.canvasInset)
            .padding(.top, DisclosureFixtureMetrics.canvasInset)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear {
            guard transitionFrameTime != nil, !transitionStarted else { return }
            transitionStarted = true
            DispatchQueue.main.async { expanded = true }
        }
    }

    @ViewBuilder
    private var bodyContent: some View {
        switch configuration.body {
        case .toggle:
            DisclosureFixtureBodySurface(
                minimumHeight: DisclosureFixtureMetrics.bodyMinimumHeight,
                verticalPadding: Space.md
            ) {
                HStack(alignment: .center, spacing: Space.lg) {
                    VStack(alignment: .leading, spacing: Space.xs) {
                        Text("Detailed diagnostics")
                            .font(Typo.ui(DesignMetrics.controlLabelSize, .medium))
                            .foregroundStyle(DuskColors.ink)
                        Text("Show sanitized identifiers and state transitions.")
                            .font(Typo.ui(TypeScale.sm))
                            .foregroundStyle(DuskColors.ink2)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    DesignToggleSwitch(
                        label: "",
                        isOn: $diagnostics,
                        accessibilityId: "visual-diff-diagnostics"
                    )
                    .accessibilityLabel("Detailed diagnostics")
                    .fixedSize(horizontal: true, vertical: false)
                }
            }
        case .paragraph:
            DisclosureFixtureBodySurface {
                Text("Storage controls belong here when defined.")
                    .font(Typo.ui(TypeScale.sm))
                    .foregroundStyle(DuskColors.ink2)
            }
        }
    }
}

private struct DisclosureFixtureAdapter: VisualDiffNativeFixtureAdapter {
    let configurations: [String: VisualDiffDisclosureRenderConfiguration]
    let motionConfigurations: [String: VisualDiffDisclosureMotionRenderConfiguration]

    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView {
        if let configuration = motionConfigurations[fixture.caseID] {
            return AnyView(
                DisclosureFixture(
                    configuration: configuration.configuration,
                    transitionFrameTime: configuration.frameTime
                )
            )
        }
        guard let configuration = configurations[fixture.caseID] else {
            throw VisualDiffFixtureAdapterError.missingConfiguration(caseID: fixture.caseID)
        }
        return AnyView(DisclosureFixture(configuration: configuration))
    }
}

private enum DisclosureFixtureCatalog {
    private static func entry(
        variantID: String,
        stateID: String,
        configuration: VisualDiffDisclosureRenderConfiguration
    ) -> VisualDiffFixtureRegistration {
        VisualDiffFixtureRegistration(
            fixture: VisualDiffFixtureCase(
                caseID: "disclosure--\(variantID)--\(stateID)",
                componentID: "disclosure",
                variantID: variantID,
                stateID: stateID
            ),
            applicability: .supported
        )
    }

    private static let advancedOptions = VisualDiffDisclosureRenderConfiguration(
        title: "Advanced options",
        description: "Additional controls for experienced users",
        body: .toggle,
        initiallyExpanded: false
    )
    private static let dataStorage = VisualDiffDisclosureRenderConfiguration(
        title: "Data and storage",
        description: "Retention and local cache",
        body: .paragraph,
        initiallyExpanded: false
    )

    private static func expanded(
        _ configuration: VisualDiffDisclosureRenderConfiguration
    ) -> VisualDiffDisclosureRenderConfiguration {
        VisualDiffDisclosureRenderConfiguration(
            title: configuration.title,
            description: configuration.description,
            body: configuration.body,
            initiallyExpanded: true
        )
    }

    private static let advancedOptionsOpen = expanded(advancedOptions)
    private static let dataStorageOpen = expanded(dataStorage)

    private static let staticDefinitions: [(VisualDiffFixtureRegistration, VisualDiffDisclosureRenderConfiguration)] = [
        (entry(variantID: "advanced-options", stateID: "closed", configuration: advancedOptions), advancedOptions),
        (entry(variantID: "advanced-options", stateID: "open", configuration: advancedOptionsOpen), advancedOptionsOpen),
        (entry(variantID: "data-storage", stateID: "closed", configuration: dataStorage), dataStorage),
        (entry(variantID: "data-storage", stateID: "open", configuration: dataStorageOpen), dataStorageOpen),
    ]

    private static let motionDefinitions: [(VisualDiffFixtureRegistration, VisualDiffDisclosureMotionRenderConfiguration)] = [
        (0, 0.0),
        (1, 0.062),
        (2, 0.125),
        (3, 0.188),
        (4, 0.250),
    ].map { index, frameTime in
        let frameID = String(format: "frame-%03d--%04dms", index, Int((frameTime * 1_000).rounded()))
        let caseID = "disclosure--closed-to-open--\(frameID)"
        let configuration = VisualDiffDisclosureRenderConfiguration(
            title: dataStorage.title,
            description: dataStorage.description,
            body: dataStorage.body,
            initiallyExpanded: false
        )
        return (
            VisualDiffFixtureRegistration(
                fixture: VisualDiffFixtureCase(
                    caseID: caseID,
                    componentID: "disclosure",
                    variantID: "closed-to-open",
                    stateID: frameID
                ),
                applicability: .supported
            ),
            VisualDiffDisclosureMotionRenderConfiguration(
                configuration: configuration,
                frameTime: frameTime
            )
        )
    }

    static let renderConfigurations: [String: VisualDiffDisclosureRenderConfiguration] =
        Dictionary(uniqueKeysWithValues: staticDefinitions.map { registration, configuration in
            (registration.fixture.caseID, configuration)
        } + motionDefinitions.map { registration, configuration in
            (registration.fixture.caseID, configuration.configuration)
        })

    private static let motionRenderConfigurations: [String: VisualDiffDisclosureMotionRenderConfiguration] =
        Dictionary(uniqueKeysWithValues: motionDefinitions.map { registration, configuration in
            (registration.fixture.caseID, configuration)
        })

    static func captureTime(for caseID: String) -> TimeInterval? {
        motionRenderConfigurations[caseID]?.frameTime
    }

    static let registration = VisualDiffComponentRegistration(
        componentID: "disclosure",
        registrations: staticDefinitions.map(\.0) + motionDefinitions.map(\.0),
        adapter: DisclosureFixtureAdapter(
            configurations: renderConfigurations,
            motionConfigurations: motionRenderConfigurations
        )
    )
}

private struct SegmentedControlFixtureAdapter: VisualDiffNativeFixtureAdapter {
    let configurations: [String: VisualDiffSegmentedRenderConfiguration]
    let motionConfigurations: [String: VisualDiffSegmentedMotionRenderConfiguration]

    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView {
        if let configuration = motionConfigurations[fixture.caseID] {
            return AnyView(
                ZStack {
                    Color.clear
                    SegmentedMotionFixture(configuration: configuration)
                        .fixedSize(horizontal: true, vertical: false)
                }
            )
        }

        guard let configuration = configurations[fixture.caseID] else {
            throw VisualDiffFixtureAdapterError.missingConfiguration(caseID: fixture.caseID)
        }

        return AnyView(
            ZStack {
                Color.clear
                DesignSegmentedPicker(
                    title: configuration.title,
                    options: configuration.options.map { (value: $0.value, label: $0.label) },
                    selection: .constant(configuration.selection),
                    visualHeight: configuration.visualHeight
                )
                .fixedSize(horizontal: true, vertical: false)
            }
        )
    }
}

private struct SegmentedMotionFixture: View {
    let configuration: VisualDiffSegmentedMotionRenderConfiguration
    @State private var selection: String
    @State private var transitionStarted = false

    init(configuration: VisualDiffSegmentedMotionRenderConfiguration) {
        self.configuration = configuration
        _selection = State(initialValue: configuration.initialSelection)
    }

    var body: some View {
        DesignSegmentedPicker(
            title: configuration.title,
            options: configuration.options.map { (value: $0.value, label: $0.label) },
            selection: $selection,
            visualHeight: configuration.visualHeight
        )
        .onAppear {
            guard !transitionStarted else { return }
            transitionStarted = true
            DispatchQueue.main.async {
                selection = configuration.targetSelection
            }
        }
    }
}

private enum SegmentedControlFixtureCatalog {
    private static func option(_ value: String, _ label: String) -> VisualDiffSegmentOptionConfiguration {
        VisualDiffSegmentOptionConfiguration(value: value, label: label)
    }

    private static let avatarOptions = [
        option("idle", "Idle"),
        option("thinking", "Thinking"),
        option("responding", "Responding"),
    ]
    private static let densityOptions = [
        option("comfortable", "Comfortable"),
        option("compact", "Compact"),
    ]

    private static let supportedConfigurations: [String: VisualDiffSegmentedRenderConfiguration] = [
        "segmented-control--avatar-state--compact-layout": VisualDiffSegmentedRenderConfiguration(
            title: "Avatar state",
            options: avatarOptions,
            selection: "idle",
            visualHeight: DesignMetrics.minimumTarget
        ),
        "segmented-control--avatar-state--idle-selected": VisualDiffSegmentedRenderConfiguration(
            title: "Avatar state",
            options: avatarOptions,
            selection: "idle",
            visualHeight: DesignMetrics.actionButtonVisualHeight
        ),
        "segmented-control--avatar-state--responding-selected": VisualDiffSegmentedRenderConfiguration(
            title: "Avatar state",
            options: avatarOptions,
            selection: "responding",
            visualHeight: DesignMetrics.actionButtonVisualHeight
        ),
        "segmented-control--avatar-state--thinking-selected": VisualDiffSegmentedRenderConfiguration(
            title: "Avatar state",
            options: avatarOptions,
            selection: "thinking",
            visualHeight: DesignMetrics.actionButtonVisualHeight
        ),
        "segmented-control--density--comfortable-selected": VisualDiffSegmentedRenderConfiguration(
            title: "View density",
            options: densityOptions,
            selection: "comfortable",
            visualHeight: DesignMetrics.actionButtonVisualHeight
        ),
        "segmented-control--density--compact-layout": VisualDiffSegmentedRenderConfiguration(
            title: "View density",
            options: densityOptions,
            selection: "comfortable",
            visualHeight: DesignMetrics.minimumTarget
        ),
        "segmented-control--density--compact-selected": VisualDiffSegmentedRenderConfiguration(
            title: "View density",
            options: densityOptions,
            selection: "compact",
            visualHeight: DesignMetrics.actionButtonVisualHeight
        ),
    ]

    private static let unavailableStates: [(String, VisualDiffMissingAuthorityReason)] = [
        ("compact-focus", .stateRequiresInteraction),
        ("compact-hover", .stateNotApplicable),
        ("compact-pressed", .stateRequiresInteraction),
    ]

    private static let motionConfigurations: [String: VisualDiffSegmentedMotionRenderConfiguration] = [
        "frame-000--0000ms": VisualDiffSegmentedMotionRenderConfiguration(
            title: "View density",
            options: densityOptions,
            initialSelection: "comfortable",
            targetSelection: "compact",
            visualHeight: DesignMetrics.actionButtonVisualHeight,
            frameTime: 0
        ),
        "frame-001--0055ms": VisualDiffSegmentedMotionRenderConfiguration(
            title: "View density",
            options: densityOptions,
            initialSelection: "comfortable",
            targetSelection: "compact",
            visualHeight: DesignMetrics.actionButtonVisualHeight,
            frameTime: 0.055
        ),
        "frame-002--0110ms": VisualDiffSegmentedMotionRenderConfiguration(
            title: "View density",
            options: densityOptions,
            initialSelection: "comfortable",
            targetSelection: "compact",
            visualHeight: DesignMetrics.actionButtonVisualHeight,
            frameTime: 0.11
        ),
        "frame-003--0165ms": VisualDiffSegmentedMotionRenderConfiguration(
            title: "View density",
            options: densityOptions,
            initialSelection: "comfortable",
            targetSelection: "compact",
            visualHeight: DesignMetrics.actionButtonVisualHeight,
            frameTime: 0.165
        ),
        "frame-004--0220ms": VisualDiffSegmentedMotionRenderConfiguration(
            title: "View density",
            options: densityOptions,
            initialSelection: "comfortable",
            targetSelection: "compact",
            visualHeight: DesignMetrics.actionButtonVisualHeight,
            frameTime: 0.22
        ),
    ]

    private static let definitions: [VisualDiffFixtureRegistration] = supportedConfigurations.keys.map { caseID in
        VisualDiffFixtureRegistration(
            fixture: VisualDiffFixtureCase(
                caseID: caseID,
                componentID: "segmented-control",
                variantID: caseID.split(separator: "--").dropFirst().first.map(String.init) ?? "",
                stateID: caseID.split(separator: "--").last.map(String.init) ?? ""
            ),
            applicability: .supported
        )
    } + unavailableStates.map { stateID, reason in
        VisualDiffFixtureRegistration(
            fixture: VisualDiffFixtureCase(
                caseID: "segmented-control--density--\(stateID)",
                componentID: "segmented-control",
                variantID: "density",
                stateID: stateID
            ),
            applicability: .missingAuthority(reason)
        )
    } + motionConfigurations.keys.map { caseID in
        VisualDiffFixtureRegistration(
            fixture: VisualDiffFixtureCase(
                caseID: caseID,
                componentID: "segmented-control",
                variantID: "comfortable-to-compact",
                stateID: caseID
            ),
            applicability: .supported
        )
    }

    static let renderConfigurations = supportedConfigurations

    static func captureTime(for caseID: String) -> TimeInterval? {
        if let frameTime = motionConfigurations[caseID]?.frameTime {
            return frameTime
        }
        // Static handoff captures preserve the first rendered transition
        // sample after requestAnimationFrame measures the continuous slate.
        return supportedConfigurations[caseID] == nil ? nil : 1.0 / 60.0
    }

    static let registration = VisualDiffComponentRegistration(
        componentID: "segmented-control",
        registrations: definitions,
        adapter: SegmentedControlFixtureAdapter(
            configurations: renderConfigurations,
            motionConfigurations: motionConfigurations
        )
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

private struct ValidatedFieldFixtureAdapter: VisualDiffNativeFixtureAdapter {
    let configurations: [String: VisualDiffValidatedFieldRenderConfiguration]

    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView {
        guard let configuration = configurations[fixture.caseID] else {
            throw VisualDiffFixtureAdapterError.missingConfiguration(caseID: fixture.caseID)
        }
        return AnyView(ValidatedFieldFixture(configuration: configuration))
    }
}

private struct ValidatedFieldFixture: View {
    let configuration: VisualDiffValidatedFieldRenderConfiguration
    @State private var text: String
    @FocusState private var focused: Bool

    init(configuration: VisualDiffValidatedFieldRenderConfiguration) {
        self.configuration = configuration
        _text = State(initialValue: configuration.value)
    }

    var body: some View {
        ZStack {
            Color.clear
            ValidatedField(
                title: configuration.title,
                text: $text,
                status: configuration.status,
                counter: configuration.counter,
                multiline: configuration.multiline,
                maxLength: configuration.maxLength,
                accessibilityId: "visual-diff-validated-field",
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

private enum ValidatedFieldFixtureCatalog {
    private static let definitions: [(VisualDiffFixtureRegistration, VisualDiffValidatedFieldRenderConfiguration)] = [
        definition(
            variantID: "confirmation",
            stateID: "error",
            title: "Confirmation",
            value: "warm emb",
            status: .error("The values do not match.")
        ),
        definition(
            variantID: "recovery-phrase",
            stateID: "valid",
            title: "Recovery phrase",
            value: "warm ember",
            status: .valid("Available")
        ),
        definition(
            variantID: "supporting-note",
            stateID: "counter",
            title: "Supporting note",
            value: "A concise note that helps others understand this choice.",
            counter: ValidatedFieldCounter(current: 58, max: 160),
            multiline: true,
            maxLength: 160
        ),
    ]

    private static func definition(
        variantID: String,
        stateID: String,
        title: String,
        value: String,
        status: ValidatedFieldStatus? = nil,
        counter: ValidatedFieldCounter? = nil,
        multiline: Bool = false,
        maxLength: Int? = nil
    ) -> (VisualDiffFixtureRegistration, VisualDiffValidatedFieldRenderConfiguration) {
        let fixture = VisualDiffFixtureCase(
            caseID: "validated-field--\(variantID)--\(stateID)",
            componentID: "validated-field",
            variantID: variantID,
            stateID: stateID
        )
        return (
            VisualDiffFixtureRegistration(fixture: fixture, applicability: .supported),
            VisualDiffValidatedFieldRenderConfiguration(
                title: title,
                value: value,
                status: status,
                counter: counter,
                multiline: multiline,
                maxLength: maxLength,
                shouldFocus: false
            )
        )
    }

    static let renderConfigurations: [String: VisualDiffValidatedFieldRenderConfiguration] =
        Dictionary(uniqueKeysWithValues: definitions.map { registration, configuration in
            (registration.fixture.caseID, configuration)
        })

    static let registration = VisualDiffComponentRegistration(
        componentID: "validated-field",
        registrations: definitions.map(\.0),
        adapter: ValidatedFieldFixtureAdapter(configurations: renderConfigurations)
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

private struct PinEntryFixtureAdapter: VisualDiffNativeFixtureAdapter {
    let configurations: [String: VisualDiffPinRenderConfiguration]

    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView {
        guard let configuration = configurations[fixture.caseID] else {
            throw VisualDiffFixtureAdapterError.missingConfiguration(caseID: fixture.caseID)
        }
        return AnyView(PinEntryFixture(configuration: configuration))
    }
}

private enum PinEntryFixtureMetrics {
    // The handoff canvas is 488×600 logical points; its 360×472 plate starts
    // at the 52pt inset visible in the immutable 2x references.
    static let canvasInset: CGFloat = 52
    static let plateWidth: CGFloat = 360
}

private struct PinEntryFixture: View {
    let configuration: VisualDiffPinRenderConfiguration

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            DesignCard(bodyStyle: .padded) {
                PinPad(
                    entered: configuration.entered,
                    isSubmitting: configuration.isSubmitting,
                    success: configuration.success,
                    reducedMotionOverride: configuration.reducedMotion,
                    onDigit: { _ in },
                    onDelete: {}
                )
            }
            .frame(width: PinEntryFixtureMetrics.plateWidth)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, PinEntryFixtureMetrics.canvasInset)
        .padding(.top, PinEntryFixtureMetrics.canvasInset)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.clear)
    }
}

private enum PinEntryFixtureCatalog {
    private static func definition(
        _ caseID: String,
        variantID: String,
        stateID: String,
        configuration: VisualDiffPinRenderConfiguration
    ) -> (VisualDiffFixtureRegistration, VisualDiffPinRenderConfiguration) {
        (
            VisualDiffFixtureRegistration(
                fixture: VisualDiffFixtureCase(
                    caseID: caseID,
                    componentID: "pin-entry",
                    variantID: variantID,
                    stateID: stateID
                ),
                applicability: .supported
            ),
            configuration
        )
    }

    private static let staticDefinitions = [
        definition(
            "pin-entry--4-digit--empty",
            variantID: "4-digit",
            stateID: "empty",
            configuration: VisualDiffPinRenderConfiguration(entered: 0, isSubmitting: false, success: nil, reducedMotion: false)
        ),
        definition(
            "pin-entry--4-digit--one-digit",
            variantID: "4-digit",
            stateID: "one-digit",
            configuration: VisualDiffPinRenderConfiguration(entered: 1, isSubmitting: false, success: nil, reducedMotion: false)
        ),
        definition(
            "pin-entry--4-digit--partial",
            variantID: "4-digit",
            stateID: "partial",
            configuration: VisualDiffPinRenderConfiguration(entered: 3, isSubmitting: false, success: nil, reducedMotion: false)
        ),
        definition(
            "pin-entry--4-digit--checking",
            variantID: "4-digit",
            stateID: "checking",
            configuration: VisualDiffPinRenderConfiguration(entered: 4, isSubmitting: true, success: nil, reducedMotion: false)
        ),
        definition(
            "pin-entry--4-digit--checking-reduced-motion",
            variantID: "4-digit",
            stateID: "checking-reduced-motion",
            configuration: VisualDiffPinRenderConfiguration(entered: 4, isSubmitting: true, success: nil, reducedMotion: true)
        ),
        definition(
            "pin-entry--4-digit--success",
            variantID: "4-digit",
            stateID: "success",
            configuration: VisualDiffPinRenderConfiguration(entered: 4, isSubmitting: true, success: "Pin accepted.", reducedMotion: false)
        ),
    ]

    private static let motionDefinitions = [
        definition(
            "pin-entry--complete-to-success--frame-000--0000ms",
            variantID: "complete-to-success",
            stateID: "frame-000--0000ms",
            configuration: VisualDiffPinRenderConfiguration(entered: 0, isSubmitting: false, success: nil, reducedMotion: false)
        ),
        definition(
            "pin-entry--complete-to-success--frame-001--0180ms",
            variantID: "complete-to-success",
            stateID: "frame-001--0180ms",
            configuration: VisualDiffPinRenderConfiguration(entered: 2, isSubmitting: false, success: nil, reducedMotion: false)
        ),
        definition(
            "pin-entry--complete-to-success--frame-002--0360ms",
            variantID: "complete-to-success",
            stateID: "frame-002--0360ms",
            configuration: VisualDiffPinRenderConfiguration(entered: 4, isSubmitting: true, success: nil, reducedMotion: false)
        ),
        definition(
            "pin-entry--complete-to-success--frame-003--0700ms",
            variantID: "complete-to-success",
            stateID: "frame-003--0700ms",
            configuration: VisualDiffPinRenderConfiguration(entered: 4, isSubmitting: true, success: nil, reducedMotion: false)
        ),
        definition(
            "pin-entry--complete-to-success--frame-004--1060ms",
            variantID: "complete-to-success",
            stateID: "frame-004--1060ms",
            configuration: VisualDiffPinRenderConfiguration(entered: 4, isSubmitting: true, success: "Pin accepted.", reducedMotion: false)
        ),
    ]

    private static let definitions = staticDefinitions + motionDefinitions

    static let renderConfigurations = Dictionary(uniqueKeysWithValues: definitions.map { registration, configuration in
        (registration.fixture.caseID, configuration)
    })

    static let registration = VisualDiffComponentRegistration(
        componentID: "pin-entry",
        registrations: definitions.map(\.0),
        adapter: PinEntryFixtureAdapter(configurations: renderConfigurations)
    )
}

struct VisualDiffMediaActionCardRenderConfiguration {
    let name: String
    let initial: String
    let tint: DesignUserAvatarTint
    let detail: String
}

private struct MediaActionCardFixtureAdapter: VisualDiffNativeFixtureAdapter {
    let configurations: [String: VisualDiffMediaActionCardRenderConfiguration]

    func makeFixture(for fixture: VisualDiffFixtureCase) throws -> AnyView {
        guard let configuration = configurations[fixture.caseID] else {
            throw VisualDiffFixtureAdapterError.missingConfiguration(caseID: fixture.caseID)
        }
        return AnyView(MediaActionCardFixture(configuration: configuration))
    }
}

private enum MediaActionCardFixtureMetrics {
    // The approved 2x references retain a 52pt transparent frame around a
    // 260pt card. These bounds belong to the isolated capture, not production.
    static let cardWidth: CGFloat = 260
    static let canvasInset: CGFloat = 52
}

private struct MediaActionCardFixture: View {
    let configuration: VisualDiffMediaActionCardRenderConfiguration

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear
            DesignDominantVisualCard(
                title: configuration.name,
                detail: configuration.detail,
                accessibilityLabel: "Continue as \(configuration.name)",
                accessibilityId: "visual-diff-media-action-card",
                quietHoverBorder: true,
                action: {}
            ) {
                ElevatedUserAvatar(
                    name: configuration.name,
                    size: DesignMetrics.dominantAvatarSize,
                    tint: configuration.tint,
                    initial: configuration.initial
                )
            }
            .frame(width: MediaActionCardFixtureMetrics.cardWidth)
        }
        .padding(MediaActionCardFixtureMetrics.canvasInset)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private enum MediaActionCardFixtureCatalog {
    private struct State {
        let id: String
        let applicability: VisualDiffFixtureApplicability

        static func supported(_ id: String) -> Self {
            Self(id: id, applicability: .supported)
        }

        static func unavailable(_ id: String, reason: VisualDiffMissingAuthorityReason) -> Self {
            Self(id: id, applicability: .missingAuthority(reason))
        }
    }

    private struct Variant {
        let id: String
        let configuration: VisualDiffMediaActionCardRenderConfiguration
    }

    private static let variants = [
        Variant(
            id: "user-sage",
            configuration: VisualDiffMediaActionCardRenderConfiguration(
                name: "Alex",
                initial: "A",
                tint: .sage,
                detail: "Household member"
            )
        ),
        Variant(
            id: "user-terra",
            configuration: VisualDiffMediaActionCardRenderConfiguration(
                name: "Maya",
                initial: "M",
                tint: .terra,
                detail: "Household owner"
            )
        ),
    ]

    private static let states = [
        State.supported("rest"),
        State.unavailable("hover", reason: .stateNotApplicable),
        State.unavailable("focus", reason: .stateRequiresInteraction),
    ]

    private static let definitions: [(VisualDiffFixtureRegistration, VisualDiffMediaActionCardRenderConfiguration?)] =
        variants.flatMap { variant in
            states.map { state in
                let fixture = VisualDiffFixtureCase(
                    caseID: "media-action-card--\(variant.id)--\(state.id)",
                    componentID: "media-action-card",
                    variantID: variant.id,
                    stateID: state.id
                )
                return (
                    VisualDiffFixtureRegistration(
                        fixture: fixture,
                        applicability: state.applicability
                    ),
                    state.applicability == .supported ? variant.configuration : nil
                )
            }
        }

    static let renderConfigurations: [String: VisualDiffMediaActionCardRenderConfiguration] =
        Dictionary(uniqueKeysWithValues: definitions.compactMap { registration, configuration in
            guard let configuration else { return nil }
            return (registration.fixture.caseID, configuration)
        })

    static let registration = VisualDiffComponentRegistration(
        componentID: "media-action-card",
        registrations: definitions.map(\.0),
        adapter: MediaActionCardFixtureAdapter(configurations: renderConfigurations)
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
