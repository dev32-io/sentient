// ---------------------------------------------------------------------------
// AppModule — the single Koin module for the Android UI app.
//
//  - PresenceCoordinator: app-scoped foreground/background relay (one instance).
//  - UserSessionManager: the User/Connection scope — owns the ChatComponent +
//    SettingsComponent + SDK, rebuilt across logout→login. Takes the presence relay
//    so it can wire pause/resume.
//  - ChatViewModel: parameterized by sessionId (route param) — a new chat is a fresh VM.
//  - Settings VMs: one thin VM per settings route, resolving usecases from the
//    connection-scoped SettingsComponent (exposed via the factory below).
//  - HistoryViewModel / Auth / Settings / BackendSetup: per-screen state holders.
//
// SettingsComponent is exposed as a `factory` (NOT a `single`) so it re-resolves the
// CURRENT connection-scoped instance from UserSessionManager — a `single` would cache
// the first-login component and go stale after logout→login.
// ---------------------------------------------------------------------------
package io.sentient.android.di

import io.sentient.android.auth.AuthViewModel
import io.sentient.android.backend.BackendSetupViewModel
import io.sentient.android.chat.ChatViewModel
import io.sentient.android.history.HistoryViewModel
import io.sentient.android.presence.PresenceCoordinator
import io.sentient.android.settings.SettingsRootViewModel
import io.sentient.android.settings.SettingsViewModel
import io.sentient.android.settings.account.AccountViewModel
import io.sentient.android.settings.advanced.AdvancedViewModel
import io.sentient.android.settings.audio.AudioViewModel
import io.sentient.android.settings.devices.DevicesViewModel
import io.sentient.android.settings.members.MembersViewModel
import io.sentient.android.settings.memory.MemoryViewModel
import io.sentient.android.settings.model.ModelViewModel
import io.sentient.android.settings.personalities.PersonalitiesViewModel
import io.sentient.android.settings.secrets.SecretsViewModel
import io.sentient.android.settings.systemprompt.SystemPromptViewModel
import io.sentient.android.settings.tools.ToolsViewModel
import io.sentient.android.settings.voice.AddVoiceViewModel
import io.sentient.android.settings.voice.FishCloneViewModel
import io.sentient.android.settings.voice.VoiceViewModel
import io.sentient.android.update.UpdateViewModel
import io.sentient.mobiledata.di.SettingsComponent
import org.koin.android.ext.koin.androidContext
import org.koin.core.module.dsl.viewModel
import org.koin.dsl.module

val appModule = module {
    single { PresenceCoordinator() }
    single { UserSessionManager(appContext = androidContext(), presence = get()) }

    // ONE shared update state holder: the force-update gate (AppNavHost), the Settings
    // update footer, and the foreground-trigger all observe the SAME UpdateViewModel. It
    // extends ViewModel (viewModelScope) but is a process-lived single, resolved via
    // koinInject — NOT a per-route koinViewModel — so its status is shared. Built lazily
    // from the connection-scoped checker/installer (UserSessionManager).
    single {
        val userSession = get<UserSessionManager>()
        UpdateViewModel(checker = userSession.updateChecker(), installer = userSession.updateInstaller())
    }

    // The connection-scoped SettingsComponent, re-resolved from UserSessionManager each
    // call (see header). Settings VM factories pull their usecases off it.
    factory { get<UserSessionManager>().settingsComponent() }

    // sessionId comes from the chat route (null = new chat). A switch is a navigation
    // that recreates this VM → clean per-conversation state. The ChatComponent is
    // resolved from the connection-scoped UserSessionManager (not the raw SDK).
    viewModel { (sessionId: String?) ->
        val userSession = get<UserSessionManager>()
        ChatViewModel(userSession.component(), sessionId)
    }
    viewModel { HistoryViewModel(get()) }

    viewModel { AuthViewModel() }
    viewModel { SettingsViewModel() }
    viewModel { BackendSetupViewModel() }

    // ── Settings routes ──
    // Root list gate: the single combine usecase resolved off the SettingsComponent.
    viewModel { SettingsRootViewModel(get<SettingsComponent>().observeSettingsAccess) }
    // Per-category page VMs — scaffold placeholders (P3a). A page agent gives each a
    // real constructor (usecases off get<SettingsComponent>()) when it fills the page.
    viewModel { MemoryViewModel() }
    viewModel { PersonalitiesViewModel() }
    viewModel { VoiceViewModel() }
    viewModel { AddVoiceViewModel() }
    viewModel { FishCloneViewModel() }
    viewModel { AudioViewModel() }
    viewModel { ModelViewModel() }
    viewModel { ToolsViewModel() }
    viewModel { SystemPromptViewModel() }
    viewModel { AdvancedViewModel() }
    viewModel { AccountViewModel() }
    viewModel { DevicesViewModel() }
    viewModel { MembersViewModel() }
    viewModel { SecretsViewModel() }
}
