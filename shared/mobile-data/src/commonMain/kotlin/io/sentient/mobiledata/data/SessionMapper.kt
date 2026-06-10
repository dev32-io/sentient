package io.sentient.mobiledata.data

import io.sentient.mobiledata.cache.db.Session

/**
 * Maps between the persisted [Session] row and the domain [SessionSummary].
 *
 * The `session` table mirrors exactly the three fields the session list renders:
 * id, title, and the last-updated timestamp (DESC-ordered for the drawer). Nothing
 * else from the SDK's SessionRow (rootId / startedAt / messageCount / isActive) is
 * persisted — those are live-render concerns the VM reconstructs, not cache state.
 */
internal fun Session.toSummary(): SessionSummary = SessionSummary(
    id = id,
    title = title,
    updatedAtMs = updated_at,
)
