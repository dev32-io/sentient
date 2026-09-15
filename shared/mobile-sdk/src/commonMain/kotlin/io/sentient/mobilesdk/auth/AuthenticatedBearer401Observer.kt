package io.sentient.mobilesdk.auth

import io.ktor.client.HttpClientConfig
import io.ktor.client.plugins.HttpResponseValidator
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.util.AttributeKey

private val DomainUnauthorized = AttributeKey<Unit>("sentient.domain-unauthorized")

/** Marks a request whose 401 is a domain result, not expired bearer credentials. */
internal fun HttpRequestBuilder.domainUnauthorized() {
    attributes.put(DomainUnauthorized, Unit)
}

/** Observes credential failures from an authenticated, session-owned Ktor client. */
internal fun HttpClientConfig<*>.installAuthenticatedBearer401Observer(
    currentToken: () -> String,
    isOwnerActive: () -> Boolean = { true },
    onAuthenticationRequired: () -> Unit,
) {
    HttpResponseValidator {
        validateResponse { response ->
            if (response.status != HttpStatusCode.Unauthorized ||
                response.call.request.attributes.contains(DomainUnauthorized)
            ) return@validateResponse

            val token = currentToken()
            if (token.isNotEmpty() &&
                response.call.request.headers[HttpHeaders.Authorization] == "Bearer $token" &&
                isOwnerActive()
            ) {
                onAuthenticationRequired()
            }
        }
    }
}
