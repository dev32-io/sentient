// ---------------------------------------------------------------------------
// ChangePinDialog — the Account "Change PIN" modal (current + new 4-digit PIN).
// Both fields are numeric-keyboard + masked; a wrong-current-PIN surfaces inline as
// [PinDialogState.error] with NO logout (the usecase folds that 401 as recoverable).
// Pure/stateless: [state] + the field/submit/cancel callbacks are hoisted from
// AccountViewModel. PIN values never leave this composable except into the VM.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.account

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.window.DialogProperties
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors

private const val PIN_LENGTH = 4

/**
 * The change-PIN dialog, shown only when [state] is non-null. [onCurrentChange] /
 * [onNewChange] feed the VM (which strips non-digits + caps at 4); [onSubmit] fires
 * the imperative PIN change; [onDismiss] closes without a call.
 */
@Composable
fun ChangePinDialog(
    state: PinDialogState,
    onCurrentChange: (String) -> Unit,
    onNewChange: (String) -> Unit,
    onSubmit: () -> Unit,
    onDismiss: () -> Unit,
) {
    val tokens = LocalTokens.current
    val submittable = state.current.length == PIN_LENGTH && state.new.length == PIN_LENGTH && !state.saving
    AlertDialog(
        onDismissRequest = onDismiss,
        // decorFitsSystemWindows = false → the dialog window uses ADJUST_NOTHING for the
        // IME (API 31+), so it stays put instead of recentering ~half the keyboard height
        // when a PIN field is focused. The two fields sit high in the card, above the
        // numeric keypad, so nothing is occluded.
        properties = DialogProperties(decorFitsSystemWindows = false),
        title = { Text("Change PIN") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
                Text(
                    "Enter your current 4-digit PIN, then choose a new one.",
                    color = Color(Colors.ink3),
                    fontSize = tokens.type.sm,
                )
                PinField(
                    label = "Current PIN",
                    value = state.current,
                    onValueChange = onCurrentChange,
                    enabled = !state.saving,
                    testTag = "settings-account-pin-current",
                )
                PinField(
                    label = "New PIN",
                    value = state.new,
                    onValueChange = onNewChange,
                    enabled = !state.saving,
                    testTag = "settings-account-pin-new",
                )
                if (state.error != null) {
                    Text(
                        text = state.error,
                        modifier = Modifier.testTag("settings-account-pin-error"),
                        color = Color(Colors.stop),
                        fontSize = tokens.type.sm,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = onSubmit,
                enabled = submittable,
                modifier = Modifier.testTag("settings-account-pin-submit"),
            ) { Text(if (state.saving) "Saving…" else "Update PIN") }
        },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                enabled = !state.saving,
                modifier = Modifier.testTag("settings-account-pin-cancel"),
            ) { Text("Cancel") }
        },
    )
}

@Composable
private fun PinField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    enabled: Boolean,
    testTag: String,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth().testTag(testTag),
        enabled = enabled,
        singleLine = true,
        label = { Text(label) },
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
    )
}

@Preview
@Composable
private fun ChangePinDialogPreview() {
    SentientTheme {
        ChangePinDialog(
            state = PinDialogState(current = "1234", new = "12", error = "Current PIN is wrong"),
            onCurrentChange = {},
            onNewChange = {},
            onSubmit = {},
            onDismiss = {},
        )
    }
}
