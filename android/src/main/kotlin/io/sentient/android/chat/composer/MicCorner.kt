// ---------------------------------------------------------------------------
// MicCorner — hold-to-talk / drag-to-lock mic control welded onto the composer
// card's top-right edge (half overhanging). Ports the webui MicCorner
// (gateway/webui/src/components/dock/mic-corner.tsx) — squircle shape, "ember
// trail" colorway, springy motion.
//
// Modes: IDLE | HOLD | LOCKED — mic on ⇔ HOLD or LOCKED.
//   press          → HOLD, mic starts immediately
//   drag LEFT      → button tracks the finger raw along the travel rail (snap)
//   release ≥ 40%  → LOCKED (snap to the far end, haptic); < 40% → IDLE
//                    (spring back, mic stops)
//   from LOCKED    → press again (base = travel), drag back right; release
//                    ≤ 50% of travel → IDLE (mic stops, haptic); else LOCKED
//
// The pure FSM (clampDrag / resolveRelease / isArmed) lives in
// MicCornerGesture.kt; the ember visuals live in MicCornerVisuals.kt.
//
// External sync: when [micActive] flips true→false while the control is not
// IDLE and not being dragged (disconnect, teardown, failed mic start), the
// control resets to IDLE WITHOUT emitting an intent. Only the true→false
// edge is observed so it never races the optimistic hold that begins before
// micActive propagates.
//
// Permission: [ensureMicPermission] gates the IDLE press. When it returns
// false (system prompt launched) the gesture is abandoned — no HOLD, no mic
// start. Stopping from LOCKED never checks permission.
//
// The wrap consumes its own pointer events (down + moves), so the composer's
// vertical swipe-dismiss gesture never fights the horizontal drag.
//
// testTags: "chat-mic" (the button, in MicCornerVisuals); the wrap flips
// "mic-corner" → "mic-corner-locked" while LOCKED for Maestro observability.
// ---------------------------------------------------------------------------
package io.sentient.android.chat.composer

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.animation.core.Animatable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.voice.talk.TalkMode
import kotlin.math.roundToInt
import kotlinx.coroutines.launch

private val log = createLogger("android", "mic-corner")

/** Wrap width — button + travel rail (webui: 96px wrap / 34px button, scaled). */
internal val MIC_CORNER_WRAP_WIDTH = 104.dp

/** Control button size — matches the composer row's [BUTTON_SIZE]. */
internal val MIC_CORNER_BUTTON = BUTTON_SIZE

/** Horizontal travel of the drag rail (wrap − button ≈ 66dp). */
internal val MIC_CORNER_TRAVEL = MIC_CORNER_WRAP_WIDTH - MIC_CORNER_BUTTON

@Composable
internal fun MicCorner(
    talkMode: TalkMode,
    ensureMicPermission: () -> Boolean,
    onPress: () -> Unit,
    onRelease: () -> Unit,
    onLock: () -> Unit,
    onStopContinuous: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val density = LocalDensity.current
    val travelPx = with(density) { MIC_CORNER_TRAVEL.toPx() }
    val buttonPx = with(density) { MIC_CORNER_BUTTON.toPx() }
    val haptic = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()

    var dragging by remember { mutableStateOf(false) }
    val sharedMode = when (talkMode) {
        TalkMode.Idle -> MicCornerMode.IDLE
        TalkMode.Hold -> MicCornerMode.HOLD
        TalkMode.Continuous -> MicCornerMode.LOCKED
    }
    // The optimistic preview is presentation-only while the shared FSM processes press.
    val renderedMode = if (dragging && sharedMode == MicCornerMode.IDLE) {
        MicCornerMode.HOLD
    } else sharedMode
    val drag = remember { Animatable(0f) }
    val armed by remember(travelPx) { derivedStateOf { isArmed(drag.value, travelPx) } }
    val railShown = dragging || renderedMode == MicCornerMode.LOCKED

    val currentOnPress by rememberUpdatedState(onPress)
    val currentOnRelease by rememberUpdatedState(onRelease)
    val currentOnLock by rememberUpdatedState(onLock)
    val currentOnStopContinuous by rememberUpdatedState(onStopContinuous)
    val currentEnsurePermission by rememberUpdatedState(ensureMicPermission)

    // Shared Idle is the only teardown presentation reset; it emits no intent.
    LaunchedEffect(talkMode, dragging) {
        if (talkMode == TalkMode.Idle && !dragging) {
            scope.launch { drag.animateTo(0f, micCornerSpring()) }
        }
    }

    // Mode transition → ONE SDK talk-mode intent. Pure gesture→intent translation with zero
    // mode semantics (the SDK's TalkModeController owns them all): this only names which
    // intent each FSM edge maps to. HOLD→LOCKED now emits onLock (audio.end + semantic
    // audio.start) rather than staying a silent visual promotion.
    fun setMode(next: MicCornerMode, trigger: String) {
        val prev = renderedMode
        if (prev == next) return
        // TalkMode remains the sole state owner; this adapter only translates the
        // pointer outcome into one shared intent.
        log.info("gesture-outcome", mapOf("from" to prev.name, "to" to next.name, "trigger" to trigger))
        when {
            prev == MicCornerMode.IDLE && next == MicCornerMode.HOLD -> currentOnPress()
            prev == MicCornerMode.HOLD && next == MicCornerMode.IDLE -> currentOnRelease()
            prev == MicCornerMode.HOLD && next == MicCornerMode.LOCKED -> currentOnLock()
            prev == MicCornerMode.LOCKED && next == MicCornerMode.IDLE -> currentOnStopContinuous()
            // Not reachable via pointer today, but keep the FSM total: a direct
            // IDLE→LOCKED composes press+lock (Idle→Hold→Continuous).
            prev == MicCornerMode.IDLE && next == MicCornerMode.LOCKED -> { currentOnPress(); currentOnLock() }
        }
    }

    Box(
        modifier = modifier
            .size(MIC_CORNER_WRAP_WIDTH, MIC_CORNER_BUTTON)
            .testTag(if (renderedMode == MicCornerMode.LOCKED) "mic-corner-locked" else "mic-corner")
            .then(micCornerOverlays(drag = { drag.value }, travelPx = travelPx, railShown = railShown, armed = armed, locked = renderedMode == MicCornerMode.LOCKED))
            .pointerInput(travelPx) {
                awaitEachGesture {
                    val down = awaitFirstDown()
                    // Only presses landing on the button start a gesture — the
                    // empty rail area to its left stays inert.
                    val buttonLeft = size.width - buttonPx - drag.value
                    if (down.position.x < buttonLeft || down.position.x > buttonLeft + buttonPx) return@awaitEachGesture
                    if (renderedMode == MicCornerMode.IDLE && !currentEnsurePermission()) return@awaitEachGesture
                    down.consume()

                    val origin = renderedMode
                    val base = if (origin == MicCornerMode.LOCKED) travelPx else 0f
                    val startX = down.position.x
                    var dragPx = base
                    dragging = true
                    scope.launch { drag.snapTo(base) }
                    if (origin == MicCornerMode.IDLE) setMode(MicCornerMode.HOLD, "pointer-down")

                    // Track the finger raw (snap, no animation) until lift/cancel.
                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                        if (!change.pressed) {
                            change.consume()
                            break
                        }
                        change.consume()
                        dragPx = clampDrag(base, startX, change.position.x, travelPx)
                        scope.launch { drag.snapTo(dragPx) }
                    }

                    val outcome = resolveRelease(origin, dragPx, travelPx)
                    log.debug(
                        "release",
                        mapOf(
                            "origin" to origin.name,
                            "drag" to dragPx.roundToInt(),
                            "travel" to travelPx.roundToInt(),
                            "outcome" to outcome.mode.name,
                        ),
                    )
                    dragging = false
                    if (outcome.mode == MicCornerMode.LOCKED && origin == MicCornerMode.IDLE) {
                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                    }
                    if (outcome.mode == MicCornerMode.IDLE && origin == MicCornerMode.LOCKED) {
                        haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    }
                    scope.launch { drag.animateTo(outcome.drag, micCornerSpring()) }
                    setMode(outcome.mode, "pointer-up")
                }
            },
    ) {
        MicCornerButton(
            mode = renderedMode,
            railShown = railShown,
            armed = armed,
            dragOffset = { -drag.value },
            modifier = Modifier.align(Alignment.CenterEnd),
        )
    }
}
