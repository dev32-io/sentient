// ---------------------------------------------------------------------------
// PermissionPromptDialog — the L3 `confirm` permission prompt (design spec §7.1,
// §5.3). Shown when the model wants to run a side-effecting tool and the PDP needs
// a user decision. Pure/stateless — [request] + Allow/Deny callbacks are hoisted
// from ChatViewModel via ChatContent/ChatHost, mirroring AddMemberDialog /
// ChangePinDialog's state-in/callbacks-out shape. Allow uses the
// canonical confirmButton TextButton; Deny uses DangerButton (the destructive-
// affordance style) instead of a plain TextButton — this is a real decision, not
// "Cancel": declining blocks the tool and the model is told the user refused.
//
// onDismissRequest is intentionally a NO-OP, and DialogProperties disables both
// back-press and tap-outside dismissal: this is a security decision gate, not a
// dismissible notice ("blocks the turn until answered" per spec §7.1). A
// swipe/back must not silently produce ANY outcome — neither an implicit allow NOR
// an implicit deny. The only exits are the two buttons below, or the server's own
// `permission.resolved` / ChatViewModel's local-timeout fallback.
//
// The countdown is DISPLAY-ONLY — it decides nothing itself; it is driven by a
// LaunchedEffect keyed on expiresAtMs, so Compose's structural concurrency cancels
// it automatically the instant this dialog leaves composition (ChatViewModel
// clears pendingPermissionRequest on Allow/Deny tap, on a matching
// permission.resolved, or on its own local-timeout fallback) — no manual Job here.
//
// The description block reuses ToolPillStrip.kt's exact args-preview text idiom
// (JetBrainsMono / ink2 / accent-tinted background @ alpha 0.10f / tokens.space.md
// padding) rather than inventing new copy formatting.
// ---------------------------------------------------------------------------
package io.sentient.android.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.window.DialogProperties
import io.sentient.android.settings.components.DangerButton
import io.sentient.android.theme.JetBrainsMono
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.connectors.PermissionPrompt
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.util.formatToolName
import kotlinx.coroutines.delay

private const val DESCRIPTION_BG_ALPHA = 0.10f
private const val COUNTDOWN_TICK_MS = 1_000L
private const val MS_PER_SECOND = 1_000L
private const val SECONDS_PER_MINUTE = 60L
private const val PREVIEW_EXPIRES_IN_MS = 120_000L

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun PermissionPromptDialog(
    request: PermissionPrompt,
    onAllow: () -> Unit,
    onDeny: () -> Unit,
) {
    val tokens = LocalTokens.current
    val remainingMs = rememberRemainingMs(request.expiresAtMs)
    AlertDialog(
        onDismissRequest = {}, // no-op — see file header: this is a decision gate, not a notice.
        properties = DialogProperties(dismissOnBackPress = false, dismissOnClickOutside = false),
        // The dialog renders in its OWN window, a SEPARATE semantics owner — the
        // app-root testTagsAsResourceId (nav/AppNavHost.kt) does NOT reach it, so
        // re-enable it here or uiautomator/Maestro sees every node with
        // resource-id="" and no `chat-permission-*` id can ever resolve. Same
        // reason settings/components/RowSelect.kt does it for its dropdown popup.
        modifier = Modifier.semantics { testTagsAsResourceId = true }.testTag("chat-permission-dialog"),
        title = { Text("Allow this action?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
                Text(
                    text = formatToolName(request.toolName),
                    fontFamily = JetBrainsMono,
                    fontSize = tokens.type.sm,
                    color = Color(Colors.ink3),
                    modifier = Modifier.testTag("chat-permission-tool"),
                )
                Text(
                    text = request.description,
                    fontFamily = JetBrainsMono,
                    fontSize = tokens.type.sm,
                    color = Color(Colors.ink2),
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color(Colors.accent).copy(alpha = DESCRIPTION_BG_ALPHA))
                        .padding(tokens.space.md)
                        .testTag("chat-permission-description"),
                )
                Text(
                    text = "Expires in ${formatRemaining(remainingMs)}",
                    color = Color(Colors.ink3),
                    fontSize = tokens.type.xs,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = onAllow, modifier = Modifier.testTag("chat-permission-allow")) {
                Text("Allow")
            }
        },
        dismissButton = {
            DangerButton(label = "Deny", onClick = onDeny, testTag = "chat-permission-deny")
        },
    )
}

/** Display-only countdown to [expiresAtMs]. Never dismisses or decides anything —
 *  see the file header. Cancelled automatically when the caller leaves composition. */
@Composable
private fun rememberRemainingMs(expiresAtMs: Long): Long {
    var remaining by remember(expiresAtMs) {
        mutableStateOf((expiresAtMs - System.currentTimeMillis()).coerceAtLeast(0))
    }
    LaunchedEffect(expiresAtMs) {
        while (remaining > 0) {
            delay(COUNTDOWN_TICK_MS)
            remaining = (expiresAtMs - System.currentTimeMillis()).coerceAtLeast(0)
        }
    }
    return remaining
}

private fun formatRemaining(ms: Long): String {
    val totalSeconds = ms / MS_PER_SECOND
    val minutes = totalSeconds / SECONDS_PER_MINUTE
    val seconds = totalSeconds % SECONDS_PER_MINUTE
    return "%d:%02d".format(minutes, seconds)
}

@Preview
@Composable
private fun PermissionPromptDialogPreview() {
    SentientTheme {
        PermissionPromptDialog(
            request = PermissionPrompt(
                requestId = "req-1",
                toolCallId = "call-1",
                toolName = "assistant_signal_send_message",
                args = mapOf("recipient" to "Bob", "body" to "On my way"),
                description = "Send a Signal message to Bob: \"On my way\"",
                expiresAtMs = System.currentTimeMillis() + PREVIEW_EXPIRES_IN_MS,
            ),
            onAllow = {},
            onDeny = {},
        )
    }
}
