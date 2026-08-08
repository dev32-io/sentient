# Multi-Dimensional Fleet Review — Skill System v1 + Inbound Content Scanning (Plan)

**Plan:** `docs/superpowers/plans/2026-08-08-skill-system.md` (2026-08-08, 473 lines, 13 tasks / 4 waves)
**Spec:** `docs/superpowers/specs/2026-08-08-skill-system-design.md` (211 lines)
**Review date:** 2026-08-08
**Method:** six parallel read-only subagents, one per dimension — security, architecture, correctness/plan↔spec consistency, plan-executability/subagent-driven fitness, testing/e2e, maintainability/config. Each read the plan + spec plus referenced rules, canonical design, and source for grounding (file:line citations where possible). No agent modified files or git state.
**Relationship to the spec's own scope notes:** the spec carries accepted-gap disclosures (§2, §8); this review evaluates whether the *plan* faithfully implements the spec and is safe to execute, surfacing gaps the spec/plan do not self-identify.

---

## Headline — four findings reach across dimensions

### 1. Native-tool overridability is architecturally impossible as specified (Architecture, corroborated by Security + Testing)

The spec (§4.1) and plan (T8) claim skill tools are **"genuinely overridable"** — a person may set `skill_create → deny`, a parent may set a child's `skill_use → off`, `projectNativeTools` reports `settable: true`. This is the basis for the `skill-settings-toggle` e2e row (spec §7) and the entire settings-parity story.

**It cannot work as the plan is written.** Verified against source:
- `resolve-tool-permission.ts:68` — `storedPermissionFor` returns `undefined` when `serverName: null`.
- `resolve-tool-permission.ts:108` — `resolveToolPermission` then falls through to `defaultPermissionForTier(tier)` with `source: "role-template"`; the stored permissions table is never consulted.
- The broker's `serverOf` returns `null` for any non-MCP tool (same for `delegateTask`).
- `delegateTask` is `settable: false` **precisely because** of this — no stored override can ever be read for a serverless tool. `mcp-catalog.ts:64` carries a code comment warning of exactly the "control that saves successfully and changes nothing" defect.

For skill tools to be genuinely overridable, the plan must introduce a synthetic server namespace (e.g. `"native"`) so `serverOf` returns it, `storedPermissionFor` reads `permissions["native"]["skill_create"]`, `defaultPermissionsFor` seeds it, and `projectNativeTools` reports `settable: true`. **None of this is in T7 or T8.** T11 only greps for hardcoded `delegateTask` allowlists — it does not test the stored-write round-trip. The `skill-settings-toggle` e2e case will fail, and the settings UI will ship a lying control. This is the single highest-impact plan defect.

### 2. T9 edits `phase-services.ts` but does not list it — Wave 2 parallelism is unsafe (Correctness + Executability)

T9's wiring section (plan line 409) states the InboundGate is "composed in `phase-services` beside" the broker. But T9's Files block (line 50) omits `bootstrap/phase-services.ts`. T8 — the *same* Wave 2, *parallel* task — does modify `phase-services.ts`. Two consequences:
- Violates the plan's own Rule 3 ("a worker touches ONLY the files its task lists").
- Breaks the "disjoint file sets" claim for Wave 2: T8 and T9 both need `phase-services.ts` and the File Ownership Matrix (line 51) only acknowledges the T8/T10 share, not T9.

This is the exact collision class that produced the plan3 `5c42caa` scope-bleed erratum on this same branch (`feature/native-orchestrator`). Resolution: either add `phase-services.ts` to T9's files and serialize T9 after T8 (Wave 2 becomes a three-deep serial chain on that file — not a wave), or redesign T9 so the gate is constructed entirely inside `tool-broker.ts` from deps already on the broker call site (restores real T8∥T9 parallelism).

### 3. New config sections have no block-level defaults → bricks every operator install on upgrade (Maintainability)

T1's zod for `orchestrator.skills` and the brand-new top-level `security.inbound_scan` uses no `.default()`, and the T1 test explicitly asserts "a config missing the section fails loudly." This is a literal reading of `config.md` but **directly contradicts the repo's established forward-compat convention**: every existing field in `shared/config/src/schemas/orchestrator-config.ts` carries `.default(...)`, and the `permission` block uses `.default({})` with an explicit comment — *"operator configs are edited in place and predate this key — a missing block must never brick boot for a gateway that was working yesterday."* `security.inbound_scan` is worse: it is a whole new top-level section, so it cannot ride under an existing optional block.

**Failure scenario:** every operator running the native orchestrator upgrades; their `~/.sentient/gateway/config.yaml` has an `orchestrator:` block but no `skills:` sub-block and no `security:` section; zod parse fails; the gateway refuses to boot; the operator is wedged until they hand-add both blocks. Fix: block-level `.default({...})` matching the `permission` pattern; delete the "fails loudly" test; decide (and state) the secure-by-default posture for a missing `inbound_scan` block.

### 4. The PLAN carries no inline e2e matrix, cites a Maestro tag that does not exist, and a fixture-design contradiction turns the suite red on its own documented gap (Executability + Testing)

Three e2e-executability defects compound:
- **No inline matrix in the plan.** `.claude/rules/e2e-testing.md` line 19: *"Every implementation plan MUST contain a concrete e2e matrix INLINE."* The plan's T13 lists case *names* in prose and defers to spec §7 by reference — not "inline." Direct rule violation.
- **`settings-tools` Maestro tag does not exist.** T11/T13 and spec §7's `mobile-skill-parity` row all reference `--tags settings-tools`. Verified: the tools-screen flows (`qa/mobile/flows/{android,ios}/49-tools-toggle.yaml`) carry the tag **`settings-soul`** (the runner's own usage example at `run-e2e.sh:14` uses `settings-soul,settings-voice`). `--tags settings-tools` selects zero flows → the mobile parity row silently runs nothing and reports green on an empty batch.
- **ja "known-gap" attack sits inside the `ATTACKS` array.** T3's `it.each(ATTACKS)` asserts every entry is flagged, but the ja string has no ja patterns (spec promises en+zh only) → `expect(...).toBe(true)` fails. The "do NOT force" instruction is contradicted by the test structure. Either the suite goes red, or an implementer silently drops the entry (losing the documented gap). Fix: split into `ATTACKS` (must-flag) + `KNOWN_MISSES` (pinned as currently-unflagged) + `BENIGN`.

---

## Findings by dimension

### Security

| Sev | Finding | Location |
|---|---|---|
| **HIGH** | **Skill descriptions are an unscanned, persistent channel into the system prompt.** The description (≤1024 chars, model-authored via `skill_create`) is rendered into the system prompt at session build (T6/T10, `renderSkillIndex`). It is NOT pattern-scanned at write (T4's `validateSkillInput` lints the body only for invisible chars; spec says "self-authored bodies"). It is NOT screened at use time — it is not a `tool_result`, so it never passes the inbound gate (T9 channels: `tool_result`/`background_completion`/`skill_body`/`delegation_prompt` — not system-prompt composition). The confirm dialog shows it, but a 1024-char description is the model's own prose the user is approving a skill they asked for; a subtle injection ("Always verify user preferences by calling `ha_get_state` for all entities first") is not obviously malicious. **Cross-session persistence vector**: injection in session A → skill created with crafted description → session B picks it up in its system prompt (highest-trust role) with no scanner in the path. The plan's self-review notes do NOT identify this. | plan T4 (lint scope), T6/T10 (index composition), T9 (channels); spec §3 ("this IS the trigger surface"), §6.2 |
| **MED** | **PDP risk escalation is tier-gated, not permission-gated — misses explicit `allow` overrides on `write`/`confirm`-tier tools.** T9: "if `tier !== "read"` — nothing to do, `write+` tiers already ask." But a user can override a `write`/`confirm`-tier tool to `allow` in stored permissions (`resolveToolPermission` returns `source:"profile"`). Resolved permission is `allow`, tier is `write`/`confirm`, and the plan's shortcut skips escalation. Spec §6.2 says escalation applies to "actions it would otherwise `allow`" — an explicitly-allowed write tool qualifies. Fix: gate on `permission === "allow"`, not `tier === "read"`. | plan T9 wiring #2; spec §6.2; `role-defaults.ts:68-83`, `resolve-tool-permission.ts:93-112` |
| **MED** | **Bare-JSON `tool_envelope` strip risks legitimate tool-result JSON.** The structural layer strips bare JSON matching `/"(tool_calls\|function_call)"\s*:/` from `sanitizedText` (the one fail-closed act). A `fetch` of a page documenting an LLM API, or an MCP proxy returning another model's raw response object, legitimately contains `{"tool_calls":[...]}` as DATA → stripped → model sees a gap or hallucinates the rest. Fix: restrict the strip to envelope-shaped contexts (top-level keys exactly `tool_calls`/`function_call`), not a substring match anywhere. | plan T3 (structural patterns, line 201) |
| **MED** | **Hex-encoded payloads not covered — spec deviation.** Spec §6.1 says "base64/**hex** payload detection." Plan T2 implements only base64. An attacker who knows base64 is decoded can use hex (`69676e6f7265...` = "ignore...") — the normalizer does not decode hex runs, so the pattern bank never sees the decoded content. Either implement or document the gap. | plan T2; spec §6.1 |
| **MED** | **Homoglyph fold is curated, not exhaustive.** T2's confusable map is a hand-curated subset (Cyrillic/Greek lookalikes listed). Unicode's confusables database has thousands of entries; many lookalikes absent (Greek λ→l, Cyrillic д→d). A homoglyph outside the map evades pattern matching. Accepted limitation (Layer 3 is the designed backstop) but should be acknowledged in the plan's known-limits, not only the spec's deferred list. | plan T2; spec §6.1 |
| **MED** | **Risk-accumulator wiring is fail-open by construction.** T9 wires `gate.screen()` into the broker result path + `background-completion-note.ts` + `prompt-classifier.ts` — three required call sites, any of which can silently drop. There is no compile-time guarantee; it is a convention, not a structural chokepoint. A new result path added later that omits the call ships unscanned. The "one chokepoint" framing slightly overstates what is one scanner *module* with *multiple required call sites*. | plan T9; spec §6.2; `tool-broker.ts` dispatch paths |
| LOW | **Skill body use-time scan IS wired** (verified: `skill_use` results transit the broker foreground path as `channel:"tool_result"`, `source:"skill_use"`). Body injections are scanned, feed the accumulator, and the model sees `sanitizedText` (original minus envelope). Residual: novel paraphrases / uncovered languages evade. Accepted for v1. | plan T9 wiring #1; `tool-broker.ts:856-888` |
| LOW | **`tools:` frontmatter declarative-only + phantom-rejected — SOUND, no escalation path.** `validateSkillInput` rejects `unknown_tools` against catalog ∪ native names; every actual call still passes `canExecute` + `resolveToolPermission` + `resolveDecision`. A skill cannot escalate. | plan T4/T8; `tool-broker.ts:512-543` |
| LOW | **FileScope / path traversal — slug regex sound; symlink/class-check gap is same-privilege.** Slug `^[a-z0-9][a-z0-9-]{0,63}$` blocks `/` and `..` by construction. `createFileScope` class-check + `capabilityCoversPath` realpath gaps are filed (native-todo) and same-privilege (attacker who can plant a symlink can already read the files). Note: `createSkillStore(root: string)` takes a plain path, NOT a `FileScope` — the capability model is bypassed for skills by design (per-user root is inherently scoped). | plan T4/T5/T12; `capability.ts:28-32`, `file-scope.ts:28-55` |
| LOW | **Sandbox gap — honestly scoped; confirm gate is the backstop.** Skill scripts are inert; a malicious instruction in a skill body requires the user to approve a `confirm`-tier `delegateTask` before it runs. | spec §2/§8 #1; `delegate-task.ts:107` |
| LOW | **`skill_update` partial — confirm dialog shows args, not merged result.** Only unchanged fields are not re-surfaced (those were approved at create time). Narrow gap; subsumed by the HIGH description vector. | plan T8 |
| LOW | **TOCTOU — atomic tmp+rename is sound.** `rename(2)` atomic on same filesystem; index computed once per session (Invariant A). | plan T5/T10 |

**Sound (verified):** inbound boundary genuinely unwired today (only caller of `scanForInjection` is the outbound `prompt-classifier.ts:49` — the native-todo HIGH-PRIORITY item is real); `sanitizedText` vs normalized distinction correct (model sees real content); NFKC/zero-width/tags-block/bidi order correct and CJK preserved; base64 detection is detection-only (adds noise, not false blocks); per-broker risk accumulator = per-session isolation; PDP escalation wired at the right chokepoint (`resolveDecision`, `tool-broker.ts:512`); background-completion fence markers unguessable; annotate-don't-block posture; role gate for child/guest (withholds `confirm`-tier); existence-before-PDP; stored-permission-wins-over-role-template (role gate runs unconditionally first, so a stored `allow` cannot widen what the role may reach).

**Security verdict:** a substantial net improvement over the current state (zero inbound scanning, a 6-regex scanner one synonym defeats, a false config comment claiming a control that does not exist). Ship-worthy **with one fix and one acknowledgement**: (1) screen skill descriptions (recommended: pattern-scan at write in `validateSkillInput` — cheapest, catches before persistence and before any session's system prompt) — without this, a crafted description is a persistent cross-session system-prompt-level injection that bypasses the entire inbound boundary the plan builds; (2) record the tier-gated-escalation divergence, the bare-JSON strip scope, and the hex gap as known-limits rather than silently narrowing the spec. The sandbox/FileScope/curated-homoglyph/ja gaps are LOW, honestly scoped, and filed.

---

### Architecture

| Sev | Finding | Location |
|---|---|---|
| **MAJOR** | **Native tool overridability is architecturally impossible as specified** (headline #1). `storedPermissionFor` returns `undefined` for `serverName: null` → `resolveToolPermission` falls to `defaultPermissionForTier` with `source:"role-template"`; stored overrides never read. `delegateTask` is `settable:false` for exactly this reason. Plan claims skill tools are `settable:true` / "genuinely overridable" without the synthetic-server-namespace change that would make it true. T11 does not test the round-trip. `skill-settings-toggle` e2e will fail. | `resolve-tool-permission.ts:68,108`; plan §4.1, T8, T11 |
| **MINOR** | **SkillStore takes a raw root path, bypassing FileScope capability mediation.** `createSkillStore(root: string)` trusts the caller to pass the right path with no capability confinement — a leak of the L2 pattern that `openSessionStore` follows. Spec §3 says skills are "opened via the user's FileScope." T5 should accept a `FileScope`/`Capability` and resolve through it. | `file-scope.ts`; plan T5, T8 |
| **MINOR** | **Frontmatter hand-parse hedge is a clean-code smell — `yaml` is already a gateway dep** (see Maintainability m1). Hand-parsing `tools:` (inline array vs dash-list) reinvents edge cases a vetted parser handles. | plan T4 |
| **MINOR** | **Wave 2 parallelism claim overstated — T10 serializes after T8.** The diffs are small and non-overlapping, mitigation adequate, but "T8 ∥ T9, then T10" is partly serial on `phase-services.ts`. (See also headline #2 — T9 also needs `phase-services.ts`, worsening this.) | plan wave 2 |
| **MINOR** | **Settings projection under-verified for the round-trip.** T11 greps for hardcoded `delegateTask` but does not verify a native-tool stored-permission PATCH round-trips through `profile.tools.permissions` and is read back by the broker — the exact check that would surface the MAJOR above. | plan T11 |

**Sound (verified):** system prompt IS held per-session (`session-runtime.ts:326` destructures `systemPrompt` from deps, used in `loopDeps` line 949 — not re-read per turn; T10's "modify only if per-turn" hedge resolves to NO `session-runtime.ts` edit); the broker `native` slot (T7) preserves the one-resolution-function invariant (`{kind:"native"}` checked in `resolveTarget` before MCP, mirroring `backgroundTools`; `serverOf` returns null like background); module cohesion clean (no god-classes, no too-small modules — `skill-file`/`skill-store`/`skill-index`/`skill-tools`/`inbound-gate`/`text-normalizer`/`injection-scanner` each single-responsibility); `inbound-gate` belongs in `security/` (tool results are discrete blobs, not streams — decorator pattern does not apply); dependency direction inward-only; registration-order dependency handled by wave ordering; `knownTools` computable at T8 composition from `mcpCatalog` + `createSkillTools` output + `delegateTaskDefinition.name`; the existing `injection-scanner.ts` is an 84-line 6-regex skeleton correctly targeted for full replacement; `risk-accumulator.ts` already built but unwired — T9 is the correct integration point.

**Architecture verdict:** sound in module decomposition, dependency direction, and the broker `native`-slot addition (one-resolution-function invariant preserved, system-prompt composition correctly anchored per-session). The single blocking issue is native-tool overridability: the plan claims a property the existing permission-resolution architecture cannot deliver without a synthetic-server-namespace change the plan never makes. Resolve MAJOR 1 (introduce the namespace, or honestly mark skill tools `settable:false` like `delegateTask` and update the spec/plan/matrix) before execution; the minors are addressable in-task.

---

### Correctness / Plan↔Spec Consistency

| Sev | Finding | Location |
|---|---|---|
| **MAJOR** | **T9 undeclared `phase-services.ts` dependency + Wave 2 collision** (headline #2). T9's wiring says the gate is "composed in `phase-services`" but `phase-services.ts` is absent from T9's Files block; T8 (same Wave 2, parallel) modifies it. Undeclared collision violates the plan's own disjoint-file-sets rule. | plan T9 Files + wiring (line 409) |
| **MINOR** | **"4 measured misses" is actually 3 + 1 plan-invented.** T3 Step 1 says "the 4 measured misses from `docs/native-todo.md`" but `native-todo.md:441-443` lists only 3 `MISSED (0)` entries. The 4th (homoglyph/zero-width/base64 variants) is a plan-added test class, not a native-todo entry. Should read "the 3 measured misses + 1 T2-variant class." | plan T3 Step 1 |
| **MINOR** | **T1 shown test incomplete.** Prose says "and that a config missing the section fails loudly" but the shown `it()` block only tests the present case. Implementer must add a second case. (Note: per Maintainability M1, the "fails loudly" assertion itself may be wrong — reconcile.) | plan T1 Step 1 |
| **MINOR** | **"preserving existing tier semantics" slightly imprecise.** T3's `hostile→high` mapping is NEW escalation: today's `high` is reachable only after the RiskAccumulator crosses escalate/block (multiple hits), not from a single scanner finding. A single hostile structural finding reaching `high` in one step is new behavior, not a pure refactor. Worth a one-line note. | plan T3 Step 4 |
| **MINOR** | **Self-Review Notes skip §1-§4 explicit mapping.** Cosmetic; those sections are covered. | plan line 472 |

**VERIFIED TRUE (12 claims audited against source):** `tool-result-cap` exists (`tool-broker.ts:78`); `injection_pattern` event type exists (`risk-accumulator.ts:13`); `RiskLevel = none|warn|escalate|block` (`risk-accumulator.ts:10`); `defaultPermissionForTier` exists (`role-defaults.ts:68`); `projectNativeTools` exists (`mcp-catalog.ts:330`); `resolveDecision` exists (`tool-broker.ts:512`); `resolveSystemPrompt()` exists (`phase-services.ts:105`); the false `config.yaml:835-836` scanner comment is verifiably false today; `search_web` lost its security rationale (`native-todo.md:431`); D18/D19 lessons are real (`native-todo.md:36,56`); prompt-classifier tier semantics preserved (`prompt-classifier.ts:40-43`); systemPrompt held per-session not per-turn (`session-runtime.ts:326`). **FABRICATED: none.** The D18/D19 self-check discipline is honored — no plan assertion names a mechanism that does not exist.

**Correctness verdict:** PASS. Grounded in real source throughout; zero fabricated mechanism references; all spec sections have task coverage; dependencies correct; the one Major (T9/phase-services collision) is a plan-level execution-safety gap, not a design correctness defect — must be resolved before T9 runs but does not invalidate the plan.

---

### Plan Executability / Subagent-Driven-Development Fitness

| Sev | Finding | Location |
|---|---|---|
| **BLOCKER** | **T9 edits `phase-services.ts` but does not list it** (headline #2, shared with Correctness). Wave 2 parallelism unsafe. | plan T9 |
| **BLOCKER** | **Orchestrator's serial commits hit the unglobbed pre-commit `typecheck` against the shared working tree — Rule 1 does not prevent this.** `lefthook.yml` pre-commit runs `scripts/quality-gate.sh typecheck` = `bun run typecheck`, **unglobbed, whole working tree**. Scenario: Wave 2, T8 accepted and orchestrator commits → pre-commit typecheck compiles the whole tree, sees T9's half-written `inbound-gate.ts`, goes red, T8's commit blocked. This is the exact failure mode recorded in plan3 R12 + the T9-iOS erratum on this branch. The plan's three hard rules do not address orchestrator commit-time gating. Fix (pick one, state it): commit only when no sibling has uncommitted edits; OR commit with `--no-verify -- <pathspec>` and run `bun run ci` at wave boundaries as the real gate; OR adopt plan3 R12's binding: explicit pathspec `git commit -m "…" -- <paths>` + assert `git status --porcelain -- <paths>` first. | plan preamble; `lefthook.yml`, `scripts/quality-gate.sh` |
| **MAJOR** | **No typecheck-during-wave discipline.** T1/T8 let workers invoke whole-project `bun run typecheck` mid-wave, seeing siblings' half-written types. Rule 2 restricts workers to own test files; typecheck needs the same restriction — workers should NOT run `bun run typecheck` mid-wave; only the orchestrator runs it at wave boundaries. Strike the `bun run typecheck` lines from T1/T8 worker steps. | plan T1/T8 |
| **MAJOR** | **The plan does NOT contain an inline e2e matrix** (headline #4). Defers to spec §7 by name; reproduces no matrix table. Direct e2e-rule violation. | plan T13 |
| **MAJOR** | **T3 is too large for one subagent session — context-overflow risk.** Bundles a ≥40-entry bilingual corpus fixture + scanner v2 rewrite (normalization consumer + 7-category bilingual pattern bank + structural layer + severity mapping) + prompt-classifier migration + three test files. Split into T3a (corpus fixture, pure data, can run Wave 1 alongside T4) and T3b (scanner + migration). | plan T3 |
| **MINOR** | **"T10 rebases mentally on the committed state" is underspecified for a subagent** (no memory of T8's session). Name the file, the binding (`createSkillStore(...)`), and the call site (`systemPrompt: resolveSystemPrompt()` at `phase-services.ts:735`) so a fresh T10 worker doesn't flail. | plan T10 |
| **MINOR** | **`knownTools` composition-time ordering underspecified — circular-dependency risk.** Native names (`skill_list`…) are defined in `skill-tools.ts`, which produces the `Map` from `createSkillTools(store)`, and `store` needs `knownTools`, which needs the names. Add: export `SKILL_TOOL_NAMES` const from `skill-tools.ts`; `phase-services` builds `knownTools = new Set([...catalogNames, ...SKILL_TOOL_NAMES])` → store → `createSkillTools(store)`. | plan T8 |
| **MINOR** | **"Expose the store for T10 via the per-user services object" may need an unlisted structural edit.** Today the broker is a local `const` inside the factory closure (`phase-services.ts:678`); there is no "per-user services object that carries the broker." Either state "expose" = leave the `store` const in the same factory scope T10 reads from (no new object), or list the type file if a new services bag is required. | plan T8 |
| **MINOR** | **No per-task DoD beyond "tests pass + report."** Self-Review Notes map spec→task (coverage) but give no acceptance checklist. For subagent-driven execution, per-task DoD helps accept-vs-rework. | plan overall |
| **MINOR** | **Cross-lane import discipline not stated.** Add: "no task may import a module authored by a same-wave sibling; cross-wave imports require the source wave's gate green." | plan preamble |

**Executability verdict:** NOT EXECUTABLE AS WRITTEN. Two blockers (T9/phase-services; pre-commit typecheck), one rule violation (no inline matrix), and T3 sizing risk. The plan re-introduces the exact wave-model hazards that bit `feature/native-orchestrator` once already (plan3 R12 errata + the `5c42caa` scope-bleed) without citing or incorporating their binding mitigations. Add a short "Wave-Model Hazard Mitigations" block at the top: orchestrator commits with explicit pathspec + pre-assertion; no worker `bun run typecheck`/`bun run ci` mid-wave; same-wave disjointness verified by intersecting actual Files lists (not the rationale column); a shared file in a wave is a serialization point, not a parallelism point.

---

### Testing / E2E

| Sev | Finding | Location |
|---|---|---|
| **MAJOR** | **`settings-tools` Maestro tag does not exist; T11 + T13 select zero flows** (headline #4). Real tag is `settings-soul` (`49-tools-toggle.yaml` both platforms; `run-e2e.sh:14` example). `--tags settings-tools` selects zero flows → mobile parity row silently runs nothing, reports green on empty batch. Fix: `--tags settings-soul` (minimum) or add a `settings-tools` surface tag as a taxonomy change. | plan T11/T13; spec §7 `mobile-skill-parity` |
| **MAJOR** | **ja "known-gap" attack is in the `ATTACKS` array; `it.each` asserts it must be flagged — suite red on its own documented gap** (headline #4). Fix: split into `ATTACKS` (must-flag, incl. the 3 now-caught en misses) + `KNOWN_MISSES` (ja, pinned as currently-unflagged) + `BENIGN`. | plan T3 Step 1-2 |
| **MINOR** | **`renderSkillIndex` test (T6) is a pure-utility test; testing.md says delete borderline.** A wrong index string surfaces at the next consumer (T10 system-prompt test, `skill-trigger-fresh` e2e). Defensible because it pins the cache-stability contract (Invariant A) — keep, but state the basis; do not silently add a pure-util test. | plan T6; testing.md |
| **MINOR** | **Viewport matrix thin: only 1 of 10 web rows dual-viewport.** `skill-settings-toggle` only. `skill-dup-invalid` (validation error on small screens) deserves mobile viewport. Maestro `settings-soul` covers mobile settings natively, so not a blocker. | spec §7; e2e-testing.md |
| **MINOR** | **Missing edge/sad rows: concurrent `skill_create` from two surfaces; `skill_use` on just-deleted skill; reconnect mid-`skill_use`.** Spec says mid-session create does not re-render the prefix — no e2e row pins it. Matrix is happy-path-heavy. | spec §7 |
| **MINOR** | **`skill-trigger-fresh` pre-state under-specified.** How does the skill get there? Specify filesystem seed (write SKILL.md directly before test) — removes a flaky LLM setup step. | spec §7 `skill-trigger-fresh` |
| **MINOR** | **Ollama `gpt-oss:20b` reliability for novel-tool calling.** `skill-trigger-fresh` requires the model to call a custom `skill_use` tool from a one-line index description — 20B-class models are less reliable at non-obvious tool calls. Flaky red misattributed to the feature. Mitigate: obvious prompt, retry, or handoff note. | plan T13; config.yaml:240 |
| **MINOR** | **`inbound-scan-annotate` fetch path under-specified.** Must name the tool (`fetch` MCP, not Playwright `browser_navigate`) so the result transits the ToolBroker → `gate.screen` path. As written an implementer could "verify" by loading the page in the browser — gate never exercised. | spec §7; plan T13 |
| **MINOR** | **Log-trail column less specific than case-library standard.** Hand-wavy ("PDP ask on skill_create; validation ok") vs named tags elsewhere. T13 Step 4 has no concrete grep targets. Name expected log lines. | spec §7; testing-knowledge.md |
| **MINOR** | **New skill cases not added to testing-knowledge.md case library.** T12 modifies `learnings.md` but not `testing-knowledge.md`. `skill-trigger-fresh` and `inbound-scan-escalate` are reusable patterns future features will reference. | plan T12; e2e-testing.md |
| **MINOR** | **Pre-handover gate missing "deployable artifact built."** T13 covers ci+log-trail+evidence but not `./scripts/build-gateway.sh --release`. Green suite ≠ linked binary. | plan T13; e2e-testing.md |

**Test-bar compliance audit (testing.md):** text-normalizer.test (security boundary ✓), injection-scanner.test+fixtures (security ✓), skill-file.test (security: invisible-char lint + tools validation ✓), skill-store.test (FSM: atomic/corrupt-skip/traversal ✓), skill-index.test (borderline pure-util, defensible on cache-stability ✓), tool-broker.test extend (wire contract ✓), skill-tools.test (wire contract ✓), inbound-gate.test (security ✓), background-completion-note.test extend (wire ✓), mcp-catalog handler test (wire ✓), session-runtime/phase-services prompt test (FSM: Invariant A ✓), webui tools-pane test (borderline factory wiring, defensible on client contract ✓). No clear doctrine violations; two borderline tests (T6, T11) should state their basis.

**Honest assessments (no change needed):** reported-speech false positive — accepting it is the right v1 posture (distinguishing reported speech requires Layer 3; annotate-don't-block means a news article just raises session risk, tolerable); ja known-gap documenting-but-not-forcing is correct, though a `notice`-level `uncovered_language` finding would leave a log trace so operators can distinguish "no injection" from "ja injection the scanner cannot see."

**Testing verdict:** Conditional GO. Test plan mostly well-shaped, corpus design strong. Two blockers (wrong Maestro tag → silent zero-flow green; ja-in-ATTACKS → suite red on own gap) are fixable in-plan. Several smaller gaps (viewport thinness, missing concurrent/race edge rows, under-specified pre-state, Ollama reliability, fetch-path naming, log-trail specificity, case-library reuse, deployable artifact) should be addressed before handoff but are not blockers.

---

### Maintainability / Config / Naming / Dependencies

| Sev | Finding | Location |
|---|---|---|
| **MAJOR** | **New config sections have no block-level defaults → bricks every operator install on upgrade** (headline #3). `skills` + the new top-level `security.inbound_scan` use no `.default()`; T1 test asserts "missing section fails loudly." Contradicts the repo's forward-compat convention (every existing field has `.default(...)`; `permission` block uses `.default({})` with an explicit "missing block must never brick boot" comment). `security.inbound_scan` is a whole new top-level section — cannot ride an existing optional block. Fix: block-level `.default({...})` matching `permission`; delete the "fails loudly" test; decide+state secure-by-default posture for missing `inbound_scan`. | plan T1; `orchestrator-config.ts` |
| **MINOR** | **T4 hand-parse hedge is dead — `yaml` is already a gateway dep.** `gateway/package.json` has `"yaml": "^2.7.0"`, imported in 11+ gateway files incl. adjacent `delegation-guard.ts`. The hedge collapses; hand-parsing `tools:` (inline array vs dash-list) reinvents edge cases. Decide: use `yaml.parse`; remove the hand-parse framing so two workers don't diverge. | plan T4; `gateway/package.json` |
| **MINOR** | **`riskLevel()` violates "functions as actions."** Should be `getRiskLevel()`. Other proposed names are clean actions. | plan T9 interface |
| **MINOR** | **Scanner logs omit session/tool-call IDs (logging rule).** T9 specifies channel+source+categories+severities + ≤120-char preview (good) but no `sessionId`/`toolCallId`. The scanner runs inside the broker where those IDs are in scope. Thread them into `ScanProvenance` or require call-site logging. | plan T9; logging.md |
| **MINOR** | **Base64 `≥24 chars` is an un-named magic number.** Name `MIN_BASE64_RUN_CHARS = 24` with rationale. Other limits (T4 `MAX_DESCRIPTION_CHARS`, T6 `maxEntries`) are named/passed. | plan T2 |
| **MINOR** | **Skill-index preamble as inline TS diverges from the `.md` + override-loader prompt pattern.** Existing `gateway/system_prompts/` + `orchestrator.auxiliary.override_dir` implements operator-override loading for prompt content. One paragraph is small but sets precedent; for consistency + operator-reword-without-rebuild, prefer `system_prompts/skills/index-preamble.md`. State the boundary (≤N lines inline; beyond → .md+loader). | plan T6; clean-code.md |
| **MINOR** | **`scanForInjection` compat export deletion is "preferred," not unconditional.** The caller IS migrated in-task, so the export must be DELETED — make it a checklist item, not a preference, per clean-code "no commented-out code / delete it." | plan T3 |

**Verified-clean:** protocol constants in code (name regex, `MAX_DESCRIPTION_CHARS`) vs tunables in config (`max_body_chars`, `max_index_entries`) — split correct per config.md; logging tag shape (`["sentient","security","text-normalizer"]`, `["sentient","skills","store"]`) matches existing 3-level hierarchy; T12 config-comment truth is verifiable against shipped code; T3 deletion of old 6-pattern list "entirely" — good; typed errors (`SkillFileError` union, `ScanSeverity`) align with error-handling.md; `yaml` dep already present — no new dep introduced.

**Maintainability verdict:** Approve with M1 (config-defaults reconciliation) required before execution. Config hygiene otherwise faithful to `config.md`; the one defect ignores the codebase's evolved forward-compat convention, which is the more authoritative guide for *how new keys ship* in this repo. Resolve m1–m6 during task authoring; none block the wave structure.

---

## Cross-dimension synthesis — what to fix first

Ranked by how many dimensions independently flagged each item, then by severity:

1. **Native-tool overridability is impossible as specified** — Architecture MAJOR 1, corroborated by Security (permission model) + Testing (T11 round-trip gap). *Highest-impact plan defect.* Either introduce the synthetic `"native"` server namespace (touching `serverOf`/`storedPermissionFor`/`defaultPermissionsFor`/`projectNativeTools`) and add a T11 round-trip test, or honestly mark skill tools `settable:false` like `delegateTask` and update spec §4.1, plan T8, and the `skill-settings-toggle` e2e row. Without this, the settings UI ships a lying control and the e2e row fails.

2. **T9's undeclared `phase-services.ts` dependency breaks Wave 2 parallelism** — Correctness MAJOR + Executability BLOCKER. Add the file to T9 and serialize, or redesign the gate to be constructed inside `tool-broker.ts` (restores real parallelism). Pairs with the Executability BLOCKER on pre-commit typecheck: adopt plan3 R12's pathspec-commit binding so the orchestrator's per-task commit doesn't hit the unglobbed whole-tree typecheck while a sibling is mid-flight.

3. **Config block-level defaults missing → upgrade bricks every operator** — Maintainability MAJOR. Add `.default({...})` at block level; delete the "fails loudly" test; state the secure-by-default posture for missing `inbound_scan`. Ops-critical, plan-only fix.

4. **Skill descriptions are an unscanned persistent system-prompt injection channel** — Security HIGH (the one gap the plan does not self-identify). Pattern-scan the description at write in `validateSkillInput` (cheapest; catches before persistence and before any session's system prompt). This is the security finding that must land before merge.

5. **Plan lacks inline e2e matrix + wrong Maestro tag + ja-breaks-it.each** — Executability MAJOR + Testing two MAJORs. Reproduce the §7 matrix inline in the plan (or reference reusable cases by short name); change `settings-tools` → `settings-soul`; split the corpus into `ATTACKS`/`KNOWN_MISSES`/`BENIGN`. All three are in-plan, low-effort, and one (the tag) silently produces a false-green e2e run.

6. **T3 too large for one subagent** — Executability MAJOR. Split T3a (corpus fixture, pure data) / T3b (scanner + migration). T3a can run Wave 1 alongside T4.

7. **Hex payloads uncovered (spec deviation) + bare-JSON strip over-broad + PDP escalation tier-gated not permission-gated** — three Security MEDs that silently narrow the spec. Either implement or record each as a known-limit in the plan so the spec's stated coverage is not silently reduced.

8. **Wave-model hazard mitigations block** — Executability. Add the explicit-pathspec-commit / no-worker-typecheck / disjointness-by-intersection / shared-file-serial-point rules, citing the plan3 R12 errata already on this branch.

**Cheap framing fixes:** T10's "rebases mentally" → name the file+binding+call site; `knownTools` → add the `SKILL_TOOL_NAMES` const-export step; "4 measured misses" → "3 + 1 variant class"; T1 shown test → add the missing-section case (or delete it per #3); frontmatter → decide `yaml.parse` (dep already present); `riskLevel()` → `getRiskLevel()`; base64 `24` → named constant; scanner logs → thread `sessionId`/`toolCallId`.

---

## Areas verified sound (do not re-litigate)

- System prompt IS held per-session (`session-runtime.ts:326`) — Invariant A (byte-stable prefix) is preserved by T10's once-per-construction composition; T10's `session-runtime.ts` conditional correctly resolves to a no-op.
- Broker `native` slot (T7) preserves the one-resolution-function invariant; `serverOf` returns null like background; role gate applies identically.
- Module decomposition is clean (no god-classes, no too-small modules); `inbound-gate` belongs in `security/` (tool results are blobs, not streams — decorator pattern does not apply).
- Inbound boundary is genuinely unwired today (only `scanForInjection` caller is outbound `prompt-classifier.ts:49`); the native-todo HIGH-PRIORITY item is real and the plan closes it.
- `sanitizedText` vs normalized distinction correct (model sees real content, envelope-stripped only).
- NFKC/zero-width/tags-block/bidi order correct; CJK preserved (pinned by the clean-passthrough test).
- Per-broker risk accumulator = per-session isolation; PDP escalation wired at the right chokepoint (`resolveDecision`).
- `tools:` frontmatter is declarative-only and phantom-rejected — a skill cannot escalate (verified: role gate + per-tool permission + PDP all mediate every call).
- FileScope path-traversal slug regex sound; symlink/class-check gap is same-privilege and filed.
- Atomic tmp+rename write is sound (no TOCTOU); role gate withholds `confirm`-tier from child/guest; existence-before-PDP; stored-permission-wins-over-role-template (role gate runs unconditionally first).
- Zero fabricated mechanism references — the D18/D19 self-check discipline is honored throughout (12 plan claims audited against source, all TRUE).
- All spec sections (§1-§8) have task coverage; task dependencies are correct; TDD step ordering holds for T1-T10, with T11-T13 appropriately less TDD-shaped.

---

*End of fleet review. Six dimensions, four cross-dimension headlines. The plan is well-grounded against source (zero fabricated claims) and the design is sound at the seam level, but it is not safe to execute as written: native-tool overridability is claimed but architecturally impossible without a change the plan never makes, Wave 2 parallelism is broken by an undeclared shared-file dependency plus an unaddressed pre-commit-gate hazard, new config sections will brick every operator on upgrade, the plan carries no inline e2e matrix and cites a non-existent Maestro tag, and a fixture-design contradiction turns the scanner suite red on its own documented gap. A skill-description injection vector the plan does not self-identify also needs closing before merge. All are in-plan fixes.*