// ---------------------------------------------------------------------------
// MembersScreen — the Members (admin) settings page (Admin group). Household card:
// slots caption + "Add user" (disabled at the 3-user cap) + a member list (avatar
// tint + name + role pill; per-row Promote/Demote + Delete for everyone but you).
// Both promote and demote confirm first (either one force-signs the target out
// everywhere); demote's copy additionally warns that only another admin can
// restore the admin access it removes. State + callbacks come from
// [MembersViewModel]; leaf rows are pure. A non-admin (shouldn't reach here — root
// gates) sees a guard state. testTags: settings-members-screen/-back,
// settings-members-{add,row-*,promote-*,delete-*,toggle-confirm,toggle-cancel}.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.members

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.sentient.android.settings.components.SettingsCard
import io.sentient.android.settings.components.SettingsTopBar
import io.sentient.android.theme.LocalTokens
import io.sentient.android.theme.SentientTheme
import io.sentient.mobilesdk.design.Colors
import io.sentient.mobilesdk.settings.UserSummary

private const val TITLE = "Members"
private val AVATAR_SIZE = 36.dp

@Composable
fun MembersScreen(
    vm: MembersViewModel,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    MembersContent(
        state = state,
        onBack = onBack,
        onAdd = vm::openAdd,
        onToggleClick = vm::openToggle,
        onToggleConfirm = vm::confirmToggle,
        onToggleCancel = vm::closeToggle,
        onDeleteClick = vm::openDelete,
        onDeleteConfirm = vm::confirmDelete,
        onDeleteCancel = vm::closeDelete,
        onAddName = vm::setAddName,
        onAddPin = vm::setAddPin,
        onAddSubmit = vm::submitAdd,
        onAddCancel = vm::closeAdd,
        modifier = modifier,
    )
}

@Composable
private fun MembersContent(
    state: MembersUiState,
    onBack: () -> Unit,
    onAdd: () -> Unit,
    onToggleClick: (UserSummary) -> Unit,
    onToggleConfirm: () -> Unit,
    onToggleCancel: () -> Unit,
    onDeleteClick: (UserSummary) -> Unit,
    onDeleteConfirm: () -> Unit,
    onDeleteCancel: () -> Unit,
    onAddName: (String) -> Unit,
    onAddPin: (String) -> Unit,
    onAddSubmit: () -> Unit,
    onAddCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val tokens = LocalTokens.current
    Column(
        modifier = modifier.fillMaxSize().safeDrawingPadding().testTag("settings-members-screen"),
    ) {
        SettingsTopBar(title = TITLE, onBack = onBack, backTestTag = "settings-members-back")
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = tokens.space.lg, vertical = tokens.space.md),
            verticalArrangement = Arrangement.spacedBy(tokens.space.md),
        ) {
            if (state.accessError && state.loaded) {
                Text(
                    "Couldn't load members.",
                    modifier = Modifier.testTag("settings-members-access-error"),
                    color = Color(Colors.ink3),
                    fontSize = tokens.type.base,
                )
                return@Column
            }
            if (!state.isAdmin && state.loaded) {
                Text(
                    "You need to be an admin to manage members.",
                    modifier = Modifier.testTag("settings-members-guard"),
                    color = Color(Colors.ink3),
                    fontSize = tokens.type.base,
                )
                return@Column
            }
            HouseholdCard(state, onAdd, onToggleClick, onDeleteClick)
            if (state.errorMessage != null) {
                Text(state.errorMessage, color = Color(Colors.stop), fontSize = tokens.type.sm)
            }
        }
    }

    state.deleteTarget?.let { target ->
        AlertDialog(
            onDismissRequest = onDeleteCancel,
            title = { Text("Remove ${target.displayName}?") },
            text = {
                Text(
                    "This signs them out and removes their agent. This cannot be undone.",
                    color = Color(Colors.ink3),
                    fontSize = tokens.type.sm,
                )
            },
            confirmButton = {
                TextButton(onClick = onDeleteConfirm, modifier = Modifier.testTag("settings-members-delete-confirm")) {
                    Text("Remove", color = Color(Colors.stop))
                }
            },
            dismissButton = {
                TextButton(onClick = onDeleteCancel, modifier = Modifier.testTag("settings-members-delete-cancel")) {
                    Text("Cancel")
                }
            },
        )
    }

    state.toggleTarget?.let { target ->
        val isDemote = target.isAdmin
        AlertDialog(
            onDismissRequest = onToggleCancel,
            title = { Text(if (isDemote) "Demote ${target.displayName}?" else "Promote ${target.displayName}?") },
            text = {
                Text(
                    if (isDemote)
                        "This signs ${target.displayName} out on every device, right now. Once demoted, they can't restore their own admin access — only another admin can promote them back."
                    else
                        "This signs ${target.displayName} out on every device, right now. They'll need to log back in before they can use their new admin access.",
                    color = Color(Colors.ink3),
                    fontSize = tokens.type.sm,
                )
            },
            confirmButton = {
                TextButton(onClick = onToggleConfirm, modifier = Modifier.testTag("settings-members-toggle-confirm")) {
                    Text(
                        if (isDemote) "Demote" else "Promote",
                        color = Color(if (isDemote) Colors.stop else Colors.accent),
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = onToggleCancel, modifier = Modifier.testTag("settings-members-toggle-cancel")) {
                    Text("Cancel")
                }
            },
        )
    }

    state.addDialog?.let {
        AddMemberDialog(
            state = it,
            onNameChange = onAddName,
            onPinChange = onAddPin,
            onSubmit = onAddSubmit,
            onDismiss = onAddCancel,
        )
    }
}

@Composable
private fun HouseholdCard(
    state: MembersUiState,
    onAdd: () -> Unit,
    onToggleClick: (UserSummary) -> Unit,
    onDeleteClick: (UserSummary) -> Unit,
) {
    val tokens = LocalTokens.current
    val slots = state.slotsFree
    SettingsCard(
        title = "Household",
        subtitle = "${state.users.size} active · $slots slot${if (slots == 1) "" else "s"} free",
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = tokens.space.lg, vertical = tokens.space.sm),
            horizontalArrangement = Arrangement.End,
        ) {
            OutlinedButton(
                onClick = onAdd,
                enabled = state.canAdd,
                modifier = Modifier.testTag("settings-members-add"),
            ) { Text("Add user") }
        }
        state.users.forEach { user ->
            MemberRow(
                user = user,
                isSelf = user.userId == state.selfUserId,
                onToggleClick = { onToggleClick(user) },
                onDelete = { onDeleteClick(user) },
            )
        }
    }
}

@Composable
private fun MemberRow(user: UserSummary, isSelf: Boolean, onToggleClick: () -> Unit, onDelete: () -> Unit) {
    val tokens = LocalTokens.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = tokens.space.lg, vertical = tokens.space.sm)
            .testTag("settings-members-row-${user.userId}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(tokens.space.sm),
    ) {
        Avatar(user)
        Column(modifier = Modifier.weight(1f)) {
            Text(
                buildString { append(user.displayName); if (isSelf) append(" · you") },
                color = Color(Colors.ink),
                fontSize = tokens.type.base,
            )
            Text(if (user.isAdmin) "Admin" else "Member", color = Color(Colors.ink3), fontSize = tokens.type.xs)
        }
        RolePill(user.isAdmin)
        if (!isSelf) {
            TextButton(onClick = onToggleClick, modifier = Modifier.testTag("settings-members-promote-${user.userId}")) {
                Text(if (user.isAdmin) "Demote" else "Promote", fontSize = tokens.type.sm)
            }
            TextButton(onClick = onDelete, modifier = Modifier.testTag("settings-members-delete-${user.userId}")) {
                Text("Delete", color = Color(Colors.stop), fontSize = tokens.type.sm)
            }
        }
    }
}

@Composable
private fun Avatar(user: UserSummary) {
    val tint = user.avatarTint.toColorOrNull() ?: Color(Colors.bgElev)
    Box(
        modifier = Modifier.size(AVATAR_SIZE).clip(CircleShape).background(tint),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            user.displayName.take(1).uppercase(),
            color = Color(Colors.ink),
            fontSize = LocalTokens.current.type.sm,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun RolePill(isAdmin: Boolean) {
    val tokens = LocalTokens.current
    Surface(
        color = Color(if (isAdmin) Colors.accent50 else Colors.bgElev),
        contentColor = Color(if (isAdmin) Colors.accent else Colors.ink3),
        shape = RoundedCornerShape(tokens.radii.pill),
    ) {
        Text(
            if (isAdmin) "Admin" else "Member",
            modifier = Modifier.padding(horizontal = tokens.space.sm, vertical = tokens.space.xs),
            fontSize = tokens.type.xs,
        )
    }
}

/** Parse a "#RRGGBB" avatar tint to a Compose color; null when absent/malformed. */
private fun String.toColorOrNull(): Color? {
    if (!startsWith("#") || (length != 7 && length != 9)) return null
    return runCatching {
        val hex = substring(1).toLong(16)
        val argb = if (length == 7) 0xFF000000 or hex else hex
        Color(argb)
    }.getOrNull()
}

@Preview
@Composable
private fun MembersScreenPreview() {
    SentientTheme {
        MembersContent(
            state = MembersUiState(
                users = listOf(
                    UserSummary("u1", "Kevin", isAdmin = true, avatarTint = "#5A3A28"),
                    UserSummary("u2", "Sam", isAdmin = false, avatarTint = "#3A4232"),
                ),
                selfUserId = "u1",
                isAdmin = true,
                loaded = true,
            ),
            onBack = {}, onAdd = {},
            onToggleClick = {}, onToggleConfirm = {}, onToggleCancel = {},
            onDeleteClick = {}, onDeleteConfirm = {}, onDeleteCancel = {},
            onAddName = {}, onAddPin = {}, onAddSubmit = {}, onAddCancel = {},
        )
    }
}
