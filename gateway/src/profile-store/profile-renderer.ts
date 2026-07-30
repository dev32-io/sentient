import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { McpCatalog, McpServerEntry } from "@sentient/config";
import { stringify as yamlStringify } from "yaml";
import { assetPath } from "../config/asset-root.ts";
import { getLog } from "../logging/logger.js";
import { writeFileAtomic } from "../user-auth/atomic-write.js";
import { getHermesProfileDir } from "../user-auth/paths.js";
import { mergePreservedConfig } from "./preserve-agent-sections.js";
import type { ModelProvider, ProfileV1 } from "./profile-types.js";

const log = getLog(["sentient", "gateway", "profile-store", "renderer"]);

// ---------------------------------------------------------------------------
// Template loading — done once at module init.
//
// Templates live in <asset root>/templates/profile/. The root differs per
// deployment shape (repo checkout vs compiled binary); config/asset-root.ts
// owns that resolution and fails loudly on a bogus root rather than letting
// an ENOENT on a template be the first symptom.
// ---------------------------------------------------------------------------

const HERMES_CONFIG_TMPL = readFileSync(assetPath("templates", "profile", "hermes-config.yaml.tmpl"), "utf8");

// Per-provider model fragments. Each fragment is 2-space indented and
// contains no trailing newline; the renderer appends "\n" between blocks.
// Convention: {{model_id}} is always present; {{base_url}} only for providers
// that need a configurable endpoint (ollama-cloud, custom).
const MODEL_FRAGMENTS: Record<ModelProvider, string> = {
  openrouter: readFileSync(assetPath("templates", "profile", "model.openrouter.tmpl"), "utf8"),
  "ollama-cloud": readFileSync(assetPath("templates", "profile", "model.ollama-cloud.tmpl"), "utf8"),
  custom: readFileSync(assetPath("templates", "profile", "model.custom.tmpl"), "utf8"),
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RenderedProfile {
  soulMarkdown: string;
  hermesConfigYaml: string;
}

/** Narrow accessor injected into RenderContext so the renderer can read
 *  the per-user base_url for the "custom" provider without taking a full
 *  SecretsStore dependency. Sync: the render path is synchronous and
 *  secrets are expected to be pre-loaded before rendering. */
export interface ProviderBaseUrlAccessor {
  /** Returns the base_url configured for the given provider, or null if
   *  not set. Used only for "custom" today; other providers use env vars
   *  or fixed URLs. */
  getProviderBaseUrlSync(provider: ModelProvider): string | null;
}

export interface RenderContext {
  // Operator-managed MCP server inventory. Names referenced by
  // profile.tools.enabled[] are resolved against this map; entries
  // not present are dropped with a warn log. An empty/missing catalog
  // yields `mcp_servers: {}` — Hermes treats that as "no MCP".
  mcpCatalog: McpCatalog;
  // Accessor for per-user provider configuration (e.g. custom base_url).
  // Optional: renderers that never use the "custom" provider can omit it.
  // If absent and the profile uses "custom", base_url renders as empty string
  // and Hermes will reject the config — pass this whenever profiles may
  // include a custom provider.
  providerBaseUrl?: ProviderBaseUrlAccessor;
}

export function renderProfile(
  profile: ProfileV1,
  templateBody: string,
  ctx: RenderContext = { mcpCatalog: {} },
): RenderedProfile {
  const soulMarkdown = renderSoul(profile, templateBody);
  const hermesConfigYaml = renderHermesYaml(profile, ctx);
  log.debug("renderProfile", { userId: profile.userId });
  return { soulMarkdown, hermesConfigYaml };
}

function renderSoul(profile: ProfileV1, templateBody: string): string {
  const head = `# ${profile.userId}\n\n`;
  const overrides = profile.persona.overrides.trim();
  const overrideBlock = overrides.length > 0 ? `\n\n## User overrides\n\n${overrides}\n` : "\n";
  return `${head}${templateBody.trim()}\n${overrideBlock}`;
}

// Per-render variable substitution. Operator-authored catalog entries can
// reference {{userId}} in any string position (command, args, url, env
// values) — useful for per-user socket paths and similar.
function substituteVars(value: string, userId: string): string {
  return value.replaceAll("{{userId}}", userId);
}

function applyVarsToEntry(entry: McpServerEntry, _ctx: RenderContext, userId: string): McpServerEntry {
  const sub = (s: string) => substituteVars(s, userId);
  if (entry.transport === "http") {
    return { ...entry, url: sub(entry.url) };
  }
  return {
    ...entry,
    command: sub(entry.command),
    args: entry.args.map(sub),
    env: Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, sub(v)])),
  };
}

// Hermes' MCP loader (tools/mcp_tool.py) expects each server config to
// expose its raw transport keys (`command`/`args`/`env` for stdio,
// `url`/`timeout` for HTTP). The schema's `transport` discriminator is a
// renderer-side hint for type safety; strip it before serialization so
// Hermes doesn't reject the config as having an unknown key.
function entryToHermesYamlMap(entry: McpServerEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (entry.transport === "http") {
    out.url = entry.url;
    out.timeout = entry.timeout;
    out.connect_timeout = entry.connect_timeout;
  } else {
    out.command = entry.command;
    if (entry.args.length > 0) out.args = entry.args;
    if (Object.keys(entry.env).length > 0) out.env = entry.env;
    out.timeout = entry.timeout;
    out.connect_timeout = entry.connect_timeout;
  }
  // `available` is operator metadata for the webui (full tool list +
  // descriptions). Hermes' MCP loader understands include/exclude plus
  // the per-MCP resources/prompts knobs (suppresses the four
  // auto-registered housekeeping tools per server). Strip `available`
  // before serializing or Hermes will reject the config; pass the rest.
  if (entry.tools) {
    const hermesTools: Record<string, unknown> = {};
    if (entry.tools.include) hermesTools.include = entry.tools.include;
    if (entry.tools.exclude) hermesTools.exclude = entry.tools.exclude;
    if (entry.tools.resources !== undefined) hermesTools.resources = entry.tools.resources;
    if (entry.tools.prompts !== undefined) hermesTools.prompts = entry.tools.prompts;
    if (Object.keys(hermesTools).length > 0) out.tools = hermesTools;
  }
  return out;
}

function renderMcpServers(profile: ProfileV1, ctx: RenderContext): string {
  // Hermes' tools_config._get_platform_tools expects mcp_servers as a
  // mapping of name -> {command|url, ...}, not a list. Server names
  // referenced in profile.tools.enabled are resolved against the
  // operator's catalog (gateway config.yaml#mcp_catalog); unknown names
  // are skipped with a warn so a typo doesn't crash the worker.
  //
  // Per-tool whitelist resolution: the catalog entry's `tools.include`
  // is the operator's authoritative allow-list (e.g. ha-mcp ships
  // ~84 tools, the operator picks ~21). The user's
  // `profile.tools.enabled[name]` array can FURTHER narrow this — must
  // be a subset of the operator's list, names not in the catalog list
  // are dropped at render with a warn. Empty user array = inherit
  // operator list verbatim.
  const resolved: Record<string, Record<string, unknown>> = {};
  const unknownServers: string[] = [];
  const unknownTools: { server: string; tool: string }[] = [];
  for (const [name, userInclude] of Object.entries(profile.tools.enabled)) {
    const entry = ctx.mcpCatalog[name];
    if (!entry) {
      unknownServers.push(name);
      continue;
    }
    const yamlEntry = entryToHermesYamlMap(applyVarsToEntry(entry, ctx, profile.userId));
    if (userInclude.length > 0) {
      const operatorInclude = entry.tools?.include ?? null;
      const narrowed = operatorInclude
        ? userInclude.filter((t) => {
            if (operatorInclude.includes(t)) return true;
            unknownTools.push({ server: name, tool: t });
            return false;
          })
        : userInclude.slice();
      // Only emit include/exclude/resources/prompts into the rendered
      // Hermes config; keep `available` (UI-only operator metadata) out
      // of the wire.
      const baseFilter: Record<string, unknown> = {};
      if (entry.tools?.exclude) baseFilter.exclude = entry.tools.exclude;
      if (entry.tools?.resources !== undefined) baseFilter.resources = entry.tools.resources;
      if (entry.tools?.prompts !== undefined) baseFilter.prompts = entry.tools.prompts;
      baseFilter.include = narrowed;
      yamlEntry.tools = baseFilter;
    }
    resolved[name] = yamlEntry;
  }
  if (unknownServers.length > 0) {
    log.warn("renderMcpServers.unknown-servers", {
      userId: profile.userId,
      unknown: unknownServers,
      hint: "add to gateway config.yaml#mcp_catalog or remove from profile.tools.enabled",
    });
  }
  if (unknownTools.length > 0) {
    log.warn("renderMcpServers.unknown-tools", {
      userId: profile.userId,
      unknown: unknownTools,
      hint: "tool name is not in the catalog's tools.include for that server",
    });
  }
  if (Object.keys(resolved).length === 0) return "  {}";
  // yaml.stringify produces a flow-block tree with stable key order; indent
  // by 2 to nest under the `mcp_servers:` parent key.
  return indent(yamlStringify(resolved).trimEnd(), 2);
}

function renderHermesYaml(profile: ProfileV1, ctx: RenderContext): string {
  const modelSection = renderModelSection(profile, ctx);
  const mcpEntries = renderMcpServers(profile, ctx);
  const agentBlock = renderAgentBlock(profile);
  const extra = profile.advanced.extraSystemPrompt.trim();
  const extraBlock = extra.length > 0 ? `extra_system_prompt: |\n${indent(extra, 2)}\n` : "";

  // The rendered yaml deliberately omits a `terminal:` block. Upstream
  // Hermes' `tools/terminal_tool.py:_get_env_config` reads terminal config
  // almost exclusively from `TERMINAL_*` env vars, not from config.yaml —
  // the yaml block we used to emit was silently dropped except for two
  // keys (image, cwd) and led to false security claims around network
  // isolation and TZ correctness. Sentient now drives terminal config via
  // supervisord program env (see gateway/templates/program/program.conf.tmpl)
  // so it actually reaches `docker run`. The single hermes-overlay patch
  // 0007-terminal-docker-network-from-env.patch adds the only missing
  // env-var path (TERMINAL_DOCKER_NETWORK) so task containers can attach
  // to `sentient-internal` for egress isolation.
  //
  // Same story for `enabled_toolsets`: ACP hardcodes `["hermes-acp"]` at
  // session creation. The 0008 hermes-overlay patch
  // (`0008-acp-completeness-fixes.patch`) covers a pile of ACP gaps:
  //   - reads `agent.enabled_toolsets` from config.yaml when set,
  //     otherwise auto-merges `mcp_servers` keys (we rely on auto-merge);
  //   - wires `session_db` so the `session_search` tool (history "pull up
  //     our recent X") actually works under ACP — upstream leaves it None;
  //   - wires `user_id` (from `agent.user_id` or HERMES_HOME basename) so
  //     the agent has framework-level identity for memory scoping, HA
  //     user-context, and audit logging;
  //   - wires `fallback_model` from config.yaml for automatic provider
  //     failover on 429/529/503.
  // Every other Hermes entry point (gateway/run.py, api_server.py,
  // cron/scheduler.py, tui_gateway/server.py) sets these; ACP omitted them
  // entirely. The patch closes that completeness gap.
  return HERMES_CONFIG_TMPL.replace("{{model_section}}", modelSection)
    .replace("{{compression_threshold}}", String(profile.compression.threshold))
    .replace("{{agent_block}}", agentBlock)
    .replace("{{mcp_servers_block}}", mcpEntries)
    .replace("{{max_tokens}}", String(profile.advanced.maxTokens))
    .replace("{{extra_system_prompt_block}}", extraBlock)
    .replace(/\n+$/, "\n");
}

// Emit the `agent:` block. Holds two fields:
//   - reasoning_effort (always emitted; defaults to "minimal" via the
//     profile schema — see profile-types.ts. This is the sentient product
//     default for family-assistant context).
//   - enabled_toolsets (Hermes 0008-acp-completeness-fixes patch; only
//     emitted when profile.tools.toolsets is explicit. Combines those
//     Hermes built-in toolset names with the user's MCP server keys —
//     each MCP is also addressable via the `mcp-<name>` alias. Hermes'
//     patched _resolve_acp_toolsets returns the list verbatim when
//     explicit, so the renderer must include the MCP keys here —
//     Hermes will not auto-append them once `enabled_toolsets` is set.
//     When omitted/empty, Hermes falls back to its baked default.).
function renderAgentBlock(profile: ProfileV1): string {
  const lines: string[] = ["agent:", `  reasoning_effort: ${profile.advanced.reasoningEffort}`];
  const toolsets = profile.tools.toolsets;
  if (toolsets && toolsets.length > 0) {
    const mcpKeys = Object.keys(profile.tools.enabled);
    const merged = Array.from(new Set([...toolsets, ...mcpKeys]));
    lines.push("  enabled_toolsets:");
    for (const t of merged) lines.push(`    - ${t}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderModelSection(profile: ProfileV1, ctx: RenderContext): string {
  const { provider, id } = profile.model;
  const fragment = MODEL_FRAGMENTS[provider];

  // Each fragment has {{model_id}} always; {{base_url}} only for "custom"
  // (Hermes auto-targets ollama.com for ollama-cloud; openrouter has its own
  // fixed endpoint). Substitution is simple string replace.
  let rendered = fragment.replace("{{model_id}}", id);

  if (provider === "custom") {
    // Per-user base_url lives in keys.yaml llm.custom.base_url.
    // Read via the injected accessor (sync — secrets pre-loaded at call site).
    const baseUrl = ctx.providerBaseUrl?.getProviderBaseUrlSync("custom") ?? "";
    if (!baseUrl) {
      log.warn("renderModelSection.custom.missing-base-url", {
        userId: profile.userId,
        hint: "set llm.custom.base_url in secrets/keys.yaml; config will be invalid",
      });
    }
    rendered = rendered.replace("{{base_url}}", baseUrl);
  }

  return rendered;
}

function indent(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export interface WriteRenderedOpts {
  /**
   * Whether to (over)write SOUL.md alongside config.yaml.
   *
   * Required so callers make a conscious choice. SOUL.md is user-editable
   * via `PUT /api/v1/profile/soul` (the webui "System Prompt" pane writes
   * directly to disk). The renderer always reproduces SOUL.md from
   * `template + profile.persona.overrides`, so naïvely overwriting SOUL.md
   * on every apply / boot-migration silently reverts the user's edits.
   *
   * Pass `true` only on provisioning (or other explicit "regenerate the
   * canonical SOUL" actions). For apply orchestration and boot re-render,
   * pass `false` so user edits survive.
   */
  writeSoul: boolean;
}

export async function writeRendered(userId: string, rendered: RenderedProfile, opts: WriteRenderedOpts): Promise<void> {
  const dir = getHermesProfileDir(userId);
  await mkdir(dir, { recursive: true });
  // config.yaml is regenerated from profile.json, which does NOT carry the
  // personality library (agent.personalities) or the active personality
  // (agent.system_prompt) — those live only in config.yaml, written separately
  // by the personality-store. Splice them back in so an apply / boot re-render
  // never wipes the user's personalities.
  const configPath = join(dir, "config.yaml");
  const configYaml = await mergePreservedConfig(configPath, rendered.hermesConfigYaml);
  await writeFileAtomic(configPath, configYaml, { mode: 0o644 });
  if (opts.writeSoul) {
    await writeFileAtomic(join(dir, "SOUL.md"), rendered.soulMarkdown, { mode: 0o644 });
  }
  log.info("writeRendered", { userId, dir, wroteSoul: opts.writeSoul });
}
