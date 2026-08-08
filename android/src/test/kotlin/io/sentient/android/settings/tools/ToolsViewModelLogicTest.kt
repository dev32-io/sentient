// ---------------------------------------------------------------------------
// ToolsViewModelLogicTest — pins the SECURITY-CRITICAL invariant ToolsViewModel.kt's
// header documents for the server MASTER Switch: turning a server "on" must be a
// CLEAR (null), never a concrete ALLOW, which would silently escalate a
// confirm-tier tool's role-template ASK to auto-approved. A regression here
// previously shipped with zero test coverage (the ViewModel hand-rolled
// ToolPermission.ALLOW inline instead of calling the shared
// withServerMasterPermission helper) — this test exercises the exact
// ViewModel-level wiring (isServerOn / serverToggleWrite) that decides which
// direction the master Switch writes and which catalog-derived tool names +
// wildcard key it writes them for, independent of the ViewModel/SettingsComponent
// (which isn't unit-testable without a real HttpClient — see android-testing.md
// Layer 1).
//
// The per-TOOL write (task 9's four-state RowSelect dropdown) has no equivalent
// ViewModel-level glue to pin: ToolsViewModel.setToolPermission is a direct,
// one-line call to the shared withToolPermission helper with values the dropdown
// already supplies verbatim (serverId, toolName, one of the four concrete
// ToolPermission values) — no catalog lookup, no derived state, nothing this
// layer could get wrong that shared/mobile-sdk's own ToolPermissionPatchTest.kt
// (WithToolPermissionTest) doesn't already pin. The task-7 interim's
// `toolToggleWrite` — a boolean flip that cleared (null) on the way "on" — was
// removed along with the per-tool Switch it backed; a per-tool control never
// clears in the four-state model (only the bulk master write does), so keeping
// that function or its tests around would pin dead code and describe a write
// path the dropdown must never take.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.tools

import io.sentient.mobilesdk.settings.ImpactTier
import io.sentient.mobilesdk.settings.McpCatalogEntry
import io.sentient.mobilesdk.settings.McpCatalogView
import io.sentient.mobilesdk.settings.McpToolView
import io.sentient.mobilesdk.settings.ToolPermission
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

private fun tool(name: String, permission: ToolPermission): McpToolView =
    McpToolView(name = name, description = "", tier = ImpactTier.READ, permission = permission, settable = true)

private fun catalog(vararg tools: McpToolView, wildcardKey: String = "*"): McpCatalogView = McpCatalogView(
    servers = mapOf("household" to McpCatalogEntry(tools = tools.toList())),
    wildcardPermissionKey = wildcardKey,
)

class ToolsViewModelLogicTest {

    // ── isServerOn ──

    @Test
    fun `isServerOn is false when every catalog tool resolves off`() {
        val cat = catalog(tool("look_up", ToolPermission.OFF), tool("unlock_door", ToolPermission.OFF))
        assertFalse(isServerOn(emptyMap(), cat, "household"))
    }

    @Test
    fun `isServerOn is true when any catalog tool resolves on`() {
        val cat = catalog(tool("look_up", ToolPermission.OFF), tool("unlock_door", ToolPermission.ASK))
        assertEquals(true, isServerOn(emptyMap(), cat, "household"))
    }

    @Test
    fun `isServerOn reads pending edits over the catalog snapshot`() {
        val cat = catalog(tool("look_up", ToolPermission.ALLOW))
        val pending = mapOf("household" to mapOf("look_up" to ToolPermission.OFF))
        assertFalse(isServerOn(pending, cat, "household"))
    }

    // ── serverToggleWrite: the security-critical direction ──

    @Test
    fun `server toggle off-to-on clears every tool and the wildcard never a concrete allow`() {
        val cat = catalog(tool("look_up", ToolPermission.OFF), tool("unlock_door", ToolPermission.OFF))
        val write = serverToggleWrite(emptyMap(), cat, "household")
        val server = write["household"]
        assertNull(server?.get("look_up"))
        assertNull(server?.get("unlock_door"))
        assertNull(server?.get("*"))
        assertFalse(server.orEmpty().values.contains(ToolPermission.ALLOW), "must never write a blanket ALLOW: $server")
    }

    @Test
    fun `server toggle on-to-off writes an explicit OFF everywhere`() {
        val cat = catalog(tool("look_up", ToolPermission.ASK), tool("unlock_door", ToolPermission.OFF))
        val write = serverToggleWrite(emptyMap(), cat, "household")
        val server = write["household"]
        assertEquals(ToolPermission.OFF, server?.get("look_up"))
        assertEquals(ToolPermission.OFF, server?.get("unlock_door"))
        assertEquals(ToolPermission.OFF, server?.get("*"))
    }

    @Test
    fun `server toggle uses the catalog's own wildcard key never a hardcoded literal`() {
        val cat = catalog(tool("look_up", ToolPermission.OFF), wildcardKey = "ALL")
        val write = serverToggleWrite(emptyMap(), cat, "household")
        assertEquals(setOf("look_up", "ALL"), write["household"]?.keys)
    }
}
