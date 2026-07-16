// ---------------------------------------------------------------------------
// SettingsEditChrome — the shared page chrome for the "draft + Save" settings pages
// (Memory, Model, Tools, System Prompt, Advanced, Audio). One home for the boilerplate
// every editing page shares: a SettingsTopBar with a dirty-gated Save action, an inline
// apply-progress notice, and a discard-confirm on back-with-dirty.
//
// [SettingsEditScaffold] wraps a verticalScroll body (the common case). Pages whose
// body is itself a scroller (Model's LazyColumn) compose [SettingsSaveTopBar] +
// [SettingsApplyNotice] + [SettingsDiscardDialog] directly instead.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.components

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors

private val NOTICE_BORDER = 1.dp

/** Flat apply-progress the pages fold their FSM into; drives the Save-enable + notice. */
data class ApplyProgress(
    val saving: Boolean = false,
    val restarting: Boolean = false,
    val alreadyApplying: Boolean = false,
    val error: String? = null,
) {
    val active: Boolean get() = saving || restarting
}

/**
 * A draft+Save page: [title] header with a Save shown iff [dirty] (disabled while
 * [ApplyProgress.active]); a scrollable [body] preceded by the apply notice; and a
 * discard-confirm when backing out dirty. [onBack] is the real pop; the scaffold owns
 * the confirm gate + system-back interception.
 */
@Composable
fun SettingsEditScaffold(
    title: String,
    screenTestTag: String,
    backTestTag: String,
    saveTestTag: String,
    dirty: Boolean,
    apply: ApplyProgress,
    onBack: () -> Unit,
    onSave: () -> Unit,
    modifier: Modifier = Modifier,
    body: @Composable ColumnScope.() -> Unit,
) {
    val tokens = LocalTokens.current
    var confirmDiscard by remember { mutableStateOf(false) }
    val attemptBack: () -> Unit = { if (dirty) confirmDiscard = true else onBack() }
    BackHandler(enabled = true, onBack = attemptBack)
    Column(modifier.fillMaxSize().safeDrawingPadding().testTag(screenTestTag)) {
        SettingsSaveTopBar(
            title = title,
            dirty = dirty,
            saveEnabled = !apply.active,
            backTestTag = backTestTag,
            saveTestTag = saveTestTag,
            onBack = attemptBack,
            onSave = onSave,
        )
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = tokens.space.lg, vertical = tokens.space.md),
            verticalArrangement = Arrangement.spacedBy(tokens.space.md),
        ) {
            SettingsApplyNotice(apply)
            body()
        }
    }
    if (confirmDiscard) {
        SettingsDiscardDialog(
            onConfirm = { confirmDiscard = false; onBack() },
            onDismiss = { confirmDiscard = false },
        )
    }
}

/** SettingsTopBar + a trailing Save that appears iff [dirty]. */
@Composable
fun SettingsSaveTopBar(
    title: String,
    dirty: Boolean,
    saveEnabled: Boolean,
    backTestTag: String,
    saveTestTag: String,
    onBack: () -> Unit,
    onSave: () -> Unit,
) {
    val tokens = LocalTokens.current
    Row(verticalAlignment = Alignment.CenterVertically) {
        SettingsTopBar(title = title, onBack = onBack, backTestTag = backTestTag, modifier = Modifier.weight(1f))
        if (dirty) {
            TextButton(
                onClick = onSave,
                enabled = saveEnabled,
                modifier = Modifier.padding(end = tokens.space.sm).testTag(saveTestTag),
            ) {
                Text("Save", color = Color(Colors.accent), fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

/** Inline apply-progress banner; renders nothing when idle. */
@Composable
fun SettingsApplyNotice(apply: ApplyProgress) {
    val tokens = LocalTokens.current
    val (msg, tone) = when {
        apply.error != null -> apply.error to Colors.stop
        apply.alreadyApplying -> "Another change is already applying. Try again in a moment." to Colors.warn
        apply.restarting -> "Applying — assistant restarting…" to Colors.accent
        apply.saving -> "Applying…" to Colors.accent
        else -> return
    }
    Text(
        text = msg,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(tokens.radii.sm))
            .background(Color(Colors.bgElev))
            .border(NOTICE_BORDER, Color(tone), RoundedCornerShape(tokens.radii.sm))
            .padding(horizontal = tokens.space.md, vertical = tokens.space.sm)
            .testTag("settings-apply-notice"),
        color = Color(tone),
        fontSize = tokens.type.sm,
    )
}

/** Discard-changes confirm dialog shared by every editing page. */
@Composable
fun SettingsDiscardDialog(onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Discard changes?") },
        text = { Text("Your unsaved edits will be lost.") },
        confirmButton = {
            TextButton(onClick = onConfirm, modifier = Modifier.testTag("settings-discard-confirm")) {
                Text("Discard", color = Color(Colors.stop))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Keep editing") } },
    )
}

/** A one-line page description under the top bar (mirrors the webui PaneHead sub). */
@Composable
fun SettingsPaneSub(text: String) {
    val tokens = LocalTokens.current
    Text(
        text = text,
        modifier = Modifier.padding(bottom = tokens.space.xs),
        color = Color(Colors.ink3),
        fontSize = tokens.type.sm,
    )
}

/** Shared loading / load-error line for a page body. */
@Composable
fun SettingsLoadStatus(loading: Boolean, error: String?) {
    val tokens = LocalTokens.current
    val text = when {
        error != null -> error
        loading -> "Loading…"
        else -> return
    }
    Text(
        text = text,
        modifier = Modifier.testTag("settings-load-status"),
        color = if (error != null) Color(Colors.stop) else Color(Colors.ink3),
        fontSize = tokens.type.sm,
    )
}
