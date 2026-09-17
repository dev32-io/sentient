import SwiftUI
import RiveRuntime

/// The complete semantic surface of the Sentient identity. Microphone capture is
/// intentionally absent: listening is composer state, not identity state.
enum SentientIdentityState: CaseIterable, Equatable {
    case idle
    case thinking
    case responding

    var triggerName: String {
        switch self {
        case .idle: "toIdle"
        case .thinking: "toThinking"
        case .responding: "toResponding"
        }
    }

    var statusLabel: String {
        switch self {
        case .idle: "Sentient is idle"
        case .thinking: "Sentient is thinking"
        case .responding: "Sentient is responding"
        }
    }
}

/// Small testable boundary around the Rive state machine. Once synchronized
/// with the view environment, state updates are synchronous and last-write-wins;
/// the choreography remains entirely in Rive.
@MainActor
protocol SentientIdentityDriving: AnyObject {
    func setReducedMotion(_ reduced: Bool)
    func transition(to state: SentientIdentityState)
    func setRenderingActive(_ active: Bool)
}

extension SentientIdentityDriving {
    func setRenderingActive(_ active: Bool) {}
}

@MainActor
final class SentientIdentityStateController {
    // The model owns this controller; retaining its driver would retain the model.
    private weak var driver: SentientIdentityDriving?
    private var synchronizedState: SentientIdentityState?
    private var synchronizedReducedMotion: Bool?
    private var needsSynchronization = true
    private var renderingActive = false
    private(set) var state: SentientIdentityState
    private(set) var reducedMotion: Bool

    init(
        state: SentientIdentityState,
        reducedMotion: Bool = false,
        driver: SentientIdentityDriving
    ) {
        self.state = state
        self.reducedMotion = reducedMotion
        self.driver = driver
    }

    /// Records view inputs while playback is ineligible, then applies only the
    /// latest pair when playback becomes eligible again.
    func synchronize(state latest: SentientIdentityState, reducedMotion reduced: Bool) {
        if state != latest || reducedMotion != reduced {
            state = latest
            reducedMotion = reduced
            needsSynchronization = true
        }
        reconcileIfActive()
    }

    func request(_ latest: SentientIdentityState) {
        guard state != latest else { return }
        state = latest
        needsSynchronization = true
        reconcileIfActive()
    }

    func setReducedMotion(_ reduced: Bool) {
        guard reducedMotion != reduced else { return }
        reducedMotion = reduced
        needsSynchronization = true
        reconcileIfActive()
    }

    func setRenderingActive(_ active: Bool) {
        guard renderingActive != active else { return }
        renderingActive = active
        driver?.setRenderingActive(active)
        if !active {
            synchronizedState = nil
            needsSynchronization = true
        }
        reconcileIfActive()
    }

    private func reconcileIfActive() {
        guard renderingActive, needsSynchronization else { return }
        let reducedMotionChanged = synchronizedReducedMotion != reducedMotion
        if reducedMotionChanged {
            driver?.setReducedMotion(reducedMotion)
            synchronizedReducedMotion = reducedMotion
        }
        if synchronizedState != state || reducedMotionChanged {
            driver?.transition(to: state)
            synchronizedState = state
        }
        needsSynchronization = false
    }
}

@MainActor
final class RiveIdentityModel: ObservableObject, SentientIdentityDriving {
    // One decoded bundled asset, never a pool of views or animation instances.
    private static var cachedFile: (bundleURL: URL, file: RiveFile)?

    private static func file(in bundle: Bundle) throws -> RiveFile {
        if let cachedFile, cachedFile.bundleURL == bundle.bundleURL {
            return cachedFile.file
        }
        let file = try RiveFile(
            name: "sentient-avatar", extension: ".riv", in: bundle, loadCdn: false
        )
        cachedFile = (bundle.bundleURL, file)
        return file
    }

    let riveViewModel: RiveViewModel?
    private(set) var controller: SentientIdentityStateController!
    private var reducedMotion = false

    init(
        initialState: SentientIdentityState,
        reducedMotion: Bool = false,
        autoPlay: Bool = false,
        bundle: Bundle = .main,
        resourceExists: (Bundle) -> Bool = {
            $0.url(forResource: "sentient-avatar", withExtension: "riv") != nil
        }
    ) {
        guard resourceExists(bundle) else {
            riveViewModel = nil
            controller = SentientIdentityStateController(
                state: initialState,
                reducedMotion: reducedMotion,
                driver: MissingIdentityDriver()
            )
            return
        }

        do {
            // Models create independent artboards/state machines from the shared file.
            let file = RiveModel(riveFile: try Self.file(in: bundle))
            riveViewModel = RiveViewModel(
                file,
                stateMachineName: "Avatar",
                fit: .contain,
                alignment: .center,
                autoPlay: autoPlay,
                artboardName: "SentientAvatar"
            )
            controller = SentientIdentityStateController(
                state: initialState,
                reducedMotion: reducedMotion,
                driver: self
            )
        } catch {
            riveViewModel = nil
            controller = SentientIdentityStateController(
                state: initialState,
                reducedMotion: reducedMotion,
                driver: MissingIdentityDriver()
            )
        }
    }

    func setReducedMotion(_ reduced: Bool) {
        reducedMotion = reduced
        riveViewModel?.setInput("reducedMotion", value: reduced)
    }

    func transition(to state: SentientIdentityState) {
        riveViewModel?.triggerInput(state.triggerName)
        guard reducedMotion else { return }
        // Reduced variants are authored as immediate static states. Apply their
        // zero-duration state change, then stop the display link in this turn.
        riveViewModel?.riveView?.advance(delta: 0)
        riveViewModel?.pause()
    }

    func setRenderingActive(_ active: Bool) {
        guard !active, riveViewModel?.isPlaying == true else { return }
        riveViewModel?.pause()
    }
}

@MainActor
private final class MissingIdentityDriver: SentientIdentityDriving {
    func setReducedMotion(_ reduced: Bool) {}
    func transition(to state: SentientIdentityState) {}
}

private struct SentientIdentityPlaybackEnabledKey: EnvironmentKey {
    static let defaultValue = true
}

private struct SentientIdentityMeasurementKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// Parent-controlled coverage eligibility. Chat sets this false while its
    /// history panel covers message content.
    var sentientIdentityPlaybackEnabled: Bool {
        get { self[SentientIdentityPlaybackEnabledKey.self] }
        set { self[SentientIdentityPlaybackEnabledKey.self] = newValue }
    }

    /// Exact row measurement preserves avatar geometry without loading Rive.
    var sentientIdentityMeasurement: Bool {
        get { self[SentientIdentityMeasurementKey.self] }
        set { self[SentientIdentityMeasurementKey.self] = newValue }
    }
}

/// SwiftUI owns only lifecycle, sizing, accessibility, and static fallback.
/// Animation timing and transitions are authored by the bundled Rive machine.
struct RiveSentientIdentity: View {
    let state: SentientIdentityState
    let size: CGFloat
    private let reducedMotionOverride: Bool?

    @Environment(\.accessibilityReduceMotion) private var reducedMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.sentientIdentityPlaybackEnabled) private var playbackEnabled
    @State private var appeared = false
    @State private var visibleInScroll = true
    @StateObject private var model: RiveIdentityModel

    init(state: SentientIdentityState, size: CGFloat = SentientMarkLayout.defaultSize) {
        self.state = state
        self.size = size
        reducedMotionOverride = nil
        _model = StateObject(wrappedValue: RiveIdentityModel(initialState: state))
    }

    /// Internal injection keeps deterministic capture on the same production
    /// view while leaving the shipped model configuration unchanged.
    init(
        state: SentientIdentityState,
        size: CGFloat,
        model: RiveIdentityModel,
        reducedMotionOverride: Bool? = nil
    ) {
        self.state = state
        self.size = size
        self.reducedMotionOverride = reducedMotionOverride
        _model = StateObject(wrappedValue: model)
    }

    private var effectiveReducedMotion: Bool {
        reducedMotionOverride ?? reducedMotion
    }

    var body: some View {
        Group {
            if let rive = model.riveViewModel {
                rive.view()
            } else {
                Image("SentientMarkFallback")
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(state.statusLabel)
        .onAppear {
            appeared = true
            updateRenderingEligibility()
        }
        .onDisappear {
            appeared = false
            updateRenderingEligibility()
        }
        .onScrollVisibilityChange { visible in
            visibleInScroll = visible
            updateRenderingEligibility()
        }
        .onChange(of: playbackEnabled) { _, _ in updateRenderingEligibility() }
        .onChange(of: scenePhase) { _, _ in updateRenderingEligibility() }
        .onChange(of: state) { _, latest in model.controller.request(latest) }
        .onChange(of: reducedMotion) { _, reduced in
            guard reducedMotionOverride == nil else { return }
            model.controller.setReducedMotion(reduced)
        }
    }

    private func updateRenderingEligibility() {
        let eligible = appeared && visibleInScroll && playbackEnabled && scenePhase == .active
        if eligible {
            model.controller.synchronize(state: state, reducedMotion: effectiveReducedMotion)
        }
        model.controller.setRenderingActive(eligible)
    }
}

struct StaticSentientMark: View {
    let size: CGFloat
    var state: SentientIdentityState = .idle

    var body: some View {
        Image("SentientMark")
            .resizable()
            .interpolation(.high)
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(state.statusLabel)
    }
}

/// Compatibility name retained for existing chat call sites.
struct SentientMark: View {
    var size: CGFloat = SentientMarkLayout.defaultSize
    var mode: SentientIdentityState = .idle

    @Environment(\.sentientIdentityMeasurement) private var measurement

    @ViewBuilder var body: some View {
        if mode == .idle || measurement {
            StaticSentientMark(size: size, state: mode)
        } else {
            RiveSentientIdentity(state: mode, size: size)
        }
    }
}

enum SentientMarkLayout {
    static let defaultSize: CGFloat = 28
}

#Preview {
    VStack(spacing: 28) {
        SentientMark(size: 96, mode: .thinking)
        SentientMark(size: 28, mode: .responding)
    }
    .padding(64)
    .background(DuskColors.bg)
}
