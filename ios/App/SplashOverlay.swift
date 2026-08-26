import SwiftUI

protocol StartupMonotonicClock: Sendable {
    func sleepForMinimum() async
}

struct ContinuousStartupClock: StartupMonotonicClock {
    func sleepForMinimum() async {
        try? await Task.sleep(for: .milliseconds(1_500))
    }
}

/// Joins the independent minimum-display and active-root readiness signals.
/// Readiness is terminal UI readiness, not network success.
@MainActor
final class StartupReadinessCoordinator: ObservableObject {
    @Published private(set) var isCovering = true
    private(set) var minimumElapsed = false
    private(set) var rootResolved = false

    private let clock: any StartupMonotonicClock
    private var minimumTask: Task<Void, Never>?

    init(clock: any StartupMonotonicClock = ContinuousStartupClock()) {
        self.clock = clock
    }

    func begin() {
        minimumTask?.cancel()
        isCovering = true
        minimumElapsed = false
        rootResolved = false
        minimumTask = Task { [weak self, clock] in
            await clock.sleepForMinimum()
            guard !Task.isCancelled else { return }
            self?.minimumDidElapse()
        }
    }

    func rootDidResolve() {
        rootResolved = true
        revealIfReady()
    }

    /// Internal deterministic seam used by focused clock tests.
    func minimumDidElapse() {
        minimumElapsed = true
        revealIfReady()
    }

    private func revealIfReady() {
        guard minimumElapsed, rootResolved else { return }
        withAnimation(.easeOut(duration: SplashLayout.fadeOut)) {
            isCovering = false
        }
    }

    deinit { minimumTask?.cancel() }
}

struct SplashOverlay: View {
    var body: some View {
        ZStack {
            DuskColors.bg.ignoresSafeArea()
            VStack(spacing: Space.lg) {
                // Thinking is bound before this view's first frame; startup never
                // constructs an idle identity that could flash during handoff.
                SentientMark(size: SplashLayout.markSize, mode: .thinking)
                Text("Sentient")
                    .font(Typo.display(TypeScale.display, .semibold))
                    .foregroundStyle(DuskColors.ink)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("splash")
    }
}

#Preview { SplashOverlay() }
