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
