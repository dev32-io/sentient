// ---------------------------------------------------------------------------
// AccountScreen — the Account settings page (User group). Identity card (display
// name field + imperative Save with inline result; a "Voice print" row carrying a
// "Coming soon" badge for parity) and a Security card ("Change PIN" → dialog). NO
// sign-out here — logout stays a root-level danger row. State + callbacks come from
// [AccountViewModel]; leaf rows are pure. testTags: settings-account-screen/-back,
// settings-account-{name-field,name-save,change-pin}.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.account

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.tooling.preview.Preview
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.android.settings.components.SettingsCard
import io.sentient.android.settings.components.SettingsTopBar
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors

private const val TITLE = "Account"

@Composable
fun AccountScreen(
    vm: AccountViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    AccountContent(
        state = state,
        onBack = onBack,
        onNameChange = vm::setName,
        onSaveName = vm::saveName,
        onOpenPin = vm::openPinDialog,
        onCurrentPin = vm::setCurrentPin,
        onNewPin = vm::setNewPin,
        onSubmitPin = vm::submitPin,
        onClosePin = vm::closePinDialog,
        modifier = modifier,
    )
}

@Composable
private fun AccountContent(
    state: AccountUiState,
    onBack: () -> Unit,
    onNameChange: (String) -> Unit,
    onSaveName: () -> Unit,
    onOpenPin: () -> Unit,
    onCurrentPin: (String) -> Unit,
    onNewPin: (String) -> Unit,
    onSubmitPin: () -> Unit,
    onClosePin: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val tokens = LocalTokens.current
    Column(
        modifier = modifier.fillMaxSize().safeDrawingPadding().testTag("settings-account-screen"),
    ) {
        SettingsTopBar(title = TITLE, onBack = onBack, backTestTag = "settings-account-back")
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = tokens.space.lg, vertical = tokens.space.md),
            verticalArrangement = Arrangement.spacedBy(tokens.space.md),
        ) {
            IdentityCard(state, onNameChange, onSaveName)
            SecurityCard(onOpenPin)
        }
    }
    state.pin?.let {
        ChangePinDialog(
            state = it,
            onCurrentChange = onCurrentPin,
            onNewChange = onNewPin,
            onSubmit = onSubmitPin,
            onDismiss = onClosePin,
        )
    }
}

@Composable
private fun IdentityCard(state: AccountUiState, onNameChange: (String) -> Unit, onSaveName: () -> Unit) {
    val tokens = LocalTokens.current
    SettingsCard(title = "Identity", subtitle = "How Sentient knows it's you.") {
        Column(
            modifier = Modifier.padding(horizontal = tokens.space.lg, vertical = tokens.space.sm),
            verticalArrangement = Arrangement.spacedBy(tokens.space.sm),
        ) {
            Text("Display name", color = Color(Colors.ink2), fontSize = tokens.type.sm)
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(tokens.space.sm),
            ) {
                OutlinedTextField(
                    value = state.name,
                    onValueChange = onNameChange,
                    modifier = Modifier.weight(1f).testTag("settings-account-name-field"),
                    singleLine = true,
                    enabled = state.loaded && state.nameSave !is NameSaveState.Saving,
                )
                Button(
                    onClick = onSaveName,
                    enabled = state.nameDirty && state.nameSave !is NameSaveState.Saving,
                    modifier = Modifier.testTag("settings-account-name-save"),
                ) { Text(if (state.nameSave is NameSaveState.Saving) "Saving…" else "Save") }
            }
            NameSaveResult(state.nameSave)
        }
        VoicePrintRow()
    }
}

@Composable
private fun NameSaveResult(result: NameSaveState) {
    val tokens = LocalTokens.current
    when (result) {
        NameSaveState.Saved -> Text(
            "Saved",
            modifier = Modifier.testTag("settings-account-name-result"),
            color = Color(Colors.ok),
            fontSize = tokens.type.sm,
        )
        is NameSaveState.Error -> Text(
            result.message,
            modifier = Modifier.testTag("settings-account-name-result"),
            color = Color(Colors.stop),
            fontSize = tokens.type.sm,
        )
        else -> Unit
    }
}

@Composable
private fun VoicePrintRow() {
    val tokens = LocalTokens.current
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = tokens.space.lg, vertical = tokens.space.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(tokens.space.md),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text("Voice print", color = Color(Colors.ink), fontSize = tokens.type.base)
            Text(
                "Used to recognize you when you speak.",
                modifier = Modifier.padding(top = tokens.space.xs),
                color = Color(Colors.ink3),
                fontSize = tokens.type.xs,
            )
        }
        ComingSoonBadge()
    }
}

@Composable
private fun ComingSoonBadge() {
    val tokens = LocalTokens.current
    Surface(
        color = Color(Colors.bgElev),
        contentColor = Color(Colors.ink3),
        shape = RoundedCornerShape(tokens.radii.pill),
    ) {
        Text(
            "Coming soon",
            modifier = Modifier.padding(horizontal = tokens.space.md, vertical = tokens.space.xs),
            fontSize = tokens.type.xs,
        )
    }
}

@Composable
private fun SecurityCard(onOpenPin: () -> Unit) {
    val tokens = LocalTokens.current
    SettingsCard(
        title = "Security",
        subtitle = "Used for destructive actions like unlocking doors or spending money.",
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = tokens.space.lg, vertical = tokens.space.md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(tokens.space.md),
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("PIN", color = Color(Colors.ink), fontSize = tokens.type.base)
                Text(
                    "4 digits. Required for sensitive actions.",
                    modifier = Modifier.padding(top = tokens.space.xs),
                    color = Color(Colors.ink3),
                    fontSize = tokens.type.xs,
                )
            }
            OutlinedButton(
                onClick = onOpenPin,
                modifier = Modifier.testTag("settings-account-change-pin"),
            ) { Text("Change PIN") }
        }
    }
}

@Preview
@Composable
private fun AccountScreenPreview() {
    SentientTheme {
        AccountContent(
            state = AccountUiState(name = "Kevin", savedName = "Kevin", loaded = true),
            onBack = {}, onNameChange = {}, onSaveName = {}, onOpenPin = {},
            onCurrentPin = {}, onNewPin = {}, onSubmitPin = {}, onClosePin = {},
        )
    }
}
