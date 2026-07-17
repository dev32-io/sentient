// ---------------------------------------------------------------------------
// SettingsTopBar — the shared Settings page header: a back chevron + a title.
// Extracted from SettingsScreen's inline title bar so the root list, the
// diagnostics page, and every category page render the SAME back affordance.
//
// [backTestTag] MUST be overridden per page (the root uses "settings-back",
// each category page uses "settings-<key>-back") so a Maestro/uiautomator back
// tap targets the right screen's chevron.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors

private const val BACK_CHEVRON = "‹"

/**
 * A Settings page header. [title] is the page name; [onBack] pops the back stack.
 * [backTestTag] identifies the chevron for E2E (default "settings-back").
 */
@Composable
fun SettingsTopBar(
    title: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    backTestTag: String = "settings-back",
) {
    val tokens = LocalTokens.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = tokens.space.md, vertical = tokens.space.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(tokens.space.xs),
    ) {
        TextButton(onClick = onBack, modifier = Modifier.testTag(backTestTag)) {
            Text(BACK_CHEVRON, color = Color(Colors.ink2), fontSize = tokens.type.xl)
        }
        Text(
            text = title,
            color = Color(Colors.ink),
            fontSize = tokens.type.lg,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Preview
@Composable
private fun SettingsTopBarPreview() {
    SentientTheme {
        SettingsTopBar(title = "Memory", onBack = {})
    }
}
