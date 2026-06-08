package io.sentient.android.chat.message

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.sdk.ChatMessage
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun MessageMeta(message: ChatMessage, userName: String) {
    val tokens = LocalTokens.current
    val name = if (message.role == "user") userName else "Sentient"
    val time = remember(message.ts) { SimpleDateFormat("h:mm a", Locale.getDefault()).format(Date(message.ts)) }
    Row(horizontalArrangement = Arrangement.spacedBy(tokens.space.sm), verticalAlignment = Alignment.CenterVertically) {
        Text(name, color = Color(Colors.ink), fontSize = tokens.type.sm, fontWeight = FontWeight.SemiBold)
        Text("·", color = Color(Colors.ink4))
        Text(time, color = Color(Colors.ink3), fontSize = tokens.type.xs)
    }
}
