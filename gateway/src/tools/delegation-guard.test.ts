import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DelegationEnvelope,
  createDelegationGuard,
  loadDelegationEnvelope,
  loadDelegationFrontmatterDir,
} from "./delegation-guard.js";
import type { PromptClassification, PromptClassifier } from "./prompt-classifier.js";

function fakeClassifier(result: PromptClassification): PromptClassifier {
  return { classify: () => result };
}

const hermesEnvelope: DelegationEnvelope = {
  agent: "hermes",
  allowed_tools: ["*"],
  network: "full",
  confirm_class: "confirm",
  enabled: true,
};

// ---------------------------------------------------------------------------
// Guard decision table — the load-bearing security-boundary tests.
// ---------------------------------------------------------------------------

describe("DelegationGuard — evaluate", () => {
  it("denies an agent absent from the frontmatter map", () => {
    const guard = createDelegationGuard({
      frontmatter: new Map(),
      classifier: fakeClassifier({ tier: "low", findings: [] }),
    });
    expect(guard.evaluate("hermes", "do a thing").action).toBe("deny");
  });

  it("denies an agent explicitly disabled in its envelope", () => {
    const guard = createDelegationGuard({
      frontmatter: new Map([["hermes", { ...hermesEnvelope, enabled: false }]]),
      classifier: fakeClassifier({ tier: "low", findings: [] }),
    });
    expect(guard.evaluate("hermes", "do a thing").action).toBe("deny");
  });

  it("allows an allowed agent with a low-tier (clean) prompt", () => {
    const guard = createDelegationGuard({
      frontmatter: new Map([["hermes", hermesEnvelope]]),
      classifier: fakeClassifier({ tier: "low", findings: [] }),
    });
    expect(guard.evaluate("hermes", "summarize my calendar")).toEqual({ action: "allow" });
  });

  it("requires confirmation for a medium-tier prompt, regardless of confirm_class", () => {
    const guard = createDelegationGuard({
      frontmatter: new Map([["hermes", { ...hermesEnvelope, confirm_class: "deny" }]]),
      classifier: fakeClassifier({ tier: "medium", findings: ["ignore_instructions"] }),
    });
    expect(guard.evaluate("hermes", "some prompt").action).toBe("confirm");
  });

  it("an allowed agent + injection-flagged (high) prompt confirms when confirm_class is confirm", () => {
    const guard = createDelegationGuard({
      frontmatter: new Map([["hermes", { ...hermesEnvelope, confirm_class: "confirm" }]]),
      classifier: fakeClassifier({ tier: "high", findings: ["jailbreak_phrases"] }),
    });
    expect(guard.evaluate("hermes", "some prompt").action).toBe("confirm");
  });

  it("an allowed agent + injection-flagged (high) prompt denies when confirm_class is deny", () => {
    const guard = createDelegationGuard({
      frontmatter: new Map([["hermes", { ...hermesEnvelope, confirm_class: "deny" }]]),
      classifier: fakeClassifier({ tier: "high", findings: ["jailbreak_phrases"] }),
    });
    expect(guard.evaluate("hermes", "some prompt").action).toBe("deny");
  });

  it("never invokes the classifier for a denied/unknown agent", () => {
    let classifyCalls = 0;
    const classifier: PromptClassifier = {
      classify: () => {
        classifyCalls += 1;
        return { tier: "low", findings: [] };
      },
    };
    const guard = createDelegationGuard({ frontmatter: new Map(), classifier });
    guard.evaluate("hermes", "do a thing");
    expect(classifyCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Frontmatter loader — fail-closed on missing/malformed files.
// ---------------------------------------------------------------------------

describe("loadDelegationEnvelope / loadDelegationFrontmatterDir", () => {
  it("loads a well-formed frontmatter file into an envelope", () => {
    const dir = mkdtempSync(join(tmpdir(), "delegation-guard-test-"));
    try {
      const filePath = join(dir, "hermes.md");
      writeFileSync(
        filePath,
        [
          "---",
          'allowed_tools:\n  - "*"',
          "network: full",
          "confirm_class: confirm",
          "enabled: true",
          "---",
          "",
          "# Hermes",
        ].join("\n"),
      );
      const envelope = loadDelegationEnvelope("hermes", filePath);
      expect(envelope).toEqual({
        agent: "hermes",
        allowed_tools: ["*"],
        network: "full",
        confirm_class: "confirm",
        enabled: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed (enabled:false) when the frontmatter block is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "delegation-guard-test-"));
    try {
      const filePath = join(dir, "broken.md");
      writeFileSync(filePath, "# not a frontmatter file at all\n");
      const envelope = loadDelegationEnvelope("broken", filePath);
      expect(envelope.enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed (enabled:false) when the file does not exist", () => {
    const envelope = loadDelegationEnvelope("ghost", "/nonexistent/path/ghost.md");
    expect(envelope.enabled).toBe(false);
  });

  // Security-boundary assertion: a delegation config file with the delimiters
  // present but an invalid YAML body must NEVER throw out of the loader (an
  // uncaught YAMLParseError here would crash gateway boot / abort loading
  // every other agent) and must NEVER resolve to an enabled envelope.
  it("fails closed (does not throw, enabled:false) when the frontmatter YAML body is invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "delegation-guard-test-"));
    try {
      const filePath = join(dir, "hermes.md");
      // Unbalanced brackets — invalid YAML, but delimiters are present.
      writeFileSync(filePath, ["---", "allowed_tools: [", "network: full", "---", "", "# Hermes"].join("\n"));

      expect(() => loadDelegationEnvelope("hermes", filePath)).not.toThrow();
      const envelope = loadDelegationEnvelope("hermes", filePath);
      expect(envelope.enabled).toBe(false);

      const guard = createDelegationGuard({
        frontmatter: new Map([["hermes", envelope]]),
        classifier: fakeClassifier({ tier: "low", findings: [] }),
      });
      expect(guard.evaluate("hermes", "clean prompt")).toEqual({
        action: "deny",
        reason: 'delegation disabled for agent "hermes"',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let one malformed-YAML agent file abort loading the rest of the directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "delegation-guard-test-"));
    try {
      writeFileSync(join(dir, "broken.md"), ["---", "network: [", "---"].join("\n"));
      writeFileSync(
        join(dir, "hermes.md"),
        ["---", "network: full", "confirm_class: confirm", "enabled: true", "---"].join("\n"),
      );

      const map = loadDelegationFrontmatterDir(dir);

      expect(map.get("hermes")).toEqual({
        agent: "hermes",
        allowed_tools: [],
        network: "full",
        confirm_class: "confirm",
        enabled: true,
      });
      // The broken file is loaded closed (enabled:false), not absent — its
      // own loader path never throws — but either way `evaluate` denies it.
      expect(map.get("broken")?.enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Asymmetry guard (MINOR 1): a present-but-empty frontmatter block must
  // fail closed exactly like a fully absent one — "present but empty" must
  // never be more trusted than "absent".
  it("fails closed (enabled:false) when the frontmatter block is present but empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "delegation-guard-test-"));
    try {
      const filePath = join(dir, "hermes.md");
      writeFileSync(filePath, ["---", "---", "", "# Hermes"].join("\n"));
      const envelope = loadDelegationEnvelope("hermes", filePath);
      expect(envelope.enabled).toBe(false);

      const guard = createDelegationGuard({
        frontmatter: new Map([["hermes", envelope]]),
        classifier: fakeClassifier({ tier: "low", findings: [] }),
      });
      expect(guard.evaluate("hermes", "clean prompt").action).toBe("deny");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scans a directory of *.md files into a map keyed by filename-as-agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "delegation-guard-test-"));
    try {
      writeFileSync(join(dir, "hermes.md"), ["---", "network: full", "confirm_class: confirm", "---"].join("\n"));
      writeFileSync(join(dir, "notes.txt"), "ignored, not .md");
      const map = loadDelegationFrontmatterDir(dir);
      expect([...map.keys()]).toEqual(["hermes"]);
      expect(map.get("hermes")?.network).toBe("full");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty map for a missing directory", () => {
    expect(loadDelegationFrontmatterDir("/nonexistent/delegation/dir").size).toBe(0);
  });
});
