// ---------------------------------------------------------------------------
// SignalLinkDialog — the in-progress Signal linking modal. Shown while the link
// flow is non-Idle: Starting (preparing), AwaitingScan (QR + instructions), or
// Error (retry). Pure/stateless — [link] + cancel/retry callbacks are hoisted from
// DevicesViewModel. The QR must be scanned from ANOTHER device running Signal (see
// QrImage). testTags: settings-devices-link-dialog/-cancel/-retry.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.devices

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors

private val QR_SIZE = 240.dp
private const val SAME_DEVICE_NOTE =
    "Scan this code from the Signal app on ANOTHER device (Settings → Linked devices → " +
        "Link New Device). You can't scan a code shown on this same screen."

/**
 * The linking overlay. [link] must be non-Idle when this is shown; [onCancel]
 * abandons (fires the server-side cancel), [onRetry] restarts the flow after an error.
 */
@Composable
fun SignalLinkDialog(
    link: LinkFlowState,
    onCancel: () -> Unit,
    onRetry: () -> Unit,
) {
    if (link is LinkFlowState.Idle) return
    val tokens = LocalTokens.current
    AlertDialog(
        onDismissRequest = onCancel,
        modifier = Modifier.testTag("settings-devices-link-dialog"),
        title = { Text("Link your Signal account") },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(tokens.space.md),
            ) {
                when (link) {
                    LinkFlowState.Starting -> {
                        CircularProgressIndicator()
                        Text("Preparing link…", color = Color(Colors.ink3), fontSize = tokens.type.sm)
                    }
                    is LinkFlowState.AwaitingScan -> {
                        QrImage(link.qrDataUrl, modifier = Modifier.size(QR_SIZE))
                        Text(
                            SAME_DEVICE_NOTE,
                            color = Color(Colors.ink3),
                            fontSize = tokens.type.xs,
                            textAlign = TextAlign.Center,
                        )
                    }
                    is LinkFlowState.Error -> Text(
                        link.message,
                        modifier = Modifier.testTag("settings-devices-link-error"),
                        color = Color(Colors.stop),
                        fontSize = tokens.type.sm,
                        textAlign = TextAlign.Center,
                    )
                    LinkFlowState.Idle -> Unit
                }
            }
        },
        confirmButton = {
            if (link is LinkFlowState.Error) {
                TextButton(onClick = onRetry, modifier = Modifier.testTag("settings-devices-link-retry")) {
                    Text("Retry")
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onCancel, modifier = Modifier.testTag("settings-devices-link-cancel")) {
                Text("Cancel")
            }
        },
    )
}

@Preview
@Composable
private fun SignalLinkDialogErrorPreview() {
    SentientTheme {
        SignalLinkDialog(link = LinkFlowState.Error("Linking failed. Try again."), onCancel = {}, onRetry = {})
    }
}
