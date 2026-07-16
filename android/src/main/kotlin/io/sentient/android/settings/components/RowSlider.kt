// ---------------------------------------------------------------------------
// RowSlider — label + value readout (webui ".sld-v" pill) + a Material3 [Slider]
// recolored with Dusk tokens. [step] > 0 snaps to discrete stops (Advanced pane's
// Compression 0..1/0.05 and Max tokens 128..8192/128); step == 0 is continuous.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors
import kotlin.math.roundToInt

private val BORDER_WIDTH = 1.dp

/**
 * A settings row for a numeric slider: [label] + value readout above a full-width
 * [Slider]. [format] renders [value] for the readout pill (e.g. "0.75" or "1024 tok").
 * [step] is the snap increment; 0 (default) means continuous.
 */
@Composable
fun RowSlider(
    label: String,
    value: Float,
    onValueChange: (Float) -> Unit,
    valueRange: ClosedFloatingPointRange<Float>,
    modifier: Modifier = Modifier,
    step: Float = 0f,
    format: (Float) -> String = { it.toString() },
    sub: String? = null,
    enabled: Boolean = true,
    testTag: String = "row-slider",
) {
    val tokens = LocalTokens.current
    val steps = discreteSteps(valueRange, step)
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = tokens.space.lg, vertical = tokens.space.md)
            .testTag(testTag),
    ) {
        RowSliderHeader(label = label, sub = sub, valueText = format(value))
        Slider(
            value = value,
            onValueChange = onValueChange,
            valueRange = valueRange,
            steps = steps,
            enabled = enabled,
            colors = SliderDefaults.colors(
                thumbColor = Color(Colors.accent),
                activeTrackColor = Color(Colors.accent),
                inactiveTrackColor = Color(Colors.bgSunk),
            ),
        )
    }
}

@Composable
private fun RowSliderHeader(label: String, sub: String?, valueText: String) {
    val tokens = LocalTokens.current
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(tokens.space.md),
    ) {
        Column(modifier = Modifier.weight(1f)) {
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
        Text(
            text = valueText,
            modifier = Modifier
                .clip(RoundedCornerShape(tokens.radii.sm))
                .background(Color(Colors.bgElev))
                .border(BORDER_WIDTH, Color(Colors.lineSoft), RoundedCornerShape(tokens.radii.sm))
                .padding(horizontal = tokens.space.sm, vertical = tokens.space.xs),
            color = Color(Colors.ink),
            fontSize = tokens.type.sm,
        )
    }
}

/** Material3 [Slider.steps] is the count of stops BETWEEN the endpoints (exclusive). */
private fun discreteSteps(range: ClosedFloatingPointRange<Float>, step: Float): Int {
    if (step <= 0f) return 0
    val span = range.endInclusive - range.start
    return ((span / step).roundToInt() - 1).coerceAtLeast(0)
}

@Preview
@Composable
private fun RowSliderPreview() {
    SentientTheme {
        RowSlider(
            label = "Compression",
            sub = "How aggressively older context is summarized",
            value = 0.4f,
            onValueChange = {},
            valueRange = 0f..1f,
            step = 0.05f,
            format = { "%.2f".format(it) },
        )
    }
}
