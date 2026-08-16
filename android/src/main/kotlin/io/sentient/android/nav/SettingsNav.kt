// ---------------------------------------------------------------------------
// SettingsNav — the settings sub-graph: the root category list + one flat
// destination per category page (Memory … Diagnostics). Split out of AppNavHost so
// that file stays lean; every route is registered here NOW so later page agents fill
// only the page files (screen + VM) and never re-touch Routes.kt / AppNavHost.kt.
//
// VM resolution pattern: each category composable resolves its page VM via
// koinViewModel() (inferred from the screen's `vm` param, so no per-VM import) and
// passes it down. onBack pops the stack; the root uses onNavigate(route) to route
// into a category. The root logout reuses the existing logout path (logoutTo).
// ---------------------------------------------------------------------------
package io.sentient.android.nav

import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.composable
import io.sentient.android.di.UserSessionManager
import io.sentient.android.settings.SettingsRootViewModel
import io.sentient.android.settings.SettingsScreen
import io.sentient.android.settings.SettingsViewModel
import io.sentient.android.settings.account.AccountScreen
import io.sentient.android.settings.advanced.AdvancedScreen
import io.sentient.android.settings.audio.AudioScreen
import io.sentient.android.settings.diagnostics.DiagnosticsScreen
import io.sentient.android.settings.members.MembersScreen
import io.sentient.android.settings.memory.MemoryScreen
import io.sentient.android.settings.model.ModelScreen
import io.sentient.android.settings.personalities.PersonalitiesScreen
import io.sentient.android.settings.secrets.SecretsScreen
import io.sentient.android.settings.systemprompt.SystemPromptScreen
import io.sentient.android.settings.tools.ToolsScreen
import io.sentient.android.settings.voice.AddVoiceScreen
import io.sentient.android.settings.voice.FishCloneScreen
import io.sentient.android.settings.voice.VoiceScreen
import io.sentient.android.settings.voice.VoiceViewModel
import io.sentient.android.update.UpdateViewModel
import org.koin.androidx.compose.koinViewModel
import org.koin.compose.koinInject

/** Registers the root Settings list + every settings category destination. */
fun NavGraphBuilder.settingsDestinations(nav: NavHostController) {
    settingsRootDestination(nav)
    memoryDestination(nav)
    personalitiesDestination(nav)
    voiceDestination(nav)
    voiceAddDestination(nav)
    voiceFishDestination(nav)
    voiceFishEditorDestination(nav)
    audioDestination(nav)
    modelDestination(nav)
    toolsDestination(nav)
    systemPromptDestination(nav)
    advancedDestination(nav)
    accountDestination(nav)
    membersDestination(nav)
    secretsDestination(nav)
    diagnosticsDestination(nav)
}

private fun NavGraphBuilder.settingsRootDestination(nav: NavHostController) {
    composable(Routes.SETTINGS) {
        val rootVm = koinViewModel<SettingsRootViewModel>()
        val settingsVm = koinViewModel<SettingsViewModel>()
        val userSession = koinInject<UserSessionManager>()
        val updateVm = koinInject<UpdateViewModel>()
        val access by rootVm.access.collectAsStateWithLifecycle()
        val updateStatus by updateVm.status.collectAsStateWithLifecycle()
        val isChecking by updateVm.isChecking.collectAsStateWithLifecycle()
        SettingsScreen(
            access = access,
            onBack = { nav.popBackStack() },
            onNavigate = { route -> nav.navigate(route) },
            onLogout = {
                settingsVm.logout()
                logoutTo(nav, userSession)
            },
            updateStatus = updateStatus,
            isCheckingUpdate = isChecking,
            onCheckUpdate = updateVm::check,
            onInstallUpdate = updateVm::install,
        )
    }
}

private fun NavGraphBuilder.memoryDestination(nav: NavHostController) {
    composable(Routes.SETTINGS_MEMORY) {
        MemoryScreen(vm = koinViewModel(), onBack = { nav.popBackStack() })
    }
}

private fun NavGraphBuilder.personalitiesDestination(nav: NavHostController) {
    composable(Routes.SETTINGS_PERSONALITIES) {
        PersonalitiesScreen(vm = koinViewModel(), onBack = { nav.popBackStack() })
    }
}

// Nav-result signal for a voice created/cloned in the Add/Fish sub-page. Those
// pages set this on the Voice entry's savedStateHandle before popping; the Voice
// destination observes it and refetches. This is reliable across the pop-back that
// a lifecycle ON_RESUME observer misses (the Voice composable leaves + re-enters
// composition when a child route is shown).
private const val VOICE_LIST_DIRTY_KEY = "voice-list-dirty"

private fun NavGraphBuilder.voiceDestination(nav: NavHostController) {
    composable(Routes.SETTINGS_VOICE) { entry ->
        val vm = koinViewModel<VoiceViewModel>()
        val dirty by entry.savedStateHandle
            .getStateFlow(VOICE_LIST_DIRTY_KEY, false)
            .collectAsStateWithLifecycle()
        LaunchedEffect(dirty) {
            if (dirty) {
                vm.refresh()
                entry.savedStateHandle[VOICE_LIST_DIRTY_KEY] = false
            }
        }
        VoiceScreen(
            vm = vm,
            onBack = { nav.popBackStack() },
            onAddVoice = { nav.navigate(Routes.SETTINGS_VOICE_ADD) },
            onCloneFish = { nav.navigate(Routes.SETTINGS_VOICE_FISH) },
        )
    }
}

private fun NavGraphBuilder.voiceAddDestination(nav: NavHostController) {
    composable(Routes.SETTINGS_VOICE_ADD) {
        AddVoiceScreen(
            vm = koinViewModel(),
            onBack = { nav.popBackStack() },
            onDone = { markVoiceListDirty(nav); nav.popBackStack() },
        )
    }
}

private fun NavGraphBuilder.voiceFishDestination(nav: NavHostController) {
    composable(Routes.SETTINGS_VOICE_FISH) {
        FishCloneScreen(
            vm = koinViewModel(),
            onBack = { nav.popBackStack() },
            onDone = { markVoiceListDirty(nav); nav.popBackStack(Routes.SETTINGS_VOICE, false) },
            onOpenEditor = { nav.navigate(Routes.SETTINGS_VOICE_FISH_EDITOR) },
        )
    }
}

/**
 * The editor is a real entry above the results entry. It deliberately resolves
 * the VM from the results entry's ViewModelStoreOwner: the catalog and its
 * filters therefore stay alive underneath this child instead of being copied
 * or reloaded when the editor is opened.
 */
private fun NavGraphBuilder.voiceFishEditorDestination(nav: NavHostController) {
    composable(Routes.SETTINGS_VOICE_FISH_EDITOR) {
        val resultsEntry = nav.getBackStackEntry(Routes.SETTINGS_VOICE_FISH)
        FishCloneScreen(
            vm = koinViewModel(viewModelStoreOwner = resultsEntry),
            editorOnly = true,
            onBack = { nav.popBackStack() },
            onDone = { markVoiceListDirty(nav); nav.popBackStack(Routes.SETTINGS_VOICE, false) },
        )
    }
}

/** Flag the Voice list (the previous entry) to refetch on the pop-back. */
private fun markVoiceListDirty(nav: NavHostController) {
    nav.previousBackStackEntry?.savedStateHandle?.set(VOICE_LIST_DIRTY_KEY, true)
}

private fun NavGraphBuilder.audioDestination(nav: NavHostController) {
    composable(Routes.SETTINGS_AUDIO) {
        AudioScreen(vm = koinViewModel(), onBack = { nav.popBackStack() })
    }
}

private fun NavGraphBuilder.modelDestination(nav: NavHostController) {
    composable(Routes.SETTINGS_MODEL) {
        ModelScreen(vm = koinViewModel(), onBack = { nav.popBackStack() })
    }
}

private fun NavGraphBuilder.toolsDestination(nav: NavHostController) {
    composable(Routes.SETTINGS_TOOLS) {
        ToolsScreen(vm = koinViewModel(), onBack = { nav.popBackStack() })
    }
}

private fun NavGraphBuilder.systemPromptDestination(nav: NavHostController) {
    composable(Routes.SETTINGS_SYSTEM_PROMPT) {
        SystemPromptScreen(vm = koinViewModel(), onBack = { nav.popBackStack() })
    }
}

private fun NavGraphBuilder.advancedDestination(nav: NavHostController) {
    composable(Routes.SETTINGS_ADVANCED) {
        AdvancedScreen(vm = koinViewModel(), onBack = { nav.popBackStack() })
    }
}

private fun NavGraphBuilder.accountDestination(nav: NavHostController) {
    composable(Routes.SETTINGS_ACCOUNT) {
        AccountScreen(vm = koinViewModel(), onBack = { nav.popBackStack() })
    }
}

private fun NavGraphBuilder.membersDestination(nav: NavHostController) {
    composable(Routes.SETTINGS_MEMBERS) {
        MembersScreen(vm = koinViewModel(), onBack = { nav.popBackStack() })
    }
}

private fun NavGraphBuilder.secretsDestination(nav: NavHostController) {
    composable(Routes.SETTINGS_SECRETS) {
        SecretsScreen(vm = koinViewModel(), onBack = { nav.popBackStack() })
    }
}

private fun NavGraphBuilder.diagnosticsDestination(nav: NavHostController) {
    composable(Routes.SETTINGS_DIAGNOSTICS) {
        val settingsVm = koinViewModel<SettingsViewModel>()
        val sessions by settingsVm.sessions.collectAsStateWithLifecycle()
        val progress by settingsVm.progress.collectAsStateWithLifecycle()
        val outcome by settingsVm.outcome.collectAsStateWithLifecycle()
        DiagnosticsScreen(
            onBack = { nav.popBackStack() },
            sessions = sessions,
            progress = progress,
            outcome = outcome,
            onUpload = settingsVm::uploadSession,
        )
    }
}
