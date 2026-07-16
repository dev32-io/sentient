// ---------------------------------------------------------------------------
// FishCloneScreen — the gated "Clone from Fish" sub-page. Two views: the browse
// list (debounced search + paged tiles + load-more + play sample) and the clone
// form (prefilled name/tags/language once a voice is picked). FeatureDisabled shows
// a gate message (normally unreachable — the Voice page only offers this when the
// flag is on). On a successful clone the VM flags `done` and the screen pops back to
// VoiceScreen, which refetches on resume. Mirrors the webui FishClonePanel.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.voice

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.android.settings.components.SettingsTopBar
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors

private const val TITLE = "Clone from Fish"

/** Fish clone page. Back returns to the list when a voice is picked, else pops. */
@Composable
fun FishCloneScreen(
    vm: FishCloneViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(state.done) { if (state.done) onBack() }
    val inForm = state.selected != null
    BackHandler(enabled = inForm) { vm.backToList() }

    Column(modifier = modifier.fillMaxSize().safeDrawingPadding().testTag("settings-voice-fish-screen")) {
        SettingsTopBar(
            title = TITLE,
            onBack = { if (inForm) vm.backToList() else onBack() },
            backTestTag = "settings-voice-fish-back",
        )
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when {
                state.featureDisabled -> GateMessage()
                inForm -> CloneForm(state = state, vm = vm)
                else -> BrowseView(state = state, vm = vm)
            }
        }
    }
}

@Composable
private fun BrowseView(state: FishCloneUiState, vm: FishCloneViewModel) {
    val tokens = LocalTokens.current
    Column(modifier = Modifier.fillMaxSize()) {
        VoiceTextField(
            value = state.query,
            onValueChange = vm::setQuery,
            placeholder = "Search Fish voices",
            modifier = Modifier.padding(horizontal = tokens.space.lg, vertical = tokens.space.md),
            testTag = "fish-search",
        )
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when {
                state.loading -> CenteredProgress()
                state.errorMessage != null -> ErrorRetry(message = state.errorMessage, onRetry = vm::retry)
                state.voices.isEmpty() -> Empty("No voices found.")
                else -> FishList(state = state, vm = vm)
            }
        }
    }
}

@Composable
private fun FishList(state: FishCloneUiState, vm: FishCloneViewModel) {
    val tokens = LocalTokens.current
    LazyColumn(
        modifier = Modifier.fillMaxSize().testTag("fish-list"),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = tokens.space.lg, vertical = tokens.space.sm),
        verticalArrangement = Arrangement.spacedBy(tokens.space.md),
    ) {
        items(state.voices, key = { it.id }) { entry ->
            FishVoiceTile(
                entry = entry,
                isPlaying = entry.id == state.playingId,
                busy = state.cloning,
                onPlay = { vm.togglePlay(entry) },
                onClone = { vm.pickForClone(entry) },
            )
        }
        if (state.hasMore) {
            item {
                OutlinedButton(
                    onClick = vm::loadMore,
                    enabled = !state.loadingMore,
                    modifier = Modifier.fillMaxWidth().testTag("fish-load-more"),
                ) { Text(if (state.loadingMore) "Loading…" else "Load more") }
            }
        }
    }
}

@Composable
private fun CloneForm(state: FishCloneUiState, vm: FishCloneViewModel) {
    val tokens = LocalTokens.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = tokens.space.lg, vertical = tokens.space.md)
            .testTag("fish-clone-form"),
        verticalArrangement = Arrangement.spacedBy(tokens.space.md),
    ) {
        Text(
            text = "Cloning \"${state.selected?.title.orEmpty()}\" — fill in the details.",
            color = Color(Colors.ink2),
            fontSize = tokens.type.sm,
        )
        VoiceMetaForm(
            name = state.name,
            description = state.description,
            tags = state.tags,
            language = state.language,
            onName = vm::setName,
            onDescription = vm::setDescription,
            onAddTag = vm::addTag,
            onRemoveTag = vm::removeTag,
            onLanguage = vm::setLanguage,
            enabled = !state.cloning,
        )
        if (state.errorMessage != null) {
            Text(text = state.errorMessage.orEmpty(), color = Color(Colors.stop), fontSize = tokens.type.sm)
        }
        Button(
            onClick = vm::clone,
            enabled = state.name.trim().isNotEmpty() && !state.cloning,
            modifier = Modifier.fillMaxWidth().testTag("fish-clone-submit"),
        ) { Text(if (state.cloning) "Cloning…" else "Clone voice") }
    }
}

@Composable
private fun GateMessage() {
    val tokens = LocalTokens.current
    Box(modifier = Modifier.fillMaxSize().padding(tokens.space.lg), contentAlignment = Alignment.Center) {
        Text(
            text = "Voice cloning isn't available on this server.",
            color = Color(Colors.ink3),
            fontSize = tokens.type.base,
            modifier = Modifier.testTag("fish-gate"),
        )
    }
}

@Composable
private fun CenteredProgress() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(color = Color(Colors.accent))
    }
}

@Composable
private fun Empty(text: String) {
    val tokens = LocalTokens.current
    Box(modifier = Modifier.fillMaxSize().padding(tokens.space.lg), contentAlignment = Alignment.Center) {
        Text(text = text, color = Color(Colors.ink3), fontSize = tokens.type.base, modifier = Modifier.testTag("fish-empty"))
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
        OutlinedButton(onClick = onRetry, modifier = Modifier.testTag("fish-retry")) { Text("Retry") }
    }
}
