// ---------------------------------------------------------------------------
// ImpactTier — which impact tiers a role may ever reach. Mirrors gateway/
// shared/protocol's impactTierSchema (roles.ts) EXACTLY. A REAL Kotlin enum
// for the same reason ToolPermission is one — see that file's header.
// ---------------------------------------------------------------------------
package io.sentient.mobilesdk.settings

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Ordered least- to most-privileged; nothing in this module depends on the
 *  order for a decision (the role gate already ran server-side — see
 *  [McpCatalogView]'s doc comment), it only makes the list readable. */
@Serializable
enum class ImpactTier {
    @SerialName("read") READ,
    @SerialName("write") WRITE,
    @SerialName("confirm") CONFIRM,
    @SerialName("admin") ADMIN,
}
