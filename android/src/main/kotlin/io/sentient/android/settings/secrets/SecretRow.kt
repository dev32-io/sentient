// ---------------------------------------------------------------------------
// SecretRow / BaseUrlRow — one provider key (or base-URL) row on the Secrets page.
// Presence-only: shows "Key set" / "Not set" from a has_key boolean and NEVER echoes
// the stored value. The edit draft is LOCAL to this composable (`remember`) — it is
// passed to the VM only on Save, so key material never enters VM state or a log line.
// An "active" badge / "Set active" affordance rides the same row. testTags derive
// from [testTagBase] (e.g. settings-secrets-openrouter-{update,field,save,...}).
// ---------------------------------------------------------------------------
package io.sentient.android.settings.secrets

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import io.sentient.android.theme.LocalTokens
import io.sentient.mobilesdk.design.Colors

private val DOT_SIZE = 8.dp

/** A provider key row (masked). [editing] = this row's key field is open. */
@Composable
fun SecretRow(
    label: String,
    hasKey: Boolean,
    isActive: Boolean,
    editing: Boolean,
    onSetActive: () -> Unit,
    onStartEdit: () -> Unit,
    onCancel: () -> Unit,
    onSave: (String) -> Unit,
    testTagBase: String,
) {
    val tokens = LocalTokens.current
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = tokens.space.lg, vertical = tokens.space.sm),
        verticalArrangement = Arrangement.spacedBy(tokens.space.xs),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
            Box(modifier = Modifier.size(DOT_SIZE).clip(CircleShape).background(Color(if (hasKey) Colors.ok else Colors.ink4)))
            Text(label, color = Color(Colors.ink), fontSize = tokens.type.base)
            if (isActive) {
                ActiveBadge()
            } else {
                TextButton(onClick = onSetActive, modifier = Modifier.testTag("$testTagBase-set-active")) {
                    Text("Set active", fontSize = tokens.type.sm)
                }
            }
            Box(modifier = Modifier.weight(1f))
            if (!editing) {
                TextButton(onClick = onStartEdit, modifier = Modifier.testTag("$testTagBase-update")) {
                    Text("Update", fontSize = tokens.type.sm)
                }
            }
        }
        if (editing) {
            SecretField(
                masked = true,
                placeholder = "Paste new key…",
                onSave = onSave,
                onCancel = onCancel,
                testTagBase = testTagBase,
            )
        } else {
            Text(
                if (hasKey) "Key set" else "Not set",
                modifier = Modifier.testTag("$testTagBase-status"),
                color = Color(if (hasKey) Colors.ink2 else Colors.ink3),
                fontSize = tokens.type.sm,
            )
        }
    }
}

/** The custom-provider base-URL subrow (not masked, url keyboard). */
@Composable
fun BaseUrlRow(
    hasBaseUrl: Boolean,
    editing: Boolean,
    onStartEdit: () -> Unit,
    onCancel: () -> Unit,
    onSave: (String) -> Unit,
    testTagBase: String,
) {
    val tokens = LocalTokens.current
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = tokens.space.lg, vertical = tokens.space.sm),
        verticalArrangement = Arrangement.spacedBy(tokens.space.xs),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
            Text("Base URL", color = Color(Colors.ink2), fontSize = tokens.type.sm)
            Box(modifier = Modifier.weight(1f))
            if (!editing) {
                TextButton(onClick = onStartEdit, modifier = Modifier.testTag("$testTagBase-baseurl-update")) {
                    Text("Update", fontSize = tokens.type.sm)
                }
            }
        }
        if (editing) {
            SecretField(
                masked = false,
                placeholder = "https://api.example.com/v1",
                onSave = onSave,
                onCancel = onCancel,
                testTagBase = "$testTagBase-baseurl",
            )
        } else {
            Text(
                if (hasBaseUrl) "Set" else "Not set",
                modifier = Modifier.testTag("$testTagBase-baseurl-status"),
                color = Color(if (hasBaseUrl) Colors.ink2 else Colors.ink3),
                fontSize = tokens.type.sm,
            )
        }
    }
}

@Composable
private fun SecretField(
    masked: Boolean,
    placeholder: String,
    onSave: (String) -> Unit,
    onCancel: () -> Unit,
    testTagBase: String,
) {
    val tokens = LocalTokens.current
    var draft by remember { mutableStateOf("") }
    OutlinedTextField(
        value = draft,
        onValueChange = { draft = it },
        modifier = Modifier.fillMaxWidth().testTag("$testTagBase-field"),
        singleLine = true,
        placeholder = { Text(placeholder, color = Color(Colors.ink4)) },
        visualTransformation = if (masked) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = if (masked) KeyboardType.Password else KeyboardType.Uri),
    )
    Row(horizontalArrangement = Arrangement.spacedBy(tokens.space.sm)) {
        TextButton(
            onClick = { onSave(draft.trim()) },
            enabled = draft.trim().isNotEmpty(),
            modifier = Modifier.testTag("$testTagBase-save"),
        ) { Text("Save") }
        TextButton(onClick = onCancel, modifier = Modifier.testTag("$testTagBase-cancel")) { Text("Cancel") }
    }
}

@Composable
private fun ActiveBadge() {
    val tokens = LocalTokens.current
    Surface(
        color = Color(Colors.accent50),
        contentColor = Color(Colors.accent),
        shape = RoundedCornerShape(tokens.radii.pill),
    ) {
        Text(
            "active",
            modifier = Modifier.padding(horizontal = tokens.space.sm, vertical = tokens.space.xs),
            fontSize = tokens.type.xs,
        )
    }
}
