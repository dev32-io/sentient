// ---------------------------------------------------------------------------
// SettingsDiagnostics — the "Send diagnostic log" two-lane section of Settings.
//
// Lane 1: a button (settings-send-logs). Tap → reveals the session list.
// Lane 2: newest-first sessions, each human-labelled ("Today 9:43 PM"), crashed
//   ones flagged 🔴, "This session" (the newest) default-selected. Tapping a row's
//   send button MORPHS it in place into a progress bar (bound to progress:
//   Float?), then a result line ("Sent ✓ — ref XXXX" / "Upload failed — retry").
//
// Stateless: state (sessions / progress / outcome / which row is uploading) is
// hoisted from SettingsViewModel via the host. Split out of SettingsScreen to keep
// both files under the clean-code line limit.
// ---------------------------------------------------------------------------
package io.sentient.android.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.vitals.VitalsSessionInfo

private const val SEND_LOGS_LABEL = "Send diagnostic log"
private const val DIAGNOSTICS_LABEL = "Diagnostics"
private const val CRASH_FLAG = "🔴 "
private const val ROW_TAG_PREFIX = "settings-log-session-"
private const val LABEL_SENT = "Sent ✓"
private const val SENT_REF_PREFIX = "Sent ✓ — ref "
private const val LABEL_RETRY = "Retry"
private const val LABEL_SEND = "Send"
private const val LABEL_SELECT = "Select"
private const val LABEL_NO_SESSIONS = "No diagnostic sessions yet."
private val PROGRESS_WIDTH = 64.dp

/**
 * The diagnostics section. [sessions] is newest-first; [progress] (0..1, null =
 * idle/done) and [outcome] reflect the in-flight / completed upload of [uploadingPath].
 */
@Composable
fun SettingsDiagnostics(
    sessions: List<VitalsSessionInfo>,
    nowMs: Long,
    uploadingPath: String?,
    progress: Float?,
    outcome: UploadOutcome?,
    onUpload: (String) -> Unit,
) {
    val tokens = LocalTokens.current
    var expanded by remember { mutableStateOf(false) }
    // Default-select the newest ("This session"); null only when there are no sessions.
    var selectedPath by remember(sessions) { mutableStateOf(sessions.firstOrNull()?.path) }

    Column(verticalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
        Text(
            text = DIAGNOSTICS_LABEL,
            color = Color(Colors.ink3),
            fontSize = tokens.type.xs,
            fontWeight = FontWeight.SemiBold,
        )
        OutlinedButton(
            onClick = { expanded = !expanded },
            modifier = Modifier.fillMaxWidth().testTag("settings-send-logs"),
        ) { Text(SEND_LOGS_LABEL) }

        if (expanded) {
            if (sessions.isEmpty()) {
                Text(
                    text = LABEL_NO_SESSIONS,
                    modifier = Modifier.testTag("settings-log-empty"),
                    color = Color(Colors.ink3),
                    fontSize = tokens.type.sm,
                )
            } else {
                sessions.forEachIndexed { index, s ->
                    SessionUploadRow(
                        info = s,
                        label = sessionLabel(s, nowMs, isNewest = index == 0),
                        selected = s.path == selectedPath,
                        isUploading = s.path == uploadingPath,
                        progress = if (s.path == uploadingPath) progress else null,
                        outcome = if (s.path == uploadingPath) outcome else null,
                        onSelect = { selectedPath = s.path },
                        onUpload = { onUpload(s.path) },
                    )
                }
            }
        }
    }
}

/** One session: a select-row whose trailing send button morphs into a bar then a result. */
@Composable
private fun SessionUploadRow(
    info: VitalsSessionInfo,
    label: String,
    selected: Boolean,
    isUploading: Boolean,
    progress: Float?,
    outcome: UploadOutcome?,
    onSelect: () -> Unit,
    onUpload: () -> Unit,
) {
    val tokens = LocalTokens.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = tokens.space.xs)
            .testTag("$ROW_TAG_PREFIX${info.sessionStartMs}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(tokens.space.sm),
    ) {
        Text(
            text = (if (info.crashed) CRASH_FLAG else "") + label,
            modifier = Modifier.weight(1f),
            color = if (selected) Color(Colors.accent) else Color(Colors.ink),
            fontSize = tokens.type.sm,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
        )
        UploadControl(
            selected = selected,
            isUploading = isUploading,
            progress = progress,
            outcome = outcome,
            onSelect = onSelect,
            onUpload = onUpload,
        )
    }
}

/** The morphing trailing control: select → send button → progress bar → result line. */
@Composable
private fun UploadControl(
    selected: Boolean,
    isUploading: Boolean,
    progress: Float?,
    outcome: UploadOutcome?,
    onSelect: () -> Unit,
    onUpload: () -> Unit,
) {
    val tokens = LocalTokens.current
    when {
        isUploading && progress != null -> LinearProgressIndicator(
            progress = { progress },
            modifier = Modifier.width(PROGRESS_WIDTH).testTag("settings-log-progress"),
        )
        outcome is UploadOutcome.Sent -> Text(
            text = if (outcome.ref.isEmpty()) LABEL_SENT else "$SENT_REF_PREFIX${outcome.ref}",
            modifier = Modifier.testTag("settings-log-sent"),
            color = Color(Colors.accent),
            fontSize = tokens.type.xs,
        )
        outcome is UploadOutcome.Failed -> OutlinedButton(
            onClick = { onSelect(); onUpload() },
            modifier = Modifier.testTag("settings-log-failed"),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(Colors.stop)),
        ) { Text(LABEL_RETRY) }
        selected -> Button(
            onClick = onUpload,
            modifier = Modifier.testTag("settings-log-send"),
        ) { Text(LABEL_SEND) }
        else -> OutlinedButton(
            onClick = onSelect,
            modifier = Modifier.testTag("settings-log-select"),
        ) { Text(LABEL_SELECT) }
    }
}
