package io.sentient.mobilesdk.attachments

import io.ktor.client.plugins.HttpTimeout
import io.sentient.mobilesdk.sessions.buildSessionsHttpClient

private const val ATTACHMENT_REQUEST_TIMEOUT_MS = 15 * 60_000L

fun createAttachmentsHttpClient(
    gatewayWsUrl: String,
    allowSelfSignedDevHost: Boolean,
    token: () -> String,
    isOwnerActive: () -> Boolean = { true },
    onAuthenticationRequired: (() -> Unit)? = null,
): AttachmentsHttpClient = AttachmentsHttpClient(
    httpClient = buildSessionsHttpClient(
        allowSelfSignedDevHost = allowSelfSignedDevHost,
        token = token,
        isOwnerActive = isOwnerActive,
        onAuthenticationRequired = onAuthenticationRequired,
        requestTimeoutSeconds = ATTACHMENT_REQUEST_TIMEOUT_MS / 1_000.0,
    ).config {
        install(HttpTimeout) {
            requestTimeoutMillis = ATTACHMENT_REQUEST_TIMEOUT_MS
            connectTimeoutMillis = ATTACHMENT_REQUEST_TIMEOUT_MS
            socketTimeoutMillis = ATTACHMENT_REQUEST_TIMEOUT_MS
        }
    },
    gatewayWsUrl = gatewayWsUrl,
    token = token,
    timeoutMs = ATTACHMENT_REQUEST_TIMEOUT_MS,
)
