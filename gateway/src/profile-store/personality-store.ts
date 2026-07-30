import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Result } from "@sentient/protocol";
import { type Document, type Pair, type Scalar, type YAMLMap, isMap, isScalar, parseDocument } from "yaml";
import { getLog } from "../logging/logger.js";
import { writeFileAtomic } from "../user-auth/atomic-write.js";

const log = getLog(["sentient", "gateway", "profile-store", "personality-store"]);

// ---------------------------------------------------------------------------
// PersonalityStore — read/parse/write the `agent.personalities` map of a
// per-user Hermes config.yaml. Resolves `activeName` by matching the current
// `agent.system_prompt` against each personality's resolved body. Atomic
// writes preserve the surrounding YAML shape (uses `yaml`'s Document API).
// ---------------------------------------------------------------------------

const CONFIG_FILENAME = "config.yaml";
const FILE_MODE = 0o600;

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** An empty personality body is a live, BLANK system prompt once the rendered
 *  config.yaml reaches hermes, and it makes `findActiveName` match any entry
 *  against an empty `agent.system_prompt`. Rejected at both writers;
 *  `preserve-agent-sections.ts` drops the ones older builds already wrote. */
function isBlank(body: string): boolean {
  return body.trim().length === 0;
}

export interface Personality {
  name: string;
  body: string;
}

export interface PersonalityList {
  personalities: Personality[];
  activeName: string | null;
}

export type PersonalityStoreError =
  | "io-error"
  | "parse-error"
  | "name-conflict"
  | "invalid-name"
  | "invalid-body"
  | "not-found";

export interface PersonalityStore {
  list(): Promise<Result<PersonalityList, "io-error" | "parse-error">>;
  add(
    name: string,
    body: string,
  ): Promise<Result<void, "io-error" | "name-conflict" | "invalid-name" | "invalid-body" | "parse-error">>;
  update(name: string, body: string): Promise<Result<void, "io-error" | "not-found" | "invalid-body" | "parse-error">>;
  remove(name: string): Promise<Result<void, "io-error" | "not-found" | "parse-error">>;
}

export interface PersonalityStoreDeps {
  /** Directory holding `config.yaml` for one user — typically
   *  `<gatewayRoot>/<userId>` (which is bind-mounted at `/data/profiles/<userId>`
   *  inside the Hermes container). */
  profileDir: string;
}

export function createPersonalityStore(deps: PersonalityStoreDeps): PersonalityStore {
  const path = join(deps.profileDir, CONFIG_FILENAME);

  async function loadDoc(): Promise<Result<Document, "io-error" | "parse-error">> {
    let raw: string;
    try {
      raw = await fs.readFile(path, "utf8");
    } catch (e: unknown) {
      log.warn("read.io-error", { path, reason: (e as Error).message });
      return { ok: false, error: "io-error" };
    }
    let doc: Document;
    try {
      doc = parseDocument(raw);
    } catch (e: unknown) {
      log.warn("read.parse-error", { path, reason: (e as Error).message });
      return { ok: false, error: "parse-error" };
    }
    if (doc.errors.length > 0) {
      log.warn("read.parse-error", { path, count: doc.errors.length });
      return { ok: false, error: "parse-error" };
    }
    return { ok: true, value: doc };
  }

  async function persist(doc: Document): Promise<Result<void, "io-error">> {
    try {
      await writeFileAtomic(path, doc.toString(), { mode: FILE_MODE });
      log.debug("persist.ok", { path });
      return { ok: true, value: undefined };
    } catch (e: unknown) {
      log.warn("persist.io-error", { path, reason: (e as Error).message });
      return { ok: false, error: "io-error" };
    }
  }

  return {
    async list() {
      const docResult = await loadDoc();
      if (!docResult.ok) return docResult;
      return { ok: true, value: extractList(docResult.value) };
    },

    async add(name, body) {
      if (!NAME_PATTERN.test(name)) return { ok: false, error: "invalid-name" };
      if (isBlank(body)) return { ok: false, error: "invalid-body" };
      const docResult = await loadDoc();
      if (!docResult.ok) return docResult;
      const map = ensurePersonalitiesMap(docResult.value);
      if (mapHasKey(map, name)) return { ok: false, error: "name-conflict" };
      map.set(name, body);
      log.info("add", { name });
      return persist(docResult.value);
    },

    async update(name, body) {
      if (isBlank(body)) return { ok: false, error: "invalid-body" };
      const docResult = await loadDoc();
      if (!docResult.ok) return docResult;
      const map = ensurePersonalitiesMap(docResult.value);
      if (!mapHasKey(map, name)) return { ok: false, error: "not-found" };
      map.set(name, body);
      log.info("update", { name });
      return persist(docResult.value);
    },

    async remove(name) {
      const docResult = await loadDoc();
      if (!docResult.ok) return docResult;
      const doc = docResult.value;
      const map = ensurePersonalitiesMap(doc);
      if (!mapHasKey(map, name)) return { ok: false, error: "not-found" };
      // If the deleted personality is currently the active one (its body
      // matches agent.system_prompt), clear system_prompt too — otherwise
      // Hermes keeps using the now-deleted body as the live system prompt
      // even after the worker restart, and the deleted persona stays "live"
      // until the user picks a different one.
      const removedBody = resolveBody(map.get(name));
      const agent = doc.get("agent");
      if (isMap(agent)) {
        const currentSysPrompt = resolveBody(agent.get("system_prompt"));
        if (currentSysPrompt !== "" && currentSysPrompt === removedBody) {
          agent.delete("system_prompt");
          log.info("remove.cleared-active-system-prompt", { name });
        }
      }
      map.delete(name);
      log.info("remove", { name });
      return persist(doc);
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — split out so the test suite can pin extract behavior cheaply.
// ---------------------------------------------------------------------------

/** Extract the personalities list + resolve the active name. */
export function extractList(doc: Document): PersonalityList {
  const agent = doc.get("agent");
  if (!isMap(agent)) return { personalities: [], activeName: null };
  const map = agent.get("personalities");
  if (!isMap(map)) return { personalities: [], activeName: null };

  const personalities: Personality[] = [];
  for (const item of map.items as Pair<Scalar, unknown>[]) {
    const key = item.key;
    if (!isScalar(key) || typeof key.value !== "string") continue;
    personalities.push({ name: key.value, body: resolveBody(item.value) });
  }

  const sysPromptRaw = agent.get("system_prompt");
  const sysPrompt = typeof sysPromptRaw === "string" ? sysPromptRaw : null;
  const activeName = sysPrompt === null ? null : findActiveName(personalities, sysPrompt);
  return { personalities, activeName };
}

/** Mirror Hermes' `_resolve_prompt`: scalar OR {system_prompt, tone, style}. */
export function resolveBody(value: unknown): string {
  if (typeof value === "string") return value;
  if (isScalar(value) && typeof value.value === "string") return value.value;
  if (isMap(value)) return resolveBodyFromMap(value);
  if (typeof value === "object" && value !== null) return resolveBodyFromObject(value as Record<string, unknown>);
  return "";
}

function resolveBodyFromMap(value: YAMLMap): string {
  const raw: Record<string, unknown> = {};
  for (const item of value.items as Pair<Scalar, unknown>[]) {
    const k = item.key;
    if (!isScalar(k) || typeof k.value !== "string") continue;
    const v = item.value;
    raw[k.value] = isScalar(v) ? v.value : v;
  }
  return resolveBodyFromObject(raw);
}

function resolveBodyFromObject(raw: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof raw.system_prompt === "string") parts.push(raw.system_prompt);
  if (typeof raw.tone === "string") parts.push(`Tone: ${raw.tone}`);
  if (typeof raw.style === "string") parts.push(`Style: ${raw.style}`);
  return parts.join("\n");
}

function findActiveName(personalities: Personality[], sysPrompt: string): string | null {
  for (const p of personalities) {
    if (p.body === sysPrompt) return p.name;
  }
  return null;
}

/** Ensure `agent.personalities` exists as a YAMLMap and return it.
 *
 * yaml's `doc.set(key, plainObject)` may store the value as a plain object,
 * not as a YAMLMap node — so a follow-up `doc.get(key)` returns the same
 * plain object and `isMap()` rejects it. We use `doc.createNode(...)` to
 * wrap plain values into proper Map nodes before assignment.
 */
function ensurePersonalitiesMap(doc: Document): YAMLMap {
  let agent = doc.get("agent");
  if (!isMap(agent)) {
    doc.set("agent", doc.createNode({ personalities: {} }));
    agent = doc.get("agent");
  }
  if (!isMap(agent)) {
    throw new Error("personality-store: agent node must be a map");
  }
  let personalities = agent.get("personalities");
  if (!isMap(personalities)) {
    agent.set("personalities", doc.createNode({}));
    personalities = agent.get("personalities");
  }
  if (!isMap(personalities)) {
    throw new Error("personality-store: personalities node must be a map");
  }
  return personalities as YAMLMap;
}

function mapHasKey(map: YAMLMap, name: string): boolean {
  for (const item of map.items as Pair<unknown, unknown>[]) {
    const k = item.key;
    if (isScalar(k) && k.value === name) return true;
    if (typeof k === "string" && k === name) return true;
  }
  return false;
}
