// ---------------------------------------------------------------------------
// HistoryAccountHeader — avatar + name/household + gear entry point.
// Shown at the top of the History drawer. Tapping the gear opens Settings.
// ---------------------------------------------------------------------------
package io.sentient.android.history

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors

@Composable
fun HistoryAccountHeader(name: String, household: String, onSettings: () -> Unit) {
    val tokens = LocalTokens.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(tokens.space.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(tokens.space.md),
    ) {
        Box(
            modifier = Modifier
                .size(38.dp)
                .clip(CircleShape)
                .background(Color(Colors.accent)),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = name.take(1).uppercase(),
                color = HistoryOnAccent,
                fontWeight = FontWeight.Bold,
            )
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = name,
                color = Color(Colors.ink),
                fontWeight = FontWeight.SemiBold,
                fontSize = tokens.type.base,
            )
            if (household.isNotEmpty()) {
                Text(
                    text = household,
                    color = Color(Colors.ink3),
                    fontSize = tokens.type.sm,
                )
            }
        }
        Text(
            text = "⚙",
            color = Color(Colors.ink2),
            fontSize = tokens.type.lg,
            modifier = Modifier
                .clickable(onClick = onSettings)
                .testTag("settings-open"),
        )
    }
}
