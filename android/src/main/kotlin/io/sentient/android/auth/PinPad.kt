// ---------------------------------------------------------------------------
// PinPad — the PIN entry surface: a row of [PIN_LENGTH] dots (filled as digits
// arrive) above a 3×4 numpad (1-9, then 0 and a delete key). Stateless: takes
// the entered length + key callbacks; the screen owns the digit string.
//
// testTags: `pin-key-<n>` on each digit key, `pin-delete` on the delete key, so
// the e2e driver taps by id. Keys are 64×48dp with a 48dp minimum tap target.
// ---------------------------------------------------------------------------
package io.sentient.android.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors

private val DOT_SIZE = 14.dp
private val KEY_WIDTH = 64.dp
private val KEY_HEIGHT = 48.dp
private val MIN_TAP = 48.dp

/** Numpad layout rows. Last row is [empty, 0, delete] so 0 sits under 8. */
private val ROWS: List<List<String>> = listOf(
    listOf("1", "2", "3"),
    listOf("4", "5", "6"),
    listOf("7", "8", "9"),
    listOf("", "0", "del"),
)

@Composable
fun PinPad(
    entered: Int,
    onDigit: (Char) -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val tokens = LocalTokens.current
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(tokens.space.xl),
    ) {
        PinDots(entered = entered)
        Column(verticalArrangement = Arrangement.spacedBy(tokens.space.md)) {
            for (row in ROWS) {
                Row(horizontalArrangement = Arrangement.spacedBy(tokens.space.md)) {
                    for (label in row) KeySlot(label = label, onDigit = onDigit, onDelete = onDelete)
                }
            }
        }
    }
}

@Composable
private fun PinDots(entered: Int) {
    val tokens = LocalTokens.current
    Row(horizontalArrangement = Arrangement.spacedBy(tokens.space.lg)) {
        repeat(PIN_LENGTH) { i ->
            val filled = i < entered
            Box(
                modifier = Modifier
                    .size(DOT_SIZE)
                    .clip(CircleShape)
                    .background(
                        if (filled) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.surfaceVariant,
                    ),
            )
        }
    }
}

@Composable
private fun KeySlot(label: String, onDigit: (Char) -> Unit, onDelete: () -> Unit) {
    when (label) {
        "" -> Box(Modifier.sizeIn(minWidth = KEY_WIDTH, minHeight = KEY_HEIGHT))
        "del" -> PinKey(
            text = "⌫",
            modifier = Modifier
                .testTag("pin-delete")
                .semantics { contentDescription = "Delete" },
            onClick = onDelete,
        )
        else -> PinKey(
            text = label,
            modifier = Modifier.testTag("pin-key-$label"),
            onClick = { onDigit(label[0]) },
        )
    }
}

@Composable
private fun PinKey(text: String, modifier: Modifier, onClick: () -> Unit) {
    Box(
        modifier = modifier
            .sizeIn(minWidth = MIN_TAP, minHeight = MIN_TAP)
            .heightIn(min = KEY_HEIGHT)
            .clip(RoundedCornerShape(LocalTokens.current.radii.md))
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier.size(width = KEY_WIDTH, height = KEY_HEIGHT),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = text,
                color = Color(Colors.ink),
                style = MaterialTheme.typography.titleLarge,
            )
        }
    }
}
