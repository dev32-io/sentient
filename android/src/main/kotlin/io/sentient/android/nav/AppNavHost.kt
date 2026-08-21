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
//   - authenticated identity present: the explicit server user id and display name
//     are both persisted by login; a WS drop does NOT clear either, so a drop keeps
//     the user on chat.
//
// Reactive transitions:
//   - login: when both identity projections are present → navigate chat.
//   - setup onSaved → re-decide (login or chat).
//   - settings logout / authExpired → purge/close UserSessionManager + clear auth
//     → identity flips absent → navigate login.
//
// testTagsAsResourceId is enabled at the composition root so Compose testTags
// surface as Android resource-ids for Maestro / uiautomator.
// ---------------------------------------------------------------------------
package io.sentient.android.nav

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
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
import io.sentient.android.sdk.AuthenticatedUserHolder
import io.sentient.android.sdk.DisplayNameHolder
import io.sentient.android.splash.AppSplashOverlay
import io.sentient.android.update.ForceUpdateScreen
import io.sentient.android.update.UpdateBanner
import io.sentient.android.update.UpdateViewModel
import io.sentient.mobilesdk.update.UpdateStatus
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
    // Auth gate value (token presence). The OTA overlay only mounts once authed so its
    // single (UpdateViewModel → resolved backend) is never constructed pre-config.
    val name by DisplayNameHolder.store.name.collectAsStateWithLifecycle()
    val authenticatedUserId by AuthenticatedUserHolder.store.userId.collectAsStateWithLifecycle()
    val hasAuthenticatedIdentity = name != null && authenticatedUserId != null
    Surface(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
        Box(Modifier.fillMaxSize()) {
            NavHost(navController = nav, startDestination = Routes.SPLASH) {
                splashDestination(nav)
                setupDestination(nav)
                loginDestination(nav)
                chatDestination(nav)
                settingsDestinations(nav)
                forceUpdateDestination()
            }
            if (hasAuthenticatedIdentity && isBackendConfigured()) {
                UpdateOverlay(nav)
            }
        }
    }
}

/**
 * The OTA overlay, mounted only while authed. Owns the single shared [UpdateViewModel]
 * (resolved via koinInject, not koinViewModel — one instance for gate + settings +
 * foreground). Two effects:
 *   - force gate: status flips to Available && mandatory → route to ForceUpdate AHEAD
 *     of the authed screen (launchSingleTop; the screen itself blocks back).
 *   - optional banner: Available && !mandatory → a dismissible top in-screen overlay.
 */
@Composable
private fun BoxScope.UpdateOverlay(nav: NavHostController) {
    val updateVm = koinInject<UpdateViewModel>()
    val status by updateVm.status.collectAsStateWithLifecycle()
    var dismissed by remember { mutableStateOf(false) }

    // One-shot authed check on first composition. Pure HTTP GET, independent of
    // the WS connect path — no double-connect risk, so cold-start-skip doesn't apply.
    LaunchedEffect(Unit) { updateVm.check() }

    LaunchedEffect(status) {
        val s = status
        if (s is UpdateStatus.Available && s.mandatory) {
            nav.navigate(Routes.FORCE_UPDATE) { launchSingleTop = true }
        }
    }

    val s = status
    if (s is UpdateStatus.Available && !s.mandatory && !dismissed) {
        UpdateBanner(
            versionName = s.versionName,
            onInstall = updateVm::install,
            onDismiss = { dismissed = true },
            modifier = Modifier.align(Alignment.TopCenter),
        )
    }
}

private fun NavGraphBuilder.forceUpdateDestination() {
    composable(Routes.FORCE_UPDATE) {
        val updateVm = koinInject<UpdateViewModel>()
        val status by updateVm.status.collectAsStateWithLifecycle()
        val s = status
        ForceUpdateScreen(
            versionName = if (s is UpdateStatus.Available) s.versionName else "",
            onInstall = updateVm::install,
        )
    }
}

/** Splash: decide the real start (setup / login / chat), then replace itself. */
private fun NavGraphBuilder.splashDestination(nav: NavHostController) {
    composable(Routes.SPLASH) {
        val name by DisplayNameHolder.store.name.collectAsStateWithLifecycle()
        val authenticatedUserId by AuthenticatedUserHolder.store.userId.collectAsStateWithLifecycle()
        LaunchedEffect(Unit) {
            val target = when {
                !isBackendConfigured() -> Routes.SETUP
                name == null || authenticatedUserId == null -> Routes.LOGIN
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
                val target = if (
                    DisplayNameHolder.store.name.value == null ||
                    AuthenticatedUserHolder.store.userId.value == null
                ) Routes.LOGIN else Routes.chat(null)
                nav.navigate(target) { popUpTo(Routes.SETUP) { inclusive = true } }
            },
        )
    }
}

private fun NavGraphBuilder.loginDestination(nav: NavHostController) {
    composable(Routes.LOGIN) {
        val vm = koinViewModel<AuthViewModel>()
        val name by DisplayNameHolder.store.name.collectAsStateWithLifecycle()
        val authenticatedUserId by AuthenticatedUserHolder.store.userId.collectAsStateWithLifecycle()
        // Both the display projection and explicit server identity must be present
        // before entering chat; this prevents a route recreation from guessing a
        // namespace while the login callback is still being applied.
        LaunchedEffect(name, authenticatedUserId) {
            if (name != null && authenticatedUserId != null) {
                nav.navigate(Routes.chat(null)) { popUpTo(Routes.LOGIN) { inclusive = true } }
            }
        }
        LoginScreen(viewModel = vm, onOpenBackendSetup = { nav.navigate(Routes.SETUP) })
    }
}

@Composable
private fun rememberUserName(): String {
    val name by DisplayNameHolder.store.name.collectAsStateWithLifecycle()
    return name ?: DEFAULT_DISPLAY_NAME
}

/** The callback passed from the drawer to the host must land on the calendar route. */
internal fun navigateToCalendar(navigate: (String) -> Unit) {
    navigate(Routes.SETTINGS_CALENDAR)
}

private fun NavGraphBuilder.chatDestination(nav: NavHostController) {
    composable(
        route = Routes.CHAT,
        arguments = listOf(navArgument(ARG_SESSION_ID) { type = NavType.StringType; nullable = true }),
    ) { backStackEntry ->
        val sessionId = backStackEntry.arguments?.getString(ARG_SESSION_ID)
        val userSession = koinInject<UserSessionManager>()
        val updateVm = koinInject<UpdateViewModel>()
        // Cold-start-skip + presence: bind the live session to the app presence relay.
        // The OTA check rides the SAME foreground signal, so it inherits the cold-start
        // skip (no check on the first foreground after launch) — only on a real resume.
        LaunchedEffect(Unit) { userSession.bindPresence(onForegroundExtra = updateVm::check) }
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
            onOpenCalendar = { navigateToCalendar { route -> nav.navigate(route) } },
            onAuthExpired = { authenticationExpiredTo(nav, userSession) },
        )
    }
}

/** Tear down the SDK session and route to login (clears the whole back stack). */
internal fun logoutTo(nav: NavHostController, userSession: UserSessionManager) {
    userSession.performLocalLogout()
    navigateToLogin(nav)
}

/** Authentication expiry has its own production lifecycle entry point. */
internal fun authenticationExpiredTo(nav: NavHostController, userSession: UserSessionManager) {
    userSession.onAuthenticationExpired()
    navigateToLogin(nav)
}

private fun navigateToLogin(nav: NavHostController) {
    nav.navigate(Routes.LOGIN) { popUpTo(nav.graph.id) { inclusive = true } }
}
