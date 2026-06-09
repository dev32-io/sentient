// ---------------------------------------------------------------------------
// AppNavHost — route-based navigation replacing the old AppRoot state-gate.
//
// A chat is a route parameterized by sessionId, so switching conversation is a
// navigation that recreates the chat ViewModel → clean per-conversation state.
//
// Start gating (was AppRoot's derived-boolean swap) now happens at the SPLASH
// destination, which decides on the EXISTING state sources:
//   - backend configured: BackendConfigHolder.store.config != null
//     OR BuildConfig.GATEWAY_WS_URL non-empty.
//   - token present: DisplayNameHolder.store.name != null (login writes it; logout
//     clears it). A WS drop does NOT clear it, so a drop keeps the user on chat.
//
// Reactive transitions:
//   - login: when the token appears (name flips non-null) → navigate chat.
//   - setup onSaved → re-decide (login or chat).
//   - settings logout / authExpired → shutdown the UserSessionManager + clear auth
//     → token flips null → navigate login.
//
// testTagsAsResourceId is enabled at the composition root so Compose testTags
// surface as Android resource-ids for Maestro / uiautomator.
// ---------------------------------------------------------------------------
package io.sentient.android.nav

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import io.sentient.android.BuildConfig
import io.sentient.android.auth.AuthViewModel
import io.sentient.android.auth.LoginScreen
import io.sentient.android.backend.BackendConfigHolder
import io.sentient.android.backend.BackendSetupScreen
import io.sentient.android.backend.BackendSetupViewModel
import io.sentient.android.di.UserSessionManager
import io.sentient.android.sdk.DisplayNameHolder
import io.sentient.android.settings.SettingsScreen
import io.sentient.android.settings.SettingsViewModel
import io.sentient.android.splash.AppSplashOverlay
import org.koin.androidx.compose.koinViewModel
import org.koin.compose.koinInject

/** Neutral display-name fallback shown before login persists a real name. */
private const val DEFAULT_DISPLAY_NAME = "You"

private fun isBackendConfigured(): Boolean =
    BackendConfigHolder.store.config.value != null || BuildConfig.GATEWAY_WS_URL.isNotEmpty()

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun AppNavHost() {
    val nav = rememberNavController()
    Surface(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
        NavHost(navController = nav, startDestination = Routes.SPLASH) {
            splashDestination(nav)
            setupDestination(nav)
            loginDestination(nav)
            chatDestination(nav)
            settingsDestination(nav)
        }
    }
}

/** Splash: decide the real start (setup / login / chat), then replace itself. */
private fun NavGraphBuilder.splashDestination(nav: NavHostController) {
    composable(Routes.SPLASH) {
        val name by DisplayNameHolder.store.name.collectAsStateWithLifecycle()
        LaunchedEffect(Unit) {
            val target = when {
                !isBackendConfigured() -> Routes.SETUP
                name == null -> Routes.LOGIN
                else -> Routes.chat(null)
            }
            nav.navigate(target) { popUpTo(Routes.SPLASH) { inclusive = true } }
        }
        AppSplashOverlay(visible = true)
    }
}

private fun NavGraphBuilder.setupDestination(nav: NavHostController) {
    composable(Routes.SETUP) {
        val vm = koinViewModel<BackendSetupViewModel>()
        BackendSetupScreen(
            viewModel = vm,
            // After a successful save the backend is configured; re-decide login/chat.
            onSaved = {
                val target = if (DisplayNameHolder.store.name.value == null) Routes.LOGIN else Routes.chat(null)
                nav.navigate(target) { popUpTo(Routes.SETUP) { inclusive = true } }
            },
        )
    }
}

private fun NavGraphBuilder.loginDestination(nav: NavHostController) {
    composable(Routes.LOGIN) {
        val vm = koinViewModel<AuthViewModel>()
        val name by DisplayNameHolder.store.name.collectAsStateWithLifecycle()
        // Token appears (login persisted the display name) → enter chat.
        LaunchedEffect(name) {
            if (name != null) nav.navigate(Routes.chat(null)) { popUpTo(Routes.LOGIN) { inclusive = true } }
        }
        LoginScreen(viewModel = vm, onOpenBackendSetup = { nav.navigate(Routes.SETUP) })
    }
}

@Composable
private fun rememberUserName(): String {
    val name by DisplayNameHolder.store.name.collectAsStateWithLifecycle()
    return name ?: DEFAULT_DISPLAY_NAME
}

private fun NavGraphBuilder.chatDestination(nav: NavHostController) {
    composable(
        route = Routes.CHAT,
        arguments = listOf(navArgument(ARG_SESSION_ID) { type = NavType.StringType; nullable = true }),
    ) { backStackEntry ->
        val sessionId = backStackEntry.arguments?.getString(ARG_SESSION_ID)
        val userSession = koinInject<UserSessionManager>()
        // Cold-start-skip + presence: bind the live session to the app presence relay.
        LaunchedEffect(Unit) { userSession.bindPresence() }
        ChatHost(
            sessionId = sessionId,
            userName = rememberUserName(),
            onSelectSession = { id ->
                nav.navigate(Routes.chat(id)) { popUpTo("chat") { inclusive = true } }
            },
            onNewChat = {
                nav.navigate(Routes.chat(null)) { popUpTo("chat") { inclusive = true } }
            },
            onOpenSettings = { nav.navigate(Routes.SETTINGS) },
            onAuthExpired = { logoutTo(nav, userSession) },
        )
    }
}

private fun NavGraphBuilder.settingsDestination(nav: NavHostController) {
    composable(Routes.SETTINGS) {
        val settingsVm = koinViewModel<SettingsViewModel>()
        val userSession = koinInject<UserSessionManager>()
        SettingsScreen(
            onLogout = {
                settingsVm.logout()
                logoutTo(nav, userSession)
            },
            onBack = { nav.popBackStack() },
        )
    }
}

/** Tear down the SDK session and route to login (clears the whole back stack). */
private fun logoutTo(nav: NavHostController, userSession: UserSessionManager) {
    userSession.shutdown()
    nav.navigate(Routes.LOGIN) { popUpTo(nav.graph.id) { inclusive = true } }
}
