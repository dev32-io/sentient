// ---------------------------------------------------------------------------
// VoiceMetaForm — the shared name / description / tags / language editor used by
// both Add Voice and Clone-from-Fish. Field caps come from VoiceFieldCaps (client
// cosmetic — the gateway truncates over-cap metadata); language options are the
// canonical Qwen list. Presentational: every value + callback is hoisted to the VM.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.voice

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import io.sentient.android.settings.components.RowSelect
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.settings.VoiceFieldCaps

/** Name / description / tags / language editor. [enabled] false while a submit is in flight. */
@Composable
fun VoiceMetaForm(
    name: String,
    description: String,
    tags: List<String>,
    language: String,
    onName: (String) -> Unit,
    onDescription: (String) -> Unit,
    onAddTag: (String) -> Unit,
    onRemoveTag: (String) -> Unit,
    onLanguage: (String) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val tokens = LocalTokens.current
    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(tokens.space.md)) {
        FieldLabel("Name")
        VoiceTextField(
            value = name,
            onValueChange = onName,
            placeholder = "e.g. Dad",
            maxLength = VoiceFieldCaps.NAME_MAX_LEN,
            showCounter = true,
            enabled = enabled,
            testTag = "voice-name",
        )
        FieldLabel("Description")
        VoiceTextField(
            value = description,
            onValueChange = onDescription,
            placeholder = "Optional — how this voice sounds or when to use it",
            maxLength = VoiceFieldCaps.DESCRIPTION_MAX_LEN,
            singleLine = false,
            minLines = 3,
            enabled = enabled,
            testTag = "voice-description",
        )
        RowSelect(
            label = "Language",
            options = formLanguageOptions(),
            selectedValue = language,
            onSelect = onLanguage,
            enabled = enabled,
            testTag = "voice-language",
        )
        TagEditor(tags = tags, onAddTag = onAddTag, onRemoveTag = onRemoveTag, enabled = enabled)
    }
}

@Composable
private fun FieldLabel(text: String) {
    Text(text = text, color = Color(Colors.ink3), fontSize = LocalTokens.current.type.sm, fontWeight = FontWeight.Medium)
}

@Composable
private fun TagEditor(tags: List<String>, onAddTag: (String) -> Unit, onRemoveTag: (String) -> Unit, enabled: Boolean) {
    val tokens = LocalTokens.current
    var draft by remember { mutableStateOf("") }
    val atCap = tags.size >= VoiceFieldCaps.MAX_TAGS
    Column(verticalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
        FieldLabel("Tags")
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
            VoiceTextField(
                value = draft,
                onValueChange = { draft = it },
                placeholder = if (atCap) "Tag limit reached" else "Add a tag",
                maxLength = VoiceFieldCaps.TAG_MAX_LEN,
                enabled = enabled && !atCap,
                modifier = Modifier.weight(1f),
                testTag = "voice-tag-input",
            )
            TextButton(
                onClick = {
                    onAddTag(draft)
                    draft = ""
                },
                enabled = enabled && !atCap && draft.isNotBlank(),
            ) { Text("Add", color = Color(Colors.accent)) }
        }
        if (tags.isNotEmpty()) {
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(tokens.space.xs),
            ) {
                tags.forEach { tag ->
                    VoiceChip(label = tag, onRemove = { onRemoveTag(tag) }, testTag = "voice-tag-chip-$tag")
                }
            }
        }
    }
}

@Preview
@Composable
private fun VoiceMetaFormPreview() {
    SentientTheme {
        VoiceMetaForm(
            name = "Dad",
            description = "",
            tags = listOf("warm", "calm"),
            language = "en",
            onName = {},
            onDescription = {},
            onAddTag = {},
            onRemoveTag = {},
            onLanguage = {},
        )
    }
}
