package io.sentient.mobilesdk.auth

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.sentient.mobilesdk.log.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs

private const val CURRENT_CREDENTIAL = "current-credential"
private const val OLD_CREDENTIAL = "old-credential"

class AuthenticatedBearer401ObserverTest {
    @Test
    fun currentBearer401Signals() = runTest {
        var signals = 0
        val client = client(
            status = HttpStatusCode.Unauthorized,
            currentToken = { CURRENT_CREDENTIAL },
            onAuthenticationRequired = { signals++ },
        )

        client.get("https://example.invalid/protected") {
            header(HttpHeaders.Authorization, "Bearer $CURRENT_CREDENTIAL")
        }

        assertEquals(1, signals)
    }

    @Test
    fun staleBearer401AfterRotationIsIgnored() = runTest {
        var current = OLD_CREDENTIAL
        var signals = 0
        val received = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val engine = MockEngine {
            received.complete(Unit)
            release.await()
            respond("", HttpStatusCode.Unauthorized)
        }
        val client = HttpClient(engine) {
            installAuthenticatedBearer401Observer({ current }) { signals++ }
        }

        val request = async {
            client.get("https://example.invalid/protected") {
                header(HttpHeaders.Authorization, "Bearer $OLD_CREDENTIAL")
            }
        }
        received.await()
        current = CURRENT_CREDENTIAL
        release.complete(Unit)
        request.await()

        assertEquals(0, signals)
    }

    @Test
    fun domainAndUnauthenticated401sAreIgnored() = runTest {
        var signals = 0
        val engine = MockEngine { respond("{}", HttpStatusCode.Unauthorized) }
        val http = HttpClient(engine) {
            install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
            installAuthenticatedBearer401Observer({ CURRENT_CREDENTIAL }) { signals++ }
        }
        val auth = AuthClient("wss://example.invalid/api/v1/ws", http, noOpObserverLog)

        val pinResult = auth.changePin(CURRENT_CREDENTIAL, "wrong", "replacement")
        val loginResult = auth.login("user", "wrong")

        assertIs<AuthResult.Failure>(pinResult)
        assertIs<AuthError.InvalidCredentials>(pinResult.error)
        assertIs<AuthResult.Failure>(loginResult)
        assertEquals(0, signals)
    }

    @Test
    fun non401ResponsesAreIgnored() = runTest {
        var signals = 0
        for (status in listOf(HttpStatusCode.Forbidden, HttpStatusCode.NotFound, HttpStatusCode.InternalServerError)) {
            val client = client(status, { CURRENT_CREDENTIAL }) { signals++ }
            client.get("https://example.invalid/protected") {
                header(HttpHeaders.Authorization, "Bearer $CURRENT_CREDENTIAL")
            }
        }
        assertEquals(0, signals)
    }

    @Test
    fun networkFailureIsIgnored() = runTest {
        var signals = 0
        val client = HttpClient(MockEngine { throw IllegalStateException("offline") }) {
            installAuthenticatedBearer401Observer({ CURRENT_CREDENTIAL }) { signals++ }
        }

        assertFailsWith<IllegalStateException> { client.get("https://example.invalid/protected") }
        assertEquals(0, signals)
    }

    @Test
    fun closedOwner401IsIgnored() = runTest {
        var signals = 0
        val client = HttpClient(MockEngine { respond("", HttpStatusCode.Unauthorized) }) {
            installAuthenticatedBearer401Observer(
                currentToken = { CURRENT_CREDENTIAL },
                isOwnerActive = { false },
                onAuthenticationRequired = { signals++ },
            )
        }

        client.get("https://example.invalid/protected") {
            header(HttpHeaders.Authorization, "Bearer $CURRENT_CREDENTIAL")
        }

        assertEquals(0, signals)
    }

    @Test
    fun authClientRethrowsCancellation() = runTest {
        val auth = AuthClient(
            "wss://example.invalid/api/v1/ws",
            HttpClient(MockEngine { throw CancellationException("cancelled") }),
            noOpObserverLog,
        )

        assertFailsWith<CancellationException> { auth.me(CURRENT_CREDENTIAL) }
    }

    private fun client(
        status: HttpStatusCode,
        currentToken: () -> String,
        onAuthenticationRequired: () -> Unit,
    ): HttpClient = HttpClient(MockEngine { respond("", status) }) {
        installAuthenticatedBearer401Observer(currentToken, onAuthenticationRequired = onAuthenticationRequired)
    }
}

private val noOpObserverLog = object : Log {
    override fun debug(message: String, props: Map<String, Any?>) = Unit
    override fun info(message: String, props: Map<String, Any?>) = Unit
    override fun warn(message: String, props: Map<String, Any?>) = Unit
    override fun error(message: String, props: Map<String, Any?>) = Unit
}
