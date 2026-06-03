// ---------------------------------------------------------------------------
// Composer — the chat input dock, mirroring the webui Composer
// (gateway/webui/src/components/dock/composer.tsx + components.css .composer).
//
// A paper-surface rounded card holding a multi-line text field over a button
// row: mic toggle, TTS toggle, a spacer, send, and (conditionally) interrupt.
// Send is disabled when the field is empty OR the SDK is not READY. Interrupt
// is shown only when cognition != IDLE || isSpeaking (a cycle is in flight or
// audio is playing). Mic toggle flips startMic/stopMic — the full mic pipeline
// is Phase-3 (E3), so it just latches voiceMode for now. TTS toggle flips the
// server-of-record preference via setTtsEnabled.
//
// imePadding keeps the dock above the soft keyboard (spec §6.1). The composer
// owns only the draft text (local UI state); everything else is read from
// SdkState and dispatched up through the callbacks.
//
// Mic button (E5): tapping it gates on the RECORD_AUDIO runtime permission. If
// already granted → toggle voice immediately; otherwise launch the system
// prompt and toggle on grant; on denial show a one-shot inline notice and do
// NOT start (audio rule: graceful mic-denial fallback). When voiceMode ACTIVE
// the mic button wears the accent "mic-on" styling.
//
// testTags: chat-input, chat-send, chat-interrupt, chat-tts-toggle, chat-mic.
// ---------------------------------------------------------------------------
package io.sentient.android.chat

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.log.createLogger

private val COMPOSER_RADIUS = 14.dp
private val BUTTON_SIZE = 40.dp
private const val MIC_DENIED_NOTICE = "Microphone permission is needed for voice."
private val composerLog = createLogger("android", "composer")

/**
 * Stateless composer. The single mutation entry is the [onSend] callback; mic /
 * TTS / interrupt fire their own callbacks. Draft text is local UI state.
 *
 * @param canSend True when the SDK is READY (text submission flows).
 * @param ttsEnabled Server-of-record TTS preference (mirrored, not owned).
 * @param micActive True while voiceMode == ACTIVE.
 * @param canInterrupt True when a cycle is in flight or audio is playing.
 */
@Composable
fun Composer(
    canSend: Boolean,
    ttsEnabled: Boolean,
    micActive: Boolean,
    canInterrupt: Boolean,
    onSend: (String) -> Unit,
    onMicToggle: () -> Unit,
    onTtsToggle: () -> Unit,
    onInterrupt: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val tokens = LocalTokens.current
    val context = LocalContext.current
    var draft by remember { mutableStateOf("") }
    var micDenied by remember { mutableStateOf(false) }
    val sendEnabled = draft.trim().isNotEmpty() && canSend

    // RECORD_AUDIO runtime gate. On grant → toggle; on denial → inline notice,
    // do not start. Already-active mic stops without a permission check.
    val micLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        composerLog.info("micPermissionResult", mapOf("granted" to granted))
        if (granted) {
            micDenied = false
            onMicToggle()
        } else {
            micDenied = true
        }
    }

    fun submit() {
        val trimmed = draft.trim()
        if (trimmed.isEmpty() || !canSend) return
        onSend(trimmed)
        draft = ""
    }

    fun onMicTap() {
        if (micActive) {
            onMicToggle()
            return
        }
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        composerLog.info("micTap", mapOf("granted" to granted))
        if (granted) {
            micDenied = false
            onMicToggle()
        } else {
            micLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .imePadding()
            .padding(horizontal = tokens.space.lg, vertical = tokens.space.md)
            .clipCard()
            .padding(tokens.space.md),
        verticalArrangement = Arrangement.spacedBy(tokens.space.sm),
    ) {
        if (micDenied) {
            Text(
                MIC_DENIED_NOTICE,
                color = Color(Colors.stop),
                fontSize = tokens.type.sm,
                modifier = Modifier.testTag("mic-denied-notice"),
            )
        }
        DraftField(draft = draft, onChange = { draft = it }, onSubmit = { submit() })
        ButtonRow(
            sendEnabled = sendEnabled,
            ttsEnabled = ttsEnabled,
            micActive = micActive,
            canInterrupt = canInterrupt,
            onSend = { submit() },
            onMicTap = { onMicTap() },
            onTtsToggle = onTtsToggle,
            onInterrupt = onInterrupt,
        )
    }
}

/** Paper card with the composer's rounded border. */
private fun Modifier.clipCard(): Modifier = this
    .background(Color(Colors.paper), RoundedCornerShape(COMPOSER_RADIUS))
    .border(1.dp, Color(Colors.line), RoundedCornerShape(COMPOSER_RADIUS))

@Composable
private fun DraftField(draft: String, onChange: (String) -> Unit, onSubmit: () -> Unit) {
    val tokens = LocalTokens.current
    TextField(
        value = draft,
        onValueChange = onChange,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .testTag("chat-input"),
        placeholder = { Text("Message Sentient", color = Color(Colors.ink3)) },
        textStyle = LocalTextStyle.current.copy(color = Color(Colors.ink), fontSize = tokens.type.base),
        maxLines = 6,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
        keyboardActions = KeyboardActions(onSend = { onSubmit() }),
        colors = TextFieldDefaults.colors(
            focusedContainerColor = Color.Transparent,
            unfocusedContainerColor = Color.Transparent,
            disabledContainerColor = Color.Transparent,
            focusedIndicatorColor = Color.Transparent,
            unfocusedIndicatorColor = Color.Transparent,
            cursorColor = Color(Colors.accent),
        ),
    )
}

@Composable
private fun ButtonRow(
    sendEnabled: Boolean,
    ttsEnabled: Boolean,
    micActive: Boolean,
    canInterrupt: Boolean,
    onSend: () -> Unit,
    onMicTap: () -> Unit,
    onTtsToggle: () -> Unit,
    onInterrupt: () -> Unit,
) {
    val tokens = LocalTokens.current
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(tokens.space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        MicButton(active = micActive, onClick = onMicTap)
        GlyphButton(
            glyph = if (ttsEnabled) "🔊" else "🔇",
            onClick = onTtsToggle,
            modifier = Modifier.testTag("chat-tts-toggle"),
        )
        Row(modifier = Modifier.weight(1f)) {}
        if (canInterrupt) {
            GlyphButton(
                glyph = "⏹",
                onClick = onInterrupt,
                tint = Color(Colors.stop),
                modifier = Modifier.testTag("chat-interrupt"),
            )
        }
        SendButton(enabled = sendEnabled, onClick = onSend)
    }
}

/** Mic toggle. [active] (voiceMode ACTIVE) wears the accent "mic-on" pill styling. */
@Composable
private fun MicButton(active: Boolean, onClick: () -> Unit) {
    val base = Modifier.size(BUTTON_SIZE).testTag("chat-mic")
    val styled = if (active) {
        base.clip(CircleShape).background(Color(Colors.accent))
    } else {
        base
    }
    TextButton(onClick = onClick, modifier = styled) {
        Text(if (active) "●" else "🎙", color = if (active) Color(Colors.bg) else Color(Colors.ink2))
    }
}

@Composable
private fun GlyphButton(
    glyph: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tint: Color = Color(Colors.ink2),
) {
    TextButton(onClick = onClick, modifier = modifier.size(BUTTON_SIZE)) {
        Text(glyph, color = tint)
    }
}

@Composable
private fun SendButton(enabled: Boolean, onClick: () -> Unit) {
    val tint = if (enabled) Color(Colors.accent) else Color(Colors.ink4)
    TextButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier
            .size(BUTTON_SIZE)
            .testTag("chat-send"),
        colors = ButtonDefaults.textButtonColors(
            contentColor = tint,
            disabledContentColor = Color(Colors.ink4),
        ),
    ) {
        Text("➤")
    }
}
