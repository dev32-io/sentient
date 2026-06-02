// ---------------------------------------------------------------------------
// AuthHttpClient — builds the OkHttp-backed Ktor HttpClient for the AuthClient.
//
// The shared SDK's AuthClient (commonMain) takes an INJECTED HttpClient so the
// platform owns the engine + TLS policy. On Android we supply Ktor's OkHttp
// engine with JSON ContentNegotiation and, in DEBUG only, the same self-signed
// dev-host TLS bypass the SDK's AndroidWebSocketEngine uses for wss://10.0.2.2.
//
// SECURITY: the trust-all TrustManager + permissive HostnameVerifier are
// constructed ONLY inside the `if (allowSelfSignedDevHost)` branch. The release
// path (false) calls OkHttpClient.Builder().build(), which defers to the
// platform system trust store with no modification. The flag is sourced from
// BuildConfig.DEBUG by the caller — never hardcoded true here.
// ---------------------------------------------------------------------------
package io.sentient.android.sdk

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * Builds the auth HttpClient: OkHttp engine + JSON ContentNegotiation
 * (ignoreUnknownKeys so newer gateway fields decode cleanly), with the dev TLS
 * bypass applied only when [allowSelfSignedDevHost] is true.
 */
internal fun buildAuthHttpClient(allowSelfSignedDevHost: Boolean): HttpClient {
    val okHttp = buildOkHttpClient(allowSelfSignedDevHost)
    return HttpClient(OkHttp) {
        engine { preconfigured = okHttp }
        install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
    }
}

/**
 * SECURITY GUARD: the trust-all branch runs ONLY when [allowSelfSignedDevHost]
 * is true (DEBUG). The release path returns the default OkHttpClient.
 */
private fun buildOkHttpClient(allowSelfSignedDevHost: Boolean): OkHttpClient {
    val builder = OkHttpClient.Builder()
    if (allowSelfSignedDevHost) {
        val trustAll = trustAllManager()
        val sslContext = SSLContext.getInstance("TLS").also { ctx ->
            ctx.init(null, arrayOf<TrustManager>(trustAll), SecureRandom())
        }
        builder
            .sslSocketFactory(sslContext.socketFactory, trustAll)
            .hostnameVerifier { _, _ -> true }
    }
    return builder.build()
}

/** Trust-all [X509TrustManager]. Used only in the dev-only bypass branch. */
private fun trustAllManager(): X509TrustManager = object : X509TrustManager {
    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) = Unit
    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}
