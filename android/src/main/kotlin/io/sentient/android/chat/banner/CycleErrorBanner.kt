// ---------------------------------------------------------------------------
// CycleErrorBanner — the inline, dismissible recovery row shown above the
// composer when a chat cycle aborts UNSOLICITED (wire-death / server error mid-
// cycle, surfaced as `SdkState.lastCycleError == true`). Mirrors the iOS
// CycleErrorBanner (parity: ios/App/Chat/CycleErrorBanner.swift) and the web-sdk
// graceful-degradation intent: the user got silence, so offer a way forward.
//
// Two recovery actions:
//   - Retry            — re-send the last user message (derived from
//                        state.messages via [CycleErrorRecovery.lastUserText]).
//                        Omitted when there is no prior user turn to resend.
//   - Start a new chat — newChat().
//
// The SDK auto-clears `lastCycleError` on the next cycle.started / a successful
// cycle / newChat / switchSession, so the row disappears once recovery begins —
// this view never mutates SDK state. The host MAY locally dismiss it (hide until
// the NEXT error) via the "×" close button; that is UI-only Compose state, reset
// on the false→true error edge so a FRESH error re-shows a dismissed row.
//
// Stateless leaf: the host derives `lastUserText` + passes the actions. No
// ViewModel reference — state hoisting per the android-compose rule.
//
// testTags: cycle-error-banner (container), cycle-error-retry, cycle-error-newchat,
//           cycle-error-dismiss.
// ---------------------------------------------------------------------------
package io.sentient.android.chat.banner

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
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.sdk.ChatMessage

/**
 * Pure derivation helpers for the cycle-error recovery affordance. Kept separate
 * from the composable so the "last user message" logic is unit-testable the same
 * way [ConnectionBannerState.derive] is (android-testing rule).
 */
object CycleErrorRecovery {
    private const val ROLE_USER = "user"

    /**
     * The text of the most recent user turn in [messages], or null when there is
     * no user entry to resend. Drives whether Retry is offered. Leading/trailing
     * whitespace is trimmed; a blank-after-trim entry counts as "nothing to
     * resend" (returns null) so Retry never fires an empty send.
     */
    fun lastUserText(messages: List<ChatMessage>): String? {
        val text = messages.lastOrNull { it.role == ROLE_USER }?.content?.trim()
        return if (text.isNullOrEmpty()) null else text
    }
}

private const val TITLE = "Couldn't get a response."
private const val RETRY_CTA = "Retry"
private const val NEW_CHAT_CTA = "Start a new chat"
private const val DISMISS_GLYPH = "✕"
private val BANNER_BORDER = 1.dp

/**
 * The inline recovery row. Stateless: the resend text + actions are injected.
 *
 * @param lastUserText Last user message to resend; null ⇒ no Retry button.
 * @param onRetry Re-send [lastUserText]. Only wired when [lastUserText] != null.
 * @param onNewChat Start a fresh chat (newChat()).
 * @param onDismiss Local dismiss — hide until the next error. UI-only.
 */
@Composable
fun CycleErrorBanner(
    lastUserText: String?,
    onRetry: () -> Unit,
    onNewChat: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val tokens = LocalTokens.current
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = tokens.space.lg, vertical = tokens.space.sm)
            .background(Color(Colors.bgElev), RoundedCornerShape(tokens.radii.lg))
            .border(BANNER_BORDER, Color(Colors.line), RoundedCornerShape(tokens.radii.lg))
            .padding(horizontal = tokens.space.lg, vertical = tokens.space.md)
            .testTag("cycle-error-banner"),
        horizontalArrangement = Arrangement.spacedBy(tokens.space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(tokens.space.xs),
        ) {
            Text(
                text = TITLE,
                color = Color(Colors.ink),
                fontSize = tokens.type.sm,
                fontWeight = FontWeight.Medium,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
                if (lastUserText != null) {
                    TextButton(onClick = onRetry, modifier = Modifier.testTag("cycle-error-retry")) {
                        Text(
                            text = RETRY_CTA,
                            color = Color(Colors.accent),
                            fontSize = tokens.type.sm,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
                TextButton(onClick = onNewChat, modifier = Modifier.testTag("cycle-error-newchat")) {
                    Text(
                        text = NEW_CHAT_CTA,
                        color = Color(Colors.ink2),
                        fontSize = tokens.type.sm,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }
        TextButton(onClick = onDismiss, modifier = Modifier.testTag("cycle-error-dismiss")) {
            Text(text = DISMISS_GLYPH, color = Color(Colors.ink3), fontSize = tokens.type.sm)
        }
    }
}

@Preview(name = "Cycle error — with retry", showBackground = true, backgroundColor = 0xFF2B2621)
@Composable
private fun CycleErrorWithRetryPreview() {
    SentientTheme {
        CycleErrorBanner(
            lastUserText = "What's the weather tomorrow?",
            onRetry = {},
            onNewChat = {},
            onDismiss = {},
        )
    }
}

@Preview(name = "Cycle error — no prior turn", showBackground = true, backgroundColor = 0xFF2B2621)
@Composable
private fun CycleErrorNoTurnPreview() {
    SentientTheme {
        CycleErrorBanner(
            lastUserText = null,
            onRetry = {},
            onNewChat = {},
            onDismiss = {},
        )
    }
}
