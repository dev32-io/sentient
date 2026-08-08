// @live — Plan 2 Task 10: "the gateway walks text-only end-to-end."
//
// Gate: TWO independent conditions, both required.
//   (a) `RUN_LIVE=1` — this repo's shared "run the live suite" opt-in (see
//       gateway/tests/integration/docker-driver.test.ts, the other committed
//       @live suite that reads the same flag). Without it, module-scope work
//       below (config load, secrets-store read, MCP warm-up dial, and the
//       real streaming LLM call inside `it`) is skipped entirely — a plain
//       `bun run test` / CI run never touches the network or spends
//       operator credit, matching this repo's established @live idiom
//       (openai-provider.test.ts, mcp-client.test.ts both gate `describe` on
//       an opt-in signal so CI skips by default).
//   (b) a boot-equivalent construction yields a non-null `provider` (an
//       active LLM key is configured in the operator's 1.0 secrets store) —
//       NEVER an env var. `OPENROUTER_API_KEY` / `ORCHESTRATOR_MODEL` (used
//       by ./provider/openai-provider.test.ts's own @live case, one
//       directory over) are the LEGACY per-user Hermes-provisioning knobs and
//       are irrelevant to this orchestrator's key sourcing — see
//       resolve-provider-connection.ts's header.
// This file never reads or prints the key's VALUE either way — only whether
// one resolved.
//
// Runner choice: `bun:test`, colocated under src/ (openai-provider.test.ts /
// secrets-store.test.ts / session-runtime.test.ts precedent), NOT vitest
// under tests/integration/ as the task brief originally sketched. Verified
// empirically: `loadStartupConfig()` and this file's transitive import graph
// (via phase-services.ts → apply-deps.ts → profile-store/profile-renderer.ts)
// read Bun-only `import.meta.dir` at module scope. `tests/integration/` runs
// under vitest (vitest.config.int.ts), whose worker pool executes on Node,
// not Bun — `import.meta.dir` is `undefined` there, so any test importing
// this graph crashes on load, before a single assertion runs (confirmed:
// `TypeError: The "path" argument must be of type string. Received
// undefined` at profile-renderer.ts's top-level `GATEWAY_ROOT` constant).
// `bun:test` runs on the real Bun engine, where `import.meta.dir` resolves
// correctly — the same reason every other file in this repo that touches
// `import.meta.dir` (phase-state.ts, startup-config.ts,
// secrets-store.test.ts, …) is only ever exercised via `bun test`.
//
// Boot-path choice: calls `buildOrchestratorServices(cfg, secretsStore)`
// directly — the exact real composition-root function `runPhaseServices`
// (Task 9) uses to build `GatewayServices.{accessManager,mcpClient,provider,
// createSessionRuntime}` — rather than booting the full WS server via
// `createGatewayServices()`. That fuller chain's `runPhaseServices` also
// runs Hermes-fleet migration/provisioning against this machine's REAL
// supervisord + user set (`migrateUnboundUsers`,
// `renderConfigsForExistingUsers`, `renderProgramsForExistingUsers`) — side
// effects with no bearing on "does a text turn reach the model and stream
// back," and unsafe to trigger from an automated test pass on a real
// operator machine (Task 9's own report hit the identical wall building its
// boot-proof script). `buildOrchestratorServices` itself has no such side
// effect (only `warmMcpClient`'s network I/O, which never throws).
//
// What this test exercises for real: the real `gateway/config.yaml`, the
// real `~/.sentient/secrets/keys.yaml` secrets store, a real streaming HTTP
// call to the operator's active LLM provider, and the real `SessionRuntime`
// → `react-loop.ts` → `ToolBroker` → `ProviderClient` stack. What it does
// NOT exercise: the WS transport layer (auth handshake, session.configure,
// text.input/interrupt routing, WsTurnEmitter's frame writes) — that is
// covered by ws-turn-emitter.ts's frame-shape contract (matched by hand
// against gateway/scripts/try-chat.ts) plus the manual dev-harness walk
// recorded in task-10-report.md.

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSecretsStore } from "../admin/secrets-store.js";
import { loadStartupConfig } from "../config/startup-config.js";
import { createUserPrincipal } from "../identity/user-principal.js";
import { createProfileStore } from "../profile-store/profile-store.js";
import type { TurnEmitter } from "../runtime/turn-emitter.js";
import type { CutoffKind } from "../store/entry-types.js";
import type { OrchestratorServices } from "./phase-services.js";
import { buildOrchestratorServices } from "./phase-services.js";

const TEST_USER_ID = "u_deadbeef" as const; // valid per user-id.ts's /^u_[a-f0-9]{8}$/
const TEST_CONVERSATION_ID = "live-native-brain-text-conversation";
const TEST_CONNECTION_ID = "live-native-brain-text-connection";
const PONG_PROMPT = "Reply with exactly the word: pong";
const TURN_TIMEOUT_MS = 60_000;

interface RecordingEmitter extends TurnEmitter {
  textDeltas: string[];
  turnStartedCount: number;
  turnCompletedCount: number;
  turnAbortedCount: number;
}

function recordingEmitter(): RecordingEmitter {
  const emitter: RecordingEmitter = {
    textDeltas: [],
    turnStartedCount: 0,
    turnCompletedCount: 0,
    turnAbortedCount: 0,
    turnStarted: () => {
      emitter.turnStartedCount += 1;
    },
    textDelta: (_turnId: string, text: string) => {
      emitter.textDeltas.push(text);
    },
    turnCompleted: () => {
      emitter.turnCompletedCount += 1;
    },
    turnAborted: (_turnId: string, _cutoff: CutoffKind) => {
      emitter.turnAbortedCount += 1;
    },
    playbackStop: () => {},
    conversationSnapshot: () => {},
    conversationEntry: () => {},
    // Audio / permission / delegation are not exercised by this text-only
    // @live walk — present to satisfy the full TurnEmitter contract. If the
    // loop ever drives one of these during a plain text turn, that is a
    // regression, so they are not silent: each records nothing but the
    // assertions below (turnCompletedCount === 1) would still hold, and the
    // absence of audio here is the point.
    audioStart: () => {},
    audioFrame: () => {},
    audioDone: () => {},
    permissionRequest: () => {},
    permissionResolved: () => {},
    delegationProgress: () => {},
    // The task-list strip is not exercised by this text-only walk either —
    // same rationale as the audio/permission/delegation trio above.
    taskList: () => {},
    // Titling is session METADATA, not turn output — this harness asserts on
    // the turn stream only.
    sessionTitle: () => {},
  };
  return emitter;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ---------------------------------------------------------------------------
// Gate — see file header for the two-condition rationale. Top-level await
// runs fine under bun:test's ESM module loader.
// ---------------------------------------------------------------------------

const RUN_LIVE = process.env.RUN_LIVE === "1";

/**
 * Real boot-equivalent resolution — config load, secrets-store read, MCP
 * warm-up dial (see buildOrchestratorServices's own doc comment on that
 * network I/O). Only invoked when `RUN_LIVE` is set: condition (a) gates
 * even ATTEMPTING this work, not just the assertion inside `it`, so a plain
 * `bun run test` never dials anything.
 */
async function resolveOrchestratorServices(): Promise<OrchestratorServices> {
  const cfg = loadStartupConfig();
  // Mirrors phase-state.ts's own path computation exactly — that file lives in
  // this same directory (src/bootstrap/), so the relative depth matches.
  const SENTIENT_HOME = process.env.SENTIENT_HOME ?? join(homedir(), ".sentient");
  const GATEWAY_RUNTIME_DIR = process.env.GATEWAY_RUNTIME_DIR ?? join(import.meta.dir, "..", "..");
  const secretsStore = cfg.hermes
    ? createSecretsStore({
        keysPath: join(SENTIENT_HOME, "secrets", "keys.yaml"),
        templatePath: join(GATEWAY_RUNTIME_DIR, "templates", "wizard", "keys.yaml.tmpl"),
        generateAdminToken: () => "unused-in-this-test",
      })
    : null;
  if (secretsStore) await secretsStore.load();
  // Real store: the provider factory reads each user's selected model out of
  // it, falling back to config.yaml when the test user has no profile.
  const services = await buildOrchestratorServices(cfg, secretsStore, createProfileStore());
  // Every composition root settles the external-tool slot before a session can
  // exist — main.ts binds the real Hermes tool once the MCP host is up; this
  // one has no MCP host, so it seals. Without this, a delegateTask the model
  // happens to emit would wait on a settle that never comes.
  services.delegatedExternalTool.sealEmpty("no MCP host in the @live text-brain composition");
  return services;
}

const orchestratorServices = RUN_LIVE ? await resolveOrchestratorServices() : null;
const hasActiveKey =
  orchestratorServices !== null &&
  orchestratorServices.provider !== null &&
  orchestratorServices.createSessionRuntime !== null;

// Matches this repo's established @live gating idiom (openai-provider.test.ts,
// mcp-client.test.ts): a ternary onto `describe`/`describe.skip`, evaluated
// once at module load — not `describe.skipIf`, kept consistent with existing
// precedent in this file's own directory tree. Both conditions (RUN_LIVE +
// hasActiveKey) are required; `hasActiveKey` is trivially false whenever
// RUN_LIVE is unset (resolution above never ran), so the `&&` is belt-and-
// braces, not load-bearing on its own.
const live = RUN_LIVE && hasActiveKey ? describe : describe.skip;

live("[@live] native orchestrator — text-only turn against the real active LLM key", () => {
  it(
    "streams response.text.delta content containing 'pong' and completes the turn",
    async () => {
      if (!orchestratorServices || !orchestratorServices.createSessionRuntime) {
        throw new Error("unreachable: gated on RUN_LIVE && createSessionRuntime !== null above");
      }

      const alice = createUserPrincipal(TEST_USER_ID, "adult", "home");
      const userHomeDir = orchestratorServices.accessManager.userHomeDir(alice);
      // Never delete an operator dir this test didn't create — capture
      // pre-existence BEFORE mkdirSync so the finally block below can guard
      // the rmSync accordingly. TEST_USER_ID is a fixed fake id, but this
      // resolves under the operator's REAL `access.user_data_root`.
      const userHomeDirPreexisted = existsSync(userHomeDir);
      mkdirSync(userHomeDir, { recursive: true });

      const emitter = recordingEmitter();
      const { runtime } = orchestratorServices.createSessionRuntime({
        principal: alice,
        conversationId: TEST_CONVERSATION_ID,
        connectionId: TEST_CONNECTION_ID,
        emitter,
        // One headless "window": enough for a permission prompt to be raised
        // rather than denied on sight (session-permission-broker.ts).
        attachedWindows: () => 1,
      });

      try {
        expect(runtime.running).toBe(false);
        runtime.submit({ kind: "conversational", text: PONG_PROMPT });
        expect(runtime.running).toBe(true); // synchronous — submit() sets in-flight before returning

        await waitFor(() => !runtime.running, TURN_TIMEOUT_MS);

        // The turn completed (not aborted) — proves it survived whatever
        // state broker.definitions() was in when react-loop.ts read it,
        // including the Task 9 MCP-warm residual: this session's ToolBroker
        // kicks off `void broker.definitions()` fire-and-forget at
        // construction, so the FIRST turn's `tools[]` snapshot can legally
        // be empty (MCP warm-up still in flight) or non-empty (already
        // resolved) — either way react-loop.ts must not crash and the turn
        // must still finish with text. This assertion is the smoke check
        // for that race; it does not force either outcome.
        expect(emitter.turnCompletedCount).toBe(1);
        expect(emitter.turnAbortedCount).toBe(0);

        const combined = emitter.textDeltas.join("");
        expect(emitter.textDeltas.length).toBeGreaterThan(0);
        expect(combined.toLowerCase()).toContain("pong");
      } finally {
        runtime.dispose();
        if (!userHomeDirPreexisted) {
          rmSync(userHomeDir, { recursive: true, force: true });
        }
      }
    },
    TURN_TIMEOUT_MS + 5_000,
  );
});
