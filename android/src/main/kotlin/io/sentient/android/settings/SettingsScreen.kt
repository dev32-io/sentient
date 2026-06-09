// ---------------------------------------------------------------------------
// SettingsScreen — the thin v1 Settings surface (D-A5). Per the operator's
// original directive ("leave the settings page very thin, just show version, we
// will add other settings stuff later") this screen has exactly two rows:
//   - App version (settings-version): read from BuildConfig.VERSION_NAME (+ code).
//   - Logout (settings-logout): clears the token + disconnects → login.
//
// Stateless screen: it takes a hoisted version string + plain callbacks and
// reads nothing from a ViewModel directly (MainActivity wires the callbacks to
// SettingsViewModel). A title bar with a back chevron (settings-back) gives the
// one defined back target per the mobile-navigation rule. The version-check hook
// is a STUB only — spec §12.2 P2 carry — no networking in v1.
//
// testTags: settings-screen, settings-version, settings-logout, settings-back.
// The settings-open entry point lives in the chat top bar (ChatContent).
// ---------------------------------------------------------------------------
package io.sentient.android.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import io.sentient.android.BuildConfig
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.log.createLogger

private const val TITLE = "Settings"
private const val VERSION_LABEL = "App version"
private const val LOGOUT_LABEL = "Log out"

private val log = createLogger("android", "settings-screen")

/**
 * The human-readable build identifier, e.g. "0.0.1 (1)". Single source: the
 * generated [BuildConfig]; no version literal lives in this file.
 */
private val versionText: String
    get() = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})"

/**
 * Version-check hook STUB (spec §12.2 P2 carry). A future "check for updates"
 * call lands here — it will query an operator-configured release endpoint and
 * surface an "update available" affordance. v1 does NO networking; this is a
 * placeholder so the call site already exists when P2 is picked up.
 */
private fun checkForUpdatesStub() {
    // P2: replace with a real release-manifest fetch + compare against
    // BuildConfig.VERSION_CODE. Intentionally a no-op in v1.
    log.debug("check-for-updates.stub", mapOf("version" to versionText))
}

/**
 * Thin Settings screen. [onLogout] clears the token + disconnects (see
 * [SettingsViewModel.logout]); [onBack] returns to chat. Both are plain
 * callbacks — the host owns navigation + the ViewModel.
 */
@Composable
fun SettingsScreen(
    onLogout: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val tokens = LocalTokens.current
    Column(
        modifier = modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .testTag("settings-screen"),
    ) {
        SettingsTitleBar(onBack = onBack)
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = tokens.space.lg, vertical = tokens.space.md),
            verticalArrangement = Arrangement.spacedBy(tokens.space.md),
        ) {
            VersionRow()
            LogoutButton(onLogout = onLogout)
        }
    }
}

@Composable
private fun SettingsTitleBar(onBack: () -> Unit) {
    val tokens = LocalTokens.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = tokens.space.md, vertical = tokens.space.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(tokens.space.xs),
    ) {
        TextButton(onClick = onBack, modifier = Modifier.testTag("settings-back")) {
            Text("‹", color = Color(Colors.ink2), fontSize = tokens.type.xl)
        }
        Text(
            text = TITLE,
            color = Color(Colors.ink),
            fontSize = tokens.type.lg,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun VersionRow() {
    val tokens = LocalTokens.current
    Column(verticalArrangement = Arrangement.spacedBy(tokens.space.xs)) {
        Text(
            text = VERSION_LABEL,
            color = Color(Colors.ink3),
            fontSize = tokens.type.xs,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            text = versionText,
            modifier = Modifier.testTag("settings-version"),
            color = Color(Colors.ink),
            fontSize = tokens.type.base,
        )
    }
}

@Composable
private fun LogoutButton(onLogout: () -> Unit) {
    val tokens = LocalTokens.current
    OutlinedButton(
        onClick = onLogout,
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = tokens.space.md)
            .testTag("settings-logout"),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(Colors.stop)),
    ) {
        Text(LOGOUT_LABEL)
    }
}
