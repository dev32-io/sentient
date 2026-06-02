// ---------------------------------------------------------------------------
// LoginScreen — the avatar-grid → PIN-pad login flow.
//
// Stateless screen body driven by AuthUiState + a dispatch(AuthIntent) lambda.
// PICK_USER shows the avatar grid (AvatarTile); ENTER_PIN shows the selected
// name + PinPad + the `login-error` text on a bad PIN. Users load once on first
// composition (LaunchedEffect → AuthIntent.LoadUsers). System back from the PIN
// pad returns to the grid (BackHandler), satisfying the one-back-target rule.
// ---------------------------------------------------------------------------
package io.sentient.android.auth

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.android.theme.LocalTokens

@Composable
fun LoginScreen(
    viewModel: AuthViewModel,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { viewModel.dispatch(AuthIntent.LoadUsers) }
    LoginScreenBody(state = state, dispatch = viewModel::dispatch, modifier = modifier)
}

@Composable
private fun LoginScreenBody(
    state: AuthUiState,
    dispatch: (AuthIntent) -> Unit,
    modifier: Modifier = Modifier,
) {
    val tokens = LocalTokens.current
    Box(
        modifier = modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .padding(tokens.space.xl),
        contentAlignment = Alignment.Center,
    ) {
        when (state.phase) {
            AuthPhase.PICK_USER -> UserGrid(state = state, dispatch = dispatch)
            AuthPhase.ENTER_PIN -> {
                BackHandler { dispatch(AuthIntent.Back) }
                PinEntry(state = state, dispatch = dispatch)
            }
        }
    }
}

@Composable
private fun UserGrid(state: AuthUiState, dispatch: (AuthIntent) -> Unit) {
    val tokens = LocalTokens.current
    if (state.loadingUsers && state.users.isEmpty()) {
        CircularProgressIndicator(Modifier.testTag("login-loading"))
        return
    }
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(tokens.space.xl),
    ) {
        Text(
            text = "Who's here?",
            style = MaterialTheme.typography.headlineSmall,
            color = MaterialTheme.colorScheme.onBackground,
        )
        LazyVerticalGrid(
            columns = GridCells.Adaptive(minSize = 96.dp),
            horizontalArrangement = Arrangement.spacedBy(tokens.space.lg),
            verticalArrangement = Arrangement.spacedBy(tokens.space.lg),
            modifier = Modifier.wrapContentSize(),
        ) {
            items(state.users, key = { it.userId }) { user ->
                AvatarTile(user = user, onClick = { dispatch(AuthIntent.SelectUser(user)) })
            }
        }
        ErrorText(error = state.error)
    }
}

@Composable
private fun PinEntry(state: AuthUiState, dispatch: (AuthIntent) -> Unit) {
    val tokens = LocalTokens.current
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(tokens.space.xl),
    ) {
        Text(
            text = state.selectedUser?.displayName.orEmpty(),
            style = MaterialTheme.typography.headlineSmall,
            color = MaterialTheme.colorScheme.onBackground,
        )
        Text(
            text = "Enter your PIN",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        PinPad(
            entered = state.pin.length,
            onDigit = { dispatch(AuthIntent.AppendDigit(it)) },
            onDelete = { dispatch(AuthIntent.DeleteDigit) },
        )
        ErrorText(error = state.error)
    }
}

@Composable
private fun ErrorText(error: String?) {
    if (error == null) return
    Text(
        text = error,
        modifier = Modifier.testTag("login-error"),
        color = MaterialTheme.colorScheme.error,
        style = MaterialTheme.typography.bodyMedium,
        textAlign = TextAlign.Center,
    )
}
