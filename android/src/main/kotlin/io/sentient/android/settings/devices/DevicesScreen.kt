// ---------------------------------------------------------------------------
// DevicesScreen — the Devices settings page (User group). One Signal card that is
// either Linked (masked account + linked date + Unlink w/ confirm) or Unlinked
// ("Link Signal" → QR + status poll). All state + callbacks come from
// [DevicesViewModel]; leaf views are pure. testTags: settings-devices-screen/-back,
// settings-devices-{link,unlink,unlink-confirm,unlink-cancel}.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.devices

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.android.settings.components.DangerButton
import io.sentient.android.settings.components.SettingsCard
import io.sentient.android.settings.components.SettingsTopBar
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors

private const val TITLE = "Devices"
private val DOT_SIZE = 8.dp

@Composable
fun DevicesScreen(
    vm: DevicesViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    DevicesContent(
        state = state,
        onBack = onBack,
        onLink = vm::startLink,
        onCancelLink = vm::cancelLink,
        onRetryLink = vm::retryLink,
        onUnlinkClick = vm::openUnlinkConfirm,
        onUnlinkConfirm = vm::unlink,
        onUnlinkCancel = vm::closeUnlinkConfirm,
        modifier = modifier,
    )
}

@Composable
private fun DevicesContent(
    state: DevicesUiState,
    onBack: () -> Unit,
    onLink: () -> Unit,
    onCancelLink: () -> Unit,
    onRetryLink: () -> Unit,
    onUnlinkClick: () -> Unit,
    onUnlinkConfirm: () -> Unit,
    onUnlinkCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val tokens = LocalTokens.current
    Column(
        modifier = modifier.fillMaxSize().safeDrawingPadding().testTag("settings-devices-screen"),
    ) {
        SettingsTopBar(title = TITLE, onBack = onBack, backTestTag = "settings-devices-back")
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = tokens.space.lg, vertical = tokens.space.md),
            verticalArrangement = Arrangement.spacedBy(tokens.space.md),
        ) {
            SettingsCard(title = "Signal", subtitle = "Text-chat via your own Signal account.") {
                Column(
                    modifier = Modifier.padding(horizontal = tokens.space.lg, vertical = tokens.space.sm),
                    verticalArrangement = Arrangement.spacedBy(tokens.space.sm),
                ) {
                    when (val card = state.card) {
                        SignalCardState.Loading ->
                            Text("Loading…", color = Color(Colors.ink3), fontSize = tokens.type.sm)
                        is SignalCardState.Linked -> LinkedView(card, state.busy, onUnlinkClick)
                        SignalCardState.Unlinked -> UnlinkedView(onLink)
                    }
                    if (state.errorMessage != null) {
                        Text(
                            state.errorMessage,
                            modifier = Modifier.testTag("settings-devices-error"),
                            color = Color(Colors.stop),
                            fontSize = tokens.type.sm,
                        )
                    }
                }
            }
        }
    }

    SignalLinkDialog(link = state.link, onCancel = onCancelLink, onRetry = onRetryLink)

    if (state.unlinkConfirmOpen) {
        AlertDialog(
            onDismissRequest = onUnlinkCancel,
            title = { Text("Disconnect Signal?") },
            text = {
                Text(
                    "This removes Sentient as a linked device from your Signal account. " +
                        "Past Signal conversation history is kept in your Sentient memory.",
                    color = Color(Colors.ink3),
                    fontSize = tokens.type.sm,
                )
            },
            confirmButton = {
                TextButton(
                    onClick = onUnlinkConfirm,
                    enabled = !state.busy,
                    modifier = Modifier.testTag("settings-devices-unlink-confirm"),
                ) { Text("Disconnect", color = Color(Colors.stop)) }
            },
            dismissButton = {
                TextButton(
                    onClick = onUnlinkCancel,
                    enabled = !state.busy,
                    modifier = Modifier.testTag("settings-devices-unlink-cancel"),
                ) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun LinkedView(card: SignalCardState.Linked, busy: Boolean, onUnlink: () -> Unit) {
    val tokens = LocalTokens.current
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(tokens.space.sm),
    ) {
        Box(modifier = Modifier.size(DOT_SIZE).clip(CircleShape).background(Color(Colors.ok)))
        Text("Linked", color = Color(Colors.ink), fontSize = tokens.type.base)
        card.accountMasked?.let { Text(it, color = Color(Colors.ink2), fontSize = tokens.type.sm) }
    }
    card.linkedAt?.let {
        Text("Linked ${formatLinkedDate(it)}", color = Color(Colors.ink3), fontSize = tokens.type.xs)
    }
    Text(
        "Open your \"Note to Self\" thread in Signal and text your agent like any conversation.",
        color = Color(Colors.ink3),
        fontSize = tokens.type.sm,
    )
    DangerButton(
        label = "Unlink",
        onClick = onUnlink,
        enabled = !busy,
        testTag = "settings-devices-unlink",
    )
}

@Composable
private fun UnlinkedView(onLink: () -> Unit) {
    val tokens = LocalTokens.current
    Text(
        "Text-chat with your agent from Signal. Uses \"Note to Self\" mode — links your own " +
            "Signal account, no second number needed.",
        color = Color(Colors.ink3),
        fontSize = tokens.type.sm,
    )
    Button(onClick = onLink, modifier = Modifier.testTag("settings-devices-link")) {
        Text("Link Signal")
    }
}

/** Show the date portion of an ISO-8601 linked_at (YYYY-MM-DD), or the raw string if shorter. */
private fun formatLinkedDate(linkedAt: String): String =
    if (linkedAt.length >= 10) "on ${linkedAt.take(10)}" else linkedAt

@Preview
@Composable
private fun DevicesLinkedPreview() {
    SentientTheme {
        DevicesContent(
            state = DevicesUiState(card = SignalCardState.Linked("+1 •••• 1234", "2026-07-16T10:00:00Z")),
            onBack = {}, onLink = {}, onCancelLink = {}, onRetryLink = {},
            onUnlinkClick = {}, onUnlinkConfirm = {}, onUnlinkCancel = {},
        )
    }
}

@Preview
@Composable
private fun DevicesUnlinkedPreview() {
    SentientTheme {
        DevicesContent(
            state = DevicesUiState(card = SignalCardState.Unlinked),
            onBack = {}, onLink = {}, onCancelLink = {}, onRetryLink = {},
            onUnlinkClick = {}, onUnlinkConfirm = {}, onUnlinkCancel = {},
        )
    }
}
