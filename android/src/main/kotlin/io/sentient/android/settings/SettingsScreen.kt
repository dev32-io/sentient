// ---------------------------------------------------------------------------
// SettingsScreen — the root Settings category list (leveled navigation entry).
//
// Renders GroupHeader + a SettingsCard of CategoryRows per group (Soul / User /
// Admin / Support), a logout danger row, and the state-morphing UpdateFooter +
// version caption as the final scrolled-to section (inside the scroll content, not
// a sticky bottom bar — it must not overlap category rows). The Admin group shows only when the
// resolved access flags report isAdmin. Diagnostics is its own page now (Support
// group row → DiagnosticsScreen), no longer inline here.
//
// Stateless: [access] + update state + callbacks are hoisted from the host
// (SettingsRootViewModel for access, the process-wide UpdateViewModel for updates,
// SettingsViewModel for logout). testTags: settings-screen, settings-back,
// settings-logout, settings-update-action, settings-version, settings-cat-<key>.
// ---------------------------------------------------------------------------
package io.sentient.android.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.tooling.preview.Preview
import io.sentient.android.BuildConfig
import io.sentient.android.settings.components.CategoryRow
import io.sentient.android.settings.components.DangerButton
import io.sentient.android.settings.components.GroupHeader
import io.sentient.android.settings.components.SettingsCard
import io.sentient.android.settings.components.SettingsTopBar
import io.sentient.android.settings.components.UpdateFooter
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobiledata.usecase.settings.SettingsAccess
import io.sentient.mobilesdk.update.UpdateStatus

private const val TITLE = "Settings"
private const val LOGOUT_LABEL = "Log out"
private const val APP_NAME = "Sentient"

/** "Sentient 0.2.0 (10)" — the version caption, single-sourced from [BuildConfig]. */
private val versionText: String
    get() = "$APP_NAME ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})"

/**
 * The root Settings list. [access] gates the Admin group (null while loading →
 * hidden). [onNavigate] routes to a category page; [onLogout] runs the existing
 * logout path; the update footer is driven by the process-wide UpdateViewModel via
 * [updateStatus] / [isCheckingUpdate] / [onCheckUpdate] / [onInstallUpdate].
 */
@Composable
fun SettingsScreen(
    access: SettingsAccess?,
    onBack: () -> Unit,
    onNavigate: (String) -> Unit,
    onLogout: () -> Unit,
    updateStatus: UpdateStatus,
    isCheckingUpdate: Boolean,
    onCheckUpdate: () -> Unit,
    onInstallUpdate: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val tokens = LocalTokens.current
    Column(
        modifier = modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .testTag("settings-screen"),
    ) {
        SettingsTopBar(title = TITLE, onBack = onBack, backTestTag = "settings-back")
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = tokens.space.lg, vertical = tokens.space.md),
            verticalArrangement = Arrangement.spacedBy(tokens.space.md),
        ) {
            CategoryGroup(SettingsGroups.soul, onNavigate)
            CategoryGroup(SettingsGroups.user, onNavigate)
            if (access?.isAdmin == true) CategoryGroup(SettingsGroups.admin, onNavigate)
            CategoryGroup(SettingsGroups.support, onNavigate)
            DangerButton(
                label = LOGOUT_LABEL,
                onClick = onLogout,
                modifier = Modifier.fillMaxWidth().padding(top = tokens.space.sm),
                testTag = "settings-logout",
            )
            // The update control + version caption live at the very bottom of the
            // scrollable page (scrolled-to, not a sticky bottom bar) so they never
            // overlap the first category rows on short screens.
            UpdateFooter(
                status = updateStatus,
                isChecking = isCheckingUpdate,
                versionText = versionText,
                onCheck = onCheckUpdate,
                onInstall = onInstallUpdate,
                modifier = Modifier.padding(top = tokens.space.md),
                actionTestTag = "settings-update-action",
                versionTestTag = "settings-version",
            )
        }
    }
}

/** One group: its header + a card of category rows (each tagged settings-cat-<key>). */
@Composable
private fun ColumnScope.CategoryGroup(group: SettingsGroup, onNavigate: (String) -> Unit) {
    GroupHeader(text = group.title)
    SettingsCard {
        group.categories.forEach { category ->
            CategoryRow(
                icon = category.icon,
                title = category.title,
                onClick = { onNavigate(category.route) },
                testTag = "settings-cat-${category.key}",
            )
        }
    }
}

@Preview
@Composable
private fun SettingsScreenAdminPreview() {
    SentientTheme {
        SettingsScreen(
            access = SettingsAccess(isAdmin = true, fishBrowseEnabled = true),
            onBack = {},
            onNavigate = {},
            onLogout = {},
            updateStatus = UpdateStatus.UpToDate,
            isCheckingUpdate = false,
            onCheckUpdate = {},
            onInstallUpdate = {},
        )
    }
}

@Preview
@Composable
private fun SettingsScreenNonAdminPreview() {
    SentientTheme {
        SettingsScreen(
            access = SettingsAccess(isAdmin = false, fishBrowseEnabled = false),
            onBack = {},
            onNavigate = {},
            onLogout = {},
            updateStatus = UpdateStatus.UpToDate,
            isCheckingUpdate = false,
            onCheckUpdate = {},
            onInstallUpdate = {},
        )
    }
}
