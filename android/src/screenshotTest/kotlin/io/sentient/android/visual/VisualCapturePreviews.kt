package io.sentient.android.visual

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import com.android.tools.screenshot.PreviewTest
import io.sentient.android.settings.components.DangerButton
import io.sentient.android.theme.SentientTheme

/**
 * Minimal Android visual-diff capture fixture. Android is not an actively
 * maintained visual target, so new cases are added only when Android work is
 * explicitly in scope.
 */
@PreviewTest
@Preview(
    name = "action-button--destructive--rest",
    device = "spec:width=113dp,height=88dp,dpi=320",
    fontScale = 1f,
    showBackground = true,
    backgroundColor = 0xFF2B2621,
)
@Composable
fun ActionButtonDestructiveRestVisualCapture() {
    SentientTheme {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            DangerButton(label = "Stop", onClick = {})
        }
    }
}
