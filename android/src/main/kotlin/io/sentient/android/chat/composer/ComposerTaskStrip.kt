// ---------------------------------------------------------------------------
// ComposerTaskStrip — the composer's live tool/task rows, flush with the top
// edge of the composer, inside its border (design v2,
// `sentient-webui-design-v2/screenshots/00-chat-reference.png`; spec
// `docs/superpowers/specs/2026-04-18-cerebrum-ux-refresh-design.md` §4.9).
// Mirrors iOS `ComposerTaskStrip.swift` and webui `composer-task-strip.tsx`.
//
// It replaced pills attached to a chat bubble. Those forced every client to
// answer "which bubble does this pill belong to", which has no stable answer
// once a mid-turn steer can split a reply. The strip has no anchor: the
// gateway owns the full row list (a `tasklist.state` full-state frame,
// surfaced here as `ChatModel.tasks`) and decides which rows exist and when
// they leave — this only renders them.
//
// The strip owns its own `openId` — no bubble to coordinate an anchor with.
// The tapped pill's detail renders ABOVE the pills row (spec §4.9: "click pill
// to expand detail upward") because the strip sits at the very top of the
// composer card; an expansion has nowhere to grow but up. It renders NOTHING
// when the list is empty — a Composable that emits no children contributes no
// size to the parent Column, so an empty strip adds no height and no padding
// to the composer.
//
// Pill width: never intrinsic-only, never equal-width `weight(1f)` either.
// The strip never wraps or shrinks pills to fit — it scrolls — and each pill
// gets a floor width DERIVED FROM THE STRIP'S OWN WIDTH via
// `taskPillMinWidth` (ComposerTaskStripLayout.kt), so the same rough number
// of pills is visible regardless of screen size or pill count, matching
// webui's `clamp(112px, 42cqw, 200px)` and iOS's `ComposerLayout
// .taskPillMinWidth` exactly. A pill may still grow past the floor to fit its
// name, capped at the same 200dp ceiling both other platforms use; beyond
// that the existing `maxLines=1` + `TextOverflow.Ellipsis` truncates. One
// pill alone sits at its natural (or floor) width, left-aligned — the Row
// below never distributes leftover space onto it.
//
// Overflow affordance: a peeking partially-visible next pill, not a visible
// scrollbar (Compose has no default one for `horizontalScroll`) or a drawn
// edge fade (skipped — a mis-tuned gradient mask is not something we can
// visually verify without an emulator, which this change deliberately
// avoids). Since ~2.4 pills fit at most widths by construction, the strip
// only exactly fits an integer pill count by coincidence, so a sliver of the
// next pill is visible whenever there's more to scroll to, same as the
// pre-existing webui mobile behavior this ports.
//
// Status dots: running=amber spinner, done=ok dot, error=stop dot, else
// (unknown/defaulted row)=ink4 dot.
// ---------------------------------------------------------------------------
package io.sentient.android.chat.composer

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.JetBrainsMono
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.protocol.TaskListItem
import io.sentient.mobilesdk.util.formatToolName

private val DOT_SIZE = 6.dp
private val SPINNER_SIZE = 10.dp
private val SPINNER_STROKE = 1.5.dp
private const val BG_ALPHA_DEFAULT = 0.04f
private const val BG_ALPHA_OPEN = 0.08f
private const val PREVIEW_BG_ALPHA = 0.10f

@Composable
fun ComposerTaskStrip(items: List<TaskListItem>, modifier: Modifier = Modifier) {
    if (items.isEmpty()) return
    val tokens = LocalTokens.current
    // Keyed by `id` — the row's identity for both a foreground tool call and a
    // background `delegateTask` (see TaskListItem.kind).
    var openId by remember { mutableStateOf<String?>(null) }
    // BoxWithConstraints reads the strip's OWN available width (before any
    // child is composed) so taskPillMinWidth can derive the floor from it —
    // the same "strip's own width" the webui `cqw` container query and iOS's
    // GeometryReader read.
    BoxWithConstraints(modifier = modifier.fillMaxWidth().testTag("task-strip")) {
        val pillMinWidth = taskPillMinWidth(maxWidth.value).dp
        Column(modifier = Modifier.fillMaxWidth()) {
            items.firstOrNull { it.id == openId }?.let { t -> Detail(t) }
            Row(
                modifier = Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(tokens.space.xs),
            ) {
                items.forEach { t ->
                    Pill(
                        t = t,
                        isOpen = openId == t.id,
                        minWidth = pillMinWidth,
                        onClick = { openId = if (openId == t.id) null else t.id },
                    )
                }
            }
        }
    }
}

@Composable
private fun Detail(t: TaskListItem) {
    val tokens = LocalTokens.current
    // `argsPreview` is USER CONTENT — rendered verbatim, never logged.
    Text(
        text = t.argsPreview,
        fontFamily = JetBrainsMono,
        fontSize = tokens.type.sm,
        color = Color(Colors.ink2),
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(Colors.accent).copy(alpha = PREVIEW_BG_ALPHA))
            .padding(tokens.space.md),
    )
}

@Composable
private fun Pill(t: TaskListItem, isOpen: Boolean, minWidth: Dp, onClick: () -> Unit) {
    val tokens = LocalTokens.current
    Row(
        modifier = Modifier
            // Outermost so it bounds the WHOLE pill (padding included), matching
            // webui's border-box min/max-width — never shrinks below the floor,
            // may grow with content up to the shared ceiling.
            .widthIn(min = minWidth, max = TASK_PILL_MAX_WIDTH_DP.dp)
            .clickable(onClick = onClick)
            .background(Color(Colors.ink).copy(alpha = if (isOpen) BG_ALPHA_OPEN else BG_ALPHA_DEFAULT))
            .padding(vertical = tokens.space.sm, horizontal = tokens.space.md)
            .testTag("task-pill-${t.id}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(tokens.space.sm),
    ) {
        StatusDot(t.status)
        Text(
            // Strip MCP/adapter routing prefixes for display (webui parity);
            // the raw name stays available via the expandable argsPreview.
            text = formatToolName(t.toolName),
            fontFamily = JetBrainsMono,
            fontSize = tokens.type.sm,
            color = Color(Colors.ink),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun StatusDot(status: String) {
    when (status) {
        "running" -> CircularProgressIndicator(
            modifier = Modifier.size(SPINNER_SIZE),
            strokeWidth = SPINNER_STROKE,
            color = Color(Colors.amber),
        )
        else -> {
            val dotColor = when (status) {
                "done" -> Colors.ok
                "error" -> Colors.stop
                else -> Colors.ink4
            }
            Box(
                modifier = Modifier
                    .size(DOT_SIZE)
                    .clip(CircleShape)
                    .background(Color(dotColor)),
            )
        }
    }
}
