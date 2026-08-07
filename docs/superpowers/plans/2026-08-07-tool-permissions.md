# Per-Tool Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One per-tool setting — `Allow | Ask | Deny | Off` — owned by the gateway's `ToolBroker`, which renders `tools[]` at runtime from it, surfaced as a dropdown in all three Tools settings screens.

**Architecture:** The broker already has exactly two choke points and this feature plugs into both: `definitions()` (`tool-broker.ts:513`) is the sole producer of the model's `tools[]`, and `resolveDecision()` (`:288`) is the sole caller of `policy.evaluate`. `Off` drops a tool at the first; `Allow`/`Ask`/`Deny` are read at the second. An absent entry falls through to `mcp-policy.yaml` exactly as today, so nothing changes behaviour until someone touches a dropdown. `mcp-policy.yaml` remains the outer gate and is not touched.

**Tech Stack:** Bun + TypeScript (gateway), zod (`shared/config`), Preact (webui), Kotlin Multiplatform (`shared/mobile-sdk`, `shared/mobile-data`), SwiftUI (iOS), Compose (Android).

## Global Constraints

- Branch `feature/native-orchestrator`. Never push to `main` or `develop`.
- `source scripts/env.sh` before ANY shell command.
- Gateway unit tests: `cd gateway/src && bun test` (Bun's runner, NOT vitest). Repo: `bun run ci`. Kotlin: `./gradlew :shared:mobile-sdk:allTests :shared:mobile-data:allTests :android:testDebugUnitTest`. iOS: `xcodebuild -project ios/SentientApp.xcodeproj -scheme SentientApp -destination 'platform=iOS Simulator,name=iPhone 16,OS=18.3.1' test` — **`test`, not `build`**; `build` does not compile `SentientAppTests` (`ios/project.yml` marks it buildable only for the Test action), so a `build`-only check proves nothing.
- **Every switch on `ToolPermission` must be exhaustive** — no `default:` arm, no `else ->` catch-all. A fifth member (`Auto`, once the classifier lands) must be a compile error at every site that has to handle it.
- The dropdown control already exists on all three platforms and must be reused, not re-invented: web `Select` (`gateway/webui/src/components/settings/primitives/select.tsx`), iOS `RowSelect` (`ios/App/Settings/Components/RowSelect.swift`), Android `RowSelect` (`android/src/main/kotlin/io/sentient/android/settings/components/RowSelect.kt`). Precedent for many options: the 6-option reasoning-effort picker (`advanced-pane.tsx:71`).
- Tagged logger everywhere; no bare `console.*`. Never log user content.
- Mobile logs upload to the gateway — ids, counts and types only.
- **Never run anything against production.** E2E prompts must be READ-ONLY: never actuate a device (no "turn on", no "play"). See the e2e matrix note.
- Commit `type(scope): description`, ending each message with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

## Why `tools.enabled` goes away

`profile.tools.enabled` has **no live consumer in the native loop**. It is read only by `renderProfile` (`profile-renderer.ts:159`), which writes an `mcp:` block into `hermes-config.yaml`. That block is dead: `hermes-external-tool.ts:85-110` registers the gateway's MCP with Hermes **at call time** (`hermes -p <id> config set mcp_servers` → a per-user socket), and every proxied call is mediated by the calling user's `ToolBroker`, already narrowed by `delegated-tool-tier.ts`. Hermes never reads the rendered `mcp:` block.

`renderProfile` itself survives — Hermes still needs the model fragments (`MODEL_FRAGMENTS`, `profile-renderer.ts:30`) to know which LLM to call. Only its MCP half retires.

So `enabled` is replaced, not supplemented. One setting, one source of truth.

---

### Task 1: The `ToolPermission` type and the profile field

**Files:**
- Create: `shared/config/src/schemas/tool-permission.ts`
- Modify: `shared/config/src/index.ts` (export it)
- Modify: `gateway/src/profile-store/profile-types.ts:50-73` (replace `enabled` with `permissions`)
- Modify: `gateway/src/profile-store/profile-defaults.ts:8-15`, `:33-45`
- Test: `gateway/src/profile-store/profile-types.test.ts` (or create it)

**Interfaces produced:** `ToolPermission = "allow" | "ask" | "deny" | "off"`; `toolPermissionSchema`; `ProfileV1["tools"]["permissions"]: Record<string, Record<string, ToolPermission>>`.

- [ ] **Step 1: The type**

Create `shared/config/src/schemas/tool-permission.ts`:

```ts
import { z } from "zod";

/**
 * What the gateway does when the model calls a tool. ONE setting per tool,
 * owned by the ToolBroker, which is the only thing that reads it.
 *
 *   allow — dispatched with no prompt.
 *   ask   — the person is asked first (permission dialog).
 *   deny  — auto-rejected with a reason the model SEES, so it can explain
 *           itself rather than silently improvising around a gap.
 *   off   — omitted from `tools[]` entirely; the model does not know the tool
 *           exists. This is the only member that changes the request prefix,
 *           and so the only one that costs a prompt-cache re-prime.
 *
 * `deny` and `off` are deliberately distinct: `deny` keeps the capability
 * legible to the model, `off` removes it. Collapsing them loses the model's
 * ability to say WHY it cannot do something.
 *
 * EXHAUSTIVE SWITCHES ONLY. A fifth member (`auto`, once the classifier
 * lands) must break every site that has to handle it — never fall through a
 * `default:` arm into silently-wrong behaviour.
 */
export const toolPermissionSchema = z.enum(["allow", "ask", "deny", "off"]);
export type ToolPermission = z.infer<typeof toolPermissionSchema>;
```

Export from `shared/config/src/index.ts` beside the other schema exports.

- [ ] **Step 2: Write the failing profile-schema test**

The old `enabled` field carried a `.preprocess` migrating a legacy `string[]` form. The new field needs its own migration FROM `enabled`, because live profiles have it.

```ts
import { describe, expect, it } from "bun:test";
import { profileV1Schema } from "./profile-types.js";

const BASE = {
  schemaVersion: 1,
  userId: "u_aaaaaaaa",
  model: { provider: "ollama-cloud", id: "gpt-oss:20b" },
  voice: { provider: "local-tts", id: "default" },
  persona: { template: "default", overrides: "" },
};

describe("profile tools.permissions", () => {
  it("migrates a legacy tools.enabled map into per-tool permissions", () => {
    const parsed = profileV1Schema.parse({
      ...BASE,
      tools: { enabled: { home_assistant: [], searxng: ["web_search"] }, toolsets: ["memory"] },
    });
    // An enabled server with an empty narrowing inherits: no explicit entries.
    expect(parsed.tools.permissions.home_assistant).toEqual({});
    // A narrowed server keeps its named tools inheriting and says nothing about
    // the rest — the catalog decides what else exists, and unnamed tools go off.
    expect(parsed.tools.permissions.searxng?.web_search).toBeUndefined();
    expect(parsed.tools.enabled).toBeUndefined();
  });

  it("accepts an explicit permissions map and rejects an unknown member", () => {
    const parsed = profileV1Schema.parse({
      ...BASE,
      tools: { permissions: { home_assistant: { ha_search: "ask", ha_call_service: "off" } } },
    });
    expect(parsed.tools.permissions.home_assistant?.ha_search).toBe("ask");
    expect(() =>
      profileV1Schema.parse({ ...BASE, tools: { permissions: { s: { t: "auto" } } } }),
    ).toThrow();
  });
});
```

Run it (`cd gateway/src && bun test profile-store/`) and watch it fail.

- [ ] **Step 3: Replace the field**

In `profile-types.ts`, delete the `enabled` key and its `.preprocess`, and add:

```ts
    /**
     * Per-tool permission, keyed by MCP server name then tool name. Server
     * names match gateway/config.yaml#mcp_catalog. An ABSENT entry — missing
     * server, or missing tool under a present server — means "inherit", and
     * the broker falls through to mcp-policy.yaml exactly as it did before
     * this field existed. That is what makes adding the field a no-op until
     * somebody touches a dropdown.
     *
     * Replaces the retired `enabled` map. That field's only consumer was the
     * Hermes profile renderer, whose `mcp:` block Hermes never reads (the
     * gateway registers its MCP at call time — external-tools/
     * hermes-external-tool.ts), so it steered nothing.
     */
    permissions: z.preprocess(migrateEnabledToPermissions, z.record(z.string().min(1), z.record(z.string().min(1), toolPermissionSchema))).default({}),
```

with the migration above it:

```ts
/**
 * Legacy `tools.enabled` → `tools.permissions`. No schema-version bump, same
 * convention as the `voice.provider: "fish-audio"` rewrite above.
 *
 * `enabled` expressed AVAILABILITY per server: a present key meant the server
 * was on (`[]` = inherit the operator's include; a non-empty array = narrow to
 * those tools). It never reached the native loop, so this migration is the
 * moment the setting starts meaning something — a server the user had switched
 * off yields `off` for every tool the catalog lists under it.
 *
 * Servers the user narrowed keep their named tools inheriting and mark nothing
 * else, because the catalog — not the profile — is the authority on what other
 * tools exist. The broker resolves the remainder against the catalog at
 * `definitions()` time (task 2).
 */
function migrateEnabledToPermissions(v: unknown): unknown { … }
```

Write the body so an already-`permissions`-shaped value passes through untouched, an `enabled` object migrates, and the doubly-legacy `enabled: string[]` form migrates too.

`profile-defaults.ts`: `DEFAULT_TOOLS_ENABLED` becomes `DEFAULT_TOOL_PERMISSIONS: Record<string, Record<string, ToolPermission>>` = `{ home_assistant: {}, gateway: {}, music_assistant: {}, searxng: {}, fetch: {} }` — every default server present with no explicit per-tool entry, i.e. inherit everything. Update `applyProfileDefaults` accordingly and keep its "caller-provided value wins" behaviour.

- [ ] **Step 4: Green, then commit**

```bash
source scripts/env.sh && cd gateway/src && bun test && cd ../.. && bun run typecheck
git add -A && git commit -m "feat(profile): give every tool one permission, replacing the Hermes-era enabled map"
```

Expect fallout in `web-tools-migrator.ts`, `profile-renderer.ts` and their tests — that is Task 3's work. If it blocks compilation, do the minimum to keep the tree green and say so in your report.

---

### Task 2: The broker enforces it

**Files:**
- Modify: `gateway/src/tools/tool-broker.ts` — `definitions()` (`:513`), `resolveDecision()` (`:288`), `ToolBrokerDeps`
- Modify: `gateway/src/bootstrap/phase-services.ts` (supply the permission map to the broker)
- Test: `gateway/src/tools/tool-broker.test.ts`

**Interfaces produced:** `ToolBrokerDeps.toolPermissions: () => Record<string, Record<string, ToolPermission>>` — read per call, never captured, so a settings save takes effect on the next turn without rebuilding the broker.

- [ ] **Step 1: Write the failing tests**

Four cases, and the fourth is the one that matters most:

```ts
it("omits an off tool from definitions()", …)
it("dispatches an allow tool with no confirm prompt", …)
it("rejects a deny tool with a reason the model can read, without prompting", …)
it("keeps the tools array byte-identical across allow, ask and deny", () => {
  // Tools are serialized AHEAD of the messages, so the array is part of the
  // provider's cached prefix. Only `off` may change it — if allow/ask/deny
  // perturb it, every permission tweak silently costs a full re-prime of the
  // system prompt and history, which is the whole reason `off` is a separate
  // state.
  const forEach = (p: ToolPermission) => JSON.stringify(brokerWith(p).definitions());
  expect(forEach("ask")).toBe(forEach("allow"));
  expect(forEach("deny")).toBe(forEach("allow"));
  expect(forEach("off")).not.toBe(forEach("allow"));
});
```

- [ ] **Step 2: Implement**

`definitions()` filters `off`. Resolve a definition's server by the same mapping `resolveTarget` uses — read it rather than inventing a second lookup.

`resolveDecision()` consults the user permission FIRST, then falls through:

```ts
    const userPermission = permissionFor(inv.name);
    // Absent → inherit: the operator policy decides exactly as it did before
    // this field existed. Present → the person's choice, which may only be
    // consulted for a tool the operator's policy has not already denied.
    if (userPermission !== undefined) {
      switch (userPermission) {
        case "allow":  break;                       // fall through to the policy engine
        case "deny":   return { action: "deny", reason: userDeniedReason(inv.name) };
        case "off":    return { action: "deny", reason: … };  // unreachable — not in tools[] — but fail closed
        case "ask":    return confirmFlow(inv, …);
      }
    }
```
No `default:` arm — the switch must break when `auto` lands.

**Ordering:** the operator's `mcp-policy.yaml` still runs and still wins on `deny`. A user's `allow` may not override an operator `deny`; write the code so that is structurally true, not a convention, and pin it with a test.

- [ ] **Step 3: Green, commit**

```bash
source scripts/env.sh && cd gateway/src && bun test && cd ../.. && bun run typecheck
git add -A && git commit -m "feat(tools): render the model's tool array from per-tool permissions"
```

---

### Task 3: Retire the Hermes MCP rendering

**Files:** `gateway/src/profile-store/profile-renderer.ts` (the MCP half, `:145-180`), `gateway/templates/profile/hermes-config.yaml.tmpl` (its `mcp:` block), `gateway/src/admin/web-tools-migrator.ts` + its wiring at `phase-services.ts:242`, and every test naming `tools.enabled`.

Before deleting `web-tools-migrator.ts`, check whether any profile under `~/.sentient/users/` still carries a `duckduckgo` key — if one does, port the migration onto `permissions` instead of deleting it, and say which you did. Do NOT read secrets while looking; `jq` the one key.

`renderProfile` keeps its model fragments. Only the MCP section goes. Update the module header, which currently frames the whole file around Hermes's tool config.

Commit: `refactor(profile): stop rendering an MCP block Hermes never reads`.

---

### Task 4: API

**Files:** `gateway/src/api/handlers/profile.ts` (accept `permissions` on PUT), `gateway/src/api/handlers/mcp-catalog.ts` (project the resolved value per tool).

`McpToolView` gains two fields:

```ts
  /** The permission in force for this tool right now. */
  permission: ToolPermission;
  /** True when no explicit user setting exists and `permission` came from
   *  mcp-policy.yaml. The UI renders this as an "inherited" tag so a person can
   *  see what they would be overriding. */
  inherited: boolean;
```

Resolving `inherited` needs the policy engine, which the handler does not currently hold — thread it in rather than re-implementing the evaluation.

Commit: `feat(api): project each tool's effective permission to the clients`.

---

### Task 5: webui

`gateway/webui/src/services/profile-api.ts` mirrors the two new fields and the `permissions` map. `tools-pane.tsx` swaps the per-tool `Toggle` (`:332`) for `Select`, with options `Allow / Ask / Deny / Off` and the `tag` set to `"inherited"` when `inherited` is true. The server master `Toggle` (`:194`) stays — it is a bulk action and sets every tool under it to `off` / back to inherit.

The tool row's grid is `grid-template-columns: 32px minmax(180px, 1fr) 1.6fr` (`panes.css:524`) — the 32px toggle column must widen to fit the select. Keep the header labels honest (`On` becomes `Permission`).

Commit: `feat(webui): pick a permission per tool`.

---

### Task 6: mobile shared

`ProfileModels.kt`'s `ProfileTools` gains `permissions`, loses `enabled`; `McpCatalogModels.kt`'s `McpToolView` gains `permission` + `inherited`; `ProfileRepository` passes them through. Kotlin `when` on the permission must be exhaustive (no `else ->`).

Commit: `feat(mobile-sdk): carry per-tool permissions`.

---

### Task 7: iOS

`ToolsServerCard.swift` — `ToolToggleRow.isOn: Bool` becomes `permission: ToolPermission` + `inherited: Bool`; the per-tool `RowToggle` (`:81`) becomes `RowSelect`. Card content width on a 390pt phone is ~318pt, already spending most of it on the mono tool name plus description — `RowSelect` is a `Menu`, so it costs only its label width, which is why the dropdown fits where a 4-segment pill would not.

Verify with `xcodebuild … test`, not `build`.

Commit: `feat(ios): pick a permission per tool`.

---

### Task 8: Android

`ToolsScreen.kt:145` — per-tool `RowToggle` becomes `RowSelect`. Same shape as iOS.

Commit: `feat(android): pick a permission per tool`.

---

### Task 9: Verify

## E2E matrix

> **Every prompt is READ-ONLY.** The stack talks to the operator's real home and smoke runs at any hour. Never actuate a device. A multi-tool turn is reachable from `ma_list_players` + `ha_search` + web search.

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| Default is inherit | desktop 1280×900 | fresh user | Open Settings → Tools | Every tool shows its policy-derived value with an "inherited" tag; nothing reads as explicitly set | `mcp-catalog` response carries `inherited:true` per tool |
| Ask prompts | desktop 1280×900 | set `ha_search` to Ask | Ask a question that needs it | Permission dialog appears; approving completes the turn | `tool-broker.pdp.confirm-resolved confirmed=true` |
| Deny is legible | desktop 1280×900 | set `ha_search` to Deny | Same question | No dialog; the reply explains it cannot check | `tool-broker.dispatch.denied`; the tool IS present in the request |
| Off is invisible | desktop 1280×900 | set `ha_search` to Off | Same question | The reply does not mention the capability at all | the tool is ABSENT from `definitions()`; next turn shows a low `cacheHitRatio` |
| Cache holds across ask/deny | desktop 1280×900 | a warm session | Flip `ha_search` Allow→Ask→Deny, one turn each | — | `react-loop` `cacheHitRatio` stays high across all three |
| Setting survives reload | desktop 1280×900 | any explicit value | Reload | Same value, no "inherited" tag | `GET /profile/me` carries it |
| Mobile parity | 390×844 + both sims | same | Set a value on each platform | Dropdown fits one line; value matches web | — |

Commit: `test(e2e): pin per-tool permissions across the four states`.
