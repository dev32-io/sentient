// ---------------------------------------------------------------------------
// VoiceScreen — the Voice settings page. Filter bar + a list of voice-pack cards
// (play preview / set active / delete), plus the top action row: "Add voice"
// always, "Clone from Fish" only when the fish-browse feature flag is on. Mirrors
// the webui VoicesPanel. State + commands come from VoiceViewModel; the two nav
// lambdas (pre-wired by SettingsNav) reach the record/upload + Fish sub-pages.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.voice

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.tooling.preview.Preview
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.android.settings.components.SettingsTopBar
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.settings.VoiceSummary

private const val TITLE = "Voice"
private const val EMPTY_TEXT = "No voices match — clear filters or add your own."

/** Voice settings page. [onAddVoice] / [onCloneFish] route to the sub-pages (host-wired). */
@Composable
fun VoiceScreen(
    vm: VoiceViewModel,
    onBack: () -> Unit,
    onAddVoice: () -> Unit,
    onCloneFish: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    VoiceScreenContent(
        state = state,
        onBack = onBack,
        onAddVoice = onAddVoice,
        onCloneFish = onCloneFish,
        onQuery = vm::setQuery,
        onSource = vm::setSource,
        onLanguage = vm::setLanguage,
        onToggleTag = vm::toggleTag,
        onRetry = vm::refresh,
        onTogglePreview = vm::togglePreview,
        onPick = vm::pick,
        onRequestDelete = vm::requestDelete,
        onDismissNotice = vm::clearNotice,
        onCancelDelete = vm::cancelDelete,
        onConfirmDelete = vm::confirmDelete,
        modifier = modifier,
    )
}

/** Stateless page body — no VM. Previewable per [VoiceUiState]. */
@Composable
private fun VoiceScreenContent(
    state: VoiceUiState,
    onBack: () -> Unit,
    onAddVoice: () -> Unit,
    onCloneFish: () -> Unit,
    onQuery: (String) -> Unit,
    onSource: (String) -> Unit,
    onLanguage: (String) -> Unit,
    onToggleTag: (String) -> Unit,
    onRetry: () -> Unit,
    onTogglePreview: (VoiceSummary) -> Unit,
    onPick: (VoiceSummary) -> Unit,
    onRequestDelete: (VoiceSummary) -> Unit,
    onDismissNotice: () -> Unit,
    onCancelDelete: () -> Unit,
    onConfirmDelete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val tokens = LocalTokens.current
    Column(
        modifier = modifier.fillMaxSize().safeDrawingPadding().testTag("settings-voice-screen"),
    ) {
        SettingsTopBar(title = TITLE, onBack = onBack, backTestTag = "settings-voice-back")
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = tokens.space.lg, vertical = tokens.space.md),
            verticalArrangement = Arrangement.spacedBy(tokens.space.md),
        ) {
            VoiceActions(fishEnabled = state.fishEnabled, onAddVoice = onAddVoice, onCloneFish = onCloneFish)
            VoiceFilterBar(
                query = state.filter.query,
                source = state.filter.source,
                language = state.filter.language,
                activeTags = state.filter.tags,
                allTags = state.allTags,
                allLanguages = state.allLanguages,
                onQuery = onQuery,
                onSource = onSource,
                onLanguage = onLanguage,
                onToggleTag = onToggleTag,
            )
        }
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            VoiceContent(state = state, onRetry = onRetry, onTogglePreview = onTogglePreview, onPick = onPick, onRequestDelete = onRequestDelete)
        }
        if (state.notice != null) NoticeBanner(text = state.notice.orEmpty(), onDismiss = onDismissNotice)
    }
    state.pendingDelete?.let { target ->
        DeleteConfirmDialog(name = target.name, onCancel = onCancelDelete, onConfirm = onConfirmDelete)
    }
}

@Composable
private fun VoiceActions(fishEnabled: Boolean, onAddVoice: () -> Unit, onCloneFish: () -> Unit) {
    val tokens = LocalTokens.current
    Column(verticalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
        OutlinedButton(
            onClick = onAddVoice,
            modifier = Modifier.fillMaxWidth().testTag("settings-voice-add-nav"),
        ) { Text("Add voice") }
        if (fishEnabled) {
            OutlinedButton(
                onClick = onCloneFish,
                modifier = Modifier.fillMaxWidth().testTag("settings-voice-fish-nav"),
            ) { Text("Clone from Fish") }
        }
    }
}

@Composable
private fun VoiceContent(
    state: VoiceUiState,
    onRetry: () -> Unit,
    onTogglePreview: (VoiceSummary) -> Unit,
    onPick: (VoiceSummary) -> Unit,
    onRequestDelete: (VoiceSummary) -> Unit,
) {
    when {
        state.loading -> CenteredProgress()
        state.errorMessage != null -> ErrorRetry(message = state.errorMessage, onRetry = onRetry)
        state.shown.isEmpty() -> EmptyState()
        else -> VoiceList(state = state, onTogglePreview = onTogglePreview, onPick = onPick, onRequestDelete = onRequestDelete)
    }
}

@Composable
private fun VoiceList(
    state: VoiceUiState,
    onTogglePreview: (VoiceSummary) -> Unit,
    onPick: (VoiceSummary) -> Unit,
    onRequestDelete: (VoiceSummary) -> Unit,
) {
    val tokens = LocalTokens.current
    LazyColumn(
        modifier = Modifier.fillMaxSize().testTag("voice-list"),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(
            horizontal = tokens.space.lg,
            vertical = tokens.space.sm,
        ),
        verticalArrangement = Arrangement.spacedBy(tokens.space.md),
    ) {
        items(state.shown, key = { it.voiceId }) { voice ->
            VoiceCard(
                voice = voice,
                isActive = voice.voiceId == state.activeVoiceId,
                isPlaying = voice.voiceId == state.previewPlayingId,
                isLoading = voice.voiceId == state.previewLoadingId,
                busy = voice.voiceId == state.busyId,
                onPlay = { onTogglePreview(voice) },
                onPick = { onPick(voice) },
                onDelete = { onRequestDelete(voice) },
            )
        }
    }
}

@Composable
private fun CenteredProgress() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(color = Color(Colors.accent))
    }
}

@Composable
private fun EmptyState() {
    val tokens = LocalTokens.current
    Box(modifier = Modifier.fillMaxSize().padding(tokens.space.lg), contentAlignment = Alignment.Center) {
        Text(text = EMPTY_TEXT, color = Color(Colors.ink3), fontSize = tokens.type.base, modifier = Modifier.testTag("voice-empty"))
    }
}

@Composable
private fun ErrorRetry(message: String, onRetry: () -> Unit) {
    val tokens = LocalTokens.current
    Column(
        modifier = Modifier.fillMaxSize().padding(tokens.space.lg),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(tokens.space.md, Alignment.CenterVertically),
    ) {
        Text(text = message, color = Color(Colors.stop), fontSize = tokens.type.base)
        OutlinedButton(onClick = onRetry, modifier = Modifier.testTag("voice-retry")) { Text("Retry") }
    }
}

@Composable
private fun NoticeBanner(text: String, onDismiss: () -> Unit) {
    val tokens = LocalTokens.current
    androidx.compose.runtime.LaunchedEffect(text) {
        kotlinx.coroutines.delay(NOTICE_MS)
        onDismiss()
    }
    Text(
        text = text,
        modifier = Modifier.fillMaxWidth().padding(horizontal = tokens.space.lg, vertical = tokens.space.md).testTag("voice-notice"),
        color = Color(Colors.ink2),
        fontSize = tokens.type.sm,
    )
}

@Composable
private fun DeleteConfirmDialog(name: String, onCancel: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text("Delete \"$name\"?") },
        text = { Text("This voice pack will be permanently deleted.") },
        confirmButton = {
            TextButton(onClick = onConfirm, modifier = Modifier.testTag("voice-delete-confirm")) {
                Text("Delete", color = Color(Colors.stop))
            }
        },
        dismissButton = {
            TextButton(onClick = onCancel, modifier = Modifier.testTag("voice-delete-cancel")) { Text("Cancel") }
        },
    )
}

private const val NOTICE_MS: Long = 2_800L

private val previewVoices = listOf(
    VoiceSummary(
        voiceId = "abc",
        name = "Dad",
        description = "Warm, calm narration voice for evening stories.",
        tags = listOf("warm", "calm"),
        language = "en",
        source = "user",
    ),
)

private val noopVoiceCallback: (VoiceSummary) -> Unit = {}

@Preview
@Composable
private fun VoiceScreenPreview() {
    SentientTheme {
        VoiceScreenContent(
            state = VoiceUiState(loading = false, allVoices = previewVoices, shown = previewVoices, activeVoiceId = "abc"),
            onBack = {},
            onAddVoice = {},
            onCloneFish = {},
            onQuery = {},
            onSource = {},
            onLanguage = {},
            onToggleTag = {},
            onRetry = {},
            onTogglePreview = noopVoiceCallback,
            onPick = noopVoiceCallback,
            onRequestDelete = noopVoiceCallback,
            onDismissNotice = {},
            onCancelDelete = {},
            onConfirmDelete = {},
        )
    }
}
