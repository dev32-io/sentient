// ---------------------------------------------------------------------------
// SettingsIconsUser — the User/Admin/Support-group icon half of SettingsIcons
// (Soul-group icons live in SettingsIcons.kt; see that file's header for the
// transcription method + [strokeIcon] helper this file reuses).
//
// Diagnostics has no webui source (webui's icon set has no heart-pulse/activity
// glyph) — per the plan it is hand-drawn "consistent with the set": a 24x24
// outline pulse-line, using the well-known open-source Feather "activity" glyph
// shape (single M-L polyline: a flat baseline broken by one spike), which reads
// unambiguously as a heartbeat/vitals trace at the same stroke weight as the rest.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.icons

import androidx.compose.ui.graphics.vector.ImageVector

private var _userCircle: ImageVector? = null

/** user-circle.tsx — Account category icon. */
val SettingsIcons.UserCircle: ImageVector
    get() {
        _userCircle?.let { return it }
        val built = strokeIcon(
            name = "UserCircle",
            pathData = "M22 12A10 10 0 1 0 2 12A10 10 0 1 0 22 12 " +
                "M15 10A3 3 0 1 0 9 10A3 3 0 1 0 15 10 " +
                "M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662",
        )
        _userCircle = built
        return built
    }

private var _usersGroup: ImageVector? = null

/** users-group.tsx — Members (admin) category icon. */
val SettingsIcons.UsersGroup: ImageVector
    get() {
        _usersGroup?.let { return it }
        val built = strokeIcon(
            name = "UsersGroup",
            pathData = "M15 8A5 5 0 1 0 5 8A5 5 0 1 0 15 8 " +
                "M18 21a8 8 0 0 0-16 0 " +
                "M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3",
        )
        _usersGroup = built
        return built
    }

private var _key: ImageVector? = null

/** key.tsx — Secrets (admin) category icon. */
val SettingsIcons.Key: ImageVector
    get() {
        _key?.let { return it }
        val built = strokeIcon(
            name = "Key",
            pathData = "M12 15A4 4 0 1 0 4 15A4 4 0 1 0 12 15 " +
                "M10.9 12.1L19 4 " +
                "M17 6L20 9",
        )
        _key = built
        return built
    }

private var _diagnostics: ImageVector? = null

/** Hand-drawn pulse-line — Diagnostics (Support group) category icon; no webui source. */
val SettingsIcons.Diagnostics: ImageVector
    get() {
        _diagnostics?.let { return it }
        val built = strokeIcon(
            name = "Diagnostics",
            pathData = "M22 12h-4l-3 9L9 3l-3 9H2",
        )
        _diagnostics = built
        return built
    }
