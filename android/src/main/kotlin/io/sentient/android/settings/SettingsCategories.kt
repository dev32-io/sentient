// ---------------------------------------------------------------------------
// SettingsCategories — the root Settings list model: the grouped set of category
// rows (icon + title + route + testTag key), transcribed from the webui
// nav-config.ts groups (Soul / User / Admin / Support). Sidebar labels win
// ("System Prompt", "Secrets"), not the pane-title variants.
//
// The Admin group is rendered only when access flags say isAdmin; the list here
// is static and the gate lives in SettingsScreen.
// ---------------------------------------------------------------------------
package io.sentient.android.settings

import androidx.compose.ui.graphics.vector.ImageVector
import io.sentient.android.nav.Routes
import io.sentient.android.settings.icons.BookOpen
import io.sentient.android.settings.icons.Brain
import io.sentient.android.settings.icons.Cpu
import io.sentient.android.settings.icons.Diagnostics
import io.sentient.android.settings.icons.Drama
import io.sentient.android.settings.icons.Key
import io.sentient.android.settings.icons.Phone
import io.sentient.android.settings.icons.SettingsIcons
import io.sentient.android.settings.icons.SlidersH
import io.sentient.android.settings.icons.UserCircle
import io.sentient.android.settings.icons.UsersGroup
import io.sentient.android.settings.icons.Volume2
import io.sentient.android.settings.icons.Waveform
import io.sentient.android.settings.icons.Wrench

/** One tappable row on the root Settings list. [key] drives the "settings-cat-<key>" testTag. */
data class SettingsCategory(
    val key: String,
    val title: String,
    val icon: ImageVector,
    val route: String,
)

/** A titled group of category rows on the root list. */
data class SettingsGroup(
    val title: String,
    val categories: List<SettingsCategory>,
)

/** Group titles (transcribed from webui nav-config.ts). */
object SettingsGroups {
    const val SOUL = "Soul"
    const val USER = "User"
    const val ADMIN = "Admin"
    const val SUPPORT = "Support"

    val soul = SettingsGroup(
        title = SOUL,
        categories = listOf(
            SettingsCategory("memory", "Memory", SettingsIcons.Brain, Routes.SETTINGS_MEMORY),
            SettingsCategory("personalities", "Personalities", SettingsIcons.Drama, Routes.SETTINGS_PERSONALITIES),
            SettingsCategory("voice", "Voice", SettingsIcons.Waveform, Routes.SETTINGS_VOICE),
            SettingsCategory("audio", "Audio", SettingsIcons.Volume2, Routes.SETTINGS_AUDIO),
            SettingsCategory("model", "Model", SettingsIcons.Cpu, Routes.SETTINGS_MODEL),
            SettingsCategory("tools", "Tools", SettingsIcons.Wrench, Routes.SETTINGS_TOOLS),
            SettingsCategory("system-prompt", "System Prompt", SettingsIcons.BookOpen, Routes.SETTINGS_SYSTEM_PROMPT),
            SettingsCategory("advanced", "Advanced", SettingsIcons.SlidersH, Routes.SETTINGS_ADVANCED),
        ),
    )

    val user = SettingsGroup(
        title = USER,
        categories = listOf(
            SettingsCategory("account", "Account", SettingsIcons.UserCircle, Routes.SETTINGS_ACCOUNT),
            SettingsCategory("devices", "Devices", SettingsIcons.Phone, Routes.SETTINGS_DEVICES),
        ),
    )

    /** Rendered only when the access flags report isAdmin. */
    val admin = SettingsGroup(
        title = ADMIN,
        categories = listOf(
            SettingsCategory("members", "Members", SettingsIcons.UsersGroup, Routes.SETTINGS_MEMBERS),
            SettingsCategory("secrets", "Secrets", SettingsIcons.Key, Routes.SETTINGS_SECRETS),
        ),
    )

    val support = SettingsGroup(
        title = SUPPORT,
        categories = listOf(
            SettingsCategory("diagnostics", "Diagnostics", SettingsIcons.Diagnostics, Routes.SETTINGS_DIAGNOSTICS),
        ),
    )
}
