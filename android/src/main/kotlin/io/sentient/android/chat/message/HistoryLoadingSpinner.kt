// ---------------------------------------------------------------------------
// HistoryLoadingSpinner — centered spinner shown over the (cleared) message list
// while an existing-session switch loads its history snapshot (ChatModel.historyLoading).
//
// The composer is NEVER gated on historyLoading — it stays live so the user can type
// into the soon-to-arrive conversation (the outbox bridges the gap). A brand-new chat
// never triggers this (its snapshot is empty/immediate), so no spinner there.
//
// testTag `history-loading-spinner` scopes the e2e driver's switch-loads assertion.
// ---------------------------------------------------------------------------
package io.sentient.android.chat.message

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import io.sentient.mobilesdk.design.Colors

private val HISTORY_SPINNER_SIZE = 28.dp
private val HISTORY_SPINNER_STROKE = 2.dp

@Composable
fun HistoryLoadingSpinner(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .testTag("history-loading-spinner"),
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator(
            modifier = Modifier.size(HISTORY_SPINNER_SIZE),
            color = Color(Colors.ink3),
            strokeWidth = HISTORY_SPINNER_STROKE,
        )
    }
}
