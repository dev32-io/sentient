// ---------------------------------------------------------------------------
// HistorySessionsError — the two sessions-load-failure affordances for the
// History drawer, mirroring the iOS HistorySessionsError (parity:
// ios/App/History/HistorySessionsError.swift) + the webui sessions drawer:
//
//   - Empty-list failure → SessionsErrorEmpty: a centered "Couldn't load — Retry"
//     message + Retry button, shown WHERE the list would be when the fetch failed
//     and no rows are loaded. testTag: sessions-error-retry.
//   - Stale failure      → SessionsStaleBanner: a thin "Sync failed — list may be
//     stale." banner + Retry, shown ABOVE the still-rendered (stale) rows.
//     testTag: sessions-stale-retry.
//
// Both are stateless leaves: the host (HistoryContent) decides which to show from
// the pure [HistoryUiState.showsErrorEmpty] / [HistoryUiState.showsStaleBanner]
// derivations and passes `onRetry`. State hoisting per the android-compose rule;
// no ViewModel reference.
// ---------------------------------------------------------------------------
package io.sentient.android.history

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors

private const val EMPTY_ERROR_MSG = "Couldn't load past chats."
private const val STALE_MSG = "Sync failed — list may be stale."
private const val RETRY_CTA = "Retry"
private val BANNER_BORDER = 1.dp

/**
 * Centered empty-state shown in place of the list when the load failed and no
 * rows are present. Mirrors the iOS SessionsErrorEmpty.
 */
@Composable
fun SessionsErrorEmpty(onRetry: () -> Unit, modifier: Modifier = Modifier) {
    val tokens = LocalTokens.current
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = tokens.space.xxl, horizontal = tokens.space.lg),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(tokens.space.md),
    ) {
        Text(
            text = EMPTY_ERROR_MSG,
            color = Color(Colors.ink3),
            fontSize = tokens.type.sm,
            textAlign = TextAlign.Center,
        )
        TextButton(onClick = onRetry, modifier = Modifier.testTag("sessions-error-retry")) {
            Text(
                text = RETRY_CTA,
                color = Color(Colors.accent),
                fontSize = tokens.type.sm,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

/**
 * Thin banner shown above the (stale) rows when a re-fetch failed but rows are
 * already loaded. Mirrors the iOS SessionsStaleBanner.
 */
@Composable
fun SessionsStaleBanner(onRetry: () -> Unit, modifier: Modifier = Modifier) {
    val tokens = LocalTokens.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(Color(Colors.bgElev), RoundedCornerShape(tokens.radii.md))
            .border(BANNER_BORDER, Color(Colors.lineSoft), RoundedCornerShape(tokens.radii.md))
            .padding(horizontal = tokens.space.md, vertical = tokens.space.sm),
        horizontalArrangement = Arrangement.spacedBy(tokens.space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = STALE_MSG,
            modifier = Modifier.weight(1f),
            color = Color(Colors.ink2),
            fontSize = tokens.type.xs,
            fontWeight = FontWeight.Medium,
        )
        TextButton(onClick = onRetry, modifier = Modifier.testTag("sessions-stale-retry")) {
            Text(
                text = RETRY_CTA,
                color = Color(Colors.ink),
                fontSize = tokens.type.xs,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

@Preview(name = "Sessions error — empty", showBackground = true, backgroundColor = 0xFF2B2621)
@Composable
private fun SessionsErrorEmptyPreview() {
    SentientTheme { SessionsErrorEmpty(onRetry = {}) }
}

@Preview(name = "Sessions error — stale", showBackground = true, backgroundColor = 0xFF2B2621)
@Composable
private fun SessionsStaleBannerPreview() {
    SentientTheme { SessionsStaleBanner(onRetry = {}) }
}
