import SwiftUI

/// Coming Home's local choreography; PIN feedback remains owned by the composite.
enum LoginMotion {
    static let headerDuration = 0.600
    static let exitDuration = 0.140
    static let entranceDuration = 0.280
    static let avatarDuration = 0.300
    static let entrance = Animation.timingCurve(0.2, 0.8, 0.2, 1, duration: entranceDuration)
    static let avatar = Animation.timingCurve(0.22, 0.8, 0.24, 1, duration: avatarDuration)
}

struct LoginArrival: ViewModifier {
    let revealed: Bool
    var index: Int = 0
    var welcome = false
    var animated = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.layoutDirection) private var direction
    @State private var arrived = false

    func body(content: Content) -> some View {
        content
            .opacity(arrived ? 1 : 0)
            .offset(
                x: !arrived && welcome && !reduceMotion ? (direction == .rightToLeft ? -12 : 12) : 0,
                y: !arrived && !welcome && !reduceMotion ? 7 : 0
            )
            .task(id: revealed) {
                guard revealed else { arrived = false; return }
                guard animated, !arrived else { arrived = true; return }
                do {
                    if !reduceMotion && !welcome {
                        try await Task.sleep(for: .milliseconds(min(index, 7) * 18))
                    }
                    try Task.checkCancellation()
                    withAnimation(reduceMotion ? nil : .timingCurve(0.2, 0.8, 0.2, 1, duration: 0.350)) {
                        arrived = true
                    }
                } catch { /* Lifecycle cancellation is not a presentation failure. */ }
            }
    }
}

/// Interpolate geometry as one value before constructing the avatar. Otherwise
/// its canvas/font can adopt the final diameter while its position is in flight.
struct LoginFlyingAvatar: View, Animatable {
    let name: String
    let tint: DesignUserAvatarTint
    var rect: CGRect

    var animatableData: AnimatablePair<AnimatablePair<CGFloat, CGFloat>, CGFloat> {
        get { .init(.init(rect.midX, rect.midY), rect.width) }
        set {
            let diameter = newValue.second
            rect = CGRect(
                x: newValue.first.first - diameter / 2,
                y: newValue.first.second - diameter / 2,
                width: diameter, height: diameter
            )
        }
    }

    var body: some View {
        ElevatedUserAvatar(name: name, size: rect.width, tint: tint)
            .dynamicTypeSize(.large)
            .position(x: rect.midX, y: rect.midY)
    }
}
