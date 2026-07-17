// ---------------------------------------------------------------------------
// UpdateFooter — the state-morphing update control + version caption for the
// Settings root page footer (replaces SettingsScreen's current UpdateRow once a
// later phase wires it in — SettingsScreen itself is NOT touched here).
//
// Design-note vs plan wording: the plan's UpdateFooter states are
// idle/checking/up-to-date(transient)/available/failed, but the existing
// `UpdateStatus` sealed type (shared/mobile-sdk) has only UpToDate/Available/
// CheckFailed — there is no wire concept of "checking in flight" (that's a local
// VM-side loading flag around UpdateChecker.check(), not a manifest value). This
// component therefore takes an explicit [isChecking] boolean alongside [status]
// rather than inventing a client-side UpdateStatus.Checking case (which would
// require touching shared/mobile-sdk, out of this phase's scope and owned by the
// parallel P1a track). The "up-to-date" transient is entirely local UI state: it
// arms for [UP_TO_DATE_TRANSIENT_MS] the moment [isChecking] flips false while
// [status] is UpToDate, then reverts to the idle look — no VM/timer dependency.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.update.UpdateStatus
import io.sentient.mobilesdk.update.UpdateTarget
import kotlinx.coroutines.delay

private val log = createLogger("android", "update-footer")

private const val UP_TO_DATE_TRANSIENT_MS = 3_000L
private const val CHECK_LABEL = "Check for updates"
private const val CHECKING_LABEL = "Checking…"
private const val UP_TO_DATE_LABEL = "✓ Up to date"
private const val AVAILABLE_PREFIX = "Update to v"
private const val FAILED_LABEL = "Check failed — Retry"
private val SPINNER_SIZE = 16.dp

/** The five morph states, derived from [UpdateStatus] + local checking/transient flags. */
private sealed interface FooterVisual {
    data object Idle : FooterVisual
    data object Checking : FooterVisual
    data object UpToDateTransient : FooterVisual
    data class Available(val versionName: String) : FooterVisual
    data class Failed(val reason: String) : FooterVisual
}

/**
 * The morphing update control + version caption. [isChecking] is true while a manual
 * check is in flight (drives the spinner + arms the up-to-date transient on
 * completion); [status] is the last-known result. [onCheck] re-runs the check
 * (idle/up-to-date/failed states); [onInstall] hands off to the installer (available
 * state only). Pure — no ViewModel reference.
 */
@Composable
fun UpdateFooter(
    status: UpdateStatus,
    isChecking: Boolean,
    versionText: String,
    onCheck: () -> Unit,
    onInstall: () -> Unit,
    modifier: Modifier = Modifier,
    testTag: String = "update-footer",
    actionTestTag: String = "update-footer-action",
    versionTestTag: String = "update-footer-version",
) {
    val tokens = LocalTokens.current
    val visual = rememberFooterVisual(status, isChecking)
    Column(
        modifier = modifier.fillMaxWidth().testTag(testTag),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(tokens.space.sm),
    ) {
        FooterControl(visual = visual, onCheck = onCheck, onInstall = onInstall, actionTestTag = actionTestTag)
        Text(
            text = versionText,
            modifier = Modifier.testTag(versionTestTag),
            color = Color(Colors.ink3),
            fontSize = tokens.type.xs,
        )
    }
}

/**
 * Derives [FooterVisual] from [status]/[isChecking] and owns the up-to-date transient
 * timer: it arms the moment [isChecking] transitions true→false while [status] is
 * [UpdateStatus.UpToDate], then self-clears after [UP_TO_DATE_TRANSIENT_MS].
 */
@Composable
private fun rememberFooterVisual(status: UpdateStatus, isChecking: Boolean): FooterVisual {
    var wasChecking by remember { mutableStateOf(false) }
    var showUpToDateTransient by remember { mutableStateOf(false) }

    LaunchedEffect(isChecking) {
        if (wasChecking && !isChecking && status is UpdateStatus.UpToDate) {
            log.info("up-to-date.transient.start")
            showUpToDateTransient = true
            delay(UP_TO_DATE_TRANSIENT_MS)
            showUpToDateTransient = false
            log.info("up-to-date.transient.end")
        }
        wasChecking = isChecking
    }

    return when {
        isChecking -> FooterVisual.Checking
        showUpToDateTransient -> FooterVisual.UpToDateTransient
        status is UpdateStatus.Available -> FooterVisual.Available(status.versionName)
        status is UpdateStatus.CheckFailed -> FooterVisual.Failed(status.reason)
        else -> FooterVisual.Idle
    }
}

@Composable
private fun FooterControl(
    visual: FooterVisual,
    onCheck: () -> Unit,
    onInstall: () -> Unit,
    actionTestTag: String,
) {
    when (visual) {
        is FooterVisual.Idle -> OutlinedButton(onClick = onCheck, modifier = Modifier.testTag(actionTestTag)) {
            Text(CHECK_LABEL)
        }
        is FooterVisual.Checking -> CheckingControl(actionTestTag = actionTestTag)
        is FooterVisual.UpToDateTransient -> Text(
            text = UP_TO_DATE_LABEL,
            modifier = Modifier.testTag(actionTestTag),
            color = Color(Colors.accent),
        )
        is FooterVisual.Available -> Button(
            onClick = onInstall,
            modifier = Modifier.testTag(actionTestTag),
        ) { Text("$AVAILABLE_PREFIX${visual.versionName}") }
        is FooterVisual.Failed -> OutlinedButton(
            onClick = onCheck,
            modifier = Modifier.testTag(actionTestTag),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(Colors.stop)),
        ) { Text(FAILED_LABEL) }
    }
}

@Composable
private fun CheckingControl(actionTestTag: String) {
    val tokens = LocalTokens.current
    Row(
        modifier = Modifier.testTag(actionTestTag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(tokens.space.sm),
    ) {
        CircularProgressIndicator(
            modifier = Modifier.size(SPINNER_SIZE).testTag("update-footer-spinner"),
            color = Color(Colors.ink3),
            strokeWidth = 2.dp,
        )
        Text(text = CHECKING_LABEL, color = Color(Colors.ink3), fontSize = tokens.type.sm)
    }
}

@Preview
@Composable
private fun UpdateFooterIdlePreview() {
    SentientTheme {
        UpdateFooter(
            status = UpdateStatus.UpToDate,
            isChecking = false,
            versionText = "Sentient 0.1.7 (108)",
            onCheck = {},
            onInstall = {},
        )
    }
}

@Preview
@Composable
private fun UpdateFooterAvailablePreview() {
    SentientTheme {
        UpdateFooter(
            status = UpdateStatus.Available(
                latestBuild = 110,
                versionName = "0.2.0",
                notes = "",
                mandatory = false,
                target = UpdateTarget.AndroidApk("https://example.invalid/app.apk"),
            ),
            isChecking = false,
            versionText = "Sentient 0.1.7 (108)",
            onCheck = {},
            onInstall = {},
        )
    }
}
