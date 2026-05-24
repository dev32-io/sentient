import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpCatalog } from "@sentient/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RenderContext, renderProfile, writeRendered } from "./profile-renderer.js";
import { PROFILE_SCHEMA_VERSION, type ProfileV1 } from "./profile-types.js";

// Test catalog mirrors gateway/config.yaml#mcp_catalog defaults so the
// renderer-output expectations stay close to operator-visible behavior.
const TEST_CATALOG: McpCatalog = {
  home_assistant: {
    transport: "http",
    url: "http://ha-mcp:8086/mcp",
    timeout: 30,
    connect_timeout: 5,
  },
  gateway: {
    transport: "stdio",
    command: "nc",
    args: ["-U", "/run/sentient/mcp-{{userId}}.sock"],
    env: {},
    timeout: 30,
    connect_timeout: 10,
    tools: { include: ["identify_user", "pause_audio"] },
  },
  duckduckgo: {
    transport: "stdio",
    command: "duckduckgo-mcp-server",
    args: [],
    env: { HTTP_PROXY: "http://egress-proxy:3128" },
    timeout: 30,
    connect_timeout: 10,
  },
  music_assistant: {
    transport: "http",
    url: "http://ma-mcp:8668/mcp",
    timeout: 30,
    connect_timeout: 5,
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
    voice: { provider: "fish-audio", id: "default" },
    audio: { ttsEnabled: true, channel: "voice" as const },
    persona: { template: "default", overrides: "" },
    tools: {
      enabled: { home_assistant: [], gateway: [], music_assistant: [], duckduckgo: [] },
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

  it("renders the enabled tools list", () => {
    const r = renderProfile(profile, templateBody, ctx);
    for (const tool of Object.keys(profile.tools.enabled)) {
      expect(r.hermesConfigYaml).toMatch(new RegExp(tool));
    }
  });

  // Hermes' MCP loader rejects servers that lack a transport (command for
  // stdio, url for HTTP). Servers must be rendered with their full spec
  // from the catalog — `enabled: true` alone surfaces as a warning loop
  // and the tool is silently absent from the agent's tool set.
  it("renders home_assistant with the HTTP url from the catalog", () => {
    const r = renderProfile({ ...profile, tools: { enabled: { home_assistant: [] } } }, templateBody, ctx);
    expect(r.hermesConfigYaml).toMatch(/home_assistant:\s*\n\s*url:\s*http:\/\/ha-mcp:8086\/mcp/);
  });

  it("interpolates {{userId}} into stdio args", () => {
    const r = renderProfile({ ...profile, tools: { enabled: { gateway: [] } } }, templateBody, ctx);
    expect(r.hermesConfigYaml).toMatch(/command:\s*nc/);
    expect(r.hermesConfigYaml).toContain("/run/sentient/mcp-alice.sock");
    expect(r.hermesConfigYaml).not.toContain("{{userId}}");
  });

  it("renders stdio env block (e.g. duckduckgo HTTP_PROXY)", () => {
    const r = renderProfile({ ...profile, tools: { enabled: { duckduckgo: [] } } }, templateBody, ctx);
    expect(r.hermesConfigYaml).toMatch(/duckduckgo:/);
    expect(r.hermesConfigYaml).toMatch(/command:\s*duckduckgo-mcp-server/);
    expect(r.hermesConfigYaml).toMatch(/HTTP_PROXY:\s*http:\/\/egress-proxy:3128/);
  });

  it("skips names not in the MCP catalog (no transport details)", () => {
    const r = renderProfile(
      { ...profile, tools: { enabled: { home_assistant: [], bogus_tool: [] } } },
      templateBody,
      ctx,
    );
    expect(r.hermesConfigYaml).toContain("home_assistant:");
    expect(r.hermesConfigYaml).not.toContain("bogus_tool");
  });

  // Per-user `tools.enabled[name] = ["a","b"]` further narrows the operator's
  // catalog `tools.include` allowlist for that server. Empty array = inherit.
  it("narrows catalog tools.include with the user's per-tool whitelist", () => {
    const r = renderProfile({ ...profile, tools: { enabled: { gateway: ["pause_audio"] } } }, templateBody, ctx);
    expect(r.hermesConfigYaml).toMatch(/pause_audio/);
    expect(r.hermesConfigYaml).not.toMatch(/identify_user/);
  });

  it("drops user tool names that are not in the operator's catalog include list", () => {
    const r = renderProfile(
      { ...profile, tools: { enabled: { gateway: ["pause_audio", "definitely_not_a_tool"] } } },
      templateBody,
      ctx,
    );
    expect(r.hermesConfigYaml).toMatch(/pause_audio/);
    expect(r.hermesConfigYaml).not.toMatch(/definitely_not_a_tool/);
  });

  // Hermes' 0008-acp-completeness-fixes patch reads `agent.enabled_toolsets`
  // verbatim when explicit — does NOT auto-append MCP server keys. Renderer
  // must merge profile.tools.toolsets ∪ profile.tools.enabled keys so MCP
  // tools stay reachable after we trim hermes-acp out of the default.
  it("emits agent.enabled_toolsets merging profile.toolsets and MCP server keys", () => {
    const r = renderProfile(profile, templateBody, ctx);
    expect(r.hermesConfigYaml).toMatch(/agent:\s*\n[\s\S]*enabled_toolsets:/);
    expect(r.hermesConfigYaml).toMatch(/-\s*memory/);
    expect(r.hermesConfigYaml).toMatch(/-\s*home_assistant/);
    expect(r.hermesConfigYaml).toMatch(/-\s*gateway/);
  });

  it("omits enabled_toolsets when profile.tools.toolsets is empty (legacy fallback)", () => {
    const legacy = { ...profile, tools: { enabled: profile.tools.enabled, toolsets: [] } };
    const r = renderProfile(legacy, templateBody, ctx);
    expect(r.hermesConfigYaml).not.toMatch(/enabled_toolsets:/);
  });

  it("emits agent.reasoning_effort from profile.advanced.reasoningEffort", () => {
    const r = renderProfile(profile, templateBody, ctx);
    expect(r.hermesConfigYaml).toMatch(/agent:\s*\n\s*reasoning_effort:\s*minimal/);
  });

  it("emits agent.reasoning_effort even when toolsets are empty (always-on agent block)", () => {
    const legacy = { ...profile, tools: { enabled: profile.tools.enabled, toolsets: [] } };
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

  // tools.available is operator metadata for the webui Tools page. Hermes'
  // MCP loader rejects unknown keys — leaking `available` into the rendered
  // config would silently disable the whole server.
  it("strips tools.available from the rendered MCP block (UI-only metadata)", () => {
    const catalogWithAvailable: McpCatalog = {
      ...TEST_CATALOG,
      gateway: {
        ...TEST_CATALOG.gateway,
        tools: {
          include: ["identify_user"],
          available: [
            { name: "identify_user", description: "..." },
            { name: "pause_audio", description: "..." },
          ],
        },
      } as McpCatalog["gateway"],
    };
    const r = renderProfile(
      { ...profile, tools: { enabled: { gateway: [] }, toolsets: profile.tools.toolsets } },
      templateBody,
      { ...ctx, mcpCatalog: catalogWithAvailable },
    );
    expect(r.hermesConfigYaml).not.toContain("available:");
  });

  it("is deterministic — same inputs yield byte-identical outputs", () => {
    const r1 = renderProfile(profile, templateBody);
    const r2 = renderProfile(profile, templateBody);
    expect(r1.soulMarkdown).toBe(r2.soulMarkdown);
    expect(r1.hermesConfigYaml).toBe(r2.hermesConfigYaml);
  });

  // Signal device pairing: gateway + cron blocks are conditional on
  // profile.devices.signal.paired. Hermes' built-in defaults apply when unpaired.
  it("omits gateway+cron blocks when Signal is not paired", () => {
    const r = renderProfile(profile, templateBody, ctx);
    expect(r.hermesConfigYaml).not.toContain("default_deliver: signal");
    // No leftover placeholder
    expect(r.hermesConfigYaml).not.toContain("{{gateway_signal_block}}");
  });

  it("includes gateway+cron blocks when Signal is paired", () => {
    const paired: ProfileV1 = {
      ...profile,
      devices: { signal: { paired: true, account_masked: "+1•••••1234" } },
    };
    const r = renderProfile(paired, templateBody, ctx);
    expect(r.hermesConfigYaml).toContain("platforms:");
    expect(r.hermesConfigYaml).toMatch(/signal:\s*\n\s+enabled: true/);
    expect(r.hermesConfigYaml).toContain("unauthorized_dm_behavior: ignore");
    expect(r.hermesConfigYaml).toContain("default_deliver: signal");
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
