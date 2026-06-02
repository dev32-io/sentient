// ---------------------------------------------------------------------------
// AvatarTile — one avatar in the login grid: a 56dp tinted circle with the
// displayName's initial centered in ink, plus the name below it. Stateless:
// takes the user + an onClick, dispatches nothing itself (the screen wires it).
//
// testTag `login-avatar-<userId>` is on the clickable circle so the e2e driver
// targets it directly. Tint resolves from the SDK's Tints.map (persona slug →
// ARGB); an unknown/blank tint falls back to the elevated surface.
// ---------------------------------------------------------------------------
package io.sentient.android.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.auth.AuthUserLite
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.design.Tints

private val AVATAR_SIZE = 56.dp
private val LABEL_WIDTH = 72.dp

/** Resolve an avatar tint slug → Compose Color, falling back to the elevated surface. */
private fun tintColor(slug: String): Color =
    Color(Tints.map[slug] ?: Colors.bgElev)

/** First letter of [displayName], uppercased; '?' when the name is blank. */
private fun initialOf(displayName: String): String =
    displayName.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "?"

@Composable
fun AvatarTile(
    user: AuthUserLite,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val tokens = LocalTokens.current
    Column(
        modifier = modifier.width(LABEL_WIDTH),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(tokens.space.sm),
    ) {
        Box(
            modifier = Modifier
                .size(AVATAR_SIZE)
                .clip(CircleShape)
                .background(tintColor(user.avatarTint))
                .clickable(onClick = onClick)
                .testTag("login-avatar-${user.userId}"),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = initialOf(user.displayName),
                color = Color(Colors.ink),
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
            )
        }
        Text(
            text = user.displayName,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
