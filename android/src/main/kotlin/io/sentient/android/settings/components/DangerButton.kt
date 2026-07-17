// ---------------------------------------------------------------------------
// DangerButton — the red-tinted outlined style, extracted from SettingsScreen's
// LogoutButton so it's reusable for other destructive actions (delete voice pack,
// delete personality, unlink Signal, delete member, restore-default confirm, etc).
// SettingsScreen itself is NOT touched here — a later phase swaps LogoutButton's
// body to delegate to this component.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.components

import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.tooling.preview.Preview
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors

/**
 * An outlined, stop-tinted destructive action button. Caller supplies [label] +
 * layout (e.g. `Modifier.fillMaxWidth()`) — this composable owns only the color style.
 */
@Composable
fun DangerButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    testTag: String = "danger-button",
) {
    OutlinedButton(
        onClick = onClick,
        modifier = modifier.testTag(testTag),
        enabled = enabled,
        colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(Colors.stop)),
    ) {
        Text(label)
    }
}

@Preview
@Composable
private fun DangerButtonPreview() {
    SentientTheme {
        DangerButton(label = "Log out", onClick = {})
    }
}
