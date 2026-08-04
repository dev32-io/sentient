package io.sentient.android.backend

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class BackendConfigTest {
    @Test fun `wss path contract for valid-cert`() {
        val c = BackendConfig("host.example", 443, ConnectionSecurity.TLS_VALID)
        assertEquals("wss://host.example:443/api/v1/ws", c.toGatewayWsUrl())
        assertEquals(false, c.allowSelfSigned())
    }
    @Test fun `trust-self-signed maps to allowSelfSigned true on wss`() {
        val c = BackendConfig("192.168.0.5", 443, ConnectionSecurity.TLS_TRUST_SELF_SIGNED)
        assertEquals("wss://192.168.0.5:443/api/v1/ws", c.toGatewayWsUrl())
        assertEquals(true, c.allowSelfSigned())
    }
    @Test fun `plain ws uses ws scheme and does not trust self-signed`() {
        val c = BackendConfig("10.0.0.2", 443, ConnectionSecurity.PLAIN_WS)
        assertEquals("ws://10.0.0.2:443/api/v1/ws", c.toGatewayWsUrl())
        assertEquals(false, c.allowSelfSigned())
    }
    @Test fun `override wins over build-time default`() {
        val override = BackendConfig("ov", 1, ConnectionSecurity.TLS_VALID)
        val r = resolveBackend(override, "wss://built:8888/api/v1/ws", true)
        assertTrue(r is ResolvedBackend.Configured)
        assertEquals("wss://ov:1/api/v1/ws", (r as ResolvedBackend.Configured).gatewayWsUrl)
    }
    @Test fun `build-time default used when no override`() {
        val r = resolveBackend(null, "wss://built:8888/api/v1/ws", true)
        assertEquals(ResolvedBackend.Configured("wss://built:8888/api/v1/ws", true), r)
    }
    @Test fun `empty build-time default and no override is Unconfigured`() {
        assertEquals(ResolvedBackend.Unconfigured, resolveBackend(null, "", false))
    }
}
