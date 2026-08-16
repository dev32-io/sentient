// ---------------------------------------------------------------------------
// ToolsViewModelLogicTest — pins the SECURITY-CRITICAL invariant ToolsViewModel.kt's
// header documents for the server MASTER Switch: turning a server "on" must be a
// CLEAR (null), never a concrete ALLOW, which would silently escalate a
// confirm-tier tool's role-template ASK to auto-approved. A regression here
// previously shipped with zero test coverage (the ViewModel hand-rolled
// ToolPermission.ALLOW inline instead of calling the shared
// withServerMasterPermission helper) — this test exercises the exact
// ViewModel-level wiring (isGroupOn / groupToggleWrite) that decides which
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
//
// It ALSO pins the master control's READBACK, which the original suite did not: it
// asserted which values groupToggleWrite produces but never that isGroupOn reads
// them back. A wildcard-blind isGroupOn therefore passed every test here while
// leaving an all-off server's Switch permanently unchecked — a state the user could
// not get out of, because every tap recomputed the same "turn on" direction. Write
// and readback are pinned together for that reason; either alone is satisfied by a
// broken pair.
// ---------------------------------------------------------------------------
package io.sentient.android.settings.tools

import io.sentient.mobilesdk.settings.ImpactTier
import io.sentient.mobilesdk.settings.ProductToolGroupView
import io.sentient.mobilesdk.settings.McpCatalogView
import io.sentient.mobilesdk.settings.McpToolView
import io.sentient.mobilesdk.settings.ToolDispatchKind
import io.sentient.mobilesdk.settings.ToolDispatchView
import io.sentient.mobilesdk.settings.ToolPermission
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

private fun tool(
    name: String,
    permission: ToolPermission,
    dispatch: ToolDispatchKind = ToolDispatchKind.NATIVE,
): McpToolView = McpToolView(
    name = name,
    description = "",
    tier = ImpactTier.READ,
    permission = permission,
    settable = true,
    dispatch = ToolDispatchView(dispatch),
)

private fun catalog(
    vararg tools: McpToolView,
    wildcardKey: String = "*",
    wildcard: ToolPermission? = null,
): McpCatalogView = McpCatalogView(
    groups = mapOf("household" to ProductToolGroupView(tools = tools.toList(), wildcardPermission = wildcard)),
    wildcardPermissionKey = wildcardKey,
)

class ToolsViewModelLogicTest {

    // ── isGroupOn — reads the WILDCARD, which is what the master control writes ──

    @Test
    fun `isGroupOn is false when the stored wildcard is off`() {
        val cat = catalog(tool("look_up", ToolPermission.OFF), wildcard = ToolPermission.OFF)
        assertFalse(isGroupOn(emptyMap(), cat, "household"))
    }

    @Test
    fun `isGroupOn is true when no wildcard has ever been stored`() {
        val cat = catalog(tool("look_up", ToolPermission.ASK), wildcard = null)
        assertEquals(true, isGroupOn(emptyMap(), cat, "household"))
    }

    @Test
    fun `isGroupOn reads a pending wildcard edit over the catalog snapshot`() {
        val cat = catalog(tool("look_up", ToolPermission.ALLOW), wildcard = null)
        val pending = mapOf("household" to mapOf("*" to ToolPermission.OFF))
        assertFalse(isGroupOn(pending, cat, "household"))
    }

    // ── The readback the master Switch actually renders ──
    //
    // A server whose tools ALL resolve OFF is the case that used to be unleavable: the
    // master's "on" write is a set of `null` CLEARS, and reading it back through
    // `effectiveToolPermission`'s `?:` resurrected the OFF catalog snapshot, so the Switch
    // stayed unchecked and every further tap recomputed `turnOn = true` again. These two
    // tests are the readback the old suite never asserted — it pinned the WRITE only.

    @Test
    fun `an all-off server reads back on after the master toggle writes its clears`() {
        val cat = catalog(
            tool("look_up", ToolPermission.OFF),
            tool("unlock_door", ToolPermission.OFF),
            wildcard = ToolPermission.OFF,
        )
        val afterTurnOn = groupToggleWrite(emptyMap(), cat, "household")
        assertEquals(true, isGroupOn(afterTurnOn, cat, "household"), "the Switch must show the state it just wrote")
    }

    @Test
    fun `a second tap on an all-off server turns it back off rather than repeating turn-on`() {
        val cat = catalog(
            tool("look_up", ToolPermission.OFF),
            tool("unlock_door", ToolPermission.OFF),
            wildcard = ToolPermission.OFF,
        )
        val afterTurnOn = groupToggleWrite(emptyMap(), cat, "household")
        val afterSecondTap = groupToggleWrite(afterTurnOn, cat, "household")
        assertEquals(ToolPermission.OFF, afterSecondTap["household"]?.get("*"))
        assertEquals(ToolPermission.OFF, afterSecondTap["household"]?.get("look_up"))
        assertFalse(isGroupOn(afterSecondTap, cat, "household"))
    }

    // ── activeToolCount — the header's "n/total tools", a per-tool tally ──

    @Test
    fun `activeToolCount counts every tool that does not resolve off`() {
        val cat = catalog(
            tool("look_up", ToolPermission.ALLOW),
            tool("unlock_door", ToolPermission.ASK),
            tool("wipe", ToolPermission.OFF),
        )
        val entry = cat.groups.getValue("household")
        assertEquals(2, activeToolCount(emptyMap(), "household", entry))
    }

    @Test
    fun `activeToolCount uses one group projection for mixed dispatch kinds`() {
        val cat = catalog(
            tool("native_lookup", ToolPermission.ALLOW, ToolDispatchKind.NATIVE),
            tool("mcp_lookup", ToolPermission.ASK, ToolDispatchKind.MCP),
            wildcard = null,
        )
        assertEquals(2, activeToolCount(emptyMap(), "household", cat.groups.getValue("household")))
    }

    @Test
    fun `activeToolCount reads a pending per-tool edit over the catalog snapshot`() {
        val cat = catalog(tool("look_up", ToolPermission.ALLOW), tool("unlock_door", ToolPermission.ALLOW))
        val entry = cat.groups.getValue("household")
        val pending = mapOf("household" to mapOf("look_up" to ToolPermission.OFF))
        assertEquals(1, activeToolCount(pending, "household", entry))
    }

    // ── groupToggleWrite: the security-critical direction ──

    @Test
    fun `server toggle off-to-on clears every tool and the wildcard never a concrete allow`() {
        val cat = catalog(
            tool("look_up", ToolPermission.OFF),
            tool("unlock_door", ToolPermission.OFF),
            wildcard = ToolPermission.OFF,
        )
        val write = groupToggleWrite(emptyMap(), cat, "household")
        val server = write["household"]
        assertNull(server?.get("look_up"))
        assertNull(server?.get("unlock_door"))
        assertNull(server?.get("*"))
        assertFalse(server.orEmpty().values.contains(ToolPermission.ALLOW), "must never write a blanket ALLOW: $server")
    }

    @Test
    fun `server toggle on-to-off writes an explicit OFF everywhere`() {
        val cat = catalog(tool("look_up", ToolPermission.ASK), tool("unlock_door", ToolPermission.OFF))
        val write = groupToggleWrite(emptyMap(), cat, "household")
        val server = write["household"]
        assertEquals(ToolPermission.OFF, server?.get("look_up"))
        assertEquals(ToolPermission.OFF, server?.get("unlock_door"))
        assertEquals(ToolPermission.OFF, server?.get("*"))
    }

    @Test
    fun `server toggle uses the catalog's own wildcard key never a hardcoded literal`() {
        val cat = catalog(tool("look_up", ToolPermission.OFF), wildcardKey = "ALL")
        val write = groupToggleWrite(emptyMap(), cat, "household")
        assertEquals(setOf("look_up", "ALL"), write["household"]?.keys)
    }
}
