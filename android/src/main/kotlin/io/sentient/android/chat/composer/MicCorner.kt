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
// control resets to IDLE WITHOUT calling [onStop] again. Only the true→false
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
    micActive: Boolean,
    onModeChange: (MicCornerMode) -> Unit,
    ensureMicPermission: () -> Boolean,
    onStart: () -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val density = LocalDensity.current
    val travelPx = with(density) { MIC_CORNER_TRAVEL.toPx() }
    val buttonPx = with(density) { MIC_CORNER_BUTTON.toPx() }
    val haptic = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()

    var mode by remember { mutableStateOf(MicCornerMode.IDLE) }
    var dragging by remember { mutableStateOf(false) }
    val drag = remember { Animatable(0f) }
    val armed by remember(travelPx) { derivedStateOf { isArmed(drag.value, travelPx) } }
    val railShown = dragging || mode == MicCornerMode.LOCKED

    val currentOnModeChange by rememberUpdatedState(onModeChange)
    val currentOnStart by rememberUpdatedState(onStart)
    val currentOnStop by rememberUpdatedState(onStop)
    val currentEnsurePermission by rememberUpdatedState(ensureMicPermission)

    // Mode transition with side effects: entering from IDLE starts the mic,
    // returning to IDLE stops it. HOLD→LOCKED is a pure visual promotion.
    fun setMode(next: MicCornerMode, trigger: String) {
        val prev = mode
        if (prev == next) return
        mode = next
        currentOnModeChange(next)
        log.info("mode-change", mapOf("from" to prev.name, "to" to next.name, "trigger" to trigger))
        if (prev == MicCornerMode.IDLE) {
            currentOnStart()
        } else if (next == MicCornerMode.IDLE) {
            currentOnStop()
        }
    }

    // External teardown (disconnect / failed start) while held or locked →
    // snap back to IDLE without stopping again. Keyed on dragging too so an
    // edge that lands mid-drag is consumed without resetting (webui parity).
    var prevActive by remember { mutableStateOf(micActive) }
    LaunchedEffect(micActive, dragging) {
        val was = prevActive
        prevActive = micActive
        if (was && !micActive && mode != MicCornerMode.IDLE && !dragging) {
            val prev = mode
            mode = MicCornerMode.IDLE
            currentOnModeChange(MicCornerMode.IDLE)
            log.info("mode-change", mapOf("from" to prev.name, "to" to "IDLE", "trigger" to "external-off"))
            scope.launch { drag.animateTo(0f, micCornerSpring()) }
        }
    }

    Box(
        modifier = modifier
            .size(MIC_CORNER_WRAP_WIDTH, MIC_CORNER_BUTTON)
            .testTag(if (mode == MicCornerMode.LOCKED) "mic-corner-locked" else "mic-corner")
            .then(micCornerOverlays(drag = { drag.value }, travelPx = travelPx, railShown = railShown, armed = armed, locked = mode == MicCornerMode.LOCKED))
            .pointerInput(travelPx) {
                awaitEachGesture {
                    val down = awaitFirstDown()
                    // Only presses landing on the button start a gesture — the
                    // empty rail area to its left stays inert.
                    val buttonLeft = size.width - buttonPx - drag.value
                    if (down.position.x < buttonLeft || down.position.x > buttonLeft + buttonPx) return@awaitEachGesture
                    if (mode == MicCornerMode.IDLE && !currentEnsurePermission()) return@awaitEachGesture
                    down.consume()

                    val origin = mode
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
            mode = mode,
            railShown = railShown,
            armed = armed,
            dragOffset = { -drag.value },
            modifier = Modifier.align(Alignment.CenterEnd),
        )
    }
}
