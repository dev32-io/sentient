// ---------------------------------------------------------------------------
// AvatarTile — one avatar in the login grid: a 56dp terra/accent-filled circle
// with the displayName's initial centered in ink, plus the name below it.
// Stateless: takes the user + an onClick, dispatches nothing itself (the screen
// wires it).
//
// The circle uses the terra accent fill (Colors.accent) so it matches the iOS
// login avatar (UserAvatar) and the in-chat / history-header avatars — NOT the
// per-user persona tint, which fell back to a dark elevated-surface circle for
// the common blank/unknown tint (the Android-only avatar bug this fixes).
//
// testTag `login-avatar-<userId>` is on the clickable circle so the e2e driver
// targets it directly.
// ---------------------------------------------------------------------------
package io.sentient.android.auth

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.sentient.android.chat.brand.InitialAvatar
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.auth.AuthUserLite
import io.sentient.mobilesdk.design.Colors

private val AVATAR_SIZE = 56.dp
private val LABEL_WIDTH = 72.dp

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
        InitialAvatar(
            name = user.displayName,
            size = AVATAR_SIZE,
            modifier = Modifier
                .clickable(onClick = onClick)
                .testTag("login-avatar-${user.userId}"),
            background = Color(Colors.accent),
        )
        Text(
            text = user.displayName,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
