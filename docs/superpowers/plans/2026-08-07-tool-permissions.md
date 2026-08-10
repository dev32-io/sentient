# Per-Tool Permissions Implementation Plan (rev 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two layers, both owned by the gateway. A **role gate** derived from the caller's capability decides which tools exist for that person at all; within that, a **per-tool permission** — `Allow | Ask | Deny | Off` — decides what happens when the model calls one. No third authority.

**Architecture:** `AccessManager` mints a `tool-broker` capability carrying the caller's role, so the broker holds authority by value rather than reading an ambient principal (spec L0→L1→L2). Every tool declares an impact tier in `config.yaml#mcp_catalog`. `definitions()` — the sole producer of the model's `tools[]` — drops a tool when the role cannot execute its tier, and drops it again when the person set it `Off`; the two produce the same outcome for the same reason (the model must not see, or spend context on, something it can never use). `resolveDecision()` reads the remaining three states. There is no runtime fallthrough: every profile carries a fully seeded permission table, seeded per role at account creation.

**What this rev changes and why.** Rev 1 modelled `mcp-policy.yaml` as a second authority above the user, and built `absent = inherit` so the broker could fall through to it. That was 1.0 framing. Of its 37 rules, 22 `allow` + 13 `confirm` are simply a *default per-tool permission template* written in a second place and re-evaluated every dispatch; 2 of the 3 `deny` rules are role restrictions; 1 is a per-session constraint that is not a permission at all. So the rule engine retires into the default template plus the role gate, and `absent = inherit` — the source of two of rev 1's review findings, including a fail-open — stops existing.

**Tech Stack:** Bun + TypeScript (gateway), zod (`shared/config`, `shared/protocol`), Preact (webui), Kotlin Multiplatform, SwiftUI, Compose.

## Global Constraints

- Branch `feature/native-orchestrator`. Never push to `main` or `develop`.
- `source scripts/env.sh` before ANY shell command.
- Gateway: `cd gateway/src && bun test` (Bun's runner, NOT vitest). Repo: `bun run ci`. Kotlin: `./gradlew :shared:mobile-sdk:allTests :shared:mobile-data:allTests :android:testDebugUnitTest`. iOS: `xcodebuild -project ios/SentientApp.xcodeproj -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16,OS=18.3.1' **test**` — `test`, NOT `build`; `build` does not compile `SentientAppTests`.
- **Exhaustive switches over `ToolPermission` and `ImpactTier`** — no `default:`/`else ->` arm. A future `Auto` (classifier) or a new tier must break compilation at every site.
- Reuse the existing dropdown: web `Select`, iOS `RowSelect`, Android `RowSelect`.
- Tunables and catalogs live in YAML, never hardcoded in TS.
- Tagged logger; no bare `console.*`; never log user content.
- **E2E prompts are READ-ONLY.** Never actuate a device. The stack talks to the operator's real home and smoke runs at any hour.
- Commit `type(scope): description` + `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## Rework carried from rev 1

P1 (`75d016d4`) and P2 (`c6babf9c`, `62e559dc`, `e03c78b1`) are committed and green. This rev keeps their machinery and changes their semantics:

- **Keep:** `ToolPermission`, `profile.tools.permissions`, the two choke points, the cache-stability invariant, the fail-closed reader, `.optional()`, `ALL_TOOLS_PERMISSION_KEY`.
- **Change:** `absent = inherit` becomes `absent = a bug we seeded around`. Tasks 3 and 4 remove the fallthrough.
- **Delete:** `gateway/mcp-policy.yaml`, `gateway/src/security/policy-engine.ts`, `policy-loader.ts`, and `resolveDecision`'s `policy.evaluate` call.

A constraint recorded during rev 1 and still binding on Tasks 6–9: **all three clients turn a server off by DELETING its key** (`tools-pane.tsx`, `ToolsViewModel.kt:92-98`, `ToolsViewModel.swift:89-97`). They must instead write explicit values and must never send `tools.enabled`. Once they do, the server-level absence rule in `permissionFor` becomes vestigial and Task 4 deletes it.

---

### Task 1: Every tool declares an impact tier

**Files:** `shared/config/src/schemas/mcp-catalog.ts` (`mcpToolDescriptorSchema`), `gateway/config.yaml#mcp_catalog`, `gateway/src/tools/tool-types.ts` (`ToolDefinition`), `gateway/src/tools/mcp-client.ts` (carry it onto the definition), plus the background-tool definitions in `gateway/src/tools/delegate-task.ts`.

**Produces:** `ToolDefinition.tier: ImpactTier`, sourced from the catalog.

Reuse `ImpactTier` from `shared/protocol/src/roles.ts` — `read | write | confirm | admin`. It already exists and has no consumers; this is what it was scaffolded for.

Tier every tool currently in `config.yaml#mcp_catalog`. Derive the assignment from `mcp-policy.yaml` before deleting it: its 22 `allow` rules are `read`, its 13 `confirm` rules are `write` or `confirm` (read each rule's `reason` to decide which), `identify_user` and `pause_audio` need the tiers that make their existing role rules fall out of `canExecute` — that is the test of whether the tiering is right.

A tool with no tier in the catalog must fail loudly at config load, not default. An untiered tool is an operator mistake, and defaulting it either silently exposes it to a guest or silently hides it from an adult.

- [ ] Write the failing test: `canExecute("child", tierOf("pause_audio"))` is `false` and `canExecute("adult", …)` is `true`; same for `identify_user` and `guest`.
- [ ] Add `tier` to the descriptor schema (required), tier every catalog entry, thread it onto `ToolDefinition`.
- [ ] Make a missing tier a hard config-load failure with the tool's name in the message.
- [ ] `cd gateway/src && bun test` green; commit `feat(catalog): give every tool an impact tier`.

---

### Task 2: The capability carries the role

**Files:** `gateway/src/access/capability.ts`, `gateway/src/access/access-manager.ts`, `gateway/src/tools/tool-broker.ts` (read the role from the capability, not from `deps.principal`).

**Produces:** `Capability.role: UserRole` on a `tool-broker` capability.

The broker currently reads `principal.role` (`resolveDecision`'s `PolicyContext`). That is an ambient read at L3 of something that should have become authority at L1. Move it: `AccessManager` bakes the role in when it mints the capability, and the broker holds it by value.

- [ ] Write the failing test: a broker built from an `adult` capability and one built from a `child` capability disagree about the same tool, with no principal in sight.
- [ ] Add `role` to the capability, mint it in `AccessManager`, and have the broker read `capability.role`.
- [ ] Delete `ToolBrokerDeps.principal` if nothing else needs it — say in your report what else did.
- [ ] Commit `refactor(access): make a tool-broker capability carry its role`.

---

### Task 2b: The user record carries a role, and `admin` becomes one

**Why this exists.** Task 2 made the capability carry a role — but `ws-auth-gate.ts:35-41` hardcodes it: *"The user record doesn't carry role/householdId yet — default them here"*, `DEFAULT_PRINCIPAL_ROLE = "adult"`, with a `principal.role-model-not-implemented` WARN at boot. Every principal in the system is an adult, including the delegated path. Without this task, Tasks 3 and 4 gate on a constant and the whole role layer is architecturally correct and behaviourally inert.

The owner's ruling: **add `role` to the user record, default `adult`, and make `admin` a role rather than a boolean flag.**

**Files:** `shared/protocol/src/roles.ts`, `gateway/src/user-auth/types.ts`, `auth-service.ts`, `token-service.ts`, `gateway/src/admin/user-provisioner.ts`, `gateway/src/session-handlers/ws-auth-gate.ts`, `gateway/src/api/middleware/require-admin-auth.ts`, `gateway/src/api/handlers/{admin,auth,secrets}.ts`, `gateway/src/apply/router.ts`, `gateway/src/server.ts`, `gateway/src/api/handlers/sessions.ts`.

**The role vocabulary gains `admin`:**

```ts
export const USER_ROLES = ["admin", "adult", "child", "guest"] as const;

export const ROLE_PERMISSIONS: Record<UserRole, readonly ImpactTier[]> = {
  admin: ["read", "write", "confirm", "admin"],
  adult: ["read", "write", "confirm"],
  child: ["read", "write"],
  guest: ["read"],
} as const;
```

Note what this fixes: the `admin` IMPACT TIER — empty after Task 1 — now has exactly one role that can reach it. `config.yaml`'s `home_assistant` entry already defers *"admin tools (restart, backup, hacs, addon mgmt)"*; those land at tier `admin` and only the `admin` role executes them. The two vocabularies were always meant to meet here.

**`isAdmin` is replaced in STORAGE, kept on the WIRE.** `UserRecord.isAdmin: boolean` becomes `role: UserRole`. But `AuthUser.isAdmin` stays on the protocol, derived as `role === "admin"`, and `role` is added beside it. That keeps all three clients compiling and correct through the rest of this plan; they migrate to reading `role` in Tasks 6–9. Removing the derived field is a follow-up, not this task.

**Migration.** Existing records have `isAdmin: boolean` and no `role`. `true → "admin"`, `false → "adult"`. Same no-schema-bump `.preprocess` idiom the profile store uses for `voice.provider: "fish-audio"` and `tools.enabled`. A record that fails to migrate must not lock anyone out — that is the failure mode with the highest cost here.

**Token claims carry the role,** not `isAdmin`. `token-service.ts` issues it; `require-admin-auth.ts` checks `role === "admin"` instead of the boolean. **An old token issued before this task has no `role` claim** — decide whether it is rejected (forcing re-login) or migrated in-place, and say which and why. Rejecting is safer and this is a dev branch; silently defaulting a roleless token to `admin` would be a privilege escalation and is not an option.

- [ ] **Step 1: Write the failing tests.** A guest's capability cannot execute a `write`-tier tool while an adult's can (this is the first test in the codebase where the role is a real per-user value rather than a constant). A record stored with `isAdmin: true` loads as `role: "admin"`. An `admin`-tier tool is executable by `admin` and by nobody else. A token with no `role` claim is refused.
- [ ] **Step 2:** Extend `USER_ROLES` and `ROLE_PERMISSIONS`. Every exhaustive switch over `UserRole` in the tree must now break — fix each deliberately rather than adding a `default:`.
- [ ] **Step 3:** `UserRecord.role` with the migration; `createUser` takes a role, defaulting `adult`.
- [ ] **Step 4:** Token claims; `require-admin-auth` and every other `isAdmin` read in gateway source switch to the role. Keep `AuthUser.isAdmin` derived on the wire.
- [ ] **Step 5:** `ws-auth-gate.ts` reads the record's role instead of `DEFAULT_PRINCIPAL_ROLE`; delete the constant and the `principal.role-model-not-implemented` WARN. `sessions.ts:41`'s mirroring comment goes too.
- [ ] **Step 6:** Decide the delegated path. `DELEGATED_PRINCIPAL_ROLE` is currently a hardcoded `"adult"`; a delegated agent acts FOR its user, so it should now carry that user's real role. Verify the delegation cannot thereby gain more than the delegator has.
- [ ] **Step 7:** `cd gateway/src && bun test`, `bun run ci`. Commit `feat(auth): give every user a role, and make admin one of them`.

---

### Task 2c: A role change revokes the account's credentials

**Why this exists.** Task 2b's fix round made the token identify and never authorize: every REST authority decision now resolves the role from the user record at the moment of the decision, so a demoted admin loses the admin surface on its very next request. One surface did not converge — `ws-auth-gate.ts:113` mints the `UserPrincipal` at CONNECT and `ws.data.principal` holds it for the socket's whole life. A demoted admin with an open WebSocket keeps the old role until they reconnect.

The owner's ruling: **`UserPrincipal` stays minted-once with no rebind — and a role change immediately invalidates the account's outward token AND its in-flight principal, so the client is kicked to the login screen and re-login mints both anew.** A rebind would make the anchor mutable; a revocation destroys the whole authenticated context and rebuilds it from the record. Same end state, no mutable authority.

**Scope note found while planning: user DELETION has the identical hole.** `emitDeleted` (`user-provisioner.ts:237`) is wired only to `hostRef.removeUser` (`main.ts:236`); nothing closes the deleted account's sockets, so a deleted user keeps a working session until their token expires. It is the same seam and the same fix — wire it in this task rather than knowingly shipping the hole.

**Files:** `gateway/src/user-auth/{types.ts,user-record-migration.ts,user-store.ts,token-service.ts}`, create `gateway/src/user-auth/credential-floor.ts`; `gateway/src/admin/{user-lifecycle.ts,user-provisioner.ts}`; create `gateway/src/session-handlers/credential-revocation.ts`; `gateway/src/session-handlers/{session-registry.ts,credential-lifetime.ts}`; `gateway/src/auth/session-manager.ts`; `gateway/src/main.ts`.

**Interfaces produced:**

```ts
// user-auth/credential-floor.ts — the port token-service reads. Injected, so
// token-service stays a crypto unit with no user-store dependency.
export interface CredentialFloor {
  /** Epoch ms before which this user's tokens are dead. `null` = no such user. */
  validFromMsFor(userId: string): Promise<number | null>;
}

// admin/user-lifecycle.ts — gains the third event beside created/deleted.
onRoleChanged(listener: UserLifecycleListener): void;
emitRoleChanged(userId: string): Promise<void>;

// session-handlers/credential-revocation.ts
export interface CredentialRevoker {
  /** Close every live socket belonging to `userId` and drop its bound sessions. */
  revokeUser(userId: string, reason: RevocationReason): Promise<void>;
}
export type RevocationReason = "role-changed" | "user-deleted";
```

**Layer 1 — the token stops validating (authoritative).** `UserRecord` gains `credentialsValidFrom: string` (ISO-8601 UTC). `token-service.validate()` keeps its signature and, after the crypto check passes, compares the payload's `issuedAt` against the floor read from the record **at that moment**. This is one choke point covering all 17 `validate()` call sites — complete mediation, no route to forget.

Four things this task must get exactly right:

1. **The comparison is `issuedAt * 1000 <= floorMs` — refuse on the boundary.** `issuedAt` is unix seconds and the floor is a millisecond instant; a token minted in the same second as the revocation must lose. Fail closed on the tie.
2. **A missing record returns `null` and the token is refused.** Never a defaulted floor, never a permissive fallback. Log the two cases apart (`reason: "revoked"` vs `reason: "no-record"`); return the same error.
3. **The refusal reuses the existing `expired` `TokenError` — do NOT add a new code.** Recorded in the ledger from Task 2b: `expired` is already in mobile's `TERMINAL_AUTH_CODES` (`AuthErrorClass.kt:28-34`) and terminal on web, so it routes to login on all three clients today. A new code would be terminal on the `auth.error` path but fall off mobile's sessions allow-list and retry forever. Semantics fit: the token's lifetime ended, just not by the clock.
4. **Migration: an absent `credentialsValidFrom` reads as the record's `createdAt`, not as `now`.** `now` would log out every account on upgrade. Absent means "no revocation has ever happened", and `createdAt` says exactly that. Same `.preprocess` idiom as Task 2b's role migration.

**The role write and the floor write are ONE `update()` call.** `setRoleFlow` (`user-provisioner.ts:269-292`) must patch `{ role, credentialsValidFrom }` together. Two writes means a crash between them leaves the role changed with the old credentials still live — the exact failure this task exists to prevent. Note `user-store.ts` writes are atomic per file (`atomic-write.ts`) but the store has no lock across read-modify-write; do not add a second round trip to this path.

**Layer 2 — the live socket is closed (immediacy).** `setRoleFlow` emits `roleChanged` after a successful write. A revoker listens and closes that user's sockets, so the client sees the kick now rather than on its next request.

- `SessionRegistry` has no userId index — `Attachment` (`subscriber-set.ts:75`) carries `ws` but no `userId`. Add the enumeration to the registry, which owns the map, reading `att.ws.data.principal?.userId`. Do not build a second index to maintain.
- Reuse the close path rather than writing a third one. `closeExpiredCredential` (`credential-lifetime.ts:108`) already does `auth.error` + `ws.close(1008)`. Extract the shared `closeWithAuthError(ws, code, message)` and have both call it; `WS_CLOSE_POLICY = 1008` is currently declared independently in `ws-auth-gate.ts:34` and `credential-lifetime.ts:58` — collapse to one exported constant while you are here.
- `session-manager.ts` holds `sessions`/`userSessions`/`sessionToUser` and its `Session` object carries a `role` field — a captured snapshot. Add `revokeUser(userId)` to the interface, dropping every session bound to that user across all three maps. **Enumerate every read of `Session.role` in the tree and confirm none of them is an authorization decision;** if one is, it is a Critical finding and converts to a record read like Task 2b's three.
- Wire both events in `main.ts` beside the existing `onCreated`/`onDeleted` lines (`main.ts:235-236`): `onRoleChanged` and `onDeleted` both call `revoker.revokeUser`.

**`UserPrincipal` is not touched.** No setter, no rebind, no re-mint on a live socket. The socket dies; the next one mints a fresh principal from the record.

- [ ] **Step 1: Write the failing tests.** (a) HEADLINE: a token issued while the user was `admin`, the record then demoted, and `validate()` refuses it — no refresh, no re-login, no cache flush. (b) `setRoleFlow` patches `role` and `credentialsValidFrom` in a single `update()` call — assert on the patch object, not on the end state. (c) A record with no `credentialsValidFrom` accepts a token issued after `createdAt`. (d) Boundary: a token whose `issuedAt` second equals the floor instant is refused. (e) A missing record refuses the token and never yields a floor. (f) The revoker closes exactly the target user's sockets, leaves every other user's open, and the closed ones got `auth.error` `code: "expired"` then close 1008. (g) A deleted user's open socket is closed by the same path.
- [ ] **Step 2:** Run them; confirm each fails for the stated reason.
- [ ] **Step 3:** `UserRecord.credentialsValidFrom` + migration; `CredentialFloor` port and its user-store implementation; `token-service.validate` reads the floor. Thread the port through composition.
- [ ] **Step 4:** `setRoleFlow`'s single-patch write; `UserLifecycle.onRoleChanged`/`emitRoleChanged`.
- [ ] **Step 5:** `closeWithAuthError` extraction + the single `WS_CLOSE_POLICY`; registry enumeration; `CredentialRevoker`; `sessionManager.revokeUser`; `main.ts` wiring for both events.
- [ ] **Step 6:** `cd gateway && bun run test`, `bun run ci`. Commit `feat(auth): make a role change revoke the account's credentials`.

---

### Task 2d: Demotion is a confirmed, signs-you-out action

**Why this exists.** The demote UI already ships — `members-pane.tsx:128` renders a bare **Demote** / **Promote** button that fires `api.setIsAdmin` on the first click, and mobile reaches the same route through `AdminUseCases`. After Task 2c that click force-logs-out the target account on every device. A one-click, no-warning control for an action that both signs someone out and can strip access they cannot restore themselves is the wrong shape.

The owner's ruling: **confirm first, and warn that this logs the account out and may be irreversible for the access it removes.**

Two things the copy must actually say, because both are true and neither is obvious:

- **It signs that member out everywhere, immediately.** Not "next time they log in".
- **A demoted admin cannot restore their own access** — only another admin can promote them back. An admin demoting *themselves* is logging themselves out of the admin surface with no way back in on their own. (The server's `last-admin-demotion` guard prevents the unrecoverable household-wide case; it does not prevent this one.)

Promotion also signs the account out, so it is also confirmed — with its own copy. Do not reuse one string for both.

**Files:** `gateway/webui/src/components/settings/panes/members-pane.tsx`; the iOS and Android members screens reached from `AdminUseCases` (`shared/mobile-data/src/commonMain/kotlin/io/sentient/mobiledata/usecase/settings/AdminUseCases.kt` — find each platform's consumer). Reuse each platform's existing confirmation/alert primitive; do not introduce a new modal component on any surface.

- [ ] **Step 1:** webui — confirmation before `handleToggleAdmin`, distinct copy per direction, cancel leaves state untouched. Verify the existing dialog primitive in the settings panes and reuse it.
- [ ] **Step 2:** iOS and Android — the same gate on their members screens, same two messages.
- [ ] **Step 3:** Verify the kick lands as a login, not as a hang: confirm web's terminal-auth classification routes `expired` to the login screen the way mobile's `TERMINAL_AUTH_CODES` does. If web treats it as retryable, that is a real gap — fix it here.
- [ ] **Step 4:** Commit `feat(settings): confirm a role change before it signs the member out`.

---

### Task 3: Per-role default permission templates

**Files:** Create `gateway/src/tools/role-defaults.ts`. Modify `gateway/src/profile-store/profile-defaults.ts`, `gateway/src/api/handlers/auth.ts`, `gateway/src/api/handlers/admin.ts`.

**Produces:** `defaultPermissionsFor(role: UserRole, catalog: McpCatalog): ToolPermissionMap` — four roles now, including `admin` — one accessor, so a later customization UI changes one thing.

This is where `mcp-policy.yaml`'s 35 tiering rules land. `allow` → `"allow"`, `confirm` → `"ask"`. Build it FROM the catalog and the tiers, not from a hand-copied list — the catalog is the source of truth and a hardcoded list drifts the moment an operator edits `config.yaml`.

**Every new profile is fully seeded.** After this task there is no such thing as an unset tool: `applyProfileDefaults` fills the table for the account's role. That is what lets Task 4 delete the fallthrough.

Also fix, since it is the same seam: `handleMePut` (`api/handlers/profile.ts:131-160`) never calls `applyProfileDefaults`, which is why a cleared table degraded to "inherit everything" in rev 1. With no fallthrough it would degrade to "nothing", which is worse. Decide and document what a PUT with a partial table means — my recommendation is that a PUT replaces only the keys it names.

- [ ] Write the failing tests: an adult, a child and a guest each get a different seeded table from the same catalog; the child's omits every tier `canExecute` denies; no tool is absent from an adult's table.
- [ ] Implement `defaultPermissionsFor`; wire it into `applyProfileDefaults` (which now needs the role and the catalog — thread them).
- [ ] Commit `feat(tools): seed a per-role permission table on every new account`.

---

### Task 4: One resolution, no fallthrough — and the policy engine retires

**Files:** `gateway/src/tools/tool-broker.ts`, `gateway/src/tools/user-tool-permissions.ts`. **Delete:** `gateway/mcp-policy.yaml`, `gateway/src/security/policy-engine.ts`, `gateway/src/security/policy-loader.ts` and their tests, plus the wiring at `main.ts:205-206` and `phase-services.ts:396`.

`definitions()` drops a tool when **either**:
1. `canExecute(capability.role, def.tier)` is false — the role gate, and
2. the person's permission is `"off"`.

Both produce absence, for the same reason: the model must not see, or spend context on, a tool it can never use. Log the two cases distinguishably.

`resolveDecision()` becomes: the role gate again (defensive — a model can hallucinate a tool name that was never advertised), then the person's permission, exhaustively. No policy engine, no fallthrough.

**The role template is the resolution FLOOR, not a one-time copy.** Resolution reads:

```
storedTable[server]?[tool]  ??  defaultPermissionsFor(role, catalog)[server]?[tool]  ??  "off"
```

Task 3 seeds the table so a person sees and edits real values, but the template answers underneath it forever. "Absent" therefore becomes well-defined rather than a bug — which is what this task needed, and a one-time copy could not give it. Four things this closes that seeding alone does not:

- **Profiles that predate Task 3.** Every account on disk today has `permissions` unset; a copy-only rule strands them the moment the fallthrough is deleted, until each one saves settings once.
- **A role change.** Promote a child to adult and their table still holds the child's answers. The floor moves with the role; the stored entries stay as the person's explicit overrides.
- **A tool the operator adds to `config.yaml` tomorrow.** It has no stored entry on any existing profile and must not therefore be unanswerable.
- **A partial write from any client**, present or future.

The final `?? "off"` is the fail-closed backstop for a tool in neither table — it must never be `"allow"`. Note this does NOT re-introduce "absent = inherit everything": the floor is a server-computed, role-derived value, not a permissive default.

**The one genuine leftover.** `no_identify_user_outside_voice` is conditioned on `session.channel`, which is per-session, not per-user or per-role — no permission table can express it. It is a constraint on when the tool is meaningful, not on who may use it. Implement it as a guard the tool itself owns and say where you put it.

**Keep intact from rev 1:** the fail-closed permission reader, and the invariant that `allow`/`ask`/`deny` produce a BYTE-IDENTICAL `tools[]` while only `off` (and now the role gate) may change it. Re-run that mutation.

- [ ] Write the failing tests: a guest never sees a `write`-tier tool in `definitions()`; a child calling a `confirm`-tier tool by name is denied even though it was never advertised; an adult's `Deny` still returns a reason the model can read; the cache-stability invariant still holds.
- [ ] Implement, then delete the policy engine and its config. Grep for stragglers.
- [ ] Commit `refactor(tools): retire the policy engine into the role gate and the permission table`.

---

### Task 5: API

**Files:** `gateway/src/api/handlers/profile.ts`, `gateway/src/api/handlers/mcp-catalog.ts`.

`McpToolView` gains `permission: ToolPermission` and `tier: ImpactTier`. It must NOT list a tool the caller's role cannot execute — the settings screen shows what the person can actually govern, and a locked row a child can never change is noise. (If a parent-facing "manage my child's tools" screen arrives later, THAT is where a locked-with-reason row belongs.)

There is no `inherited` flag any more — every tool has a real value.

- [ ] Commit `feat(api): project each tool's permission and tier`.

---

### Task 6: webui

`profile-api.ts` mirrors the new shapes and drops `enabled`. `tools-pane.tsx` swaps the per-tool `Toggle` for `Select` with `Allow / Ask / Deny / Off`. The server master toggle writes `{"*": "off"}` — **it must never delete a key** (rev 1 constraint). Widen the 32px toggle column in `panes.css:524`.

This also fixes the render crash at `tools-pane.tsx:26` (`id in draft.tools.enabled` on an undefined `enabled`), which is live on the branch today.

- [ ] Commit `feat(webui): pick a permission per tool`.

---

### Task 7: mobile shared

`ProfileModels.kt`'s `ProfileTools` drops `enabled`, gains `permissions`; `McpCatalogModels.kt`'s `McpToolView` gains `permission` + `tier`. Kotlin `when` exhaustive, no `else ->`. `ToolsViewModel.kt`/`.swift` must write `{"*":"off"}`, never delete keys.

Note `ProfileTools.enabled` is currently required-no-default, so an `enabled`-less response throws on deserialize — that is a live break on this branch, fixed here.

- [ ] Commit `feat(mobile-sdk): carry per-tool permissions and tiers`.

---

### Task 8: iOS · Task 9: Android

`RowToggle` → `RowSelect` per tool, same four options. Content width on a 390pt phone is ~318pt, already spent on the mono tool name plus description — a `Menu` costs only its label, which is why the dropdown fits where a segmented control would not.

- [ ] Commits `feat(ios): pick a permission per tool` / `feat(android): pick a permission per tool`.

---

### Task 10: Verify

## E2E matrix

> **Every prompt is READ-ONLY.** Never actuate a device. A multi-tool turn is reachable from `ma_list_players` + `ha_search` + web search.

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| Adult sees the full set | desktop 1280×900 | fresh adult | Open Settings → Tools | Every catalog tool listed with a real value; no "inherited" anywhere | seeded table in `GET /profile/me` |
| Role gate hides, not denies | desktop 1280×900 | a guest account | Same | `write`-tier tools are absent from the list entirely | `definitions()` omits them; log distinguishes role-gate from `off` |
| Ask prompts | desktop 1280×900 | `ha_search` → Ask | Ask a question needing it | Permission dialog; approving completes | `tool-broker.pdp.confirm-resolved confirmed=true` |
| Deny is legible | desktop 1280×900 | `ha_search` → Deny | Same question | No dialog; the reply explains it cannot check | `dispatch.denied`; the tool IS in the request |
| Off is invisible | desktop 1280×900 | `ha_search` → Off | Same question | The reply does not mention the capability | tool ABSENT from `definitions()`; low `cacheHitRatio` next turn |
| Cache holds | desktop 1280×900 | warm session | Allow→Ask→Deny, one turn each | — | `cacheHitRatio` stays high across all three |
| Server off round-trips | desktop 1280×900 | any | Toggle a server off, reload | Still off | profile carries `{"*":"off"}`, not a deleted key |
| Mobile parity | 390×844 + both sims | same | Set a value on each | Dropdown fits one line; matches web | — |
| Demote confirms | desktop 1280×900 | two admins, both signed in | Settings → Members → Demote the other admin, then Cancel | Dialog names the sign-out AND the it-takes-another-admin-to-undo; Cancel leaves them Admin | no `setRole` call on cancel |
| Demote kicks the open session | desktop 1280×900 | same, target admin has a live WS in a second browser | Confirm the demotion | The target window returns to the login screen without a reload | `auth.error code=expired`, close 1008, `revokeUser reason=role-changed` |
| The old token is dead | desktop 1280×900 | just demoted, token still in storage | Target re-uses the stored token | Refused; login required | `validate` refuses with `expired`, `reason=revoked` |
| Demoted admin loses the surface | desktop 1280×900 | demoted, re-logged in | Open Settings | Members pane absent; a hand-rolled `/api/v1/admin/*` call 403s | admin gate refuses on the record |
