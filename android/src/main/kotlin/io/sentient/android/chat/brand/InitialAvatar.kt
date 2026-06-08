// ---------------------------------------------------------------------------
// InitialAvatar — a circle filled with [background] and the first letter of
// [name] centered in ink. Shared between the chat user bubble and the login
// avatar grid so the two surfaces stay pixel-identical.
// ---------------------------------------------------------------------------
package io.sentient.android.chat.brand

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors

/** First letter of [name], uppercased; '?' when blank. */
private fun initialOf(name: String): String =
    name.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "?"

/**
 * A filled circle avatar showing the first letter of [name].
 *
 * @param name        Display name — first letter is uppercased and centered.
 * @param size        Diameter of the circle.
 * @param modifier    Passed to the outer [Box].
 * @param background  Fill color; defaults to [Colors.accent50] (terra-dim).
 */
@Composable
fun InitialAvatar(
    name: String,
    size: Dp,
    modifier: Modifier = Modifier,
    background: Color = Color(Colors.accent50),
) {
    val tokens = LocalTokens.current
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .size(size)
            .clip(CircleShape)
            .background(background),
    ) {
        Text(
            text = initialOf(name),
            color = Color(Colors.ink),
            fontSize = tokens.type.sm,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Preview(showBackground = true, backgroundColor = 0xFF2B2621)
@Composable
private fun PreviewInitialAvatar() {
    InitialAvatar(name = "Alice", size = 40.dp)
}

@Preview(showBackground = true, backgroundColor = 0xFF2B2621)
@Composable
private fun PreviewInitialAvatarBlank() {
    InitialAvatar(name = "", size = 40.dp)
}
