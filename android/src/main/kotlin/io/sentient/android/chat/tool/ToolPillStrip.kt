// ---------------------------------------------------------------------------
// ToolPillStrip — one pill per tool task on an assistant bubble.
//
// Renders a horizontal row of pills (one per TaskSnapshotItem). Each pill shows
// a status dot + tool name. Tapping a pill toggles an argsPreview expansion
// below the row. Mirrors iOS Task 6.1.
//
// Status dots: running=amber spinner, finished=ok dot, failed=stop dot,
// cancelled=ink3 dot, else=ink4 dot.
// ---------------------------------------------------------------------------
package io.sentient.android.chat.tool

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.JetBrainsMono
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.connectors.TaskSnapshotItem
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.util.formatToolName

private val DOT_SIZE = 6.dp
private val SPINNER_SIZE = 10.dp
private val SPINNER_STROKE = 1.5.dp
private const val BG_ALPHA_DEFAULT = 0.04f
private const val BG_ALPHA_OPEN = 0.08f
private const val PREVIEW_BG_ALPHA = 0.10f

@Composable
fun ToolPillStrip(tools: List<TaskSnapshotItem>) {
    val tokens = LocalTokens.current
    var openId by remember { mutableStateOf<String?>(null) }
    Column(modifier = Modifier.fillMaxWidth().padding(top = tokens.space.md)) {
        Row(modifier = Modifier.fillMaxWidth()) {
            tools.forEach { t ->
                Pill(
                    t = t,
                    isOpen = openId == t.taskId,
                    modifier = Modifier.weight(1f),
                    onClick = { openId = if (openId == t.taskId) null else t.taskId },
                )
            }
        }
        tools.firstOrNull { it.taskId == openId }?.let { t ->
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
    }
}

@Composable
private fun Pill(t: TaskSnapshotItem, isOpen: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val tokens = LocalTokens.current
    Row(
        modifier = modifier
            .clickable(onClick = onClick)
            .background(Color(Colors.ink).copy(alpha = if (isOpen) BG_ALPHA_OPEN else BG_ALPHA_DEFAULT))
            .padding(vertical = tokens.space.sm, horizontal = tokens.space.md),
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
                "finished" -> Colors.ok
                "failed" -> Colors.stop
                "cancelled" -> Colors.ink3
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
