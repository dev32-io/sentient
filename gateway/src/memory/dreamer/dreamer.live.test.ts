// Dreamer LIVE smoke — the branch's ONE paid test (global constraint: only
// `DREAMER_LIVE` costs tokens). Gated on `DREAMER_LIVE=1`; skips cleanly
// otherwise, so CI and the unit suite never touch a provider.
//
// It drives the WHOLE night against a REAL provider — map (distill a seeded
// session into an episode + fact candidates) → reduce (reconcile candidates
// against a seeded MEMORY.md into ops) → applyOps (reconciler write arm, rails +
// scan) → writeDreamOutputs (journal + archive) — and asserts the durable
// artifacts: journal written, MEMORY.md gained ≥1 fact, the pre-rewrite archive
// snapshot exists, the preservation rail held, and every write passed the
// fail-closed injection scan.
//
// PROVIDER: whichever OpenAI-compatible endpoint the env points at. This run was
// executed once against LOCAL OLLAMA (`gpt-oss:20b`, `http://localhost:11434/v1`)
// — a small local reasoning model, ZERO paid tokens. Point it at a paid provider
// (OpenRouter etc.) via the env vars below and it costs REAL money: one map call
// (~1-2k input tokens) + one reduce call (~1k input tokens), a few thousand
// output tokens total. Run it against local Ollama unless you specifically mean
// to spend.
//
//   Env: DREAMER_LIVE=1
//        DREAMER_LIVE_BASE_URL   (default http://localhost:11434/v1 — Ollama)
//        DREAMER_LIVE_MODEL      (default gpt-oss:20b)
//        DREAMER_LIVE_API_KEY    (default "ollama" — Ollama ignores it)
//
// On success it CAPTURES the map+reduce request/response pair, the pre-reduce
// MEMORY.md, and the applied ops into `fixtures/dreamer.fixture.json`, so the
// zero-cost replay test (`dreamer-replay.test.ts`) can re-verify the reconciler
// rails for free forever after.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OrchestratorConfig } from "@sentient/config";
import { orchestratorConfigSchema } from "@sentient/config";
import { afterEach, describe, expect, it } from "vitest";
import type { Capability } from "../../access/capability.js";
import { createOpenAIProvider } from "../../provider/openai-provider.js";
import type { ProviderClient, ProviderRequest, ProviderStreamChunk } from "../../provider/provider-client.js";
import { loadDreamerTemplate } from "../../context/system-prompt-loader.js";
import { scanContent } from "../../security/injection-scanner.js";
import type { DreamWindow } from "../../store/project-for-dreaming.js";
import type { UserId } from "../../user-auth/user-id.js";
import type { IndexSync } from "../index-sync.js";
import { type MemoryConfig, openMemoryStore } from "../memory-store.js";
import { createDreamRunner } from "./dreamer-runner.js";
import type { DreamResult } from "./dreamer-runner.js";
import { writeDreamOutputs } from "./episode-writer.js";
import { type SessionIndexEntry, applyOps } from "./reconciler.js";

const LIVE = process.env.DREAMER_LIVE === "1";
const suite = LIVE ? describe : describe.skip;

const BASE_URL = process.env.DREAMER_LIVE_BASE_URL ?? "http://localhost:11434/v1";
const MODEL = process.env.DREAMER_LIVE_MODEL ?? "gpt-oss:20b";
const API_KEY = process.env.DREAMER_LIVE_API_KEY ?? "ollama";

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "dreamer.fixture.json");

const USER_ID = "u_live" as UserId;
const SCOPE_ID = "user:u_live:private";
const DATE = "2026-08-09";

// A seeded transcript with two unambiguous durable facts the model should carry.
const SESSION_ID = "s_live_1";
const TRANSCRIPT = [
  "#1 User: One thing to remember — we're adopting a dog next month, a beagle named Biscuit.",
  "#2 Assistant: Congratulations! A beagle named Biscuit joining next month — noted.",
  "#3 User: Also I switched to oat milk; dairy doesn't sit well with me anymore.",
  "#4 Assistant: Understood — oat milk from now on.",
].join("\n");

// Prior MEMORY.md content — one line, so an ADD triggers a real archive snapshot.
const SEED_MEMORY = "The household lives in Portland.";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function memConfig(): OrchestratorConfig["memory"] {
  return orchestratorConfigSchema.shape.memory.parse({});
}

/** Wraps the real provider so each round-trip's request messages + accumulated
 *  response text are captured for the fixture. First call = map, last = reduce. */
function recordingProvider(inner: ProviderClient): {
  provider: ProviderClient;
  calls: Array<{ prompt: string; text: string }>;
} {
  const calls: Array<{ prompt: string; text: string }> = [];
  const provider: ProviderClient = {
    stream(req: ProviderRequest): AsyncGenerator<ProviderStreamChunk> {
      const prompt = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      const source = inner.stream(req);
      return (async function* (): AsyncGenerator<ProviderStreamChunk> {
        let text = "";
        for await (const chunk of source) {
          if (chunk.type === "text") text += chunk.content;
          yield chunk;
        }
        calls.push({ prompt, text });
      })();
    },
  };
  return { provider, calls };
}

suite("[@live] dreamer full night against a real provider", () => {
  it("distills a session, reconciles into MEMORY.md, and writes the journal + archive", async () => {
    const ollama = createOpenAIProvider(
      {
        base_url: BASE_URL,
        model: MODEL,
        max_output_tokens: 3000,
        request_timeout_ms: 300000,
        site_name: "Sentient",
        // Omit reasoning_effort — Ollama's OpenAI-compat endpoint 400s on it.
        reasoning_effort: "unset",
      } as unknown as OrchestratorConfig["provider"],
      API_KEY,
    );
    const { provider, calls } = recordingProvider(ollama);

    const cfg = memConfig();
    const runner = createDreamRunner({
      provider,
      loadTemplate: (name) => loadDreamerTemplate(name),
      turnStateFor: () => ({ hasActiveTurn: () => false }),
      cfg,
      model: MODEL,
    });

    const root = mkdtempSync(join(tmpdir(), "dreamer-live-"));
    dirs.push(root);
    const cap = {
      ownerUserId: "u_live",
      resource: "memory-private",
      rootPath: root,
      role: "adult",
    } as unknown as Capability;
    const store = openMemoryStore(cap, cfg, { scan: scanContent });
    store.writeCore(SEED_MEMORY);

    const enqueued: unknown[] = [];
    const sync = {
      enqueueFile: () => {},
      enqueueEntries: (e: unknown) => enqueued.push(e),
      retireEntry: () => {},
      enqueueSessionChunks: () => {},
      flush: async () => {},
      onHealthRecovered: () => {},
      rebuildScope: async () => ({ ok: true, value: undefined }),
    } as unknown as IndexSync;

    // --- MAP ---
    const window: DreamWindow = { sessions: [{ sessionId: SESSION_ID, text: TRANSCRIPT, containsToolDerived: false }] };
    const result: DreamResult = await runner.runMapStage({ userId: USER_ID, memoryDir: root }, window);
    expect(result.sessions.length).toBe(1);
    const durableFacts = result.sessions.flatMap((s) => s.facts).filter((f) => f.kind === "durable");
    expect(durableFacts.length).toBeGreaterThanOrEqual(1);

    // --- REDUCE ---
    const currentMemory = { core: store.readCore() ?? "", topics: [] as Array<{ slug: string; body: string }> };
    const ops = await runner.runReduceStage({ userId: USER_ID, memoryDir: root }, result, currentMemory);
    expect(ops).not.toBeNull();
    expect((ops ?? []).length).toBeGreaterThanOrEqual(1);

    // --- APPLY (reconciler: rails + scan) ---
    const sessionsIndex: SessionIndexEntry[] = result.sessions.map((s) => ({
      sessionId: s.sessionId,
      containsToolDerived: s.containsToolDerived,
      ranges: s.facts.flatMap((f) => f.sources),
    }));
    const applyResult = await applyOps(
      store,
      { retireLine: async () => {}, scan: scanContent },
      SCOPE_ID,
      ops ?? [],
      sessionsIndex,
      cfg as MemoryConfig,
    );
    expect(applyResult.ok).toBe(true); // rail + scan held

    // --- WRITE (journal + archive) ---
    const applied = applyResult.ok ? applyResult.applied : [];
    const written = writeDreamOutputs(store, sync, SCOPE_ID, DATE, result, applied);
    expect(written.ok).toBe(true);

    // --- ASSERT durable artifacts ---
    const coreAfter = store.readCore() ?? "";
    expect(coreAfter.length).toBeGreaterThan(SEED_MEMORY.length); // gained ≥1 fact
    expect(coreAfter.startsWith(SEED_MEMORY)).toBe(true); // prior preserved (rail held)

    const archiveDir = join(root, "memory", "archive");
    expect(existsSync(archiveDir) && readdirSync(archiveDir).length >= 1).toBe(true); // archived before rewrite
    const journalDir = join(root, "memory", "journal");
    expect(existsSync(journalDir) && readdirSync(journalDir).length === 1).toBe(true); // journal written

    // --- CAPTURE the fixture for zero-cost replay ---
    const mapCall = calls[0];
    const reduceCall = calls[calls.length - 1];
    const fixture = {
      meta: {
        note: "Captured from a live dreamer run. Replay via dreamer-replay.test.ts (zero-cost).",
        provider: BASE_URL.includes("11434") ? "ollama (local, free)" : BASE_URL,
        model: MODEL,
        capturedAt: new Date().toISOString(),
      },
      map: { promptChars: mapCall?.prompt.length ?? 0, responseText: mapCall?.text ?? "" },
      reduce: { promptChars: reduceCall?.prompt.length ?? 0, responseText: reduceCall?.text ?? "" },
      // Everything the replay needs to re-run the reconciler for free:
      preState: { memoryMd: SEED_MEMORY },
      reduceOps: ops ?? [],
      sessionsIndex,
    };
    writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    expect(existsSync(FIXTURE_PATH)).toBe(true);
    // Sanity: the captured reduce output re-parses to the same ops we applied.
    const reparsed = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    expect(reparsed.reduceOps.length).toBe((ops ?? []).length);
  }, 300000);
});
