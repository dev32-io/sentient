// ---------------------------------------------------------------------------
// Composer — the chat input dock, mirroring the webui Composer
// (gateway/webui/src/components/dock/composer.tsx + components.css .composer).
//
// A paper-surface rounded card holding a multi-line text field over a button
// row (TTS toggle, attach, spacer, interrupt, send), with the MicCorner
// hold-to-talk / drag-to-lock control welded onto the card's top-right edge —
// half overhanging, so the card rides MIC_OVERHANG below the control's top
// inside a non-clipping parent Box (z-order: control above card).
//
// Send is enabled whenever the field is non-empty; a send issued before READY
// is queued by the outbox and flushed on the READY edge (always-typeable,
// web-sdk parity). canSend only tints the send glyph (accent=READY, muted=will
// queue). Interrupt is shown only when cognition != IDLE || isSpeaking.
//
// Recording takeover: while the MicCorner is HOLD or LOCKED the text field is
// hidden (alpha only — draft, focus/IME, and measured height all PRESERVED),
// the PttWave waveform overlays the WHOLE card as an inset-0 layer (drawn
// behind the content, so the interrupt button stays on top), and TTS / attach /
// send hide from the row (row min-height pinned — the composer's measured size
// is identical between idle and live). The composer glow keeps keying on
// micActive (server-confirmed voiceMode), webui parity.
//
// Mic permission (E5, adapted): the corner control's press gates on
// RECORD_AUDIO. Granted → HOLD + onMicPress. Not granted → system prompt,
// no HOLD; on grant the user presses again (no auto-start); on denial a
// one-shot inline notice shows. Stopping never checks permission.
//
// imePadding keeps the dock above the soft keyboard (spec §6.1). The composer
// owns only the draft text + corner-mic mode (local UI state); everything else
// is read from SdkState and dispatched up through the callbacks.
//
// testTags: composer-input, chat-send, chat-interrupt, chat-tts-toggle,
// chat-attach, chat-mic, mic-corner / mic-corner-locked, mic-denied-notice.
// ---------------------------------------------------------------------------
package io.sentient.android.chat.composer

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import io.sentient.android.chat.voice.PttWave
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTokens
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.log.createLogger

private val COMPOSER_RADIUS = 24.dp
private val SWIPE_DISMISS_DP = 24.dp

/** The corner control rides half its height above the card's top edge. */
private val MIC_OVERHANG = MIC_CORNER_BUTTON / 2

/** Inset of the corner control from the card's right edge (webui right: 10px). */
private val MIC_END_INSET = 10.dp

private const val MIC_DENIED_NOTICE = "Microphone permission is needed for voice."
private const val WAVE_IN_MS = 320
private const val WAVE_OUT_MS = 150
private const val WAVE_SLIDE_FRACTION = 12 // entrance slide = height / this (≈ webui 5px)
private val composerLog = createLogger("android", "composer")

/**
 * Stateless composer. The single mutation entry is the [onSend] callback; mic /
 * TTS / interrupt fire their own callbacks. Draft text + corner-mic mode are
 * local UI state.
 *
 * @param canSend True when the SDK is READY (text submission flows).
 * @param ttsEnabled Server-of-record TTS preference (mirrored, not owned).
 * @param micActive True while voiceMode == ACTIVE — external sync for MicCorner.
 * @param canInterrupt True when a cycle is in flight or audio is playing.
 * @param onMicPress Corner mic pressed (idle→hold) — enter push-to-talk.
 * @param onMicRelease Corner mic released below the lock threshold (hold→idle).
 * @param onMicLock Corner mic slid to lock (hold→locked) — enter continuous.
 * @param onMicStopContinuous Locked control released to stop (locked→idle) — leave continuous.
 * @param onFocus Called once when the text field gains focus — used for ensureConnected.
 */
@Composable
fun Composer(
    canSend: Boolean,
    ttsEnabled: Boolean,
    micActive: Boolean,
    canInterrupt: Boolean,
    onSend: (String) -> Unit,
    onMicPress: () -> Unit,
    onMicRelease: () -> Unit,
    onMicLock: () -> Unit,
    onMicStopContinuous: () -> Unit,
    onTtsToggle: () -> Unit,
    onInterrupt: () -> Unit,
    onFocus: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val tokens = LocalTokens.current
    val context = LocalContext.current
    var draft by remember { mutableStateOf("") }
    var micDenied by remember { mutableStateOf(false) }
    var micMode by remember { mutableStateOf(MicCornerMode.IDLE) }
    val micLive = micMode != MicCornerMode.IDLE
    val sendEnabled = draft.trim().isNotEmpty()
    val focusManager = LocalFocusManager.current
    val density = LocalDensity.current
    val swipeThresholdPx = with(density) { SWIPE_DISMISS_DP.toPx() }

    // RECORD_AUDIO result: granted clears the notice but does NOT auto-start —
    // the user presses the control again. Denial shows the one-shot notice.
    val micLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        composerLog.info("micPermissionResult", mapOf("granted" to granted))
        micDenied = !granted
    }

    // Press gate for the corner control: granted → enter HOLD; not granted →
    // launch the system prompt and abandon the press. Stop paths never gate.
    fun ensureMicPermission(): Boolean {
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        composerLog.info("micPress", mapOf("granted" to granted))
        if (granted) micDenied = false else micLauncher.launch(Manifest.permission.RECORD_AUDIO)
        return granted
    }

    fun submit() {
        val trimmed = draft.trim()
        if (trimmed.isEmpty()) return
        onSend(trimmed)
        draft = ""
    }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .imePadding()
            .padding(horizontal = tokens.space.lg)
            .padding(bottom = tokens.space.md),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = MIC_OVERHANG)
                .composerGlow(listening = micActive, tokens = tokens)
                .clipCard(listening = micActive)
                .pointerInput(Unit) {
                    var dragDown = 0f
                    detectVerticalDragGestures(
                        onDragEnd = { dragDown = 0f },
                        onVerticalDrag = { _, dy ->
                            dragDown += dy
                            if (dragDown > swipeThresholdPx) {
                                focusManager.clearFocus()
                                composerLog.info("keyboardDismiss", mapOf("gesture" to "swipeDown"))
                                dragDown = 0f
                            }
                        },
                    )
                },
        ) {
            // Recording takeover — an inset-0 overlay spanning the WHOLE card,
            // vertically centered, composed BEFORE the content so buttons stay on
            // top (webui .composer__wave-field parity). matchParentSize keeps it
            // out of the card's measurement: the composer never changes size.
            AnimatedVisibility(
                visible = micLive,
                enter = fadeIn(tween(WAVE_IN_MS)) + slideInVertically(tween(WAVE_IN_MS)) { it / WAVE_SLIDE_FRACTION },
                exit = fadeOut(tween(WAVE_OUT_MS)),
                modifier = Modifier.matchParentSize(),
            ) {
                Box(
                    Modifier.fillMaxSize().padding(horizontal = tokens.space.md),
                    contentAlignment = Alignment.Center,
                ) { PttWave() }
            }
            Column(
                modifier = Modifier
                    .fillMaxWidth()
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
                DraftField(
                    draft = draft,
                    live = micLive,
                    streaming = canInterrupt,
                    onChange = { draft = it },
                    onFocus = onFocus,
                )
                ButtonRow(
                    sendEnabled = sendEnabled,
                    canSend = canSend,
                    ttsEnabled = ttsEnabled,
                    live = micLive,
                    canInterrupt = canInterrupt,
                    onSend = { submit() },
                    onTtsToggle = onTtsToggle,
                    onInterrupt = onInterrupt,
                )
            }
        }
        MicCorner(
            micActive = micActive,
            onModeChange = { micMode = it },
            ensureMicPermission = { ensureMicPermission() },
            onPress = onMicPress,
            onRelease = onMicRelease,
            onLock = onMicLock,
            onStopContinuous = onMicStopContinuous,
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(end = MIC_END_INSET),
        )
    }
}

/**
 * Paper card with the composer's rounded border. While [listening] (mic active)
 * the border glows accent — mirrors the webui .composer--listening state.
 */
private fun Modifier.clipCard(listening: Boolean): Modifier = this
    .background(Color(Colors.paper), RoundedCornerShape(COMPOSER_RADIUS))
    .border(
        1.dp,
        if (listening) Color(Colors.accent) else Color(Colors.line),
        RoundedCornerShape(COMPOSER_RADIUS),
    )

/**
 * Soft amber outer glow behind the composer card (webui .composer halo). Drawn
 * BEHIND the card fill; intensifies (radius + alpha) while [listening]. Tunables
 * from [ShadowTokens]; color is the brand accent so it tracks the palette.
 */
private fun Modifier.composerGlow(listening: Boolean, tokens: SentientTokens): Modifier {
    val alpha = if (listening) tokens.shadow.composerGlowAlphaListening else tokens.shadow.composerGlowAlpha
    val radius = if (listening) tokens.shadow.composerGlowRadiusListening else tokens.shadow.composerGlowRadius
    val glow = Color(Colors.accent).copy(alpha = alpha)
    return this.drawBehind {
        val r = radius.toPx()
        val yOff = tokens.shadow.composerGlowYOffset.toPx()
        drawRoundRect(
            brush = Brush.verticalGradient(
                0f to glow.copy(alpha = 0f),
                1f to glow,
                startY = size.height * 0.4f,
                endY = size.height + r,
            ),
            topLeft = Offset(-r * 0.3f, yOff),
            size = Size(size.width + r * 0.6f, size.height + r),
            cornerRadius = CornerRadius((COMPOSER_RADIUS + radius).toPx()),
        )
    }
}
