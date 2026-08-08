// ---------------------------------------------------------------------------
// ToolPermissionOptions — wire-value / label mapping + the RowSelect option list
// for the Tools screen's per-tool permission dropdown. Mirrors the webui's
// PERMISSION_OPTION_BY_VALUE (tools-pane.tsx) and iOS's ToolPermission+Display.swift.
//
// ToolPermission is a REAL Kotlin enum, deliberately unlike the plain-String wire
// fields elsewhere in the settings model (see ToolPermission.kt's header): the
// `when` blocks below are EXHAUSTIVE, no `else ->`, so a future fifth state
// (`auto`, once a classifier exists — plan 2026-08-07-tool-permissions) fails to
// COMPILE here instead of silently falling through to a wrong label or wire value.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.tools

import io.sentient.android.settings.components.SelectOption
import io.sentient.mobilesdk.settings.ToolPermission

/** The wire value this permission round-trips as through the Tools screen's
 *  RowSelect. Matches the gateway wire value (`toolPermissionSchema`, mirrored by
 *  this enum's own `@SerialName`s). */
val ToolPermission.wireValue: String
    get() = when (this) {
        ToolPermission.ALLOW -> "allow"
        ToolPermission.ASK -> "ask"
        ToolPermission.DENY -> "deny"
        ToolPermission.OFF -> "off"
    }

/** Human-facing label for the permission dropdown. */
val ToolPermission.displayLabel: String
    get() = when (this) {
        ToolPermission.ALLOW -> "Allow"
        ToolPermission.ASK -> "Ask"
        ToolPermission.DENY -> "Deny"
        ToolPermission.OFF -> "Off"
    }

/** Reverse of [wireValue]. Built over [ToolPermission.entries] rather than its own
 *  `when`, so a future fifth case needs no change here — only [wireValue] and
 *  [displayLabel] must be taught about it, and the compiler enforces that at
 *  their own exhaustive `when`s. */
fun toolPermissionFromWireValue(value: String): ToolPermission? =
    ToolPermission.entries.firstOrNull { it.wireValue == value }

/** The four-state permission dropdown's option list, in the gateway's declared
 *  enum order (Allow, Ask, Deny, Off). Built from [ToolPermission.entries] so the
 *  SET of options always matches the real enum; only the per-case label needs a
 *  human hand once a fifth value ships. */
val toolPermissionSelectOptions: List<SelectOption> =
    ToolPermission.entries.map { SelectOption(it.wireValue, it.displayLabel) }
