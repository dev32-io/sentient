// ---------------------------------------------------------------------------
// BackendSetupScreen — "Sentient backend setup". Host + Port + 3-way security
// selector + a Save button that probes then dismisses on success (brief check),
// or shows an error and stays. Stateless body driven by BackendSetupUiState +
// dispatch; the host owns the VM + dismiss/onSaved navigation.
// testTags: backend-setup, backend-host, backend-port, backend-security-*,
// backend-save, backend-error.
// ---------------------------------------------------------------------------
package io.sentient.android.backend

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.android.theme.LocalTokens

@Composable
fun BackendSetupScreen(
    viewModel: BackendSetupViewModel,
    onSaved: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    LaunchedEffect(state.saved) { if (state.saved) onSaved() }
    BackendSetupBody(state = state, dispatch = viewModel::dispatch, modifier = modifier)
}

private val SECURITY_OPTIONS = listOf(
    ConnectionSecurity.TLS_VALID to "TLS",
    ConnectionSecurity.TLS_TRUST_SELF_SIGNED to "TLS · self-signed",
    ConnectionSecurity.PLAIN_WS to "Plain ws",
)

@Composable
private fun BackendSetupBody(
    state: BackendSetupUiState,
    dispatch: (BackendSetupIntent) -> Unit,
    modifier: Modifier = Modifier,
) {
    val tokens = LocalTokens.current
    Column(
        modifier = modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .padding(tokens.space.xl)
            .testTag("backend-setup"),
        verticalArrangement = Arrangement.spacedBy(tokens.space.lg),
    ) {
        Text("Sentient backend", style = MaterialTheme.typography.headlineSmall)
        Text("Point the app at your Sentient gateway.", style = MaterialTheme.typography.bodyMedium)
        OutlinedTextField(
            value = state.host,
            onValueChange = { dispatch(BackendSetupIntent.SetHost(it)) },
            label = { Text("Host or IP") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().testTag("backend-host"),
        )
        OutlinedTextField(
            value = state.port,
            onValueChange = { dispatch(BackendSetupIntent.SetPort(it)) },
            label = { Text("Port") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth().testTag("backend-port"),
        )
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            SECURITY_OPTIONS.forEachIndexed { i, (sec, label) ->
                SegmentedButton(
                    selected = state.security == sec,
                    onClick = { dispatch(BackendSetupIntent.SetSecurity(sec)) },
                    shape = SegmentedButtonDefaults.itemShape(i, SECURITY_OPTIONS.size),
                    modifier = Modifier.testTag("backend-security-${sec.name}"),
                ) { Text(label, maxLines = 1) }
            }
        }
        if (state.security == ConnectionSecurity.TLS_TRUST_SELF_SIGNED) {
            Text(
                "Trusts a self-signed certificate for this server only. Use for LAN/self-hosted gateways.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
        state.error?.let {
            Text(
                it,
                modifier = Modifier.testTag("backend-error"),
                color = MaterialTheme.colorScheme.error,
            )
        }
        Button(
            onClick = { dispatch(BackendSetupIntent.Save) },
            enabled = !state.saving,
            modifier = Modifier.fillMaxWidth().testTag("backend-save"),
        ) {
            when {
                state.saving -> CircularProgressIndicator(Modifier.padding(2.dp), strokeWidth = 2.dp)
                state.saved -> Text("✓")
                else -> Text("Save & connect")
            }
        }
    }
}
