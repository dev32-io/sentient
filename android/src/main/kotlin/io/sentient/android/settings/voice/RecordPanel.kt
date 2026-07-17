// ---------------------------------------------------------------------------
// RecordPanel — the in-app record capture UI for Add Voice (record mode). Handles
// the RECORD_AUDIO permission AT POINT OF USE (per mobile-lifecycle rules): request
// on the first Record tap, and on denial show a rationale + a settings-bounce button
// (and point the user at the Upload tab). Drives the elapsed timer, a soft minimum
// before "Use recording", the playback check, and re-record. Presentational apart
// from the permission plumbing; capture/encode lives in the VM + VoiceRecorder.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.voice

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.core.content.ContextCompat
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors

private const val MS_PER_SECOND = 1000.0

/** Record-mode capture UI. [onRecordStart] fires only once RECORD_AUDIO is granted. */
@Composable
fun RecordPanel(
    recording: Boolean,
    elapsedMs: Long,
    hasAudio: Boolean,
    audioDurationMs: Long?,
    previewPlaying: Boolean,
    micDenied: Boolean,
    onRecordStart: () -> Unit,
    onMicDenied: () -> Unit,
    onStop: () -> Unit,
    onCancel: () -> Unit,
    onTogglePlayback: () -> Unit,
    onReRecord: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) onRecordStart() else onMicDenied()
    }
    fun requestRecord() {
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) onRecordStart() else launcher.launch(Manifest.permission.RECORD_AUDIO)
    }

    val tokens = LocalTokens.current
    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
        when {
            micDenied -> MicDeniedState { openAppSettings(context) }
            recording -> RecordingState(elapsedMs = elapsedMs, onStop = onStop, onCancel = onCancel)
            hasAudio -> ReviewState(
                durationMs = audioDurationMs,
                previewPlaying = previewPlaying,
                onTogglePlayback = onTogglePlayback,
                onReRecord = onReRecord,
            )
            else -> IdleState(onRecord = ::requestRecord)
        }
    }
}

@Composable
private fun MicDeniedState(onOpenSettings: () -> Unit) {
    val tokens = LocalTokens.current
    Text(
        text = "Microphone access is off. Enable it in Settings, or use the Upload tab instead.",
        color = Color(Colors.stop),
        fontSize = tokens.type.sm,
    )
    OutlinedButton(onClick = onOpenSettings, modifier = Modifier.testTag("voice-record-settings")) {
        Text("Open settings")
    }
}

@Composable
private fun RecordingState(elapsedMs: Long, onStop: () -> Unit, onCancel: () -> Unit) {
    val tokens = LocalTokens.current
    val canFinish = elapsedMs >= MIN_RECORDING_MS
    Text(text = formatSeconds(elapsedMs), color = Color(Colors.accent), fontSize = tokens.type.xl, modifier = Modifier.testTag("voice-record-timer"))
    Row(horizontalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
        Button(onClick = onStop, enabled = canFinish, modifier = Modifier.testTag("voice-record-stop")) {
            Text("Use recording")
        }
        OutlinedButton(onClick = onCancel, modifier = Modifier.testTag("voice-record-cancel")) { Text("Cancel") }
    }
    if (!canFinish) {
        Text(text = "Record at least 6s to continue.", color = Color(Colors.ink3), fontSize = tokens.type.xs)
    }
}

@Composable
private fun ReviewState(durationMs: Long?, previewPlaying: Boolean, onTogglePlayback: () -> Unit, onReRecord: () -> Unit) {
    val tokens = LocalTokens.current
    val label = if (durationMs != null) "Recorded ${formatSeconds(durationMs)}." else "Clip ready."
    Text(text = label, color = Color(Colors.ink2), fontSize = tokens.type.sm)
    Row(horizontalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
        OutlinedButton(onClick = onTogglePlayback, modifier = Modifier.testTag("voice-record-play")) {
            Text(if (previewPlaying) "Stop" else "Play")
        }
        OutlinedButton(onClick = onReRecord, modifier = Modifier.testTag("voice-record-rerecord")) { Text("Re-record") }
    }
}

@Composable
private fun IdleState(onRecord: () -> Unit) {
    val tokens = LocalTokens.current
    Button(onClick = onRecord, modifier = Modifier.testTag("voice-record-start")) { Text("Record") }
    Text(text = "Record ~10–15s of clear speech.", color = Color(Colors.ink3), fontSize = tokens.type.xs)
}

private fun formatSeconds(ms: Long): String = "%.1fs".format(ms / MS_PER_SECOND)

private fun openAppSettings(context: android.content.Context) {
    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
}
