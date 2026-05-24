# Wizard Step Registry — Design

**Status:** Draft — pending user review
**Date:** 2026-05-03
**Branch:** `feature/chat-ux-refinement` (worktree `setup-wizard-writable-layout`)
**Scope:** Architecture refactor only. Security and Hermes secret-isolation deferred to follow-up specs.

---

## Goal

Make the setup wizard future-proof for adding steps. Today, adding a single step requires coordinated edits across ~11 files (cursor union, transition sets ×2, server handler, server back-target if/else, client visualStep mapping, client render branch, client stepper, hook duplicate cursor union, state.yaml.tmpl, plus tests). The state machine is glued together by hand-edited code in 5+ places. This spec replaces that with a single declarative registry shared between server and client; adding a step becomes one entry in the registry plus one file on each side.

Three concrete pain points addressed:

1. **State machine duplicated.** `WizardCursor` literal union exists in `gateway/src/admin/install-state.ts` and again in `gateway/webui/src/hooks/use-install-state.ts`. Drift hazard.
2. **`complete` cursor overloaded.** Maps to two different screens (AccountWizard step then Finish step), gated by client-only `adminDone` boolean. Server cursor lies — true completion gate is `auth/setup` succeeded **then** `wizard/finalize` flipped `bootstrap_complete`. Reload mid-admin works but the contract is fragile.
3. **`wizard.ts` bespoke imperative router.** 451 lines, 9 handlers, no abstraction over "step handler". Each new step is a copy-paste of the previous handler shape.

Out of scope (acknowledged but deferred):

- LAN security hardening (CSRF, SSRF on test-provider, apply-status auth gate). User flagged as acceptable for trusted-LAN deployment model.
- Hermes-side LLM key isolation via gateway-hosted LLM proxy. Substantial cross-cutting change deserving its own spec.
- Version probe coverage for ddg/ha/ma/egress-proxy. Tracked separately.

---

## Architecture

The wizard is modelled as a linear directed chain of steps. Each step has a stable id, a zod schema for its advance request body (or null for poll-only / no-body steps), an `advanceTo` next step, and an optional `backTo` previous step. The chain lives in `shared/wizard/steps.ts` and is the single source of truth for cursor enumeration, transition validity, step ordering, and visual stepper labels. Both gateway server and webui import it.

Each step's server-side logic is one file: validate request, apply side effects, optionally fire post-advance hook. A shared step-pipeline runs the canonical sequence (gate → parse → apply → advance → post-advance) so individual step files contain only step-specific code. The client mirrors this: each step is one component file, registered in a step-id → component map; `wizard-shell.tsx` collapses to a thin dispatcher over the registry.

Two structural changes accompany the refactor:

- The `complete` cursor is replaced by an explicit `admin` cursor (when AccountWizard mounts) followed by a `finish` cursor (when StepFinish mounts). The terminal completion gate is `bootstrap_complete: bool` on the install state, not the cursor itself. `adminDone` client state is dropped — server cursor is always the source of truth for which step is visible.
- `gateway/src/bootstrap/create-gateway-services.ts` (797 lines) is split into phased init files. This is required because the bootstrap is the assembly point for both the new wizard handler dependencies and the existing TTS / STT / orchestrator wiring; doing the wizard refactor without splitting bootstrap leaves one of the two largest files in the repo unchanged.

---

## Components

### `shared/wizard/steps.ts` — declarative chain

```ts
import { z } from "zod";

export type WizardStepId =
  | "provider"
  | "voice"
  | "secrets"
  | "bringup"
  | "admin"
  | "finish";

export interface WizardStepDef<Body = unknown> {
  id: WizardStepId;
  /** Next step in the chain. null = terminal step (finish). */
  advanceTo: WizardStepId | null;
  /** Previous step user can retreat to. null = no Back button. */
  backTo: WizardStepId | null;
  /** Zod schema for POST body. null = step has no advance POST
   *  (e.g. bringup polls; admin delegates to /auth/setup). */
  bodySchema: z.ZodType<Body> | null;
  /** Stepper label. */
  label: string;
}

export const WIZARD_STEPS: ReadonlyArray<WizardStepDef> = [
  { id: "provider", advanceTo: "voice",   backTo: null,       bodySchema: ProviderBody, label: "Provider" },
  { id: "voice",    advanceTo: "secrets", backTo: "provider", bodySchema: VoiceBody,    label: "Voice"    },
  { id: "secrets",  advanceTo: "bringup", backTo: "voice",    bodySchema: SecretsBody,  label: "Services" },
  { id: "bringup",  advanceTo: "admin",   backTo: null,       bodySchema: null,         label: "Bringup"  },
  { id: "admin",    advanceTo: "finish",  backTo: null,       bodySchema: null,         label: "Account"  },
  { id: "finish",   advanceTo: null,      backTo: null,       bodySchema: null,         label: "Finish"   },
];
```

Cursor type is `WizardStepId`. The body schemas referenced above (`ProviderBody`, `VoiceBody`, `SecretsBody`) live in the same `shared/wizard/steps.ts` file alongside `WIZARD_STEPS` so server and client share both the chain shape and the request validators. The schemas themselves are mechanical lifts of the existing zod definitions in `gateway/src/api/handlers/wizard.ts` — no semantic change.

Forward and reverse transition sets are derived at module load:

```ts
export const VALID_FORWARD: ReadonlySet<string> = new Set(
  WIZARD_STEPS.filter(s => s.advanceTo).map(s => `${s.id}→${s.advanceTo}`),
);
export const VALID_REVERSE: ReadonlySet<string> = new Set(
  WIZARD_STEPS.filter(s => s.backTo).map(s => `${s.id}→${s.backTo}`),
);
```

`install-state.ts` imports these instead of hand-coding sets.

### Server: `gateway/src/api/wizard/`

Layout:

```
gateway/src/api/wizard/
  index.ts                  ← exports createWizardHandler — replaces handlers/wizard.ts
  router.ts                 ← URL → meta-handler | step-handler dispatch
  step-pipeline.ts          ← shared validate → side-effects → advance flow
  steps/
    provider.ts             ← StepHandler exports
    voice.ts
    secrets.ts
    bringup.ts              ← exports retry + complete-bringup helpers; no advance body
    admin.ts                ← cursor advance triggered by /auth/setup, not /wizard/advance
    finish.ts               ← /wizard/finalize body trigger (cursor → bootstrap_complete=true)
  meta/
    unlock.ts
    back.ts                 ← target derived from VALID_REVERSE; no hardcoded if/else
    test-provider.ts
    catalog.ts              ← active-llm + models + voices
```

Each step file exports a `StepHandler`:

```ts
export interface StepHandler<Body> {
  id: WizardStepId;
  /** Pure: read JSON, zod-validate. Returns "invalid-body" on fail. */
  parse(req: Request): Promise<Result<Body, "invalid-body">>;
  /** Atomic side-effect application. Returns the failure kind on error. */
  apply(deps: WizardDeps, body: Body): Promise<Result<void, StepError>>;
  /** Optional fire-and-forget hook AFTER cursor advance lands. Use sparingly:
   *  today only secrets-step uses it (orchestrator.applyAll kick). */
  postAdvance?(deps: WizardDeps): void;
}
```

`step-pipeline.ts` runs the canonical sequence:

```ts
async function runStep<B>(deps: WizardDeps, handler: StepHandler<B>, def: WizardStepDef, req: Request) {
  const gate = await assertWizardOpen(deps.installState, def.id);
  if (gate) return gate;
  const parsed = await handler.parse(req);
  if (!parsed.ok) return jsonResponse(400, { error: "invalid-body" });
  const applied = await handler.apply(deps, parsed.value);
  if (!applied.ok) return jsonResponse(500, { error: "step-apply-failed", kind: applied.error.kind });
  if (def.advanceTo) {
    const advance = await deps.installState.advanceCursor(def.id, def.advanceTo);
    if (!advance.ok) return jsonResponse(409, { error: "transition", kind: advance.error.kind });
  }
  handler.postAdvance?.(deps);
  return jsonResponse(200, { ok: true, cursor: def.advanceTo });
}
```

`router.ts` dispatches to the registry by step id:

```ts
const STEP_HANDLERS: Record<WizardStepId, StepHandler<unknown> | null> = {
  provider: providerStep,
  voice:    voiceStep,
  secrets:  secretsStep,
  bringup:  null,            // bringup advances via /wizard/complete-bringup
  admin:    null,            // admin advances via /auth/setup
  finish:   finishStep,
};
```

POST `/api/v1/wizard/<step>` finds the handler in the registry and runs `runStep`. Meta endpoints (unlock, back, retry-bringup, complete-bringup, finalize, test-provider, catalog GETs) live in `meta/`.

`back.ts` derives target from `WIZARD_STEPS`:

```ts
const def = WIZARD_STEPS.find(s => s.id === parsed.from);
if (!def?.backTo) return jsonResponse(409, { error: "no-back-target" });
const result = await deps.installState.retreatCursor(def.id, def.backTo);
```

### Client: `gateway/webui/src/components/wizard/`

Layout (most files already exist; refactor formalizes the pattern):

```
gateway/webui/src/components/wizard/
  wizard-shell.tsx          ← uses WIZARD_STEPS + STEP_COMPONENTS map
  step-registry.tsx         ← maps WizardStepId → component
  wizard-stepper.tsx        ← consumes WIZARD_STEPS labels + current
  unlock-gate.tsx           ← unchanged
  shared/                   ← unchanged
  steps/
    step-provider.tsx
    step-voice.tsx
    step-secrets.tsx
    step-bringup.tsx
    step-admin.tsx
    step-finish.tsx
```

`step-registry.tsx`:

```tsx
import type { WizardStepId } from "@sentient/shared/wizard/steps";

export interface StepProps {
  onAdvance: () => Promise<void>;
  onBack?: () => Promise<void>;
}

export const STEP_COMPONENTS: Record<WizardStepId, ComponentType<StepProps>> = {
  provider: StepProvider,
  voice:    StepVoice,
  secrets:  StepSecrets,
  bringup:  StepBringup,
  admin:    StepAdmin,
  finish:   StepFinish,
};
```

`wizard-shell.tsx` (~30 lines) becomes:

```tsx
export function WizardShell({ state, onChange }: WizardShellProps) {
  if (!state.unlock_verified) {
    return <div class="wizard-page"><div class="wizard-box"><UnlockGate onUnlocked={onChange} /></div></div>;
  }
  const Step = STEP_COMPONENTS[state.wizard_cursor];
  const def  = WIZARD_STEPS.find(s => s.id === state.wizard_cursor);
  return (
    <div class="wizard-page"><div class="wizard-box">
      <header class="wizard-box__header">
        <h1>Welcome to Sentient</h1>
        <WizardStepper steps={WIZARD_STEPS} current={state.wizard_cursor} />
      </header>
      <div class="wizard-box__content">
        <Step
          onAdvance={onChange}
          onBack={def?.backTo ? () => postBack(def.id) : undefined}
        />
      </div>
    </div></div>
  );
}
```

Each step component receives the same `{ onAdvance, onBack? }` shape. No more bespoke prop passing per step. `visualStep()` mapping deleted. `adminDone` state deleted.

### `admin` cursor: explicit, server-driven

Today: cursor `complete` covers both AccountWizard and StepFinish. AccountWizard sits in front of StepFinish via client `adminDone` boolean. `/auth/setup` does not touch the cursor; client refetches install-state, which still says `complete`, and renders AccountWizard or StepFinish based on `adminDone`.

After: cursor `admin` covers AccountWizard. Cursor `finish` covers StepFinish. `/auth/setup` handler explicitly advances `admin → finish` on success. Pure cursor advance, idempotent. Reload mid-admin lands on AccountWizard via cursor=admin. Reload after admin success lands on StepFinish via cursor=finish.

`wizard/finalize` keeps its current responsibility: assert cursor=finish and bootstrap_complete=false, flip bootstrap_complete=true, clear unlock code.

### Bootstrap split: `gateway/src/bootstrap/`

Today `create-gateway-services.ts` is 797 lines: load config, init logging, build secrets store, build internal secrets, build install state, build unlock code, build system orchestrator (with boot-reconcile gate), build TTS service factory, build STT factory, build LLM factory, build cerebrum factory, build content-TTS factory, build MCP host, wire all routes, mount handlers, build WS server. One function is the wiring superglue for the whole gateway.

Split into phases (each file under 200 lines):

```
gateway/src/bootstrap/
  index.ts                 ← createGatewayServices, ~80 lines, calls phases in order
  phase-config.ts          ← loadStartupConfig + logging init
  phase-state.ts           ← install-state, secrets-store, internal-secrets, unlock-code
  phase-orchestrator.ts    ← system orchestrator + boot-reconcile gate
  phase-services.ts        ← TTS, STT, cerebrum, LLM, MCP host (delegates to existing factories)
  phase-routes.ts          ← handler instantiation + router build
  adapter-registry.ts      ← unchanged
  cerebrum-factory.ts      ← unchanged
  content-tts-factory.ts   ← unchanged
  create-mcp-host.ts       ← unchanged
  llm-factory.ts           ← unchanged
  stt-factory.ts           ← unchanged
  tts-factory.ts           ← unchanged
```

Each phase returns its built objects to `index.ts` which threads them into the next. Existing factories under `bootstrap/` are kept as-is.

---

## Data flow

Wizard advance (server side):

```
POST /api/v1/wizard/<step>
  └─→ router.ts dispatches by step id
        └─→ step-pipeline.runStep(handler, def, req)
              ├─ assertWizardOpen(installState, def.id)            ← 401/409/410 gates
              ├─ handler.parse(req)                                 ← zod validation
              ├─ handler.apply(deps, body)                          ← side effects
              ├─ installState.advanceCursor(def.id, def.advanceTo)  ← single cursor write
              └─ handler.postAdvance?.(deps)                        ← orchestrator kick (secrets only)
```

Wizard back (server side):

```
POST /api/v1/wizard/back  { from: "<step>" }
  └─→ meta/back.ts
        ├─ WIZARD_STEPS.find(s => s.id === from).backTo  ← target derivation
        └─ installState.retreatCursor(from, backTo)
```

Auth setup → admin cursor advance:

```
POST /api/v1/auth/setup
  └─→ handlers/auth.ts handleSetup
        ├─ provisioner creates user
        ├─ token issuance
        └─ NEW: if installState.cursor === "admin": advanceCursor("admin", "finish")
```

Migration (state.yaml schema bump v0.1.0 → v0.2.0):

```
read state.yaml
  if schema_version === "0.1.0" and wizard_cursor === "complete":
    if any user exists in users.json:
      wizard_cursor = "finish"
    else:
      wizard_cursor = "admin"
  schema_version = "0.2.0"
  write state.yaml
```

Migration runs once at install-state.load() if the read schema_version is older. Pure data fix, no handler change.

---

## Error handling

Step pipeline failure modes and HTTP mapping:

| Stage         | Failure                                | HTTP | Body                                      |
|---------------|----------------------------------------|------|-------------------------------------------|
| gate          | `bootstrap_complete=true`              | 410  | `{ error: "wizard-closed" }`              |
| gate          | `unlock_verified=false`                | 401  | `{ error: "unlock-required" }`            |
| gate          | cursor mismatch                        | 409  | `{ error: "wizard-cursor-mismatch", current_cursor, expected_cursor }` |
| parse         | invalid JSON / zod fail                | 400  | `{ error: "invalid-body" }`               |
| apply         | secrets-store io fail                  | 500  | `{ error: "step-apply-failed", kind: <store-error-kind> }` |
| apply         | provisioner / orchestrator fail        | 500  | same                                      |
| advance       | cursor write race / invalid transition | 409  | `{ error: "transition", kind: <state-error-kind> }` |

Step handlers `Result<void, StepError>` use a discriminated union of step-error kinds. Client maps known kinds to friendly UI; unknown kinds get a generic "Could not save. Check the gateway log." with the gateway log carrying the full kind + IDs for debugging.

`postAdvance` is fire-and-forget. Failure is logged, never propagated. Today only `secrets.postAdvance` uses this — kicks `orchestrator.applyAll()`. If the kick fails, the bringup step polls and surfaces the failure via `apply-status`. Same UX as today.

---

## Testing

Per `.claude/rules/testing.md`, tests pin contracts at process boundaries. With registry-driven dispatch, the contracts are: HTTP shape per step, cursor side effect per advance, transition validity per pair.

Tests kept after refactor:

- **Per step file** — one contract test asserting: 200 path writes the expected secret(s), advances cursor to `def.advanceTo`, returns `{ ok: true, cursor }`. Bad-body path returns 400. Bootstrap-complete path returns 410. (6 step files × 1 happy + 2 unhappy = ~18 tests.)
- **Transition matrix** — for each adjacent pair in `WIZARD_STEPS`, advance cursor then back-cursor where `backTo` set; assert state.yaml round-trips correctly.
- **Migration** — state.yaml v0.1.0 with `complete` cursor lifts cleanly to v0.2.0. Both branches (admin user exists / does not exist) covered.
- **Auth-setup cursor side effect** — POST /auth/setup with cursor=admin advances to finish. With cursor != admin, cursor untouched.
- **Frontend wizard-shell** — pin that the registry-driven dispatch renders the correct step component for each cursor value.

Tests deleted:

- Internal handler-shape tests in the existing `wizard.test.ts` that vanish with the split. The contract tests above subsume them.
- The hardcoded `visualStep` mapping test (function deleted).
- The `adminDone` race-condition test (state deleted).

Manual smoke procedure (added to `agents/docs/testing-knowledge.md`):

```
1. rm -rf ~/.sentient/
2. Bring up stack. Read unlock code from log banner.
3. Walk wizard fresh: provider → voice → secrets → bringup → admin → finish.
4. Confirm each Back button works where present (voice → provider, secrets → voice).
5. Mid-admin reload: refresh page during AccountWizard step. Should land back on AccountWizard.
6. Post-admin reload: complete admin step, refresh page. Should land on StepFinish.
7. Confirm cursor in ~/.sentient/state.yaml matches each visible step.
```

---

## Risks

- **In-progress installs across upgrade.** A user mid-wizard at upgrade time has v0.1.0 schema. The migration handles this; smoke test must include resume-from-complete-cursor cases.
- **state.yaml schema bump backward compatibility.** Migration is one-way (v0.1.0 → v0.2.0). Downgrade is not supported. Operators must not roll back the gateway across this bump without manually rewriting state.yaml. Documented in `deploy/setup.py` migration changelog.
- **Hidden assumption that `complete` cursor maps to two screens.** Any code path outside the wizard that branches on cursor=complete needs review. Search target: `wizard_cursor === "complete"` across the repo. Expected hits: install-state finish() guard (will be updated to require cursor=finish), test files, the deprecated visualStep mapping.
- **AccountWizard reuse.** Component is shared between first-admin (mode=first-admin) and admin-add-user (mode=admin) flows. `admin` cursor only governs first-admin path. Settings-mode admin-add-user keeps current prop shape and is untouched.
- **Cursor-mismatch fail-loud loop.** Existing 409 handling in client refetches install-state and re-renders the correct step. The new pipeline preserves that. Verified by transition-matrix test.

---

## Out of scope (acknowledged)

- LAN security hardening (CSRF on wizard POSTs, SSRF on `/wizard/test-provider`, auth gate on `/api/v1/system/apply-status`). User flagged trusted-LAN deployment model; deferred.
- Hermes-side LLM API key isolation via gateway-hosted LLM proxy. Substantial cross-cutting change. Deserves its own brainstorm.
- Version probe coverage for ddg-mcp / ha-mcp / ma-mcp / egress-proxy. Deserves its own spec because of docker-label fallback design and `ServiceVersionRecord` schema generalization.
- Sync getter cleanup on secrets-store (`getActiveLlmSync`, `getProviderSecretsSync`, `getFishAudioKeySync` — replace with scoped accessors). Pure secret-hygiene cleanup, low coupling to wizard refactor.
- Unlock-code log redaction (`log.info("unlock-code.banner", { code })`).
- Raw `reason` leak in install-state.ts and services-versions.ts 500 responses.

These belong in a follow-up "secret hygiene + version probes" spec.
