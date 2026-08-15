import type { ProductToolGroup, ToolDefaultExposure, ToolPermission, ToolPermissionPatchMap } from "@sentient/config";
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
  /**
   * Per-user memory toggles. Gateway-side only, like `audio` above — a
   * change here is a "fast" apply-bar op, never the Hermes profile rewrite.
   * S1: storage only; the spark/dreamer consumers land in later slices.
   */
  memory: {
    /** Bring up relevant past memories in conversation. */
    spark: boolean;
    /** Nightly reflection — Sentient reviews the day and updates its notes. */
    dreaming: boolean;
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
  readonly settable: boolean;
  readonly dispatch?: { readonly kind: "mcp"; readonly serverName: string } | { readonly kind: "native" };
}

export interface ProductToolGroupView {
  readonly tools: readonly McpToolView[];
  readonly wildcardPermission: ToolPermission | null;
  readonly defaultExposure: ToolDefaultExposure;
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
  readonly groups: Record<ProductToolGroup, ProductToolGroupView>;
  readonly wildcardPermissionKey: string;
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
