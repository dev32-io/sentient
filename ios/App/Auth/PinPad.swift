import SwiftUI

/// Compatibility entry for the login PIN surface. The common keypad owns the
/// visual states, keyboard behavior, and feedback timing; authentication stays
/// in AuthViewModel.
struct PinPad: View {
    let entered: Int
    var isSubmitting = false
    var error: String? = nil
    var success: String? = nil
    var errorRevision = 0
    /// Previews and deterministic capture may override the system setting;
    /// normal callers leave this nil and follow Accessibility settings.
    var reducedMotionOverride: Bool? = nil
    let onDigit: (Character) -> Void
    let onDelete: () -> Void

    var body: some View {
        DesignPinKeypad(
            entered: entered,
            isSubmitting: isSubmitting,
            error: error,
            success: success,
            errorRevision: errorRevision,
            reducedMotionOverride: reducedMotionOverride,
            statusAccessibilityId: "pin-status",
            onDigit: onDigit,
            onDelete: onDelete
        )
    }
}
