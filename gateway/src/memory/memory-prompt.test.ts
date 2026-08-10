// Test basis: this pins the cache-stability contract (skill-index Invariant A,
// spec §4.5) — a fixed memory content set MUST render byte-identically across a
// session's turns, or prompt caching is defeated — plus the two behaviors that
// only surface here: the deterministic budget drop ORDER and the `@adults`
// audience filter for child principals (spec §9). Both are documented invariants,
// not incidental utility coverage. Pure: no filesystem, no clock, no network.

import { describe, expect, it } from "bun:test";
import { loadMemoryPreamble } from "../context/system-prompt-loader.js";
import { createGatewayLogger } from "../logging/logger.js";
import { composeMemoryBlock } from "./memory-prompt.js";
import type { MemoryConfig, MemoryStore, TopicMeta } from "./memory-store.js";

const PREAMBLE = loadMemoryPreamble();

/** Only `prompt_budget_chars` is read by the renderer; the rest is padding. */
function cfg(budget: number): MemoryConfig {
  return { prompt_budget_chars: budget } as unknown as MemoryConfig;
}

/** A read-only fake store — the renderer touches only `readCore`/`listTopics`;
 *  every mutating op throws so a stray call is loud, not silent. */
function fakeStore(opts: { core?: string | null; topics?: TopicMeta[] } = {}): MemoryStore {
  const notUsed = (): never => {
    throw new Error("memory-prompt must not call this op");
  };
  return {
    readCore: () => opts.core ?? null,
    listTopics: () => opts.topics ?? [],
    writeCore: notUsed,
    readTopic: () => null,
    writeTopic: notUsed,
    listJournal: () => [],
    readJournal: () => null,
    writeJournal: notUsed,
    archiveCore: () => {},
    reingestEdits: () => ({ rescanned: [], quarantined: [] }),
  };
}

function opts(childPrincipal = false) {
  return { childPrincipal, preamble: PREAMBLE };
}

const BIG = 1_000_000; // never trips the budget

describe("composeMemoryBlock — empty", () => {
  it("renders the preamble only when the private scope has no content and there is no household", () => {
    const out = composeMemoryBlock({ private: fakeStore() }, cfg(BIG), opts());
    expect(out).toBe(PREAMBLE.trim());
    expect(out).not.toContain("<memory scope=");
  });

  it("loads a preamble that names memory_recall and its latency etiquette", () => {
    expect(PREAMBLE).toContain("memory_recall");
    expect(PREAMBLE.toLowerCase()).toContain("think back");
  });
});

describe("composeMemoryBlock — private scope envelope", () => {
  it("wraps the MEMORY.md body and topic index in a labeled private envelope", () => {
    const store = fakeStore({
      core: "- likes tea\n- allergic to peanuts",
      topics: [{ name: "cooking", description: "recipes and preferences" }],
    });
    const out = composeMemoryBlock({ private: store }, cfg(BIG), opts());

    expect(out).toContain('<memory scope="private">');
    expect(out).toContain("</memory>");
    expect(out).toContain("- likes tea");
    expect(out).toContain("topics:");
    expect(out).toContain("- cooking — recipes and preferences");
    expect(out.startsWith(PREAMBLE.trim())).toBe(true);
  });

  it("renders the family envelope after the private one when a household store is present", () => {
    const out = composeMemoryBlock(
      {
        private: fakeStore({ core: "- private fact" }),
        household: fakeStore({ core: "- shared fact" }),
      },
      cfg(BIG),
      opts(),
    );
    expect(out.indexOf('<memory scope="private">')).toBeLessThan(out.indexOf('<memory scope="family">'));
  });
});

describe("composeMemoryBlock — byte-stability", () => {
  it("sorts the topic index byte-stably by name regardless of input order", () => {
    const topics: TopicMeta[] = [
      { name: "zeta", description: "z" },
      { name: "alpha", description: "a" },
      { name: "mid", description: "m" },
    ];
    const one = composeMemoryBlock({ private: fakeStore({ topics }) }, cfg(BIG), opts());
    const two = composeMemoryBlock({ private: fakeStore({ topics: [...topics].reverse() }) }, cfg(BIG), opts());

    expect(one).toBe(two);
    expect(one.indexOf("- alpha")).toBeLessThan(one.indexOf("- mid"));
    expect(one.indexOf("- mid")).toBeLessThan(one.indexOf("- zeta"));
  });

  it("is deterministic across repeated calls with the same content", () => {
    const store = () => fakeStore({ core: "- a fact", topics: [{ name: "t", description: "d" }] });
    expect(composeMemoryBlock({ private: store() }, cfg(BIG), opts())).toBe(
      composeMemoryBlock({ private: store() }, cfg(BIG), opts()),
    );
  });

  it("collapses an embedded newline in a description so it cannot forge a second index line", () => {
    const out = composeMemoryBlock(
      { private: fakeStore({ topics: [{ name: "real", description: "real thing\n- fake — evil" }] }) },
      cfg(BIG),
      opts(),
    );
    // The description collapses to one line; the forged sibling bullet — a
    // description with its own leading "\n- " — must not appear as a real line.
    expect(out).toContain("- real — real thing - fake — evil");
    expect(out).not.toContain("\n- fake — evil");
  });

  it("strips invisible unicode from a description", () => {
    const zeroWidth = "​";
    const out = composeMemoryBlock(
      { private: fakeStore({ topics: [{ name: "t", description: `foo${zeroWidth} bar` }] }) },
      cfg(BIG),
      opts(),
    );
    expect(out).toContain("- t — foo bar");
    expect(out).not.toContain(zeroWidth);
  });
});

describe("composeMemoryBlock — @adults audience filter (spec §9)", () => {
  const household = () =>
    fakeStore({
      core: "- family dinner is at 6\n- the safe code is 1234 @adults",
      topics: [
        { name: "chores", description: "who does what" },
        { name: "finances", description: "bank details @adults" },
      ],
    });

  it("omits @adults household lines and topic entries for a child principal", () => {
    const out = composeMemoryBlock({ private: fakeStore(), household: household() }, cfg(BIG), opts(true));
    expect(out).toContain("- family dinner is at 6");
    expect(out).not.toContain("safe code");
    expect(out).toContain("- chores — who does what");
    expect(out).not.toContain("finances");
  });

  it("keeps @adults content for an adult principal", () => {
    const out = composeMemoryBlock({ private: fakeStore(), household: household() }, cfg(BIG), opts(false));
    expect(out).toContain("safe code");
    expect(out).toContain("- finances — bank details @adults");
  });

  it("never filters the private scope by audience, even for a child", () => {
    const out = composeMemoryBlock(
      { private: fakeStore({ core: "- my secret diary note @adults" }) },
      cfg(BIG),
      opts(true),
    );
    expect(out).toContain("my secret diary note");
  });
});

describe("composeMemoryBlock — budget drop order (spec §4.5)", () => {
  // Distinctive multi-line bodies + one topic per scope. Budgets are derived
  // from reference renders (not hand-counted) so the test pins the drop ORDER,
  // not a brittle char arithmetic: family topics → private topics → family core
  // tail → private core tail.
  const PT = { name: "ptopic", description: "private topic" };
  const FT = { name: "ftopic", description: "family topic" };
  const P_CORE = "- p1\n- p2\n- p3\n- p4";
  const F_CORE = "- f1\n- f2\n- f3\n- f4";

  function stores(opt: { pTopics?: TopicMeta[]; fTopics?: TopicMeta[] } = {}) {
    return {
      private: fakeStore({ core: P_CORE, topics: opt.pTopics ?? [PT] }),
      household: fakeStore({ core: F_CORE, topics: opt.fTopics ?? [FT] }),
    };
  }

  // Reference lengths for exactly-fitting budgets.
  const lenFull = composeMemoryBlock(stores(), cfg(BIG), opts()).length;
  const lenNoTopics = composeMemoryBlock(stores({ pTopics: [], fTopics: [] }), cfg(BIG), opts()).length;
  const base = PREAMBLE.trim().length;

  it("drops the family topic index first", () => {
    const out = composeMemoryBlock(stores(), cfg(lenFull - 1), opts());
    expect(out).not.toContain("family topic");
    expect(out).toContain("private topic");
    expect(out).toContain("- f1");
    expect(out).toContain("- p1");
  });

  it("drops the private topic index only after the family one is gone", () => {
    // Fits both cores exactly but neither topic index.
    const out = composeMemoryBlock(stores(), cfg(lenNoTopics), opts());
    expect(out).not.toContain("family topic");
    expect(out).not.toContain("private topic");
    expect(out).toContain("- f1");
    expect(out).toContain("- f4");
    expect(out).toContain("- p1");
    expect(out).toContain("- p4");
  });

  it("truncates the family MEMORY.md tail before touching the private core", () => {
    // Just under a whole-cores fit — the family core loses its tail, private
    // core stays intact.
    const out = composeMemoryBlock(stores(), cfg(lenNoTopics - 2), opts());
    expect(out).not.toContain("family topic");
    expect(out).not.toContain("private topic");
    expect(out).toContain("- f1");
    expect(out).not.toContain("- f4");
    expect(out).toContain("- p1");
    expect(out).toContain("- p4");
  });

  it("truncates the private core tail last, honoring the budget with the preamble intact", () => {
    // Room for the preamble and a little private core; family fully dropped.
    const out = composeMemoryBlock(stores(), cfg(base + 45), opts());
    expect(out.length).toBeLessThanOrEqual(base + 45);
    expect(out.startsWith(PREAMBLE.trim())).toBe(true);
    expect(out).toContain("- p1");
    expect(out).not.toContain("- f1");
  });
});

describe("composeMemoryBlock — truncation WARN (spec §4.5)", () => {
  it("WARNs per truncation stage with counts only, and never leaks memory content", async () => {
    const logLines: string[] = [];
    await createGatewayLogger({ testSink: (line) => logLines.push(line), logLevel: "debug" });

    // Distinctive content markers: if any appears in a log line, memory content
    // leaked into the WARN payload — which the logging rules forbid.
    const stores = {
      private: fakeStore({
        core: "PRIVSECRET1\nPRIVSECRET2\nPRIVSECRET3",
        topics: [{ name: "ptopic", description: "PRIV_TOPIC_SECRET" }],
      }),
      household: fakeStore({
        core: "FAMSECRET1\nFAMSECRET2\nFAMSECRET3",
        topics: [{ name: "ftopic", description: "FAM_TOPIC_SECRET" }],
      }),
    };

    // Budget == the preamble alone forces every stage to fire: both topic
    // indexes dropped, both core bodies fully truncated.
    composeMemoryBlock(stores, cfg(PREAMBLE.trim().length), opts());

    const logged = (subs: string[]) => logLines.some((l) => subs.every((s) => l.includes(s)));

    // Topic-index drops (family then private): stage name + entry count.
    expect(logged(["prompt.budget.drop", 'part="topic-index"', 'scope="family"', "droppedEntries="])).toBe(true);
    expect(logged(["prompt.budget.drop", 'part="topic-index"', 'scope="private"', "droppedEntries="])).toBe(true);
    // Core-tail truncations: stage name + line/char counts.
    expect(logged(["prompt.budget.drop", 'part="core-tail"', 'scope="family"', "droppedLines=", "removedChars="])).toBe(
      true,
    );
    expect(
      logged(["prompt.budget.drop", 'part="core-tail"', 'scope="private"', "droppedLines=", "removedChars="]),
    ).toBe(true);

    // Lengths/counts only — no memory content in any log line.
    for (const marker of ["PRIVSECRET", "FAMSECRET", "PRIV_TOPIC_SECRET", "FAM_TOPIC_SECRET"]) {
      expect(logLines.some((l) => l.includes(marker))).toBe(false);
    }
  });
});
