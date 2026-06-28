// ---------------------------------------------------------------------------
// SettingsScreen — the thin v1 Settings surface (D-A5). Per the operator's
// original directive ("leave the settings page very thin, just show version, we
// will add other settings stuff later") this screen has exactly two rows:
//   - App version (settings-version): read from BuildConfig.VERSION_NAME (+ code).
//   - Logout (settings-logout): clears the token + disconnects → login.
//
// Stateless screen: it takes hoisted state + plain callbacks and reads nothing from
// a ViewModel directly (the host wires the callbacks to SettingsViewModel +
// UpdateViewModel). A title bar with a back chevron (settings-back) gives the one
// defined back target per the mobile-navigation rule. The update row is a real
// OTA check/install hook (B5): status text + a context action (Check / Update).
//
// The diagnostics "Send diagnostic log" two-lane section lives in
// SettingsDiagnostics.kt (hoisted state from SettingsViewModel).
//
// testTags: settings-screen, settings-version, settings-update, settings-update-action,
// settings-logout, settings-back, settings-send-logs (+ the per-row diagnostics tags
// in SettingsDiagnostics). The settings-open entry point lives in the chat top bar.
// ---------------------------------------------------------------------------
package io.sentient.android.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import io.sentient.android.BuildConfig
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.update.UpdateStatus
import io.sentient.mobilesdk.vitals.VitalsSessionInfo

private const val TITLE = "Settings"
private const val VERSION_LABEL = "App version"
private const val LOGOUT_LABEL = "Log out"
private const val UPDATES_LABEL = "Updates"
private const val UP_TO_DATE_TEXT = "Up to date"
private const val CHECK_FAILED_TEXT = "Check failed"
private const val CHECK_ACTION = "Check for updates"
private const val UPDATE_ACTION = "Update"
private const val AVAILABLE_PREFIX = "Update available — v"

/**
 * The human-readable build identifier, e.g. "0.0.1 (1)". Single source: the
 * generated [BuildConfig]; no version literal lives in this file.
 */
private val versionText: String
    get() = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})"

/** Human status line for the update row, derived from the hoisted [UpdateStatus]. */
private fun updateStatusText(status: UpdateStatus): String = when (status) {
    is UpdateStatus.UpToDate -> UP_TO_DATE_TEXT
    is UpdateStatus.Available -> "$AVAILABLE_PREFIX${status.versionName}"
    is UpdateStatus.CheckFailed -> CHECK_FAILED_TEXT
}

/**
 * Thin Settings screen. [onLogout] clears the token + disconnects (see
 * [SettingsViewModel.logout]); [onBack] returns to chat. The diagnostics block is
 * driven by hoisted vitals state ([sessions] / [progress] / [outcome]) + [onUpload].
 * All callbacks/state are hoisted — the host owns navigation + the ViewModel.
 */
@Composable
fun SettingsScreen(
    onLogout: () -> Unit,
    onBack: () -> Unit,
    sessions: List<VitalsSessionInfo>,
    progress: Float?,
    outcome: UploadOutcome?,
    onUpload: (String) -> Unit,
    updateStatus: UpdateStatus,
    onCheckUpdate: () -> Unit,
    onInstallUpdate: () -> Unit,
    modifier: Modifier = Modifier,
    nowMs: Long = System.currentTimeMillis(),
) {
    val tokens = LocalTokens.current
    // Track which row's upload is in flight so only that row morphs into a bar/result.
    var uploadingPath by remember { mutableStateOf<String?>(null) }
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
            UpdateRow(
                status = updateStatus,
                onCheck = onCheckUpdate,
                onInstall = onInstallUpdate,
            )
            SettingsDiagnostics(
                sessions = sessions,
                nowMs = nowMs,
                uploadingPath = uploadingPath,
                progress = progress,
                outcome = outcome,
                onUpload = { path -> uploadingPath = path; onUpload(path) },
            )
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

/**
 * The OTA update row. Status text + ONE context action: when an update is available
 * the action installs it ([UPDATE_ACTION]); otherwise it re-runs the manual check
 * ([CHECK_ACTION]). All state/callbacks are hoisted from [UpdateViewModel] via the host.
 */
@Composable
private fun UpdateRow(
    status: UpdateStatus,
    onCheck: () -> Unit,
    onInstall: () -> Unit,
) {
    val tokens = LocalTokens.current
    val available = status as? UpdateStatus.Available
    Column(
        modifier = Modifier.fillMaxWidth().testTag("settings-update"),
        verticalArrangement = Arrangement.spacedBy(tokens.space.xs),
    ) {
        Text(
            text = UPDATES_LABEL,
            color = Color(Colors.ink3),
            fontSize = tokens.type.xs,
            fontWeight = FontWeight.SemiBold,
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(tokens.space.sm),
        ) {
            Text(
                text = updateStatusText(status),
                modifier = Modifier.weight(1f),
                color = Color(Colors.ink),
                fontSize = tokens.type.base,
            )
            if (available != null) {
                Button(onClick = onInstall, modifier = Modifier.testTag("settings-update-action")) {
                    Text(UPDATE_ACTION)
                }
            } else {
                OutlinedButton(onClick = onCheck, modifier = Modifier.testTag("settings-update-action")) {
                    Text(CHECK_ACTION)
                }
            }
        }
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
