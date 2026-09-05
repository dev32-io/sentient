import SwiftUI

/// Shared semantic state for controls. The visual primitive owns how a state is
/// drawn; the state also supplies the VoiceOver value so disabled, loading,
/// error, selected, and on states cannot drift between controls.
enum DesignControlState: Equatable {
    case normal
    case loading
    case error(String)
    case selected
    case on
    case disabled

    var isInteractive: Bool {
        switch self {
        case .normal, .selected, .on: true
        case .loading, .error, .disabled: false
        }
    }

    var accessibilityValue: String {
        switch self {
        case .normal: "Ready"
        case .loading: "In progress"
        case .error(let message): "Error: \(message)"
        case .selected: "Selected"
        case .on: "On"
        case .disabled: "Disabled"
        }
    }

    var isSelected: Bool {
        switch self {
        case .selected, .on: true
        case .normal, .loading, .error, .disabled: false
        }
    }
}

enum DesignButtonRole { case action, secondary, destructive, quiet }

enum DesignNoticeKind: Equatable { case loading, empty, info, error, success, warning }

private struct DesignFieldError: View {
    let message: String
    let accessibilityId: String?

    var body: some View {
        Label(message, systemImage: "exclamationmark.circle.fill")
            .font(Typo.ui(TypeScale.sm))
            .foregroundStyle(DuskColors.stop)
            .accessibilityLabel("Error: \(message)")
            .accessibilityIdentifier(accessibilityId ?? "")
    }
}

// Keep the error view file-private while allowing focused controls to reuse
// the same semantic presentation from separate source files.
func designFieldError(message: String, accessibilityId: String?) -> some View {
    DesignFieldError(message: message, accessibilityId: accessibilityId)
}
