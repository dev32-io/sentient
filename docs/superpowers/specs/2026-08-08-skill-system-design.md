# Skill System v1 + Inbound Content Scanning — Design

- **Date:** 2026-08-08
- **Branch:** `feature/native-orchestrator`
- **Status:** Design approved in brainstorm; pending plan
- **Parent:** `2026-07-23-sentient-2.0-native-orchestrator-design.md` §1.2 ("skills — its own spec")

---

## 1. Thesis

Sentient learns per-user skills the user teaches it in conversation. A skill is a
named, reusable instruction set the assistant writes for itself on the user's
instruction, stored on disk in the **Agent Skills SKILL.md standard**, indexed
cheaply in the system prompt, and lazy-loaded into context only when invoked.

Two security deliverables ride with it, at the owner's direction:

1. **`InjectionScanner` rebuilt as a reusable, encapsulated boundary** —
   normalization + layered detection + provenance, replacing the 6-regex
   skeleton (which one synonym defeats).
2. **The inbound tool-result scanning boundary** — the HIGH-PRIORITY SECURITY
   item from `docs/native-todo.md`: every piece of text entering model context
   from a non-person source passes one chokepoint. Skill bodies are one more
   such source, which is why this lands together.

## 2. Scope

**In:** per-user skills; authored/managed only through chat by the model via
five gateway-native tools; SKILL.md standard on disk; descriptions-only index in
the system prompt (progressive disclosure level 1); body loaded on invoke as a
`tool_result` (level 2); per-tool permission wiring for the new tools across the
template/role/settings surfaces; the two scanner deliverables.

**Out — recorded in `docs/native-todo.md` as follow-ups:**

- **Skill scripts / executable bundles. NEEDS SANDBOXING FIRST — flag loudly.**
  We have per-user working dirs but no sandbox. A skill that ships code runs it
  on the gateway host as the gateway user; nothing contains it today. Until a
  sandbox exists, script parts of the standard are inert here.
- External skill import (claude/opencode/ClawHub registries) + its import-time
  scan/confirm gate. Format compatibility is kept on purpose so import is a
  file drop-in later.
- Household/shared skills; per-user only for v1.
- Settings UI for skills (list/edit); chat-only for v1.
- Discovery tool / RAG routing for 100s of skills; v1 caps the index.
- Multi-file reference bundles (level 3); v1 is a single SKILL.md.
- Model-based (LLM classifier) scanning layer; v1 ships the deterministic
  layers with the classifier as a designed-for config extension.

## 3. Skill format and storage

```
~/.sentient/gateway/users/<userId>/skills/<slug>/SKILL.md
```

- `<slug>`: kebab-case, `[a-z0-9-]{1,64}`, validated at write; no traversal, no
  symlink following (opened via the user's `FileScope`).
- SKILL.md = YAML frontmatter + markdown body, per the Agent Skills standard:

```yaml
---
name: dinner-planner          # ≤64 chars, must equal <slug>
description: Plan family dinners; use when asked about meals, groceries, weekly menus.  # ≤1024 chars — this IS the trigger surface
tools: [ha_get_state, search_web]   # optional, declarative ONLY
---
<markdown instructions>
```

- `tools:` is **declarative, grants nothing**. Validated against the catalog +
  native tool names at write time so the model cannot reference phantoms
  (the D19 lesson). Every actual call the skill leads to still passes the role
  gate + per-tool permission + PDP at dispatch, exactly as if the user had asked
  in prose. **A skill cannot escalate anything.**
- Body size cap `orchestrator.skills.max_body_chars` (config; standard practice
  ≈ 5k tokens). Enforced at write with a legible error the model can relay.

## 4. The five tools (gateway-native)

Same shape as `delegateTask`: no MCP server, `ToolDefinition.tier` declared on
the definition, registered with the broker's native runner map, foreground.

| Tool | Args | Tier | Behavior |
|---|---|---|---|
| `skill_list` | — | `read` | names + descriptions + updated_at |
| `skill_use` | `name` | `read` | returns SKILL.md body as the tool result (lazy level 2) |
| `skill_create` | `name, description, body, tools?` | `confirm` | validate frontmatter limits + slug + tools; write; refuse duplicates |
| `skill_update` | `name, description?, body?, tools?` | `confirm` | partial update; same validation |
| `skill_delete` | `name` | `confirm` | remove the skill dir |

- `confirm` tier → `ask` permission → the existing permission dialog. The
  dialog's argument rendering (full-value rows, from the tool-permissions wave)
  shows the user exactly what is being written — for `skill_create` the body IS
  the authority being granted to future turns, so it renders in full.
- Role gate falls out of `canExecute`: `child`/`guest` reach `read` only —
  they can use and list skills, never author them.

### 4.1 Per-tool permission wiring (owner's heads-up, folded in)

The five tools ride every surface the tool-permissions wave built, as
`nativeTools` entries beside `delegateTask`:

- **Settings projection** (`api/handlers/mcp-catalog.ts#projectNativeTools`):
  all five appear with human-facing copy, per-tool permission + tier, honest
  writability. Unlike `delegateTask` (structurally pinned), skill tools are
  genuinely overridable — a person may set `skill_create` to `deny`, or a
  parent may set a child's `skill_use` to `off`.
- **Role template**: gateway-native tools resolve through
  `defaultPermissionForTier` at the broker (not the catalog-seeded table) —
  same path `delegateTask` uses; no template migration needed. Verify the
  settings screen's stored-write path round-trips for native tools.
- **Clients**: webui + iOS + Android render `nativeTools` generically from the
  projection; plan verifies (not assumes) all three render five new rows and
  their dropdown writes land.
- **Back-fill**: the catalogued-tool tier back-fill (`b79ade12`) covers catalog
  tools; native tools carry tiers in code, so no config migration.

## 5. Index + lazy load (progressive disclosure)

- **Level 1 — always in context:** the system prompt gains a skills section:
  one `name — description` line per skill, rendered at prompt build from the
  user's skills dir, through the existing two-tier loader
  (`context/system-prompt-loader.ts` shape: template + rendered content).
  ~20–100 tokens per skill. Cap `orchestrator.skills.max_index_entries`
  (config), WARN + deterministic truncation (newest first) on overflow.
- **Session-stable, cache-safe:** the index is computed once per session at
  runtime construction, not per turn. Mid-session `skill_create` does not
  re-render the prefix — the authoring session already holds the content in
  context via its own tool call; other sessions pick it up at their next
  runtime build. This preserves Invariant A's byte-stable prefix.
- **Level 2:** `skill_use` returns the body as a `tool_result` — ordinary
  tool_call/tool_result store entries, ordinary tool pill on all clients,
  `render(replay) == render(live)` untouched. **No new wire frames, no store
  schema change, no client feature work.**
- The index section also carries a fixed one-paragraph harness note telling the
  model what skills are and to invoke `skill_use` before acting on one.

## 6. Security — the two scanner deliverables

### 6.1 `InjectionScanner` v2 — reusable, encapsulated (owner: "very important")

One module, many callers (DelegationGuard today; the inbound boundary below;
the future import gate). Contract sketch:

```
scan(text, provenance) → { findings[], normalizedText, maxSeverity }
provenance: { channel: "tool_result" | "delegation_prompt" | "skill_body" | ...,
              source: string /* tool/server name */ }
```

- **Layer 0 — normalization before any matching:** Unicode NFKC, homoglyph
  folding, zero-width strip, case fold; base64/hex payload detection.
  Today's regexes see none of that.
- **Layer 1 — patterns:** rebuilt category set; **English AND Chinese are both
  requirements** (this household speaks both), synonym coverage
  (ignore/disregard/forget/override...), not one regex per category.
- **Layer 2 — structural:** inline tool-call envelope smuggling
  (`<tool_call>`, `<function-call>`, tool-JSON shapes) — the one class that is
  never legitimate data and may be stripped/fail-closed outright.
- **Layer 3 (deferred, designed-for):** model-based classifier behind config.
- The **impl plan must ground this in extensive research** (owner instruction):
  published injection corpora, OWASP LLM01 guidance, normalization pitfalls,
  multilingual evasion. Detection quality is measured against a fixture corpus
  committed with the tests, not asserted.

### 6.2 Inbound boundary — tool results enter through one chokepoint

The native-todo "shape of the fix", now built:

- **Chokepoint:** one function on the path every non-person text takes into
  model context: MCP tool results (in `ToolBroker`, beside the existing
  `tool-result-cap`), background completion payloads, `skill_use` bodies.
  Complete mediation — a scanner with optional callers is the current defect.
- **Annotate and raise, do not silently block:** findings mark the result
  (logged with IDs), feed `RiskAccumulator` (already built, currently unwired);
  at `escalate` level the PDP requires `confirm` for side-effecting tools it
  would otherwise `allow` for the remainder of the risk window. Blocking a
  legitimate page is worse than prompting; the published guidance (judge the
  action against original user intent) is implemented as tier escalation, not
  content suppression.
- **Fail-closed only where cheap:** Layer-2 envelope smuggling is stripped.
- **Config:** `security.inbound_scan.*` — enabled, thresholds, per-channel
  toggles. The false `config.yaml:832` comment ("handled by the injection
  scanner") finally becomes true and is reworded to point at the real module.

## 7. E2E matrix (inline, per e2e-testing rule)

| Case | Viewport | Pre-state | Action | Expected user-visible | Expected log trail |
|---|---|---|---|---|---|
| skill-create-chat | desktop 1280×900 | authed adult | "make yourself a skill for X" | confirm dialog w/ full body; approve → created; assistant confirms | PDP ask on `skill_create`; validation ok; file written under user dir |
| skill-trigger-fresh | desktop | skill exists; NEW session | ask something matching description only | model calls `skill_use`, follows instructions; tool pill renders | index rendered in prompt; `skill_use` tool_call+result appended |
| skill-list-chat | desktop | ≥2 skills | "what skills do you have" | names+descriptions in reply | `skill_list` allow (read) |
| skill-update-delete | desktop | skill exists | ask edit, then delete | confirm each; list reflects | PDP ask ×2; dir removed |
| skill-role-gate | desktop | child user | child asks to create skill | refused; tool absent from model | role gate withholds `skill_create` from `tools[]` |
| skill-settings-toggle | desktop + mobile 390×844 | admin in settings | set `skill_create` → Deny; retry create | tool absent / denied for that user | stored permission wins over template |
| skill-dup-invalid | desktop | skill exists | create same name; create 2000-char description | model relays legible errors; nothing written | validation errors as tool errors, no PDP prompt spent |
| skill-index-cap | desktop | > cap skills | new session | prompt carries cap-many entries | WARN overflow, deterministic truncation |
| inbound-scan-annotate | desktop | stack up | fetch a page seeded with an injection phrase | reply unaffected or hedged; NO tool execution from injected text | scanner findings logged; risk recorded; escalation if threshold crossed |
| inbound-scan-escalate | desktop | risk ≥ escalate | model attempts a write-tier tool | permission dialog where allow was expected | PDP tier escalation logged with risk snapshot |
| mobile-skill-parity | Maestro android+ios (`settings-tools` tag) | skills exist | settings tools screen | five native tool rows render; dropdown writes persist | settings PATCH round-trip |

Native-mobile via Maestro tags, web via Playwright MCP, local stack only.

## 8. Follow-ups this spec creates (to native-todo on landing)

1. **Skill scripts require a sandbox** — loud entry, per owner.
2. External import + import-time scan/confirm gate.
3. Sharing / household skills; settings UI; discovery-at-scale.
4. Scanner Layer 3 (model classifier) evaluation.
5. `capabilityCoversPath` symlink hardening + `createFileScope` class check
   become live concerns the moment skills land (already filed; now elevated).
