import type { ToolPermission, ToolPermissionPatchMap } from "@sentient/config";
import type { ImpactTier } from "@sentient/protocol";
import { createLogger } from "@sentient/web-sdk";
import { type ApiHttpError, bearerHeaders, handleFetch, jsonHeaders } from "./_helpers";

const log = createLogger(["sentient", "webui", "profile", "api"]);

// ---------------------------------------------------------------------------
// Types — mirror gateway/src/profile-store/profile-types.ts ProfileV1 exactly.
// TODO: move to shared/ when the gateway/webui boundary is formally bridged.
// ---------------------------------------------------------------------------

export type ModelProvider = "openrouter" | "ollama-cloud" | "custom";
export type VoiceProvider = "local-tts";
/** Mirrors gateway reasoningEffortSchema (Hermes `agent.reasoning_effort`). */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Local mirror of gateway ProfileV1. Keep in sync with profileV1Schema. */
export interface ProfileV1 {
  schemaVersion: 1;
  userId: string;
  model: {
    provider: ModelProvider;
    id: string;
  };
  voice: {
    provider: VoiceProvider;
    id: string;
  };
  audio: {
    ttsEnabled: boolean;
    channel: "voice" | "text";
  };
  persona: {
    template: string;
    overrides: string;
  };
  tools: {
    /**
     * Per-tool permission, keyed by MCP server name then tool name (or the
     * server's `"*"` wildcard — see `McpCatalogView.wildcardPermissionKey`
     * below). Mirrors gateway `ProfileV1PutBody["tools"]["permissions"]`
     * (`gateway/src/profile-store/profile-types.ts`) exactly, NOT the stored
     * `ProfileV1["tools"]["permissions"]` — the gateway's GET response never
     * contains a `null` leaf, but a PUT this client sends MAY, to CLEAR a key
     * back to "no stored opinion" (see `ToolPermissionOrClear`'s doc comment
     * in `@sentient/config`). Using the wider PUT-body type for the single
     * client-side draft this whole pane edits, rather than switching types
     * between GET and PUT, keeps `withToolPermission` (tool-permission-patch.ts)
     * the one place that has to reason about the difference.
     *
     * OPTIONAL, and that is load-bearing, not an oversight: absent means
     * "never set" — every tool resolves from the person's role template.
     * An empty object (`{}`) is a DIFFERENT, deliberate statement: a table
     * naming no server, i.e. every server off. Never default this to `{}`
     * when building a PUT body — see `McpCatalogView.servers`'s doc comment
     * for the absent-server rule this trips.
     */
    permissions?: ToolPermissionPatchMap;
    /**
     * Hermes built-in toolsets enabled for this user. Each entry is a
     * Hermes toolset name (memory, todo, skills, web, browser, terminal,
     * file, vision, code_execution, delegation, …). Powers the per-tool
     * toggle UI on the "Hermes built-ins" Tools-page category — flipping
     * any tool of a toolset flips the whole toolset here. Optional for
     * back-compat with older saved profiles; the renderer falls back to
     * a lean default when missing.
     */
    toolsets?: readonly string[];
  };
  compression: {
    threshold: number;
  };
  advanced: {
    extraSystemPrompt: string;
    maxTokens: number;
    /** Hermes `agent.reasoning_effort`. Default "minimal" for family-
     *  assistant latency/cost; override in Settings → Advanced. */
    reasoningEffort: ReasoningEffort;
  };
}

export type ProfileApiError = ApiHttpError;

type Result<T> = { ok: true; value: T } | { ok: false; error: ProfileApiError };

// ---------------------------------------------------------------------------
// SOUL + Personality types — mirror gateway profile-edit handlers.
// ---------------------------------------------------------------------------

export interface SoulDoc {
  content: string;
  /** ISO-8601 timestamp when the file was last written, or null if never. */
  lastModified: string | null;
}

/** Hermes memory file (MEMORY.md or USER.md). The `charLimit` is the
 *  upstream Hermes spec (memory_char_limit / user_char_limit) — the UI
 *  enforces it as a hard cap on the textarea so users can't write past
 *  what the agent's pruner expects to keep. */
export interface MemoryDoc {
  content: string;
  lastModified: string | null;
  charLimit: number;
}

export type MemorySlot = "memory" | "user";

export interface Personality {
  name: string;
  body: string;
}

export interface PersonalityList {
  personalities: Personality[];
  /** Name of the currently active personality, or null if none. */
  activeName: string | null;
}

export interface RestartResult {
  state: "ready" | "failed";
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// MCP catalog — mirrors gateway/src/api/handlers/mcp-catalog.ts's view types
// EXACTLY (read that file's doc comments before touching this section; they
// answer most questions about what a client is and isn't allowed to assume).
// Used by the Tools pane to render one permission dropdown per tool.
// ---------------------------------------------------------------------------

export interface McpToolView {
  readonly name: string;
  readonly description: string;
  readonly tier: ImpactTier;
  readonly permission: ToolPermission;
  /** Whether a PUT to `/api/v1/profile/me` can actually change this tool's
   *  `permission`. `false` for a gateway-native tool (`delegateTask`, under
   *  `McpCatalogView.nativeTools`): no MCP server addresses it, so no key a
   *  client writes back is ever read for it. A client MUST render an
   *  unsettable tool read-only — branch on THIS FIELD, never on the tool's
   *  name; the wire never special-cases `delegateTask` by name either. */
  readonly settable: boolean;
}

export interface McpCatalogEntryView {
  /** Role-narrowed: a tool this account's role can never execute is omitted
   *  entirely, never shown locked. Always non-empty when the server key
   *  itself is present (see `McpCatalogView.servers` below). */
  readonly tools: readonly McpToolView[];
  /** Operator-curated default whitelist, predates per-tool permissions;
   *  superseded for governance purposes by each tool's own `permission`
   *  above. Mirrored for wire fidelity, not read by this pane. */
  readonly defaultInclude: readonly string[];
  /** This server's own `"*"` wildcard entry, or `null` when unset. `null`
   *  does NOT mean every tool resolves to the role template — a person may
   *  still have per-tool overrides this field doesn't reflect. To turn a
   *  whole server off, PUT `permissions[server][wildcardPermissionKey] =
   *  "off"` — NEVER delete the server's key (see `servers` below). */
  readonly wildcardPermission: ToolPermission | null;
  readonly description?: string;
}

export interface HermesBuiltinToolView {
  name: string;
  description: string;
  /** Hermes toolset this tool lives inside — toggling any tool flips
   *  the whole toolset on/off in `profile.tools.toolsets`. */
  toolset: string;
}

export interface McpCatalogView {
  /** A server key is present here iff it has >= 1 tool this role can govern.
   *  Do NOT infer "off" from a missing key in THIS READ view — a server can
   *  be absent for three unrelated reasons (stdio transport, zero
   *  role-governable tools, or simply not in the catalog) that this shape
   *  does not distinguish. Contrast the STORED table a PUT writes back,
   *  where an absent server key is NOT neutral: it means "off" permanently.
   *  A PUT body's `permissions` must carry forward every server key it
   *  means to keep — build it from what changed, never by re-deriving the
   *  whole map from this view (that would silently drop the three kinds of
   *  absence above and write `off` for them forever). */
  readonly servers: Record<string, McpCatalogEntryView>;
  /** The literal sentinel key a client writes into `permissions[server]` to
   *  set every tool on that server at once. Read this rather than
   *  hardcoding `"*"` — if the sentinel ever changes, this field changes
   *  with it. */
  readonly wildcardPermissionKey: string;
  /** Gateway-native tools with no MCP server (today just `delegateTask`).
   *  Governed by the same resolver and role gate as every catalog tool, just
   *  addressed by declared tier instead of by server — cannot live under
   *  `servers` because no `mcp_catalog` entry curates it. Empty for a role
   *  that cannot reach the `confirm` tier (child, guest). */
  readonly nativeTools: readonly McpToolView[];
  readonly hermesBuiltins: readonly HermesBuiltinToolView[];
}

// ---------------------------------------------------------------------------
// Profile API factory
// ---------------------------------------------------------------------------

export interface ProfileApiConfig {
  baseUrl?: string;
}

export interface ProfileApi {
  getMe(token: string): Promise<Result<ProfileV1>>;
  updateMe(token: string, profile: ProfileV1): Promise<Result<ProfileV1>>;
  /**
   * Convenience: GET-modify-PUT that flips just the audio sub-object. Used by
   * the dock TTS toggle, which has no profile draft of its own — it persists a
   * single field without round-tripping through SettingsView's apply-bar flow.
   */
  patchAudio(token: string, patch: { ttsEnabled?: boolean; channel?: "voice" | "text" }): Promise<Result<ProfileV1>>;
  apply(token: string): Promise<Result<{ status: "ready"; elapsedMs: number }>>;
  // SOUL doc
  getSoul(token: string): Promise<Result<SoulDoc>>;
  /** Returns the canonical default SOUL template — used by the
   *  "Restore to default" button to populate the editor without saving. */
  getSoulDefault(token: string): Promise<Result<{ content: string }>>;
  putSoul(token: string, content: string): Promise<Result<RestartResult>>;
  // Memory docs (MEMORY.md / USER.md)
  getMemoryDoc(token: string, slot: MemorySlot): Promise<Result<MemoryDoc>>;
  putMemoryDoc(token: string, slot: MemorySlot, content: string): Promise<Result<RestartResult>>;
  // Personalities
  getPersonalities(token: string): Promise<Result<PersonalityList>>;
  postPersonality(token: string, name: string, body: string): Promise<Result<RestartResult>>;
  putPersonality(token: string, name: string, body: string): Promise<Result<RestartResult>>;
  deletePersonality(token: string, name: string): Promise<Result<RestartResult>>;
  postActivePersonality(token: string, name: string): Promise<Result<void>>;
  // MCP catalog
  getMcpCatalog(token: string): Promise<Result<McpCatalogView>>;
}

export function createProfileApi(config?: ProfileApiConfig): ProfileApi {
  const base = config?.baseUrl ?? "";

  return {
    async getMe(token) {
      log.debug("getMe");
      return handleFetch<ProfileV1>(
        fetch(`${base}/api/v1/profile/me`, {
          method: "GET",
          headers: bearerHeaders(token),
        }),
      );
    },

    async updateMe(token, profile) {
      log.debug("updateMe", { userId: profile.userId });
      return handleFetch<ProfileV1>(
        fetch(`${base}/api/v1/profile/me`, {
          method: "PUT",
          headers: jsonHeaders(bearerHeaders(token)),
          body: JSON.stringify(profile),
        }),
      );
    },

    async patchAudio(token, patch) {
      log.debug("patchAudio", { patch });
      const cur = await this.getMe(token);
      if (!cur.ok) return cur;
      const next: ProfileV1 = {
        ...cur.value,
        audio: {
          ttsEnabled: patch.ttsEnabled ?? cur.value.audio.ttsEnabled,
          channel: patch.channel ?? cur.value.audio.channel,
        },
      };
      return this.updateMe(token, next);
    },

    async apply(token) {
      log.debug("apply");
      return handleFetch<{ status: "ready"; elapsedMs: number }>(
        fetch(`${base}/api/v1/profile/apply`, {
          method: "POST",
          headers: bearerHeaders(token),
        }),
      );
    },

    async getSoul(token) {
      log.debug("getSoul");
      return handleFetch<SoulDoc>(
        fetch(`${base}/api/v1/profile/soul`, {
          method: "GET",
          headers: bearerHeaders(token),
        }),
      );
    },

    async getSoulDefault(token) {
      log.debug("getSoulDefault");
      return handleFetch<{ content: string }>(
        fetch(`${base}/api/v1/profile/soul/default`, {
          method: "GET",
          headers: bearerHeaders(token),
        }),
      );
    },

    async putSoul(token, content) {
      log.debug("putSoul", { bytes: content.length });
      return handleFetch<RestartResult>(
        fetch(`${base}/api/v1/profile/soul`, {
          method: "PUT",
          headers: jsonHeaders(bearerHeaders(token)),
          body: JSON.stringify({ content }),
        }),
      );
    },

    async getMemoryDoc(token, slot) {
      log.debug("getMemoryDoc", { slot });
      return handleFetch<MemoryDoc>(
        fetch(`${base}/api/v1/profile/memory/${slot}`, {
          method: "GET",
          headers: bearerHeaders(token),
        }),
      );
    },

    async putMemoryDoc(token, slot, content) {
      log.debug("putMemoryDoc", { slot, bytes: content.length });
      return handleFetch<RestartResult>(
        fetch(`${base}/api/v1/profile/memory/${slot}`, {
          method: "PUT",
          headers: jsonHeaders(bearerHeaders(token)),
          body: JSON.stringify({ content }),
        }),
      );
    },

    async getPersonalities(token) {
      log.debug("getPersonalities");
      return handleFetch<PersonalityList>(
        fetch(`${base}/api/v1/profile/personalities`, {
          method: "GET",
          headers: bearerHeaders(token),
        }),
      );
    },

    async postPersonality(token, name, body) {
      log.debug("postPersonality", { name });
      return handleFetch<RestartResult>(
        fetch(`${base}/api/v1/profile/personalities`, {
          method: "POST",
          headers: jsonHeaders(bearerHeaders(token)),
          body: JSON.stringify({ name, body }),
        }),
      );
    },

    async putPersonality(token, name, body) {
      log.debug("putPersonality", { name });
      return handleFetch<RestartResult>(
        fetch(`${base}/api/v1/profile/personalities/${encodeURIComponent(name)}`, {
          method: "PUT",
          headers: jsonHeaders(bearerHeaders(token)),
          body: JSON.stringify({ body }),
        }),
      );
    },

    async deletePersonality(token, name) {
      log.debug("deletePersonality", { name });
      return handleFetch<RestartResult>(
        fetch(`${base}/api/v1/profile/personalities/${encodeURIComponent(name)}`, {
          method: "DELETE",
          headers: bearerHeaders(token),
        }),
      );
    },

    async postActivePersonality(token, name) {
      log.debug("postActivePersonality", { name });
      return handleFetch<void>(
        fetch(`${base}/api/v1/profile/active-personality`, {
          method: "POST",
          headers: jsonHeaders(bearerHeaders(token)),
          body: JSON.stringify({ name }),
        }),
      );
    },

    async getMcpCatalog(token) {
      log.debug("getMcpCatalog");
      return handleFetch<McpCatalogView>(
        fetch(`${base}/api/v1/mcp-catalog`, {
          method: "GET",
          headers: bearerHeaders(token),
        }),
      );
    },
  };
}
