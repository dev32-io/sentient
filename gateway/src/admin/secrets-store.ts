import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { Result } from "@sentient/protocol";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getLog } from "../logging/logger.js";
import {
  type KeysYaml,
  KeysYamlSchema,
  type LlmProvider,
  type ResolvedLlm,
  type SecretsStore,
  type SecretsStoreConfig,
  type SecretsStoreError,
} from "./secrets-store-schema.js";

export type {
  KeysYaml,
  LlmProvider,
  SecretsStoreError,
  ResolvedLlm,
  SecretsStatus,
  SecretsStore,
  SecretsStoreConfig,
} from "./secrets-store-schema.js";

type KR<T> = Result<T, SecretsStoreError>;

const log = getLog(["sentient", "gateway", "admin", "secrets-store"]);
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export function createSecretsStore(cfg: SecretsStoreConfig): SecretsStore {
  let cache: KeysYaml | null = null;

  async function readFromDisk(): Promise<KR<KeysYaml>> {
    try {
      const s = await fs.stat(cfg.keysPath);
      const mode = s.mode & 0o777;
      if (process.getuid?.() !== 0 && mode > FILE_MODE) {
        return { ok: false, error: { kind: "permission-too-broad", mode } };
      }
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        return { ok: false, error: { kind: "io-error", reason: (e as Error).message } };
      }
    }
    try {
      const raw = await fs.readFile(cfg.keysPath, "utf8");
      let parsed: unknown;
      try {
        parsed = parseYaml(raw);
      } catch {
        log.warn("secrets-store.read.corrupt", { reason: "invalid YAML" });
        return { ok: false, error: { kind: "corrupt-file", reason: "invalid YAML" } };
      }
      const result = KeysYamlSchema.safeParse(parsed);
      if (!result.success) {
        log.warn("secrets-store.read.corrupt", { reason: result.error.message });
        return { ok: false, error: { kind: "corrupt-file", reason: result.error.message } };
      }
      return { ok: true, value: result.data };
    } catch (e: unknown) {
      const reason = (e as Error).message;
      log.warn("secrets-store.read.io-error", { reason });
      return { ok: false, error: { kind: "io-error", reason } };
    }
  }

  async function writeAtomic(data: KeysYaml): Promise<KR<void>> {
    const tmp = `${cfg.keysPath}.tmp`;
    try {
      await fs.mkdir(dirname(cfg.keysPath), { recursive: true });
      await fs.chmod(dirname(cfg.keysPath), DIR_MODE).catch(() => undefined);
      const handle = await fs.open(tmp, "w", FILE_MODE);
      try {
        await handle.writeFile(stringifyYaml(data));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, cfg.keysPath);
      log.debug("secrets-store.write-atomic", { path: cfg.keysPath });
      return { ok: true, value: undefined };
    } catch (e: unknown) {
      const reason = (e as Error).message;
      log.warn("secrets-store.write.io-error", { reason });
      return { ok: false, error: { kind: "io-error", reason } };
    }
  }

  async function bootstrap(): Promise<KR<KeysYaml>> {
    try {
      const tmpl = await fs.readFile(cfg.templatePath, "utf8");
      const adminToken = cfg.generateAdminToken();
      const rendered = tmpl.replaceAll("{{admin_token}}", adminToken);
      const data = KeysYamlSchema.parse(parseYaml(rendered));
      const wr = await writeAtomic(data);
      if (!wr.ok) return wr;
      cache = data;
      log.info("secrets-store.bootstrapped", { path: cfg.keysPath });
      return { ok: true, value: data };
    } catch (e: unknown) {
      const reason = (e as Error).message;
      log.warn("secrets-store.bootstrap.failed", { reason });
      return { ok: false, error: { kind: "io-error", reason } };
    }
  }

  async function loadOrBootstrap(): Promise<KR<KeysYaml>> {
    if (cache) return { ok: true, value: cache };
    let fileExists = true;
    try {
      await fs.access(cfg.keysPath);
    } catch {
      fileExists = false;
    }
    if (!fileExists) return bootstrap();
    const r = await readFromDisk();
    if (!r.ok) return r;
    cache = r.value;
    log.info("secrets-store.loaded", { path: cfg.keysPath });
    return { ok: true, value: cache };
  }

  async function applyWrite(next: KeysYaml, event: string, props: Record<string, unknown>): Promise<KR<void>> {
    const wr = await writeAtomic(next);
    if (wr.ok) {
      cache = next;
      log.info(event, props);
    }
    return wr;
  }

  function resolveProviderLlm(data: KeysYaml, provider: LlmProvider): ResolvedLlm {
    const providerKey = provider === "ollama-cloud" ? "ollama_cloud" : provider;
    const entry = data.llm[providerKey as keyof typeof data.llm] as {
      api_key: string | null;
      base_url: string | null;
    };
    return {
      provider,
      apiKey: entry.api_key ?? "",
      baseUrl: entry.base_url ?? "",
    };
  }

  function resolveActiveLlm(data: KeysYaml): ResolvedLlm {
    return resolveProviderLlm(data, data.llm.active);
  }

  return {
    async load() {
      const r = await loadOrBootstrap();
      if (!r.ok) throw new Error(`secrets-store load failed: ${JSON.stringify(r.error)}`);
      return r.value;
    },

    loadSync() {
      if (!cache) throw new Error("secrets-store: loadSync() called before load()");
      return cache;
    },

    async getActiveLlm() {
      const r = await loadOrBootstrap();
      if (!r.ok) return r;
      return { ok: true, value: resolveActiveLlm(r.value) };
    },

    async getFishAudioKey() {
      const r = await loadOrBootstrap();
      if (!r.ok) throw new Error(`secrets-store load failed: ${JSON.stringify(r.error)}`);
      return r.value.tts.fish_audio.api_key;
    },

    getActiveLlmSync() {
      if (!cache) return null;
      return resolveActiveLlm(cache);
    },

    async getProviderSecrets(provider) {
      const r = await loadOrBootstrap();
      if (!r.ok) return r;
      return { ok: true, value: resolveProviderLlm(r.value, provider) };
    },

    getProviderSecretsSync(provider) {
      if (!cache) return null;
      return resolveProviderLlm(cache, provider);
    },

    getFishAudioKeySync() {
      return cache?.tts.fish_audio.api_key ?? null;
    },

    async setLlmProviderKey(provider, patch) {
      const r = await loadOrBootstrap();
      if (!r.ok) return r;
      const data = r.value;
      const providerKey = provider === "ollama-cloud" ? "ollama_cloud" : provider;
      const existing = data.llm[providerKey as keyof typeof data.llm] as {
        api_key: string | null;
        base_url: string | null;
      };
      const next: KeysYaml = {
        ...data,
        llm: {
          ...data.llm,
          [providerKey]: {
            api_key: "api_key" in patch ? (patch.api_key ?? null) : existing.api_key,
            base_url: "base_url" in patch ? (patch.base_url ?? null) : existing.base_url,
          },
        },
      };
      const updated = next.llm[providerKey as keyof typeof next.llm] as { api_key: string | null };
      return applyWrite(next, "secrets-store.setLlmProviderKey", { provider, hasApiKey: updated.api_key !== null });
    },

    async setActiveLlmProvider(provider) {
      const r = await loadOrBootstrap();
      if (!r.ok) return r;
      return applyWrite(
        { ...r.value, llm: { ...r.value.llm, active: provider } },
        "secrets-store.setActiveLlmProvider",
        { provider },
      );
    },

    async setFishAudioKey(key) {
      const r = await loadOrBootstrap();
      if (!r.ok) return r;
      return applyWrite({ ...r.value, tts: { fish_audio: { api_key: key } } }, "secrets-store.setFishAudioKey", {
        hasKey: key !== null,
      });
    },

    async setHomeAssistantToken(kind, token) {
      const r = await loadOrBootstrap();
      if (!r.ok) return r;
      const next: KeysYaml = { ...r.value, home_assistant: { ...r.value.home_assistant, [kind]: token } };
      return applyWrite(next, "secrets-store.setHomeAssistantToken", { kind, hasToken: token !== null });
    },

    async setHomeAssistantUrl(url) {
      const r = await loadOrBootstrap();
      if (!r.ok) return r;
      const next: KeysYaml = { ...r.value, home_assistant: { ...r.value.home_assistant, url } };
      return applyWrite(next, "secrets-store.setHomeAssistantUrl", { hasUrl: url !== null });
    },

    async setHomeAssistantLocalIp(ip) {
      const r = await loadOrBootstrap();
      if (!r.ok) return r;
      const next: KeysYaml = { ...r.value, home_assistant: { ...r.value.home_assistant, local_ip: ip } };
      return applyWrite(next, "secrets-store.setHomeAssistantLocalIp", { hasIp: ip !== null });
    },

    async setMusicAssistantToken(token) {
      const r = await loadOrBootstrap();
      if (!r.ok) return r;
      return applyWrite(
        { ...r.value, music_assistant: { ...r.value.music_assistant, token } },
        "secrets-store.setMusicAssistantToken",
        { hasToken: token !== null },
      );
    },

    async setMusicAssistantUrl(url) {
      const r = await loadOrBootstrap();
      if (!r.ok) return r;
      return applyWrite(
        { ...r.value, music_assistant: { ...r.value.music_assistant, url } },
        "secrets-store.setMusicAssistantUrl",
        { hasUrl: url !== null },
      );
    },

    async setMusicAssistantLocalIp(ip) {
      const r = await loadOrBootstrap();
      if (!r.ok) return r;
      return applyWrite(
        { ...r.value, music_assistant: { ...r.value.music_assistant, local_ip: ip } },
        "secrets-store.setMusicAssistantLocalIp",
        { hasIp: ip !== null },
      );
    },

    async diffPaths(partial) {
      if (!partial) return [];
      const r = await loadOrBootstrap();
      if (!r.ok) return [];
      const current = r.value as unknown as Record<string, Record<string, unknown>>;
      const out: string[] = [];
      for (const [block, fields] of Object.entries(partial)) {
        if (!fields) continue;
        for (const [field, value] of Object.entries(fields)) {
          const path = `${block}.${field}`;
          const cur = current[block]?.[field];
          if (cur !== value) out.push(path);
        }
      }
      return out;
    },

    async getAdminToken() {
      const r = await loadOrBootstrap();
      if (!r.ok) throw new Error(`secrets-store load failed: ${JSON.stringify(r.error)}`);
      return r.value.admin_token;
    },

    async status() {
      let hasFile: boolean;
      try {
        await fs.access(cfg.keysPath);
        hasFile = true;
      } catch {
        hasFile = false;
      }
      const result = await loadOrBootstrap();
      if (!result.ok) return result;
      return {
        ok: true,
        value: {
          keysPath: cfg.keysPath,
          schemaVersion: result.value.schema_version,
          hasFile,
          activeLlmProvider: result.value.llm.active,
          hasFishAudioKey: result.value.tts.fish_audio.api_key !== null,
        },
      };
    },
  };
}
