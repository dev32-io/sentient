// ---------------------------------------------------------------------------
// ConnectionBanner — the connection-state pill that floats over the chat
// surface, mirroring the webui ConnectionLostBanner + the iOS ConnectionBanner
// (parity: ios/App/Chat/ConnectionBanner.swift).
//
// Two states, discriminated by STATUS (NOT by connectionLost alone). In the
// mobile-sdk, `connectionLost` is true from the unexpected drop through the
// WHOLE backoff recovery AND at exhaustion — it is cleared only when status
// reaches READY (SentientSdk.onConnectionDrop / onReconnectExhausted /
// setStatus). So `connectionLost` only gates WHETHER a banner shows; the STATUS
// decides WHICH one:
//   - Reconnecting — SDK is mid-backoff: status is RECONNECTING / CONNECTING /
//                    AUTHENTICATING (the loop cycles through these while
//                    connectionLost stays true). A subtle "Reconnecting…"
//                    indicator with a spinner; NO CTA (the SDK is already
//                    retrying). Distinct affordance, never tap-to-retry.
//   - Lost         — recovery is OVER and unhealthy: status is DISCONNECTED
//                    (reconnect exhausted) or ERROR (terminal auth failure /
//                    session-ready timeout). Renders "Connection lost." + a
//                    "Tap to reconnect" CTA that calls forceReconnect().
//
// Stateless leaf: the host (MainActivity) derives the case via
// [ConnectionBannerState.derive] and passes `onReconnect`. No ViewModel
// reference — state hoisting per the android-compose rule. null case ⇒ host
// renders nothing.
//
// testTags: connection-lost-banner, connection-reconnect, connection-reconnecting.
// ---------------------------------------------------------------------------
package io.sentient.android.chat.banner

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
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
import io.sentient.mobilesdk.transport.SdkStatus

/**
 * Which connection affordance to show, or null. Derived from the SDK's single
 * state surface (`status` + `connectionLost`) via [derive].
 */
enum class ConnectionBannerState {
    /** Recovery is over and unhealthy — needs a manual "Tap to reconnect". */
    LOST,

    /** SDK is mid-backoff while `connectionLost` stays true. "Reconnecting…", no CTA. */
    RECONNECTING,
    ;

    companion object {
        /**
         * Pure FSM mapping from the single SDK state surface to a banner case.
         *
         * `connectionLost` is true from an unexpected drop through the entire
         * recovery AND at exhaustion (cleared only on READY), so it cannot
         * distinguish "looping" from "exhausted" on its own — STATUS does that:
         *   - not (`connectionLost` or status ERROR) → null (healthy, or a normal
         *     FIRST connect where `connectionLost` is false).
         *   - status RECONNECTING / CONNECTING / AUTHENTICATING → [RECONNECTING].
         *   - status DISCONNECTED / ERROR → [LOST].
         *   - status READY → null.
         */
        fun derive(status: SdkStatus, connectionLost: Boolean): ConnectionBannerState? {
            if (!connectionLost && status != SdkStatus.ERROR) return null
            return when (status) {
                SdkStatus.RECONNECTING, SdkStatus.CONNECTING, SdkStatus.AUTHENTICATING -> RECONNECTING
                SdkStatus.DISCONNECTED, SdkStatus.ERROR -> LOST
                SdkStatus.READY -> null
            }
        }
    }
}

private const val LOST_TEXT = "Connection lost."
private const val RECONNECT_CTA = "Tap to reconnect"
private const val RECONNECTING_TEXT = "Reconnecting…"
private val SPINNER_SIZE = 14.dp
private val SPINNER_STROKE = 2.dp
private val BANNER_BORDER = 1.dp

/**
 * A floating status pill. Stateless: the case + reconnect action are injected.
 * [onReconnect] is only invoked by the [ConnectionBannerState.LOST] CTA.
 */
@Composable
fun ConnectionBanner(
    state: ConnectionBannerState,
    onReconnect: () -> Unit,
    modifier: Modifier = Modifier,
) {
    when (state) {
        ConnectionBannerState.LOST -> LostBanner(onReconnect, modifier)
        ConnectionBannerState.RECONNECTING -> ReconnectingBanner(modifier)
    }
}

@Composable
private fun LostBanner(onReconnect: () -> Unit, modifier: Modifier) {
    val tokens = LocalTokens.current
    Row(
        modifier = modifier
            .background(Color(Colors.bgElev), RoundedCornerShape(tokens.radii.pill))
            .border(BANNER_BORDER, Color(Colors.line), RoundedCornerShape(tokens.radii.pill))
            .padding(horizontal = tokens.space.lg, vertical = tokens.space.xs)
            .testTag("connection-lost-banner"),
        horizontalArrangement = Arrangement.spacedBy(tokens.space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = LOST_TEXT,
            color = Color(Colors.ink),
            fontSize = tokens.type.sm,
            fontWeight = FontWeight.Medium,
        )
        TextButton(
            onClick = onReconnect,
            modifier = Modifier.testTag("connection-reconnect"),
        ) {
            Text(
                text = RECONNECT_CTA,
                color = Color(Colors.accent),
                fontSize = tokens.type.sm,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

@Composable
private fun ReconnectingBanner(modifier: Modifier) {
    val tokens = LocalTokens.current
    Row(
        modifier = modifier
            .background(Color(Colors.bgElev), RoundedCornerShape(tokens.radii.pill))
            .border(BANNER_BORDER, Color(Colors.line), RoundedCornerShape(tokens.radii.pill))
            .padding(horizontal = tokens.space.lg, vertical = tokens.space.sm)
            .testTag("connection-reconnecting"),
        horizontalArrangement = Arrangement.spacedBy(tokens.space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(
            modifier = Modifier.size(SPINNER_SIZE),
            color = Color(Colors.ink3),
            strokeWidth = SPINNER_STROKE,
        )
        Text(
            text = RECONNECTING_TEXT,
            color = Color(Colors.ink2),
            fontSize = tokens.type.sm,
            fontWeight = FontWeight.Medium,
        )
    }
}

@Preview(name = "Connection lost", showBackground = true, backgroundColor = 0xFF2B2621)
@Composable
private fun ConnectionBannerLostPreview() {
    SentientTheme { ConnectionBanner(state = ConnectionBannerState.LOST, onReconnect = {}) }
}

@Preview(name = "Reconnecting", showBackground = true, backgroundColor = 0xFF2B2621)
@Composable
private fun ConnectionBannerReconnectingPreview() {
    SentientTheme { ConnectionBanner(state = ConnectionBannerState.RECONNECTING, onReconnect = {}) }
}
