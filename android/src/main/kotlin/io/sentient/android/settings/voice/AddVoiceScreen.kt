// ---------------------------------------------------------------------------
// AddVoiceScreen — the Add Voice sub-page. A Record / Upload mode toggle, the
// matching capture UI (RecordPanel for in-app recording, a SAF file picker for
// upload), the shared name/description/tags/language form, and the multipart
// create with progress. On success the VM flags `done` and the screen fires
// [onDone] (distinct from a plain back) so the caller can signal VoiceScreen to
// refetch before popping. Mirrors the webui AddVoiceModal.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.voice

import android.content.Context
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.tooling.preview.Preview
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.android.settings.components.RowSegmented
import io.sentient.android.settings.components.SegmentOption
import io.sentient.android.settings.components.SettingsTopBar
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val UPLOAD_MIME = "audio/*"
private val MODE_OPTIONS = listOf(SegmentOption("record", "Record"), SegmentOption("upload", "Upload"))

/**
 * Add Voice page. [onBack] is a plain pop (top-bar back); [onDone] fires once on a
 * successful create ([AddVoiceUiState.done]) so the caller can flag VoiceScreen to
 * refetch before popping.
 */
@Composable
fun AddVoiceScreen(
    vm: AddVoiceViewModel,
    onBack: () -> Unit,
    onDone: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) scope.launch { readUpload(context, uri)?.let(vm::onUpload) }
    }
    LaunchedEffect(state.done) { if (state.done) onDone() }

    AddVoiceContent(
        state = state,
        onBack = onBack,
        onSetMode = vm::setMode,
        onPickFile = { picker.launch(UPLOAD_MIME) },
        onRecordStart = vm::startRecording,
        onMicDenied = vm::onMicDenied,
        onStop = vm::stopRecording,
        onCancel = vm::cancelRecording,
        onTogglePlayback = vm::togglePlayback,
        onReRecord = vm::reRecord,
        onName = vm::setName,
        onDescription = vm::setDescription,
        onAddTag = vm::addTag,
        onRemoveTag = vm::removeTag,
        onLanguage = vm::setLanguage,
        onSubmit = vm::submit,
        modifier = modifier,
    )
}

/** Stateless page body — no VM. Previewable per [AddVoiceUiState]. */
@Composable
private fun AddVoiceContent(
    state: AddVoiceUiState,
    onBack: () -> Unit,
    onSetMode: (AddVoiceMode) -> Unit,
    onPickFile: () -> Unit,
    onRecordStart: () -> Unit,
    onMicDenied: () -> Unit,
    onStop: () -> Unit,
    onCancel: () -> Unit,
    onTogglePlayback: () -> Unit,
    onReRecord: () -> Unit,
    onName: (String) -> Unit,
    onDescription: (String) -> Unit,
    onAddTag: (String) -> Unit,
    onRemoveTag: (String) -> Unit,
    onLanguage: (String) -> Unit,
    onSubmit: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val tokens = LocalTokens.current
    Column(modifier = modifier.fillMaxSize().safeDrawingPadding().testTag("settings-voice-add-screen")) {
        SettingsTopBar(title = "Add Voice", onBack = onBack, backTestTag = "settings-voice-add-back")
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = tokens.space.lg, vertical = tokens.space.md),
            verticalArrangement = Arrangement.spacedBy(tokens.space.md),
        ) {
            RowSegmented(
                options = MODE_OPTIONS,
                selected = if (state.mode == AddVoiceMode.RECORD) "record" else "upload",
                onSelect = { onSetMode(if (it == "record") AddVoiceMode.RECORD else AddVoiceMode.UPLOAD) },
                enabled = !state.submitting,
                modifier = Modifier.testTag("voice-add-mode"),
            )
            CaptureArea(
                state = state,
                onPickFile = onPickFile,
                onRecordStart = onRecordStart,
                onMicDenied = onMicDenied,
                onStop = onStop,
                onCancel = onCancel,
                onTogglePlayback = onTogglePlayback,
                onReRecord = onReRecord,
            )
            VoiceMetaForm(
                name = state.name,
                description = state.description,
                tags = state.tags,
                language = state.language,
                onName = onName,
                onDescription = onDescription,
                onAddTag = onAddTag,
                onRemoveTag = onRemoveTag,
                onLanguage = onLanguage,
                enabled = !state.submitting,
            )
            if (state.errorMessage != null) {
                Text(text = state.errorMessage.orEmpty(), color = Color(Colors.stop), fontSize = tokens.type.sm)
            }
            SubmitButton(state = state, onSubmit = onSubmit)
        }
    }
}

@Composable
private fun CaptureArea(
    state: AddVoiceUiState,
    onPickFile: () -> Unit,
    onRecordStart: () -> Unit,
    onMicDenied: () -> Unit,
    onStop: () -> Unit,
    onCancel: () -> Unit,
    onTogglePlayback: () -> Unit,
    onReRecord: () -> Unit,
) {
    when (state.mode) {
        AddVoiceMode.RECORD -> RecordPanel(
            recording = state.recording,
            elapsedMs = state.elapsedMs,
            hasAudio = state.hasAudio,
            audioDurationMs = state.audioDurationMs,
            previewPlaying = state.previewPlaying,
            micDenied = state.micDenied,
            onRecordStart = onRecordStart,
            onMicDenied = onMicDenied,
            onStop = onStop,
            onCancel = onCancel,
            onTogglePlayback = onTogglePlayback,
            onReRecord = onReRecord,
        )
        AddVoiceMode.UPLOAD -> UploadPanel(
            hasAudio = state.hasAudio,
            previewPlaying = state.previewPlaying,
            onPickFile = onPickFile,
            onTogglePlayback = onTogglePlayback,
        )
    }
}

@Composable
private fun UploadPanel(hasAudio: Boolean, previewPlaying: Boolean, onPickFile: () -> Unit, onTogglePlayback: () -> Unit) {
    val tokens = LocalTokens.current
    Column(verticalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
        Row(horizontalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
            OutlinedButton(onClick = onPickFile, modifier = Modifier.testTag("voice-upload-choose")) {
                Text(if (hasAudio) "Replace file" else "Choose file")
            }
            if (hasAudio) {
                OutlinedButton(onClick = onTogglePlayback, modifier = Modifier.testTag("voice-upload-play")) {
                    Text(if (previewPlaying) "Stop" else "Play")
                }
            }
        }
        Text(text = "WAV, FLAC, OGG, or MP3.", color = Color(Colors.ink3), fontSize = tokens.type.xs)
    }
}

@Composable
private fun SubmitButton(state: AddVoiceUiState, onSubmit: () -> Unit) {
    val enabled = state.hasAudio && state.name.trim().isNotEmpty() && !state.submitting
    Button(
        onClick = onSubmit,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().testTag("voice-add-submit"),
    ) {
        Text(if (state.submitting) "Creating…" else "Create voice")
    }
}

/** Read the SAF-picked audio bytes off the main thread; null on any read failure. */
private suspend fun readUpload(context: Context, uri: Uri): ByteArray? =
    withContext(Dispatchers.IO) {
        runCatching { context.contentResolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull()
    }

@Preview
@Composable
private fun AddVoiceScreenPreview() {
    SentientTheme {
        AddVoiceContent(
            state = AddVoiceUiState(
                mode = AddVoiceMode.RECORD,
                hasAudio = true,
                audioDurationMs = 8_400L,
                name = "Dad",
                tags = listOf("warm"),
            ),
            onBack = {},
            onSetMode = {},
            onPickFile = {},
            onRecordStart = {},
            onMicDenied = {},
            onStop = {},
            onCancel = {},
            onTogglePlayback = {},
            onReRecord = {},
            onName = {},
            onDescription = {},
            onAddTag = {},
            onRemoveTag = {},
            onLanguage = {},
            onSubmit = {},
        )
    }
}
