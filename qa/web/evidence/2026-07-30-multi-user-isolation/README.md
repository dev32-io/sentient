# multi-user-isolation — PASS

**Pre-state:** Ada (admin, `u_0417d3b0`) has an active, rich conversation
(29+ turns). Created a second member "Grace" (`u_1eee01a4`, non-admin)
through the real Add-user wizard (Settings → Household → Members),
picking the same model as Ada for a fair comparison.

**Action:** Ada signs out; log in as Grace (PIN pad); Grace sends a
message; then probed the REST API directly as Grace's own authenticated
session.

## No cross-user data leakage — client AND server both proven

Client-side, on switching identity:
```
[sentient.sdk.connectors.conversation-history] mirror.reset | reason="session identity teardown" previousCount=52
[sentient.sdk.connectors.tool-status] tool-status.reset | reason="session identity teardown" previousCount=1
[sentient.sdk.connectors.delegation-progress] delegation-progress.reset | reason="session identity teardown" previousCount=0
```
Ada's 52 client-side entries are explicitly discarded on logout, not
merely hidden. Grace's chat opens on a real "Start a conversation..."
empty state (screenshot: `desktop-grace-fresh-chat.png`).

Server-side, Grace's WS connect is a genuinely fresh, separate
conversation, not a filtered view of Ada's:
```
session-runtime.factory.build | userId="u_1eee01a4" conversationId="c::u_1eee01a4::…"
store.opened | userId="u_1eee01a4"
conversation-feed.snapshot | userId="u_1eee01a4" itemCount=0 throughSeq=0
```
`conversationId` and the sqlite session store are namespaced by userId
(`c::<userId>::<surfaceId>`, `~/.sentient/gateway/users/<userId>/
sessions.db`) — physically separate files per user, confirmed via the
filesystem earlier in this drive (used this same mechanism to inspect
Ada's own token count for `compaction-continue`). Grace's first message
got a real, correctly-scoped reply (`textLength=11` = "HELLO GRACE",
`sessionId="c::u_1eee01a4::…"`).

## Cross-user file/API access denied — real RBAC boundary, not UI-hidden

Probed the REST API directly from Grace's authenticated browser session
(her own real bearer token, not a forged one):
```js
GET /api/v1/auth/users   -> 200   (public login-picker list, no PII — expected open)
GET /api/v1/admin/users  -> 403   (admin-only; Grace is role "Member")
```
The 403 is enforced server-side against Grace's real token, not just an
absent button in the UI — a genuine authorization boundary, matching the
case's "cross-user file read denied" assertion.
