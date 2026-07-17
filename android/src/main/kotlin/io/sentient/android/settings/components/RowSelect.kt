// ---------------------------------------------------------------------------
// RowSelect — label + current value, opens a DropdownMenu on tap. Mirrors the
// webui ".sel"/".sel-btn"/".sel-menu" custom dropdown (Model provider select,
// Advanced reasoning-effort select).
// ---------------------------------------------------------------------------
package io.sentient.android.settings.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors

private val BORDER_WIDTH = 1.dp
private const val CHEVRON_DOWN = "⌄"

/** Stable per-option testTag prefix so Maestro can target `settings-select-option-<value>`. */
private const val OPTION_TAG_PREFIX = "settings-select-option-"

/** One select option: a stable [value] used for equality + the display [label]. */
data class SelectOption(val value: String, val label: String)

/**
 * A settings row for a single-select field: [label] on the left, the current option's
 * label + a chevron on the right — tapping opens a [DropdownMenu] over [options].
 * [onSelect] fires with the chosen option's value and the menu closes.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun RowSelect(
    label: String,
    options: List<SelectOption>,
    selectedValue: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    sub: String? = null,
    enabled: Boolean = true,
    testTag: String = "row-select",
) {
    val tokens = LocalTokens.current
    var expanded by remember { mutableStateOf(false) }
    val currentLabel = options.firstOrNull { it.value == selectedValue }?.label ?: selectedValue

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = tokens.space.lg, vertical = tokens.space.md)
            .testTag(testTag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(tokens.space.md),
    ) {
        RowSelectLabel(label = label, sub = sub, modifier = Modifier.weight(1f))
        RowSelectValueBox(
            currentLabel = currentLabel,
            enabled = enabled,
            expanded = expanded,
            onToggle = { expanded = !expanded },
        ) {
            // The menu renders in its own popup window, a SEPARATE semantics owner —
            // the app-root testTagsAsResourceId does NOT reach it, so re-enable it here
            // or Maestro/uiautomator can't see the option testTags as resource-ids.
            DropdownMenu(
                expanded = expanded,
                onDismissRequest = { expanded = false },
                modifier = Modifier.semantics { testTagsAsResourceId = true },
            ) {
                options.forEach { option ->
                    DropdownMenuItem(
                        text = { Text(option.label) },
                        onClick = { expanded = false; onSelect(option.value) },
                        // mergeDescendants makes the clickable item ONE a11y node that
                        // carries the option label directly (via contentDescription), so
                        // TalkBack reads it and uiautomator exposes content-desc on the
                        // same node as the resource-id — the item otherwise has no text of
                        // its own (the label lives in a separate child Text node).
                        modifier = Modifier
                            .testTag("$OPTION_TAG_PREFIX${option.value}")
                            .semantics(mergeDescendants = true) { contentDescription = option.label },
                    )
                }
            }
        }
    }
}

@Composable
private fun RowSelectLabel(label: String, sub: String?, modifier: Modifier = Modifier) {
    val tokens = LocalTokens.current
    Column(modifier = modifier) {
        Text(text = label, color = Color(Colors.ink), fontSize = tokens.type.base)
        if (sub != null) {
            Text(
                text = sub,
                modifier = Modifier.padding(top = tokens.space.xs),
                color = Color(Colors.ink3),
                fontSize = tokens.type.xs,
            )
        }
    }
}

@Composable
private fun RowSelectValueBox(
    currentLabel: String,
    enabled: Boolean,
    expanded: Boolean,
    onToggle: () -> Unit,
    menu: @Composable () -> Unit,
) {
    val tokens = LocalTokens.current
    Box {
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(tokens.radii.sm))
                .background(if (expanded) Color(Colors.paper) else Color(Colors.bgElev))
                .border(BORDER_WIDTH, Color(Colors.lineSoft), RoundedCornerShape(tokens.radii.sm))
                .clickable(enabled = enabled, onClick = onToggle)
                .padding(horizontal = tokens.space.md, vertical = tokens.space.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(tokens.space.xs),
        ) {
            Text(text = currentLabel, color = Color(Colors.ink), fontSize = tokens.type.sm)
            Text(text = CHEVRON_DOWN, color = Color(Colors.ink3), fontSize = tokens.type.sm)
        }
        menu()
    }
}

@Preview
@Composable
private fun RowSelectPreview() {
    SentientTheme {
        RowSelect(
            label = "Reasoning",
            options = listOf(
                SelectOption("none", "None"),
                SelectOption("medium", "Medium"),
                SelectOption("xhigh", "Extra high"),
            ),
            selectedValue = "medium",
            onSelect = {},
        )
    }
}
