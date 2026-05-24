import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersonalityStore } from "./personality-store.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ps-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(body: string): void {
  writeFileSync(join(dir, "config.yaml"), body);
}

describe("personality-store.list", () => {
  it("reads simple-string personalities and resolves active by body match", async () => {
    writeConfig(
      [
        "agent:",
        '  system_prompt: "Speak warmly."',
        "  personalities:",
        '    warm: "Speak warmly."',
        '    focus: "Be terse."',
        "",
      ].join("\n"),
    );
    const store = createPersonalityStore({ profileDir: dir });
    const r = await store.list();
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.personalities).toHaveLength(2);
    expect(r.value.personalities.map((p) => p.name).sort()).toEqual(["focus", "warm"]);
    expect(r.value.activeName).toBe("warm");
  });

  it("resolves dict-form personality (system_prompt + tone + style)", async () => {
    writeConfig(
      [
        "agent:",
        '  system_prompt: "You are X\\nTone: bright\\nStyle: brief"',
        "  personalities:",
        "    x:",
        '      system_prompt: "You are X"',
        '      tone: "bright"',
        '      style: "brief"',
        "",
      ].join("\n"),
    );
    const r = await createPersonalityStore({ profileDir: dir }).list();
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.personalities[0]?.body).toBe("You are X\nTone: bright\nStyle: brief");
    expect(r.value.activeName).toBe("x");
  });

  it("returns activeName=null when no personality body matches", async () => {
    writeConfig(
      ["agent:", '  system_prompt: "completely unrelated"', "  personalities:", '    warm: "Speak warmly."', ""].join(
        "\n",
      ),
    );
    const r = await createPersonalityStore({ profileDir: dir }).list();
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.activeName).toBeNull();
  });

  it("returns io-error when config.yaml is missing", async () => {
    const r = await createPersonalityStore({ profileDir: dir }).list();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toBe("io-error");
  });

  it("returns parse-error on malformed yaml", async () => {
    writeConfig("agent: {{");
    const r = await createPersonalityStore({ profileDir: dir }).list();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toBe("parse-error");
  });
});

describe("personality-store.add/update/remove", () => {
  it("add then list round-trips", async () => {
    writeConfig("agent:\n  personalities: {}\n");
    const store = createPersonalityStore({ profileDir: dir });
    const add = await store.add("warm", "be warm");
    expect(add.ok).toBe(true);
    const list = await store.list();
    if (!list.ok) throw new Error("unreachable");
    expect(list.value.personalities[0]?.name).toBe("warm");
    expect(list.value.personalities[0]?.body).toBe("be warm");
  });

  it("add bootstraps agent.personalities when config has no agent key", async () => {
    // Real-world: profile-renderer does not seed agent.personalities; user's
    // first /personalities POST must create the structure. Pre-fix this
    // threw "agent node must be a map" because doc.set with a plain object
    // didn't produce a YAMLMap node.
    writeConfig("model:\n  provider: openai\nmax_output_tokens: 1024\n");
    const store = createPersonalityStore({ profileDir: dir });
    const add = await store.add("focus", "be terse");
    expect(add.ok).toBe(true);
    const list = await store.list();
    if (!list.ok) throw new Error("unreachable");
    expect(list.value.personalities).toHaveLength(1);
    expect(list.value.personalities[0]?.name).toBe("focus");
  });

  it("add rejects duplicate name with name-conflict", async () => {
    writeConfig('agent:\n  personalities:\n    warm: "x"\n');
    const store = createPersonalityStore({ profileDir: dir });
    const r = await store.add("warm", "y");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toBe("name-conflict");
  });

  it("add rejects invalid name", async () => {
    writeConfig("agent:\n  personalities: {}\n");
    const store = createPersonalityStore({ profileDir: dir });
    const r = await store.add("has spaces!", "y");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toBe("invalid-name");
  });

  it("update returns not-found when entry missing", async () => {
    writeConfig("agent:\n  personalities: {}\n");
    const store = createPersonalityStore({ profileDir: dir });
    const r = await store.update("warm", "y");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toBe("not-found");
  });

  it("remove deletes the entry and persists", async () => {
    writeConfig('agent:\n  personalities:\n    warm: "x"\n    focus: "y"\n');
    const store = createPersonalityStore({ profileDir: dir });
    expect((await store.remove("warm")).ok).toBe(true);
    const list = await store.list();
    if (!list.ok) throw new Error("unreachable");
    expect(list.value.personalities.map((p) => p.name)).toEqual(["focus"]);
  });

  // Regression: deleting the currently-active personality must also clear
  // agent.system_prompt. Without this Hermes keeps using the deleted body
  // as the live system prompt across restart, leaving the deleted persona
  // "stuck on" with no way to revert short of switching to another one.
  it("remove clears agent.system_prompt when deleting the active personality", async () => {
    writeConfig(
      [
        "agent:",
        '  system_prompt: "be warm"',
        "  personalities:",
        '    warm: "be warm"',
        '    focus: "be focused"',
        "",
      ].join("\n"),
    );
    const store = createPersonalityStore({ profileDir: dir });
    expect((await store.remove("warm")).ok).toBe(true);
    const after = readFileSync(join(dir, "config.yaml"), "utf8");
    expect(after).not.toContain("system_prompt:");
    const list = await store.list();
    if (!list.ok) throw new Error("unreachable");
    expect(list.value.activeName).toBeNull();
  });

  it("remove leaves agent.system_prompt alone when deleting an inactive personality", async () => {
    writeConfig(
      [
        "agent:",
        '  system_prompt: "be warm"',
        "  personalities:",
        '    warm: "be warm"',
        '    focus: "be focused"',
        "",
      ].join("\n"),
    );
    const store = createPersonalityStore({ profileDir: dir });
    expect((await store.remove("focus")).ok).toBe(true);
    const after = readFileSync(join(dir, "config.yaml"), "utf8");
    expect(after).toContain('system_prompt: "be warm"');
  });

  it("preserves surrounding YAML structure across writes", async () => {
    writeConfig(
      [
        "# top-level comment",
        "agent:",
        '  system_prompt: "keep me"',
        "  personalities:",
        '    warm: "be warm"',
        "other:",
        "  unrelated: 1",
        "",
      ].join("\n"),
    );
    const store = createPersonalityStore({ profileDir: dir });
    expect((await store.add("focus", "be focused")).ok).toBe(true);
    const after = readFileSync(join(dir, "config.yaml"), "utf8");
    expect(after).toContain("system_prompt:");
    expect(after).toContain("other:");
    expect(after).toContain("unrelated:");
    expect(after).toContain("focus:");
    expect(after).toContain("warm:");
  });
});
