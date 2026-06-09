package io.sentient.mobilesdk.auth

import kotlin.test.Test
import kotlin.test.assertEquals

/** Pure-function tests for [deriveBaseUrl]. */
class DeriveBaseUrlTest {

    @Test
    fun deriveBaseUrl_wssToHttps() {
        assertEquals("https://gateway.local:3000/api/v1", deriveBaseUrl("wss://gateway.local:3000/api/v1/ws"))
    }

    @Test
    fun deriveBaseUrl_wsToHttp() {
        assertEquals("http://localhost:3000/api/v1", deriveBaseUrl("ws://localhost:3000/api/v1/ws"))
    }

    @Test
    fun deriveBaseUrl_noPort() {
        assertEquals("https://host/api/v1", deriveBaseUrl("wss://host/api/v1/ws"))
    }
}
