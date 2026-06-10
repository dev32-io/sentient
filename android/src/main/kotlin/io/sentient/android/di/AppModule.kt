// ---------------------------------------------------------------------------
// AppModule — the single Koin module for the Android UI app.
//
//  - PresenceCoordinator: app-scoped foreground/background relay (one instance).
//  - UserSessionManager: the User/Connection scope — owns the ChatComponent + SDK,
//    rebuilt across logout→login. Takes the presence relay so it can wire pause/resume.
//  - ChatViewModel: parameterized by sessionId (route param) — a new chat is a fresh VM.
//  - HistoryViewModel / Auth / Settings / BackendSetup: per-screen state holders.
//
// Auth/Settings/BackendSetup VMs keep their existing AppDependencies-backed
// constructors (their params default), so Koin just instantiates them.
// ---------------------------------------------------------------------------
package io.sentient.android.di

import io.sentient.android.auth.AuthViewModel
import io.sentient.android.backend.BackendSetupViewModel
import io.sentient.android.chat.ChatViewModel
import io.sentient.android.history.HistoryViewModel
import io.sentient.android.presence.PresenceCoordinator
import io.sentient.android.settings.SettingsViewModel
import org.koin.android.ext.koin.androidContext
import org.koin.core.module.dsl.viewModel
import org.koin.dsl.module

val appModule = module {
    single { PresenceCoordinator() }
    single { UserSessionManager(appContext = androidContext(), presence = get()) }

    // sessionId comes from the chat route (null = new chat). A switch is a navigation
    // that recreates this VM → clean per-conversation state.
    viewModel { (sessionId: String?) -> ChatViewModel(get(), sessionId) }
    viewModel { HistoryViewModel(get()) }

    viewModel { AuthViewModel() }
    viewModel { SettingsViewModel() }
    viewModel { BackendSetupViewModel() }
}
