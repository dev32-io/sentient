import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpCatalog, McpToolDescriptor } from "@sentient/config";
import type { ImpactTier } from "@sentient/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMap, parseDocument } from "yaml";
import { createPersonalityStore } from "./personality-store.js";
import { type RenderContext, renderProfile, writeRendered } from "./profile-renderer.js";
import { PROFILE_SCHEMA_VERSION, type ProfileV1 } from "./profile-types.js";

// Test catalog mirrors gateway/config.yaml#mcp_catalog defaults so the
// renderer-output expectations stay close to operator-visible behavior.
function tool(name: string, tier: ImpactTier): McpToolDescriptor {
  return { name, description: "", tier };
}

const TEST_CATALOG: McpCatalog = {
  home_assistant: {
    transport: "http",
    url: "http://ha-mcp:8086/mcp",
    timeout: 30,
    connect_timeout: 5,
    tools: { include: [tool("ha_get_state", "read"), tool("ha_call_service", "confirm")] },
  },
  gateway: {
    transport: "stdio",
    command: "nc",
    args: ["-U", "/run/sentient/mcp-{{userId}}.sock"],
    env: {},
    timeout: 30,
    connect_timeout: 10,
    tools: { include: [tool("identify_user", "confirm"), tool("pause_audio", "admin")] },
  },
  duckduckgo: {
    transport: "stdio",
    command: "duckduckgo-mcp-server",
    args: [],
    env: { HTTP_PROXY: "http://egress-proxy:3128" },
    timeout: 30,
    connect_timeout: 10,
    tools: { include: [tool("search", "read")] },
  },
  music_assistant: {
    transport: "http",
    url: "http://ma-mcp:8668/mcp",
    timeout: 30,
    connect_timeout: 5,
    tools: { include: [tool("ma_search", "read")] },
  },
};

const ctx: RenderContext = { mcpCatalog: TEST_CATALOG };

/** Inline test profile — mirrors the bridge defaults used at createUser call
 *  sites. Replace with wizard-supplied shape once Task 46 lands. */
function buildTestProfile(userId: string): ProfileV1 {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    userId,
    model: { provider: "openrouter", id: "google/gemini-2.5-flash" },
    voice: { provider: "local-tts", id: "default" },
    audio: { ttsEnabled: true, channel: "voice" as const },
    persona: { template: "default", overrides: "" },
    tools: {
      permissions: {},
      toolsets: ["memory", "todo", "session_search", "skills"],
    },
    compression: { threshold: 0.5 },
    advanced: { extraSystemPrompt: "", maxTokens: 1024, reasoningEffort: "minimal" as const },
  };
}

describe("renderProfile (pure function)", () => {
  const profile = buildTestProfile("alice");
  const templateBody = "MY_TEMPLATE_TEXT\n\nSome instructions here.";

  it("produces a non-empty SOUL.md and config.yaml", () => {
    const r = renderProfile(profile, templateBody);
    expect(r.soulMarkdown.length).toBeGreaterThan(0);
    expect(r.hermesConfigYaml.length).toBeGreaterThan(0);
  });

  it("includes the template body in SOUL.md", () => {
    const r = renderProfile(profile, templateBody);
    expect(r.soulMarkdown).toContain("MY_TEMPLATE_TEXT");
  });

  it("includes persona overrides AFTER the template body", () => {
    const profileWithOverrides = {
      ...profile,
      persona: { ...profile.persona, overrides: "Extra override text" },
    };
    const r = renderProfile(profileWithOverrides, templateBody);
    const templateIdx = r.soulMarkdown.indexOf("MY_TEMPLATE_TEXT");
    const overrideIdx = r.soulMarkdown.indexOf("Extra override text");
    expect(templateIdx).toBeGreaterThanOrEqual(0);
    expect(overrideIdx).toBeGreaterThan(templateIdx);
  });

  it("renders model.provider + model.id in the YAML for openrouter (new-user default)", () => {
    const r = renderProfile(profile, templateBody);
    expect(r.hermesConfigYaml).toMatch(/provider:\s*openrouter/);
    // Hermes' ACP adapter reads `default:`; the gateway runner reads either
    // `default:` or `model:`. Use `default:` so both code paths work.
    expect(r.hermesConfigYaml).toMatch(/default:\s*google\/gemini-2\.5-flash/);
  });

  it("renders ollama-cloud provider shape", () => {
    const ollamaProfile = {
      ...profile,
      model: { provider: "ollama-cloud" as const, id: "gpt-oss:120b" },
    };
    const r = renderProfile(ollamaProfile, templateBody);
    expect(r.hermesConfigYaml).toMatch(/provider:\s*ollama-cloud/);
    // Hermes' ollama-cloud provider auto-targets https://ollama.com — the
    // profile yaml does NOT carry a base_url field. Auth flows via
    // OLLAMA_API_KEY env (set by supervisord program env block).
    expect(r.hermesConfigYaml).not.toMatch(/base_url:/);
    expect(r.hermesConfigYaml).toMatch(/default:\s*gpt-oss:120b/);
    expect(r.hermesConfigYaml).toMatch(/api_key_env:\s*OLLAMA_API_KEY/);
  });

  it("renders custom provider shape with per-user base_url from providerBaseUrl accessor", () => {
    // Outcome B: custom provider uses provider: custom + base_url from secrets.
    // base_url is per-user (llm.custom.base_url in keys.yaml), not an env var.
    const customProfile = {
      ...profile,
      model: { provider: "custom" as const, id: "my-model:latest" },
    };
    const stubAccessor = {
      getProviderBaseUrlSync: () => "http://192.168.1.100:8080/v1",
    };
    const r = renderProfile(customProfile, templateBody, {
      mcpCatalog: {},
      providerBaseUrl: stubAccessor,
    });
    expect(r.hermesConfigYaml).toMatch(/provider:\s*custom/);
    expect(r.hermesConfigYaml).toMatch(/base_url:\s*http:\/\/192\.168\.1\.100:8080\/v1/);
    expect(r.hermesConfigYaml).toMatch(/default:\s*my-model:latest/);
    expect(r.hermesConfigYaml).toMatch(/api_key_env:\s*CUSTOM_API_KEY/);
  });

  it("does NOT render a terminal: block (terminal config flows via supervisord program TERMINAL_* env vars, not config.yaml)", () => {
    const r = renderProfile(profile, templateBody);
    // Upstream Hermes' _get_env_config drops terminal config from yaml; the
    // rendered profile must not pretend otherwise. See the renderer comment
    // in renderHermesYaml() for the full story.
    expect(r.hermesConfigYaml).not.toMatch(/^terminal:/m);
    expect(r.hermesConfigYaml).not.toMatch(/docker_network:/);
    expect(r.hermesConfigYaml).not.toMatch(/docker_env:/);
  });

  it("renders compression.threshold and advanced.maxTokens", () => {
    const customProfile = {
      ...profile,
      compression: { threshold: 0.42 },
      advanced: { ...profile.advanced, maxTokens: 4096 },
    };
    const r = renderProfile(customProfile, templateBody);
    expect(r.hermesConfigYaml).toMatch(/threshold:\s*0\.42/);
    expect(r.hermesConfigYaml).toMatch(/max_output_tokens:\s*4096/);
  });

  // Tool-permissions work (task 1, 2026-08-07): `profile.tools.enabled` is
  // retired and renderMcpServers is now a STUB that always emits an empty
  // block, regardless of profile.tools.permissions or the passed-in catalog
  // — see the STUB comment on renderMcpServers in profile-renderer.ts for
  // why (Hermes never read this block; the gateway registers its own MCP
  // with a delegated Hermes agent through a separate, live mechanism). The
  // catalog-driven rendering tests that used to live here (per-server URL/
  // stdio/env rendering, unknown-server skip, per-tool narrowing, `available`
  // stripping) asserted behavior that no longer exists and were deleted
  // rather than kept red or given misleading passing bodies.
  it("always renders an empty mcp_servers block (dead code pending Task 3)", () => {
    const r = renderProfile(profile, templateBody, ctx);
    expect(r.hermesConfigYaml).toMatch(/mcp_servers:\s*\n\s*\{\}/);
  });

  // Hermes' 0008-acp-completeness-fixes patch reads `agent.enabled_toolsets`
  // verbatim when explicit. It used to also merge in MCP server keys so MCP
  // tools stayed reachable via a `mcp-<name>` alias; that merge is retired
  // alongside `tools.enabled` because the aliased servers no longer appear
  // in this file's (now-stubbed) mcp_servers block — see renderAgentBlock's
  // comment in profile-renderer.ts.
  it("emits agent.enabled_toolsets from profile.tools.toolsets only (no MCP-key merge)", () => {
    const r = renderProfile(profile, templateBody, ctx);
    expect(r.hermesConfigYaml).toMatch(/agent:\s*\n[\s\S]*enabled_toolsets:/);
    expect(r.hermesConfigYaml).toMatch(/-\s*memory/);
    expect(r.hermesConfigYaml).not.toMatch(/-\s*home_assistant/);
    expect(r.hermesConfigYaml).not.toMatch(/-\s*gateway/);
  });

  it("omits enabled_toolsets when profile.tools.toolsets is empty (legacy fallback)", () => {
    const legacy = { ...profile, tools: { permissions: profile.tools.permissions, toolsets: [] } };
    const r = renderProfile(legacy, templateBody, ctx);
    expect(r.hermesConfigYaml).not.toMatch(/enabled_toolsets:/);
  });

  it("emits agent.reasoning_effort from profile.advanced.reasoningEffort", () => {
    const r = renderProfile(profile, templateBody, ctx);
    expect(r.hermesConfigYaml).toMatch(/agent:\s*\n\s*reasoning_effort:\s*minimal/);
  });

  it("emits agent.reasoning_effort even when toolsets are empty (always-on agent block)", () => {
    const legacy = { ...profile, tools: { permissions: profile.tools.permissions, toolsets: [] } };
    const r = renderProfile(legacy, templateBody, ctx);
    expect(r.hermesConfigYaml).toMatch(/agent:\s*\n\s*reasoning_effort:\s*minimal/);
  });

  it("propagates a non-default reasoning_effort to the rendered yaml", () => {
    const r = renderProfile(
      { ...profile, advanced: { ...profile.advanced, reasoningEffort: "high" } },
      templateBody,
      ctx,
    );
    expect(r.hermesConfigYaml).toMatch(/reasoning_effort:\s*high/);
  });

  it("is deterministic — same inputs yield byte-identical outputs", () => {
    const r1 = renderProfile(profile, templateBody);
    const r2 = renderProfile(profile, templateBody);
    expect(r1.soulMarkdown).toBe(r2.soulMarkdown);
    expect(r1.hermesConfigYaml).toBe(r2.hermesConfigYaml);
  });
});

describe("writeRendered (side-effect helper)", () => {
  let tmpDir: string;
  const userId = "bob";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sentient-test-"));
    process.env.SENTIENT_GATEWAY_ROOT = tmpDir;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: test cleanup requires full env var removal
    delete process.env.SENTIENT_GATEWAY_ROOT;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes both files when writeSoul=true (provisioning path)", async () => {
    const profile = buildTestProfile(userId);
    const rendered = renderProfile(profile, "TEMPLATE_BODY");
    await writeRendered(userId, rendered, { writeSoul: true });

    const hermesDir = join(tmpDir, userId, "profiles", userId);
    const soulPath = join(hermesDir, "SOUL.md");
    const configPath = join(hermesDir, "config.yaml");

    expect(existsSync(soulPath)).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    expect(readFileSync(soulPath, "utf8")).toBe(rendered.soulMarkdown);
    expect(readFileSync(configPath, "utf8")).toBe(rendered.hermesConfigYaml);
  });

  // Apply + boot-migration call writeRendered with writeSoul:false so they
  // don't clobber user-edited SOUL.md saved via PUT /api/v1/profile/soul.
  it("skips SOUL.md when writeSoul=false (apply / boot-migration path)", async () => {
    const profile = buildTestProfile(userId);
    const rendered = renderProfile(profile, "TEMPLATE_BODY");
    await writeRendered(userId, rendered, { writeSoul: false });

    const hermesDir = join(tmpDir, userId, "profiles", userId);
    expect(existsSync(join(hermesDir, "config.yaml"))).toBe(true);
    expect(existsSync(join(hermesDir, "SOUL.md"))).toBe(false);
  });

  it("uses chmod 0644", async () => {
    const profile = buildTestProfile(userId);
    const rendered = renderProfile(profile, "TEMPLATE_BODY");
    await writeRendered(userId, rendered, { writeSoul: true });

    const hermesDir = join(tmpDir, userId, "profiles", userId);
    const soulMode = statSync(join(hermesDir, "SOUL.md")).mode & 0o777;
    const configMode = statSync(join(hermesDir, "config.yaml")).mode & 0o777;

    expect(soulMode).toBe(0o644);
    expect(configMode).toBe(0o644);
  });
});

// Regression: personalities live ONLY in config.yaml#agent.personalities (and
// the active one as agent.system_prompt), written by the personality-store.
// They are NOT in profile.json / ProfileV1. The renderer regenerates config.yaml
// from the profile, so before the fix every apply / boot re-render (the webui
// apply bar calls POST /apply on any "slow" op — creating a personality is one)
// wiped the whole library. writeRendered must splice those sections back in.
describe("writeRendered preserves personality state across a re-render (wipe-bug regression)", () => {
  let tmpDir: string;
  const userId = "carol";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sentient-test-"));
    process.env.SENTIENT_GATEWAY_ROOT = tmpDir;
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: test cleanup requires full env var removal
    delete process.env.SENTIENT_GATEWAY_ROOT;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // The active personality is encoded as agent.system_prompt (extractList
  // resolves activeName by matching it against each personality body).
  function activate(configPath: string, body: string): void {
    const doc = parseDocument(readFileSync(configPath, "utf8"));
    const agent = doc.get("agent");
    if (!isMap(agent)) throw new Error("test setup: rendered config has no agent map");
    agent.set("system_prompt", body);
    writeFileSync(configPath, doc.toString());
  }

  it("keeps a created + activated personality after an apply re-render", async () => {
    const profile = buildTestProfile(userId);
    const hermesDir = join(tmpDir, userId, "profiles", userId);
    const configPath = join(hermesDir, "config.yaml");

    // 1) Provision the initial config.yaml.
    await writeRendered(userId, renderProfile(profile, "TEMPLATE_BODY"), { writeSoul: true });

    // 2) Create a personality (writes agent.personalities into config.yaml).
    const store = createPersonalityStore({ profileDir: hermesDir });
    const body = "You are a rigorous scientist. Cite sources.";
    expect((await store.add("scientist", body)).ok).toBe(true);

    // 3) Activate it.
    activate(configPath, body);

    const before = await store.list();
    if (!before.ok) throw new Error("unreachable");
    expect(before.value.personalities.map((p) => p.name)).toContain("scientist");
    expect(before.value.activeName).toBe("scientist");

    // 4) An apply / boot re-renders config.yaml from the profile (no
    //    personalities) and writes it back. The personality MUST survive.
    await writeRendered(userId, renderProfile(profile, "TEMPLATE_BODY"), { writeSoul: false });

    const after = await store.list();
    if (!after.ok) throw new Error("unreachable");
    expect(after.value.personalities.map((p) => p.name)).toContain("scientist");
    expect(after.value.personalities.find((p) => p.name === "scientist")?.body).toBe(body);
    expect(after.value.activeName).toBe("scientist");
  });
});
