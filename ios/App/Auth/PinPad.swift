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
    let onDigit: (Character) -> Void
    let onDelete: () -> Void

    var body: some View {
        DesignPinKeypad(
            entered: entered,
            isSubmitting: isSubmitting,
            error: error,
            success: success,
            errorRevision: errorRevision,
            statusAccessibilityId: "pin-status",
            onDigit: onDigit,
            onDelete: onDelete
        )
    }
}
