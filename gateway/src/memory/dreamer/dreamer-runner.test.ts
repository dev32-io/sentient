import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrchestratorConfig } from "@sentient/config";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderClient, ProviderRequest, ProviderStreamChunk } from "../../provider/provider-client.js";
import type { DreamWindow } from "../../store/project-for-dreaming.js";
import type { UserId } from "../../user-auth/user-id.js";
import {
  type DreamFact,
  type DreamRunnerDeps,
  type TurnStateView,
  chunkTranscript,
  createDreamRunner,
  readMark,
} from "./dreamer-runner.js";

const USER_ID = "u_00000001" as UserId;
const PASSTHROUGH_TEMPLATE = "{{transcript}}";

// --- test doubles ----------------------------------------------------------

async function* chunkStream(body: string, completionTokens = 5): AsyncGenerator<ProviderStreamChunk> {
  yield { type: "text", content: body };
  yield { type: "done", finishReason: "stop", usage: { promptTokens: 1, cachedTokens: 0, completionTokens } };
}

/** Provider whose reply is scripted by call index. Records every request so a
 *  test can assert the input size fed on each call. */
function scriptedProvider(reply: (callIndex: number, content: string) => string): {
  provider: ProviderClient;
  requests: ProviderRequest[];
} {
  const requests: ProviderRequest[] = [];
  const provider: ProviderClient = {
    stream(req: ProviderRequest): AsyncGenerator<ProviderStreamChunk> {
      const idx = requests.length;
      requests.push(req);
      const content = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      return chunkStream(reply(idx, content));
    },
  };
  return { provider, requests };
}

function mapJson(episode: string, facts: DreamFact[] = []): string {
  return JSON.stringify({ episode, facts });
}

const DURABLE_FACT: DreamFact = { text: "prefers oat milk", kind: "durable", sources: [{ fromSeq: 1, toSeq: 2 }] };

function memCfg(
  over: { max_input_chars_per_call?: number; max_output_tokens?: number; yield_check_ms?: number } = {},
): OrchestratorConfig["memory"] {
  return {
    dreamer: {
      max_input_chars_per_call: over.max_input_chars_per_call ?? 100000,
      max_output_tokens: over.max_output_tokens ?? 3000,
      yield_check_ms: over.yield_check_ms ?? 5000,
    },
  } as unknown as OrchestratorConfig["memory"];
}

const IDLE: (userId: UserId) => TurnStateView = () => ({ hasActiveTurn: () => false });

function win(sessions: Array<{ sessionId: string; text: string; containsToolDerived?: boolean }>): DreamWindow {
  return {
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      text: s.text,
      containsToolDerived: s.containsToolDerived ?? false,
    })),
  };
}

function deps(over: Partial<DreamRunnerDeps> & Pick<DreamRunnerDeps, "provider">): DreamRunnerDeps {
  return {
    loadTemplate: () => PASSTHROUGH_TEMPLATE,
    turnStateFor: IDLE,
    cfg: memCfg(),
    model: "test-model",
    now: () => 0,
    sleep: async () => {},
    ...over,
  };
}

// --- pure chunker ----------------------------------------------------------

describe("chunkTranscript", () => {
  it("returns the whole text as one chunk when within budget", () => {
    expect(chunkTranscript("short", 100)).toEqual(["short"]);
  });

  it("splits on line boundaries so every chunk stays within budget", () => {
    const lines = ["#1 aaaaaaaaaa", "#2 bbbbbbbbbb", "#3 cccccccccc"];
    const chunks = chunkTranscript(lines.join("\n"), 20);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(20);
  });

  it("hard-slices a single line longer than the budget", () => {
    const chunks = chunkTranscript("x".repeat(25), 10);
    expect(chunks).toEqual(["xxxxxxxxxx", "xxxxxxxxxx", "xxxxx"]);
  });
});

// --- map stage -------------------------------------------------------------

describe("runMapStage", () => {
  it("keeps every provider request within max_input_chars_per_call", async () => {
    const budget = 20;
    const { provider, requests } = scriptedProvider(() => mapJson("ep"));
    const runner = createDreamRunner(deps({ provider, cfg: memCfg({ max_input_chars_per_call: budget }) }));

    const text = ["#1 aaaaaaaaaa", "#2 bbbbbbbbbb", "#3 cccccccccc"].join("\n");
    await runner.runMapStage({ userId: USER_ID, memoryDir: "/unused" }, win([{ sessionId: "s1", text }]));

    expect(requests.length).toBeGreaterThan(1);
    for (const req of requests) {
      const content = req.messages[0]?.content ?? "";
      expect(content.length).toBeLessThanOrEqual(budget);
    }
  });

  it("passes the configured output cap on every provider call", async () => {
    const { provider, requests } = scriptedProvider(() => mapJson("ep"));
    const runner = createDreamRunner(deps({ provider, cfg: memCfg({ max_output_tokens: 1234 }) }));

    await runner.runMapStage({ userId: USER_ID, memoryDir: "/unused" }, win([{ sessionId: "s1", text: "hi" }]));

    expect(requests[0]?.maxOutputTokens).toBe(1234);
  });

  it("retries once on malformed output and uses the second, valid response", async () => {
    const { provider, requests } = scriptedProvider((idx) =>
      idx === 0 ? "not json at all" : mapJson("recovered", [DURABLE_FACT]),
    );
    const runner = createDreamRunner(deps({ provider }));

    const result = await runner.runMapStage(
      { userId: USER_ID, memoryDir: "/unused" },
      win([{ sessionId: "s1", text: "hi" }]),
    );

    expect(requests.length).toBe(2);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.episode).toBe("recovered");
    expect(result.sessions[0]?.facts).toEqual([DURABLE_FACT]);
  });

  it("skips a session that fails both attempts and keeps the others", async () => {
    // s1 always malformed (2 attempts fail); s2 valid.
    const { provider } = scriptedProvider((_idx, content) =>
      content.includes("bad") ? "still not json" : mapJson("good", [DURABLE_FACT]),
    );
    const runner = createDreamRunner(deps({ provider }));

    const result = await runner.runMapStage(
      { userId: USER_ID, memoryDir: "/unused" },
      win([
        { sessionId: "s1", text: "bad session" },
        { sessionId: "s2", text: "good session" },
      ]),
    );

    expect(result.sessions.map((s) => s.sessionId)).toEqual(["s2"]);
    expect(result.sessions[0]?.episode).toBe("good");
  });

  it("carries the containsToolDerived taint through untouched", async () => {
    const { provider } = scriptedProvider(() => mapJson("ep"));
    const runner = createDreamRunner(deps({ provider }));

    const result = await runner.runMapStage(
      { userId: USER_ID, memoryDir: "/unused" },
      win([{ sessionId: "s1", text: "hi", containsToolDerived: true }]),
    );

    expect(result.sessions[0]?.containsToolDerived).toBe(true);
  });

  it("defers while a turn is active and resumes when idle (injected clock)", async () => {
    const sleeps: number[] = [];
    let checks = 0;
    const turnStateFor: (userId: UserId) => TurnStateView = () => ({
      // active for the first two polls, then idle.
      hasActiveTurn: () => {
        checks += 1;
        return checks <= 2;
      },
    });
    const { provider, requests } = scriptedProvider(() => mapJson("ep"));
    const runner = createDreamRunner(
      deps({
        provider,
        turnStateFor,
        cfg: memCfg({ yield_check_ms: 5000 }),
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    );

    await runner.runMapStage({ userId: USER_ID, memoryDir: "/unused" }, win([{ sessionId: "s1", text: "hi" }]));

    expect(sleeps).toEqual([5000, 5000]);
    expect(requests.length).toBe(1);
  });

  it("merges a chunked session deterministically (joined episodes, unioned facts)", async () => {
    const factB: DreamFact = { text: "has a cat", kind: "durable", sources: [{ fromSeq: 3, toSeq: 3 }] };
    const reply = (idx: number): string => (idx % 2 === 0 ? mapJson("epA", [DURABLE_FACT]) : mapJson("epB", [factB]));

    const runOnce = async () => {
      const { provider } = scriptedProvider(reply);
      const runner = createDreamRunner(deps({ provider, cfg: memCfg({ max_input_chars_per_call: 10 }) }));
      // "chunkone"(8) + "\n" + "chunktwo"(8) = 17 > 10 → two chunks.
      return runner.runMapStage(
        { userId: USER_ID, memoryDir: "/unused" },
        win([{ sessionId: "s1", text: "chunkone\nchunktwo" }]),
      );
    };

    const first = await runOnce();
    const second = await runOnce();

    expect(first).toEqual(second);
    expect(first.sessions[0]?.episode).toBe("epA\n\nepB");
    expect(first.sessions[0]?.facts).toEqual([DURABLE_FACT, factB]);
  });

  it("dedups identical facts when unioning chunked results", async () => {
    const { provider } = scriptedProvider(() => mapJson("ep", [DURABLE_FACT]));
    const runner = createDreamRunner(deps({ provider, cfg: memCfg({ max_input_chars_per_call: 10 }) }));

    const result = await runner.runMapStage(
      { userId: USER_ID, memoryDir: "/unused" },
      win([{ sessionId: "s1", text: "chunkone\nchunktwo" }]),
    );

    expect(result.sessions[0]?.facts).toEqual([DURABLE_FACT]);
  });
});

// --- reduce stage ----------------------------------------------------------

const REDUCE_TEMPLATE = "MEM[{{memory_md}}]TOPICS[{{topics}}]FACTS[{{fact_candidates}}]";

function reduceReply(ops: unknown[]): string {
  return JSON.stringify({ ops });
}

function reduceDeps(over: Partial<DreamRunnerDeps> & Pick<DreamRunnerDeps, "provider">): DreamRunnerDeps {
  return deps({ loadTemplate: (name) => (name === "reduce" ? REDUCE_TEMPLATE : PASSTHROUGH_TEMPLATE), ...over });
}

const DURABLE: DreamFact = { text: "prefers oat milk", kind: "durable", sources: [{ fromSeq: 1, toSeq: 2 }] };
const EPHEMERAL: DreamFact = { text: "is tired right now", kind: "ephemeral", sources: [{ fromSeq: 3, toSeq: 3 }] };

function resultWith(sessions: Array<{ sessionId: string; facts: DreamFact[]; containsToolDerived?: boolean }>): {
  sessions: Array<{ sessionId: string; episode: string; facts: DreamFact[]; containsToolDerived: boolean }>;
} {
  return {
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      episode: "ep",
      facts: s.facts,
      containsToolDerived: s.containsToolDerived ?? false,
    })),
  };
}

const CURRENT_MEMORY = { core: "Kevin likes tea.", topics: [{ slug: "cooking", body: "sear the steak" }] };

const ADD_OP = { op: "ADD", target: "MEMORY.md", line: "prefers oat milk", sources: [{ fromSeq: 1, toSeq: 2 }] };

describe("runReduceStage", () => {
  it("substitutes memory, topics, and DURABLE fact candidates (with taint) into the prompt", async () => {
    const { provider, requests } = scriptedProvider(() => reduceReply([]));
    const runner = createDreamRunner(reduceDeps({ provider }));

    await runner.runReduceStage(
      { userId: USER_ID, memoryDir: "/unused" },
      resultWith([{ sessionId: "s1", facts: [DURABLE, EPHEMERAL], containsToolDerived: true }]),
      CURRENT_MEMORY,
    );

    const prompt = requests[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain("MEM[Kevin likes tea.]");
    expect(prompt).toContain("--- topics/cooking ---\nsear the steak");
    expect(prompt).toContain("prefers oat milk"); // durable fact included
    expect(prompt).toContain("tool-derived"); // taint annotation on the tainted session
    expect(prompt).not.toContain("is tired right now"); // ephemeral facts are NOT carried
  });

  it("parses a valid reduce reply into the ops array", async () => {
    const { provider } = scriptedProvider(() => reduceReply([ADD_OP]));
    const runner = createDreamRunner(reduceDeps({ provider }));

    const ops = await runner.runReduceStage(
      { userId: USER_ID, memoryDir: "/unused" },
      resultWith([{ sessionId: "s1", facts: [DURABLE] }]),
      CURRENT_MEMORY,
    );

    expect(ops).toEqual([ADD_OP]);
  });

  it("treats an empty ops array as a valid quiet-night answer", async () => {
    const { provider, requests } = scriptedProvider(() => reduceReply([]));
    const runner = createDreamRunner(reduceDeps({ provider }));

    const ops = await runner.runReduceStage(
      { userId: USER_ID, memoryDir: "/unused" },
      resultWith([{ sessionId: "s1", facts: [] }]),
      CURRENT_MEMORY,
    );

    expect(ops).toEqual([]);
    expect(requests.length).toBe(1);
  });

  it("retries once on a malformed reply and uses the second, valid one", async () => {
    const { provider, requests } = scriptedProvider((idx) => (idx === 0 ? "not json" : reduceReply([ADD_OP])));
    const runner = createDreamRunner(reduceDeps({ provider }));

    const ops = await runner.runReduceStage(
      { userId: USER_ID, memoryDir: "/unused" },
      resultWith([{ sessionId: "s1", facts: [DURABLE] }]),
      CURRENT_MEMORY,
    );

    expect(requests.length).toBe(2);
    expect(ops).toEqual([ADD_OP]);
  });

  it("returns null when BOTH attempts fail (the night completes episodic-only)", async () => {
    const { provider, requests } = scriptedProvider(() => "still not json");
    const runner = createDreamRunner(reduceDeps({ provider }));

    const ops = await runner.runReduceStage(
      { userId: USER_ID, memoryDir: "/unused" },
      resultWith([{ sessionId: "s1", facts: [DURABLE] }]),
      CURRENT_MEMORY,
    );

    expect(ops).toBeNull();
    expect(requests.length).toBe(2);
  });

  it("refuses a reply with an unknown op (schema-validated) and returns null after retry", async () => {
    const { provider } = scriptedProvider(() => reduceReply([{ op: "DELETE", target: "MEMORY.md", line: "x" }]));
    const runner = createDreamRunner(reduceDeps({ provider }));

    const ops = await runner.runReduceStage(
      { userId: USER_ID, memoryDir: "/unused" },
      resultWith([{ sessionId: "s1", facts: [DURABLE] }]),
      CURRENT_MEMORY,
    );

    expect(ops).toBeNull();
  });
});

// --- checkpoint mark -------------------------------------------------------

describe("mark", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns the pre-first-run state when the mark file is missing", () => {
    dir = mkdtempSync(join(tmpdir(), "dreamer-"));
    expect(readMark(dir)).toEqual({ lastSeq: 0, lastRunAt: null });
  });

  it("round-trips through advanceMark, leaving no temp file behind", () => {
    dir = mkdtempSync(join(tmpdir(), "dreamer-"));
    const runner = createDreamRunner(deps({ provider: scriptedProvider(() => "").provider }));

    runner.advanceMark(dir, 42, "2026-08-09T03:00:00.000Z");

    expect(runner.readMark(dir)).toEqual({ lastSeq: 42, lastRunAt: "2026-08-09T03:00:00.000Z" });
    // Atomic write: tmp file was renamed away, only the canonical file remains.
    expect(readdirSync(dir)).toEqual([".dream-mark.json"]);
  });

  it("last-writer-wins across successive advances", () => {
    dir = mkdtempSync(join(tmpdir(), "dreamer-"));
    const runner = createDreamRunner(deps({ provider: scriptedProvider(() => "").provider }));

    runner.advanceMark(dir, 10, "2026-08-09T03:00:00.000Z");
    runner.advanceMark(dir, 20, "2026-08-09T04:00:00.000Z");

    expect(runner.readMark(dir)).toEqual({ lastSeq: 20, lastRunAt: "2026-08-09T04:00:00.000Z" });
    expect(readdirSync(dir)).toEqual([".dream-mark.json"]);
  });

  it("falls back to the pre-first-run state on a corrupt mark file", () => {
    dir = mkdtempSync(join(tmpdir(), "dreamer-"));
    writeFileSync(join(dir, ".dream-mark.json"), "{ this is not json", "utf8");
    expect(readMark(dir)).toEqual({ lastSeq: 0, lastRunAt: null });
  });
});
