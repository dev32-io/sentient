// ---------------------------------------------------------------------------
// FishCloneScreen — the gated "Clone from Fish" sub-page. Two views: the browse
// list (debounced search + paged tiles + load-more + play sample) and the clone
// form (prefilled name/tags/language once a voice is picked). FeatureDisabled shows
// a gate message (normally unreachable — the Voice page only offers this when the
// flag is on). On a successful clone the VM flags `done` and the screen fires [onDone]
// (distinct from a plain back) so the caller can signal VoiceScreen to refetch before
// popping. Mirrors the webui FishClonePanel.
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
import androidx.compose.ui.tooling.preview.Preview
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.android.settings.components.SettingsTopBar
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.settings.FishVoiceEntry
import io.sentient.mobilesdk.settings.FishSort
import io.sentient.android.settings.components.RowSelect
import io.sentient.android.settings.components.SelectOption

private const val TITLE = "Clone from Fish"

/**
 * Fish clone page. Back returns to the list when a voice is picked, else pops via
 * [onBack]; [onDone] fires once on a successful clone ([FishCloneUiState.done]) so the
 * caller can flag VoiceScreen to refetch before popping.
 */
@Composable
fun FishCloneScreen(
    vm: FishCloneViewModel,
    onBack: () -> Unit,
    onDone: () -> Unit,
    /** When true this is the child editor entry, not the results page. */
    editorOnly: Boolean = false,
    onOpenEditor: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(state.done) { if (state.done) onDone() }
    val inForm = editorOnly || state.selected != null
    // The results entry handles Back as cancel. The editor entry leaves system
    // Back to Navigation Compose so it pops exactly one route entry.
    BackHandler(enabled = inForm && !editorOnly) { vm.backToList() }
    val pick: (FishVoiceEntry) -> Unit = { entry ->
        vm.pickForClone(entry)
        if (!editorOnly) onOpenEditor?.invoke()
    }

    FishCloneContent(
        state = state,
        inForm = inForm,
        onBack = { if (inForm && !editorOnly) vm.backToList() else onBack() },
        onQuery = vm::setQuery,
        onLanguageFilter = vm::setLanguage,
        onToggleGender = vm::toggleGender,
        onToggleAge = vm::toggleAge,
        onToggleVibe = vm::toggleVibe,
        onSort = vm::setSort,
        onClearFilters = vm::clearFilters,
        onRetry = vm::retry,
        onLoadMore = vm::loadMore,
        onTogglePlay = vm::togglePlay,
        onPickForClone = pick,
        onName = vm::setName,
        onDescription = vm::setDescription,
        onAddTag = vm::addTag,
        onRemoveTag = vm::removeTag,
        onLanguage = vm::setCloneLanguage,
        onClone = vm::clone,
        modifier = modifier,
    )
}

/** Stateless page body — no VM. Previewable per [FishCloneUiState]. */
@Composable
private fun FishCloneContent(
    state: FishCloneUiState,
    inForm: Boolean,
    onBack: () -> Unit,
    onQuery: (String) -> Unit,
    onLanguageFilter: (String) -> Unit,
    onToggleGender: (String) -> Unit,
    onToggleAge: (String) -> Unit,
    onToggleVibe: (String) -> Unit,
    onSort: (FishSort) -> Unit,
    onClearFilters: () -> Unit,
    onRetry: () -> Unit,
    onLoadMore: () -> Unit,
    onTogglePlay: (FishVoiceEntry) -> Unit,
    onPickForClone: (FishVoiceEntry) -> Unit,
    onName: (String) -> Unit,
    onDescription: (String) -> Unit,
    onAddTag: (String) -> Unit,
    onRemoveTag: (String) -> Unit,
    onLanguage: (String) -> Unit,
    onClone: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxSize().safeDrawingPadding().testTag("settings-voice-fish-screen")) {
        SettingsTopBar(
            title = TITLE,
            onBack = onBack,
            backTestTag = "settings-voice-fish-back",
        )
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when {
                state.featureDisabled -> GateMessage()
                inForm -> CloneForm(
                    state = state,
                    onName = onName,
                    onDescription = onDescription,
                    onAddTag = onAddTag,
                    onRemoveTag = onRemoveTag,
                    onLanguage = onLanguage,
                    onClone = onClone,
                )
                else -> BrowseView(
                    state = state,
                    onQuery = onQuery,
                    onLanguageFilter = onLanguageFilter,
                    onToggleGender = onToggleGender,
                    onToggleAge = onToggleAge,
                    onToggleVibe = onToggleVibe,
                    onSort = onSort,
                    onClearFilters = onClearFilters,
                    onRetry = onRetry,
                    onLoadMore = onLoadMore,
                    onTogglePlay = onTogglePlay,
                    onPickForClone = onPickForClone,
                )
            }
        }
    }
}

@Composable
private fun BrowseView(
    state: FishCloneUiState,
    onQuery: (String) -> Unit,
    onLanguageFilter: (String) -> Unit,
    onToggleGender: (String) -> Unit,
    onToggleAge: (String) -> Unit,
    onToggleVibe: (String) -> Unit,
    onSort: (FishSort) -> Unit,
    onClearFilters: () -> Unit,
    onRetry: () -> Unit,
    onLoadMore: () -> Unit,
    onTogglePlay: (FishVoiceEntry) -> Unit,
    onPickForClone: (FishVoiceEntry) -> Unit,
) {
    val tokens = LocalTokens.current
    Column(modifier = Modifier.fillMaxSize()) {
        VoiceTextField(
            value = state.query,
            onValueChange = onQuery,
            placeholder = "Search Fish voices",
            modifier = Modifier.padding(horizontal = tokens.space.lg, vertical = tokens.space.md),
            testTag = "fish-search",
        )
        RowSelect("Language", listOf(SelectOption("", "All languages")) + state.options.languages.map { SelectOption(it, voiceLanguageLabel(it)) }, state.language, onLanguageFilter, testTag = "fish-language-filter")
        RowSelect("Sort", listOf(SelectOption("popular", "Popular"), SelectOption("recent", "Recent"), SelectOption("az", "A–Z")), state.sort.name.lowercase(), { onSort(FishSort.valueOf(it.uppercase())) }, testTag = "fish-sort-filter")
        FishFacetChips("Gender", state.options.genders, state.genders, onToggleGender, "fish-gender")
        FishFacetChips("Age", state.options.ages, state.ages, onToggleAge, "fish-age")
        FishFacetChips("Vibe", state.options.vibes, state.vibes, onToggleVibe, "fish-vibe")
        if (state.filterActive) OutlinedButton(onClick = onClearFilters, modifier = Modifier.padding(horizontal = tokens.space.lg).testTag("fish-clear-filters")) { Text("Clear filters") }
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when {
                state.loading -> CenteredProgress()
                state.errorMessage != null -> ErrorRetry(message = state.errorMessage, onRetry = onRetry)
                state.voices.isEmpty() -> Empty("No voices found.")
                else -> FishList(state = state, onLoadMore = onLoadMore, onTogglePlay = onTogglePlay, onPickForClone = onPickForClone)
            }
        }
    }
}

@Composable
private fun FishFacetChips(label: String, options: List<String>, selected: List<String>, onToggle: (String) -> Unit, tag: String) {
    if (options.isEmpty()) return
    val tokens = LocalTokens.current
    Column(Modifier.fillMaxWidth().testTag(tag)) {
        Text(label, color = Color(Colors.ink2), fontSize = tokens.type.sm, modifier = Modifier.padding(horizontal = tokens.space.lg))
        androidx.compose.foundation.lazy.LazyRow(horizontalArrangement = Arrangement.spacedBy(tokens.space.xs), contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = tokens.space.lg)) {
            items(options) { value -> VoiceChip(value, active = value in selected, onClick = { onToggle(value) }, testTag = "$tag-$value") }
        }
    }
}

@Composable
private fun FishList(
    state: FishCloneUiState,
    onLoadMore: () -> Unit,
    onTogglePlay: (FishVoiceEntry) -> Unit,
    onPickForClone: (FishVoiceEntry) -> Unit,
) {
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
                onPlay = { onTogglePlay(entry) },
                onClone = { onPickForClone(entry) },
            )
        }
        if (state.hasMore) {
            item {
                OutlinedButton(
                    onClick = onLoadMore,
                    enabled = !state.loadingMore,
                    modifier = Modifier.fillMaxWidth().testTag("fish-load-more"),
                ) { Text(if (state.loadingMore) "Loading…" else "Load more") }
            }
        }
    }
}

@Composable
private fun CloneForm(
    state: FishCloneUiState,
    onName: (String) -> Unit,
    onDescription: (String) -> Unit,
    onAddTag: (String) -> Unit,
    onRemoveTag: (String) -> Unit,
    onLanguage: (String) -> Unit,
    onClone: () -> Unit,
) {
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
            onName = onName,
            onDescription = onDescription,
            onAddTag = onAddTag,
            onRemoveTag = onRemoveTag,
            onLanguage = onLanguage,
            enabled = !state.cloning,
        )
        if (state.errorMessage != null) {
            Text(text = state.errorMessage.orEmpty(), color = Color(Colors.stop), fontSize = tokens.type.sm)
        }
        Button(
            onClick = onClone,
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

private val previewEntries = listOf(
    FishVoiceEntry(
        id = "fish1",
        title = "Morgan Freeman",
        description = "Deep, calm, authoritative narration.",
        languages = listOf("en"),
        tags = listOf("male", "deep"),
        previewAudioUrl = "https://example.com/sample.mp3",
        taskCount = 1200,
    ),
)

private val noopFishCallbacks: (FishVoiceEntry) -> Unit = {}

@Preview(name = "browse")
@Composable
private fun FishCloneScreenBrowsePreview() {
    SentientTheme {
        FishCloneContent(
            state = FishCloneUiState(loading = false, voices = previewEntries, hasMore = true),
            inForm = false,
            onBack = {},
            onQuery = {},
            onLanguageFilter = {}, onToggleGender = {}, onToggleAge = {}, onToggleVibe = {}, onSort = {}, onClearFilters = {},
            onRetry = {},
            onLoadMore = {},
            onTogglePlay = noopFishCallbacks,
            onPickForClone = noopFishCallbacks,
            onName = {},
            onDescription = {},
            onAddTag = {},
            onRemoveTag = {},
            onLanguage = {},
            onClone = {},
        )
    }
}

@Preview(name = "clone-form")
@Composable
private fun FishCloneScreenFormPreview() {
    SentientTheme {
        FishCloneContent(
            state = FishCloneUiState(loading = false, selected = previewEntries.first(), name = "Morgan Freeman"),
            inForm = true,
            onBack = {},
            onQuery = {},
            onLanguageFilter = {}, onToggleGender = {}, onToggleAge = {}, onToggleVibe = {}, onSort = {}, onClearFilters = {},
            onRetry = {},
            onLoadMore = {},
            onTogglePlay = noopFishCallbacks,
            onPickForClone = noopFishCallbacks,
            onName = {},
            onDescription = {},
            onAddTag = {},
            onRemoveTag = {},
            onLanguage = {},
            onClone = {},
        )
    }
}
