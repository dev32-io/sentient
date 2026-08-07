import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { McpCatalog } from "@sentient/config";
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
  // Operator-managed MCP server inventory. Unused by renderMcpServers as of
  // the tool-permissions work (see that function's STUB comment) — kept on
  // the context shape only because callers (apply-deps.ts) still construct
  // and pass it. Task 3 should decide whether this field goes away with
  // renderMcpServers or stays for a future consumer.
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

// STUB (Task 1 of the tool-permissions work, 2026-08-07): this used to
// resolve `profile.tools.enabled` (per-server tool whitelist) against
// `ctx.mcpCatalog` into a Hermes `mcp_servers:` block. `tools.enabled` is
// retired — replaced by `profile.tools.permissions`, owned by the gateway's
// own ToolBroker (see profile-types.ts) — and per the owner's own read of
// this file's ONLY consumer, Hermes never read this block anyway: the
// gateway's MCP is registered with a delegated Hermes agent at call time via
// `hermes mcp add` (external-tools/hermes-external-tool.ts), and every
// proxied call is mediated by the CALLER's own ToolBroker, not by anything
// Hermes loads from its own config.yaml. So this always rendered dead data.
//
// Left as an explicit empty stub — not deleted outright — because deciding
// whether `renderProfile`/`RenderContext.mcpCatalog` should lose this
// concept entirely (vs. keep emitting an inert `{}` for template-shape
// stability) is Task 3's call, not this task's. Task 3 punch list: delete
// this function and `ctx.mcpCatalog`'s only remaining use-site (this file),
// OR confirm callers still need the `{}` placeholder in the rendered yaml
// and keep the stub as-is.
function renderMcpServers(_profile: ProfileV1, _ctx: RenderContext): string {
  return "  {}";
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
//     emitted when profile.tools.toolsets is explicit).
//
// STUB (Task 1 of the tool-permissions work, 2026-08-07): this used to merge
// the emitted toolsets with `Object.keys(profile.tools.enabled)` so each MCP
// server also got a `mcp-<name>` toolset alias. `tools.enabled` is retired
// and `renderMcpServers` above always emits an empty `mcp_servers:` block
// now, so there is nothing left in THIS file's rendered yaml for such an
// alias to reference — merging `Object.keys(profile.tools.permissions)` in
// its place would just re-introduce the same phantom-alias problem the stub
// above was written to avoid. Dropped the merge entirely; Task 3 should
// remove this whole comment once it disposes of renderMcpServers.
function renderAgentBlock(profile: ProfileV1): string {
  const lines: string[] = ["agent:", `  reasoning_effort: ${profile.advanced.reasoningEffort}`];
  const toolsets = profile.tools.toolsets;
  if (toolsets && toolsets.length > 0) {
    lines.push("  enabled_toolsets:");
    for (const t of toolsets) lines.push(`    - ${t}`);
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
