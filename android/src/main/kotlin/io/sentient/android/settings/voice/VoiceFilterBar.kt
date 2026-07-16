// ---------------------------------------------------------------------------
// VoiceFilterBar — the Voice list filter controls: search text, source segmented
// (All / Built-in / Yours), language select, and tag chips. Mirrors the webui
// VoiceFilterBar; the actual filtering is the pure `filterVoices` usecase driven by
// the VM. Presentational only — every value + callback is hoisted.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.voice

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.tooling.preview.Preview
import io.sentient.android.settings.components.RowSegmented
import io.sentient.android.settings.components.RowSelect
import io.sentient.android.settings.components.SegmentOption
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme

private val SOURCE_OPTIONS = listOf(
    SegmentOption("all", "All"),
    SegmentOption("builtin", "Built-in"),
    SegmentOption("user", "Yours"),
)

/** Hoisted voice-list filter bar. [allTags] / [allLanguages] derive from the full library. */
@Composable
fun VoiceFilterBar(
    query: String,
    source: String,
    language: String,
    activeTags: List<String>,
    allTags: List<String>,
    allLanguages: List<String>,
    onQuery: (String) -> Unit,
    onSource: (String) -> Unit,
    onLanguage: (String) -> Unit,
    onToggleTag: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val tokens = LocalTokens.current
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(tokens.space.sm),
    ) {
        VoiceTextField(
            value = query,
            onValueChange = onQuery,
            placeholder = "Search voices",
            testTag = "voice-search",
        )
        RowSegmented(
            options = SOURCE_OPTIONS,
            selected = source,
            onSelect = onSource,
            modifier = Modifier.testTag("voice-source-filter"),
        )
        RowSelect(
            label = "Language",
            options = filterLanguageOptions(allLanguages),
            selectedValue = language,
            onSelect = onLanguage,
            testTag = "voice-language-filter",
        )
        if (allTags.isNotEmpty()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .testTag("voice-tag-filter"),
                horizontalArrangement = Arrangement.spacedBy(tokens.space.sm),
            ) {
                allTags.forEach { tag ->
                    VoiceChip(
                        label = tag,
                        active = tag in activeTags,
                        onClick = { onToggleTag(tag) },
                        testTag = "voice-tag-$tag",
                    )
                }
            }
        }
    }
}

@Preview
@Composable
private fun VoiceFilterBarPreview() {
    SentientTheme {
        VoiceFilterBar(
            query = "",
            source = "all",
            language = "",
            activeTags = listOf("warm"),
            allTags = listOf("warm", "calm", "bright"),
            allLanguages = listOf("en", "zh"),
            onQuery = {},
            onSource = {},
            onLanguage = {},
            onToggleTag = {},
        )
    }
}
