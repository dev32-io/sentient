// ---------------------------------------------------------------------------
// DiagnosticsScreen — the Support-group "Diagnostics" category page. Moved off the
// root Settings page: it hosts the EXISTING SettingsDiagnostics section (session
// list → select → send → progress → sent/retry morph) unchanged, under a short
// description line. State (sessions / progress / outcome) is hoisted from
// SettingsViewModel via the host (AppNavHost), same wiring the root page used
// before the move — the section's testTags (settings-send-logs, settings-log-*)
// are preserved so the existing E2E keeps targeting them.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.diagnostics

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.tooling.preview.Preview
import io.sentient.android.settings.SettingsDiagnostics
import io.sentient.android.settings.UploadOutcome
import io.sentient.android.settings.components.SettingsTopBar
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.vitals.VitalsSessionInfo

private const val TITLE = "Diagnostics"
private const val DESCRIPTION =
    "Send a diagnostic log to help debug an issue. Pick a session and upload it — " +
        "logs contain timings and ids only, never your messages."

/**
 * The Diagnostics category page. [sessions] is newest-first; [progress] / [outcome]
 * reflect the in-flight / completed upload; [onUpload] posts the chosen session.
 * All state is hoisted from SettingsViewModel via the host.
 */
@Composable
fun DiagnosticsScreen(
    onBack: () -> Unit,
    sessions: List<VitalsSessionInfo>,
    progress: Float?,
    outcome: UploadOutcome?,
    onUpload: (String) -> Unit,
    modifier: Modifier = Modifier,
    nowMs: Long = System.currentTimeMillis(),
) {
    val tokens = LocalTokens.current
    var uploadingPath by remember { mutableStateOf<String?>(null) }
    Column(
        modifier = modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .testTag("diagnostics-screen"),
    ) {
        SettingsTopBar(title = TITLE, onBack = onBack, backTestTag = "diagnostics-back")
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = tokens.space.lg, vertical = tokens.space.md),
            verticalArrangement = Arrangement.spacedBy(tokens.space.md),
        ) {
            Text(
                text = DESCRIPTION,
                color = Color(Colors.ink3),
                fontSize = tokens.type.sm,
            )
            SettingsDiagnostics(
                sessions = sessions,
                nowMs = nowMs,
                uploadingPath = uploadingPath,
                progress = progress,
                outcome = outcome,
                onUpload = { path -> uploadingPath = path; onUpload(path) },
            )
        }
    }
}

private val previewSessions = listOf(
    VitalsSessionInfo(path = "vitals-1.log", sessionStartMs = 0L, crashed = false, sizeBytes = 4_096L),
    VitalsSessionInfo(path = "vitals-2.log", sessionStartMs = 60_000L, crashed = true, sizeBytes = 9_500L),
)

@Preview(name = "idle")
@Composable
private fun DiagnosticsScreenPreview() {
    SentientTheme {
        DiagnosticsScreen(
            onBack = {},
            sessions = previewSessions,
            progress = null,
            outcome = null,
            onUpload = {},
            nowMs = 120_000L,
        )
    }
}

@Preview(name = "sent")
@Composable
private fun DiagnosticsScreenSentPreview() {
    SentientTheme {
        DiagnosticsScreen(
            onBack = {},
            sessions = previewSessions,
            progress = null,
            outcome = UploadOutcome.Sent(ref = "ref-123"),
            onUpload = {},
            nowMs = 120_000L,
        )
    }
}
