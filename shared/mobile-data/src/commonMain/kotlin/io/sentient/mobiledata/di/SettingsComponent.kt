// ---------------------------------------------------------------------------
// SettingsComponent — the settings slice of the User/Connection scope. Built once
// per login BESIDE ChatComponent (same connection scope). Hand-written factory (no
// framework), mirroring ChatComponent's construction style: it wires the mobile-sdk
// settings REST clients → stateless repos → usecases over ONE injected HttpClient.
//
// Wiring (P3): the platform (UserSessionManager / IosUserSession) builds this from
// the resolved backend and hands in:
//   - httpClient    — a Ktor client on the platform engine (OkHttp / Darwin) with a
//                     GENEROUS request timeout. The apply / soul / memory / personality
//                     writes BLOCK MULTI-SECONDS through a Hermes worker restart; the
//                     clients set no per-request timeout, so this client's policy MUST
//                     allow ~60-120s or a healthy slow restart resolves as
//                     ApplyResult.Network. Use a DEDICATED settings client, not the chat
//                     WS or a short-timeout auth client.
//   - gatewayWsUrl  — full WS URL; the REST base is derived internally.
//   - token         — supplier of the current PASETO token (read per request).
//   - liveAudioPatch— the live-WS audio-pref patch for the Audio fast-save. Bind to
//                     `chatComponent::patchAudioPreferences` (connection-scope handle).
//   - onTokenRefreshed — persist the rolled token after me / rename (drawer header).
//     Bind to the platform SecureTokenStore save.
//   - onLoggedOut   — clear local session on logout (shut the connection scope +
//                     drop the token). Bind to UserSessionManager.shutdown / equivalent.
//
// NOTE: not yet constructed by android/ or ios/ — P3 wires it. This file only
// establishes the exact constructor contract those layers bind to.
// ---------------------------------------------------------------------------
package io.sentient.mobiledata.di

import io.ktor.client.HttpClient
import io.sentient.mobiledata.data.settings.AccountRepository
import io.sentient.mobiledata.data.settings.AdminRepository
import io.sentient.mobiledata.data.settings.ProfileRepository
import io.sentient.mobiledata.data.settings.SdkAccountRepository
import io.sentient.mobiledata.data.settings.SdkAdminRepository
import io.sentient.mobiledata.data.settings.SdkProfileRepository
import io.sentient.mobiledata.data.settings.SdkVoicesRepository
import io.sentient.mobiledata.data.settings.VoicesRepository
import io.sentient.mobiledata.usecase.settings.AccountUseCases
import io.sentient.mobiledata.usecase.settings.AdminUseCases
import io.sentient.mobiledata.usecase.settings.ApplyProfileChangeUseCase
import io.sentient.mobiledata.usecase.settings.ObserveSettingsAccessUseCase
import io.sentient.mobiledata.usecase.settings.VoicesUseCases
import io.sentient.mobilesdk.auth.AuthClient
import io.sentient.mobilesdk.log.createLogger
import io.sentient.mobilesdk.protocol.AudioPreferencesPatch
import io.sentient.mobilesdk.settings.AdminHttpClient
import io.sentient.mobilesdk.settings.FishHttpClient
import io.sentient.mobilesdk.settings.ProfileEditHttpClient
import io.sentient.mobilesdk.settings.ProfileHttpClient
import io.sentient.mobilesdk.settings.ProvidersHttpClient
import io.sentient.mobilesdk.settings.ServicesVersionsHttpClient
import io.sentient.mobilesdk.settings.VoicesHttpClient

/**
 * Settings slice of the connection scope. Constructor-injects everything; exposes
 * the repos (for the rare direct read) and the per-concern usecases the VMs resolve.
 */
class SettingsComponent(
    httpClient: HttpClient,
    gatewayWsUrl: String,
    token: () -> String,
    /** Live-WS audio-pref patch for the Audio fast-save. No-op default keeps tests/host-less builds sound. */
    liveAudioPatch: suspend (AudioPreferencesPatch) -> Unit = {},
    /** Persist the rolled token after me / rename. */
    onTokenRefreshed: (String) -> Unit = {},
    /** Clear local session on logout. */
    onLoggedOut: () -> Unit = {},
) {
    private val log = createLogger("data", "settings", "component")

    // ── REST clients (over the single injected HttpClient) ──
    private val profileHttp = ProfileHttpClient(httpClient, gatewayWsUrl, token)
    private val profileEditHttp = ProfileEditHttpClient(httpClient, gatewayWsUrl, token)
    private val providersHttp = ProvidersHttpClient(httpClient, gatewayWsUrl, token)
    private val voicesHttp = VoicesHttpClient(httpClient, gatewayWsUrl, token)
    private val fishHttp = FishHttpClient(httpClient, gatewayWsUrl, token)
    private val servicesVersionsHttp = ServicesVersionsHttpClient(httpClient, gatewayWsUrl, token)
    private val adminHttp = AdminHttpClient(httpClient, gatewayWsUrl, token)
    private val authClient = AuthClient(gatewayWsUrl, httpClient)

    // ── Stateless repos ──
    val profileRepository: ProfileRepository = SdkProfileRepository(profileHttp, profileEditHttp, providersHttp)
    val voicesRepository: VoicesRepository = SdkVoicesRepository(voicesHttp, fishHttp, servicesVersionsHttp)
    val accountRepository: AccountRepository = SdkAccountRepository(authClient, token)
    val adminRepository: AdminRepository = SdkAdminRepository(adminHttp)

    // ── Usecases (VM-facing) ──
    val applyProfileChange = ApplyProfileChangeUseCase(profileRepository, liveAudioPatch)
    val observeSettingsAccess = ObserveSettingsAccessUseCase(accountRepository, voicesRepository)
    val voices = VoicesUseCases(voicesRepository, profileRepository)
    val account = AccountUseCases(accountRepository, onTokenRefreshed, onLoggedOut)
    val admin = AdminUseCases(adminRepository, profileRepository)

    init {
        log.info("build")
    }
}
