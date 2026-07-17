// ---------------------------------------------------------------------------
// AddMemberDialog — the Members "Add user" modal: display name + 4-digit PIN. The
// rest of the new member's profile is templated by AdminUseCases (shared
// mobile-data) off the admin's own live profile; the member tunes model/voice
// from their own settings after first login. Pure/stateless —
// [state] + callbacks are hoisted from MembersViewModel; the PIN never leaves this
// composable except into the VM. testTags: settings-members-add-{name,pin,submit,cancel}.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.members

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
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors

@Composable
fun AddMemberDialog(
    state: AddMemberState,
    onNameChange: (String) -> Unit,
    onPinChange: (String) -> Unit,
    onSubmit: () -> Unit,
    onDismiss: () -> Unit,
) {
    val tokens = LocalTokens.current
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add user") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
                Text(
                    "Give them a name and a 4-digit PIN. They can set up their model and voice after signing in.",
                    color = Color(Colors.ink3),
                    fontSize = tokens.type.sm,
                )
                OutlinedTextField(
                    value = state.displayName,
                    onValueChange = onNameChange,
                    modifier = Modifier.fillMaxWidth().testTag("settings-members-add-name"),
                    singleLine = true,
                    enabled = !state.saving,
                    label = { Text("Display name") },
                )
                OutlinedTextField(
                    value = state.pin,
                    onValueChange = onPinChange,
                    modifier = Modifier.fillMaxWidth().testTag("settings-members-add-pin"),
                    singleLine = true,
                    enabled = !state.saving,
                    label = { Text("PIN") },
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                )
                if (state.error != null) {
                    Text(
                        state.error,
                        modifier = Modifier.testTag("settings-members-add-error"),
                        color = Color(Colors.stop),
                        fontSize = tokens.type.sm,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = onSubmit,
                enabled = state.submittable,
                modifier = Modifier.testTag("settings-members-add-submit"),
            ) { Text(if (state.saving) "Adding…" else "Add") }
        },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                enabled = !state.saving,
                modifier = Modifier.testTag("settings-members-add-cancel"),
            ) { Text("Cancel") }
        },
    )
}

@Preview
@Composable
private fun AddMemberDialogPreview() {
    SentientTheme {
        AddMemberDialog(
            state = AddMemberState(displayName = "Sam", pin = "12"),
            onNameChange = {}, onPinChange = {}, onSubmit = {}, onDismiss = {},
        )
    }
}
