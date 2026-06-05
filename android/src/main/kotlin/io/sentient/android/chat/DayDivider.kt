package io.sentient.android.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors

@Composable
fun DayDivider(label: String) {
    val tokens = LocalTokens.current
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = tokens.space.xs),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(tokens.space.md),
    ) {
        HorizontalDivider(modifier = Modifier.weight(1f), color = Color(Colors.lineSoft))
        Text(label.uppercase(), color = Color(Colors.ink3), fontSize = tokens.type.xs, fontWeight = FontWeight.Medium)
        HorizontalDivider(modifier = Modifier.weight(1f), color = Color(Colors.lineSoft))
    }
}
