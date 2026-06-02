// ---------------------------------------------------------------------------
// HistoryRow + dialogs — one session row (tap → switch, long-press → menu) plus
// the rename/delete dialogs. Mirrors the webui session-row.tsx + row-menu.tsx +
// rename-dialog.tsx + confirm-delete-dialog.tsx semantics:
//   - tap the row body → switch to that session
//   - long-press → a Material DropdownMenu with Rename / Delete
//   - Rename → AlertDialog with a prefilled text field
//   - Delete → AlertDialog confirm (destructive)
// The active session highlights via SessionRow.isActive (gateway-sourced).
//
// testTag `history-row-<sessionId>` on the row root so the e2e driver targets a
// specific session.
// ---------------------------------------------------------------------------
package io.sentient.android.history

import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.protocol.SessionRow

private const val ROW_TAG_PREFIX = "history-row-"

@Composable
fun HistoryRow(
    row: SessionRow,
    nowMs: Long,
    onSwitch: () -> Unit,
    onAskRename: () -> Unit,
    onAskDelete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val tokens = LocalTokens.current
    var menuOpen by remember { mutableStateOf(false) }
    val bg = if (row.isActive) Color(Colors.accent50) else Color.Transparent
    val titleColor = if (row.isActive) Color(Colors.accent) else Color(Colors.ink)

    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(tokens.radii.md))
            .background(bg)
            .combinedClickable(
                onClick = onSwitch,
                onLongClick = { menuOpen = true },
            )
            .testTag("$ROW_TAG_PREFIX${row.sessionId}")
            .padding(horizontal = tokens.space.md, vertical = tokens.space.md),
    ) {
        Text(
            text = row.title,
            color = titleColor,
            fontSize = tokens.type.base,
            fontWeight = if (row.isActive) FontWeight.SemiBold else FontWeight.Normal,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text = "${relativeTime(nowMs, row.lastActiveAt)} · ${messageCountLabel(row.messageCount)}",
            color = Color(Colors.ink3),
            fontSize = tokens.type.xs,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            DropdownMenuItem(
                text = { Text("Rename") },
                onClick = { menuOpen = false; onAskRename() },
            )
            DropdownMenuItem(
                text = { Text("Delete", color = Color(Colors.stop)) },
                onClick = { menuOpen = false; onAskDelete() },
            )
        }
    }
}

@Composable
fun RenameDialog(initialTitle: String, onConfirm: (String) -> Unit, onDismiss: () -> Unit) {
    var text by rememberSaveable { mutableStateOf(initialTitle) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Rename chat") },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().testTag("history-rename-input"),
            )
        },
        confirmButton = {
            TextButton(
                enabled = text.trim().isNotEmpty(),
                onClick = { onConfirm(text.trim()); onDismiss() },
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
fun ConfirmDeleteDialog(title: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Delete chat?") },
        text = { Text("\"$title\" will be permanently deleted.") },
        confirmButton = {
            TextButton(onClick = { onConfirm(); onDismiss() }) {
                Text("Delete", color = Color(Colors.stop))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
