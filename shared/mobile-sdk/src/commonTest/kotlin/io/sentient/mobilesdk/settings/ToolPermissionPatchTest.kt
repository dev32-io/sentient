// ---------------------------------------------------------------------------
// ToolPermissionPatchTest — ports gateway/webui's tool-permission-patch.test.ts
// case-for-case. Pins the exact wildcard/named-key merge semantics a settings
// screen depends on; two of these (blanket-allow privilege escalation,
// wildcard-only no-op) were shipped-and-caught-in-review bugs on web — this
// test is what stops them shipping again on mobile.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

private fun tool(
    name: String = "look_up",
    permission: ToolPermission = ToolPermission.ALLOW,
    tier: ImpactTier = ImpactTier.READ,
    settable: Boolean = true,
): McpToolView = McpToolView(
    name = name,
    description = "Look something up.",
    tier = tier,
    permission = permission,
    settable = settable,
)

class WithToolPermissionTest {
    @Test
    fun `sets the target server tool key without touching other servers`() {
        val before = mapOf("household" to mapOf("unlock_door" to ToolPermission.ASK), "search" to mapOf("web_search" to ToolPermission.DENY))
        val after = withToolPermission(before, "household", "look_up", ToolPermission.OFF)
        assertEquals(mapOf("web_search" to ToolPermission.DENY), after["search"])
    }

    @Test
    fun `keeps other tool keys already set under the same server`() {
        val before = mapOf("household" to mapOf("unlock_door" to ToolPermission.ASK, "look_up" to ToolPermission.ALLOW))
        val after = withToolPermission(before, "household", "look_up", ToolPermission.OFF)
        assertEquals(mapOf("unlock_door" to ToolPermission.ASK, "look_up" to ToolPermission.OFF), after["household"])
    }

    @Test
    fun `never drops a previously-set wildcard entry when writing a named tool`() {
        val before = mapOf("household" to mapOf("*" to ToolPermission.OFF))
        val after = withToolPermission(before, "household", "look_up", ToolPermission.ALLOW)
        assertEquals(mapOf("*" to ToolPermission.OFF, "look_up" to ToolPermission.ALLOW), after["household"])
    }

    @Test
    fun `builds a minimal map from null rather than seeding every server`() {
        val after = withToolPermission(null, "household", "look_up", ToolPermission.DENY)
        assertEquals(mapOf("household" to mapOf("look_up" to ToolPermission.DENY)), after)
    }

    @Test
    fun `writes the wildcard key itself for a server master-control write`() {
        val before = mapOf("household" to mapOf("unlock_door" to ToolPermission.ASK))
        val after = withToolPermission(before, "household", "*", ToolPermission.OFF)
        assertEquals(mapOf("unlock_door" to ToolPermission.ASK, "*" to ToolPermission.OFF), after["household"])
    }

    @Test
    fun `returns a new map rather than mutating the input`() {
        val before = mapOf("household" to mapOf("look_up" to ToolPermission.ALLOW))
        val after = withToolPermission(before, "household", "look_up", ToolPermission.OFF)
        assertEquals(ToolPermission.ALLOW, before["household"]?.get("look_up"))
        assertEquals(ToolPermission.OFF, after["household"]?.get("look_up"))
    }

    @Test
    fun `writes an explicit null to clear a key keeping the server key and its siblings`() {
        val before: ToolPermissionPatchMap = mapOf("household" to mapOf("*" to ToolPermission.OFF, "unlock_door" to ToolPermission.ASK))
        val after = withToolPermission(before, "household", "*", null)
        assertEquals(mapOf("*" to null, "unlock_door" to ToolPermission.ASK), after["household"])
    }
}

// The exact PUT-body-shaped patch the master control produces, pinned directly.
class WithServerMasterPermissionTest {
    @Test
    fun `off writes an explicit off for every named tool plus the wildcard`() {
        val after = withServerMasterPermission(null, "household", listOf("look_up", "unlock_door"), "*", turnOn = false)
        assertEquals(
            mapOf("look_up" to ToolPermission.OFF, "unlock_door" to ToolPermission.OFF, "*" to ToolPermission.OFF),
            after["household"],
        )
    }

    @Test
    fun `on clears every named tool plus the wildcard never writes a blanket value`() {
        val after = withServerMasterPermission(null, "household", listOf("look_up", "unlock_door"), "*", turnOn = true)
        assertEquals(mapOf("look_up" to null, "unlock_door" to null, "*" to null), after["household"])
    }

    @Test
    fun `handles an empty tool list by writing only the wildcard`() {
        val after = withServerMasterPermission(null, "household", emptyList(), "*", turnOn = false)
        assertEquals(mapOf("*" to ToolPermission.OFF), after["household"])
    }

    @Test
    fun `preserves other servers and other keys on the same server not in the tool list`() {
        val before: ToolPermissionPatchMap =
            mapOf("household" to mapOf("orphaned_tool" to ToolPermission.DENY), "search" to mapOf("web_search" to ToolPermission.ASK))
        val after = withServerMasterPermission(before, "household", listOf("look_up"), "*", turnOn = false)
        assertEquals(mapOf("web_search" to ToolPermission.ASK), after["search"])
        assertEquals(
            mapOf("orphaned_tool" to ToolPermission.DENY, "look_up" to ToolPermission.OFF, "*" to ToolPermission.OFF),
            after["household"],
        )
    }

    @Test
    fun `overwrites a tool's own prior value the whole point of a bulk write`() {
        val before: ToolPermissionPatchMap = mapOf("household" to mapOf("look_up" to ToolPermission.ASK))
        val after = withServerMasterPermission(before, "household", listOf("look_up"), "*", turnOn = true)
        assertNull(after["household"]?.get("look_up"))
    }
}

class EffectiveToolPermissionTest {
    @Test
    fun `prefers the person's own stored or pending value over the catalog's`() {
        val permissions: ToolPermissionPatchMap = mapOf("household" to mapOf("look_up" to ToolPermission.OFF))
        assertEquals(ToolPermission.OFF, effectiveToolPermission(permissions, "household", tool(permission = ToolPermission.ALLOW)))
    }

    @Test
    fun `falls back to the catalog's resolved value when this tool has no override`() {
        val permissions: ToolPermissionPatchMap = mapOf("household" to mapOf("unlock_door" to ToolPermission.ASK))
        assertEquals(
            ToolPermission.ALLOW,
            effectiveToolPermission(permissions, "household", tool(name = "look_up", permission = ToolPermission.ALLOW)),
        )
    }

    @Test
    fun `falls back to the catalog value when no permissions map exists at all`() {
        assertEquals(ToolPermission.ASK, effectiveToolPermission(null, "household", tool(permission = ToolPermission.ASK)))
    }
}

class EffectiveWildcardPermissionTest {
    @Test
    fun `prefers a pending or stored wildcard write over the catalog snapshot`() {
        val permissions: ToolPermissionPatchMap = mapOf("household" to mapOf("*" to ToolPermission.OFF))
        assertEquals(ToolPermission.OFF, effectiveWildcardPermission(permissions, "household", "*", ToolPermission.ALLOW))
    }

    @Test
    fun `falls back to the catalog's wildcard snapshot when unset locally`() {
        assertEquals(ToolPermission.DENY, effectiveWildcardPermission(null, "household", "*", ToolPermission.DENY))
    }

    @Test
    fun `is null when neither the draft nor the catalog has a wildcard set`() {
        assertNull(effectiveWildcardPermission(null, "household", "*", null))
    }

    // The regression this control exists to prevent: a pending CLEAR (null) must read as
    // "cleared", never silently fall back to a stale catalog snapshot.
    @Test
    fun `reads an explicit pending null as cleared not as fall back to the catalog snapshot`() {
        val permissions: ToolPermissionPatchMap = mapOf("household" to mapOf("*" to null))
        assertNull(effectiveWildcardPermission(permissions, "household", "*", ToolPermission.OFF))
    }
}
