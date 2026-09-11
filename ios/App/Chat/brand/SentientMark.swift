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
}

@MainActor
final class SentientIdentityStateController {
    private let driver: SentientIdentityDriving
    private var hasSynchronized = false
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

    /// Applies the latest view inputs together so Reduced Motion always reaches
    /// Rive before the first state trigger. Repeated appearances are no-ops
    /// unless an input changed while the view was absent.
    func synchronize(state latest: SentientIdentityState, reducedMotion reduced: Bool) {
        let stateChanged = state != latest
        let reducedMotionChanged = reducedMotion != reduced
        state = latest
        reducedMotion = reduced

        guard !hasSynchronized || stateChanged || reducedMotionChanged else { return }
        if !hasSynchronized || reducedMotionChanged {
            driver.setReducedMotion(reduced)
        }
        driver.transition(to: latest)
        hasSynchronized = true
    }

    func request(_ latest: SentientIdentityState) {
        guard state != latest else { return }
        state = latest
        guard hasSynchronized else { return }
        driver.transition(to: latest)
    }

    func setReducedMotion(_ reduced: Bool) {
        guard reducedMotion != reduced else { return }
        reducedMotion = reduced
        guard hasSynchronized else { return }
        driver.setReducedMotion(reduced)
        // The authored machine has separate reduced-motion variants. Re-apply
        // the latest state after changing the input so a live identity leaves
        // any in-flight transition and settles on the matching variant.
        driver.transition(to: state)
    }
}

@MainActor
final class RiveIdentityModel: ObservableObject, SentientIdentityDriving {
    let riveViewModel: RiveViewModel?
    private(set) var controller: SentientIdentityStateController!

    init(
        initialState: SentientIdentityState,
        reducedMotion: Bool = false,
        autoPlay: Bool = true,
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
            let file = try RiveModel(
                fileName: "sentient-avatar",
                extension: ".riv",
                in: bundle,
                loadCdn: false
            )
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
        riveViewModel?.setInput("reducedMotion", value: reduced)
    }

    func transition(to state: SentientIdentityState) {
        riveViewModel?.triggerInput(state.triggerName)
    }
}

@MainActor
private final class MissingIdentityDriver: SentientIdentityDriving {
    func setReducedMotion(_ reduced: Bool) {}
    func transition(to state: SentientIdentityState) {}
}

/// SwiftUI owns only lifecycle, sizing, accessibility, and static fallback.
/// Animation timing and transitions are authored by the bundled Rive machine.
struct RiveSentientIdentity: View {
    let state: SentientIdentityState
    let size: CGFloat
    private let reducedMotionOverride: Bool?

    @Environment(\.accessibilityReduceMotion) private var reducedMotion
    @StateObject private var model: RiveIdentityModel

    init(state: SentientIdentityState, size: CGFloat = SentientMarkLayout.defaultSize) {
        self.init(
            state: state,
            size: size,
            model: RiveIdentityModel(initialState: state)
        )
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
            model.controller.synchronize(
                state: state,
                reducedMotion: effectiveReducedMotion
            )
        }
        .onChange(of: state) { _, latest in model.controller.request(latest) }
        .onChange(of: reducedMotion) { _, reduced in
            guard reducedMotionOverride == nil else { return }
            model.controller.setReducedMotion(reduced)
        }
    }
}

/// Compatibility name retained for existing chat call sites.
struct SentientMark: View {
    var size: CGFloat = SentientMarkLayout.defaultSize
    var mode: SentientIdentityState = .idle

    var body: some View {
        RiveSentientIdentity(state: mode, size: size)
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
