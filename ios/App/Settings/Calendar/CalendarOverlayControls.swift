import SwiftUI

struct CalendarPrimaryButton: View {
    let title: String
    var disabled = false
    let action: () -> Void
    var body: some View {
        DesignActionButton(title: title, state: disabled ? .disabled : .normal, action: action)
            .frame(minHeight: CalendarOverlaySemantics.actionHeight)
    }
}
struct CalendarSecondaryButton: View {
    let title: String
    var disabled = false
    let action: () -> Void
    var body: some View {
        DesignActionButton(title: title, role: .quiet,
                           state: disabled ? .disabled : .normal, action: action)
            .frame(minHeight: CalendarOverlaySemantics.actionHeight)
    }
}
struct CalendarDestructiveButton: View {
    let title: String
    var disabled = false
    let action: () -> Void
    var body: some View {
        DesignActionButton(title: title, role: .destructive,
                           state: disabled ? .disabled : .normal, action: action)
            .frame(minHeight: CalendarOverlaySemantics.actionHeight)
    }
}

struct CalendarOverlayPressButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(Rectangle())
            .scaleEffect(configuration.isPressed && !reduceMotion
                         ? CalendarOverlaySemantics.pressedScale
                         : CalendarOverlaySemantics.normalScale)
            .animation(DesignV2.Motion.animation(duration: DesignV2.Motion.feedback,
                                                 reduceMotion: reduceMotion),
                       value: configuration.isPressed)
    }
}
