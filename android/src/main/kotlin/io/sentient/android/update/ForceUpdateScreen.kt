// ---------------------------------------------------------------------------
// ForceUpdateScreen — the full-screen blocking gate for a MANDATORY update.
//
// Routed to by AppNavHost's force-update gate when the status is
// Available && mandatory, AHEAD of the normal authed destination. There is no
// back affordance and no dismiss: a BackHandler swallows the system back so the
// user cannot escape the gate. The single action installs the update; after the
// install relaunches a new build, the next process starts UpToDate and the gate
// is gone.
//
// Stateless: takes the version label + onInstall. testTags: force-update
// (container), force-update-action ([Update now]).
// ---------------------------------------------------------------------------
package io.sentient.android.update

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors

private const val TITLE = "Update required"
private const val BODY =
    "A newer version is required to keep using Sentient. Please update to continue."
private const val VERSION_PREFIX = "Version "
private const val ACTION_LABEL = "Update now"

/**
 * Blocking mandatory-update gate. [versionName] labels the required release;
 * [onInstall] hands off to the installer. No back / no dismiss by design.
 */
@Composable
fun ForceUpdateScreen(
    versionName: String,
    onInstall: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // Swallow the system back gesture: a mandatory gate has no exit but update.
    BackHandler(enabled = true) { /* intentionally blocked */ }
    Surface(modifier = modifier.fillMaxSize(), color = Color(Colors.bg)) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .padding(horizontal = LocalTokens.current.space.xl)
                .testTag("force-update"),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            ForceUpdateCopy(versionName)
            Button(
                onClick = onInstall,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = LocalTokens.current.space.xl)
                    .testTag("force-update-action"),
            ) {
                Text(ACTION_LABEL)
            }
        }
    }
}

@Composable
private fun ForceUpdateCopy(versionName: String) {
    val tokens = LocalTokens.current
    Text(
        text = TITLE,
        color = Color(Colors.ink),
        fontSize = tokens.type.xl,
        fontWeight = FontWeight.SemiBold,
        textAlign = TextAlign.Center,
    )
    Text(
        modifier = Modifier.padding(top = tokens.space.md),
        text = BODY,
        color = Color(Colors.ink2),
        fontSize = tokens.type.base,
        textAlign = TextAlign.Center,
    )
    if (versionName.isNotEmpty()) {
        Text(
            modifier = Modifier.padding(top = tokens.space.sm),
            text = "$VERSION_PREFIX$versionName",
            color = Color(Colors.ink3),
            fontSize = tokens.type.sm,
            textAlign = TextAlign.Center,
        )
    }
}

@Preview
@Composable
private fun ForceUpdateScreenPreview() {
    SentientTheme {
        ForceUpdateScreen(versionName = "0.2.0", onInstall = {})
    }
}
