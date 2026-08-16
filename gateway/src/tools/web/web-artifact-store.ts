import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Capability } from "../../access/capability.js";
import { capabilityCoversPath } from "../../access/capability.js";

const ID_RE = /^wa_[a-f0-9]{32}$/;

export interface WebArtifactStoreConfig {
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
  maxSliceChars: number;
  maxPassages: number;
  passageContextChars: number;
}

interface ArtifactRecord {
  version: 1;
  ownerUserId: string;
  createdAt: number;
  sourceUrl: string;
  finalUrl: string;
  title: string | null;
  contentType: string;
  content: string;
}

export type ArtifactReadResult =
  | {
      ok: true;
      value: {
        id: string;
        sourceUrl: string;
        finalUrl: string;
        title: string | null;
        contentType: string;
        totalChars: number;
        returnedStart: number;
        returnedEnd: number;
        content: string;
        matches?: number;
      };
    }
  | { ok: false; error: "malformed" | "not_found" | "expired" | "foreign" | "invalid_request" };

function artifactRoot(cap: Capability): string {
  if (cap.resource !== "web-artifact") throw new Error("web artifact capability required");
  const root = join(cap.rootPath, "web-artifacts");
  if (!capabilityCoversPath(cap, root)) throw new Error("artifact root outside capability");
  return root;
}

function parseRecord(value: unknown): ArtifactRecord | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    v.version !== 1 ||
    typeof v.ownerUserId !== "string" ||
    typeof v.createdAt !== "number" ||
    typeof v.sourceUrl !== "string" ||
    typeof v.finalUrl !== "string" ||
    !(typeof v.title === "string" || v.title === null) ||
    typeof v.contentType !== "string" ||
    typeof v.content !== "string"
  )
    return null;
  return v as unknown as ArtifactRecord;
}

export class WebArtifactStore {
  constructor(
    private readonly config: WebArtifactStoreConfig,
    private readonly now: () => number = Date.now,
  ) {}

  async put(cap: Capability, artifact: Omit<ArtifactRecord, "version" | "ownerUserId" | "createdAt">): Promise<string> {
    const root = artifactRoot(cap);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const id = `wa_${crypto.randomUUID().replaceAll("-", "")}`;
    const path = join(root, `${id}.json`);
    const record: ArtifactRecord = { version: 1, ownerUserId: cap.ownerUserId, createdAt: this.now(), ...artifact };
    await writeFile(path, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    await chmod(path, 0o600);
    await this.evict(root);
    return id;
  }

  async readSlice(cap: Capability, id: string, offset: number, limit: number): Promise<ArtifactReadResult> {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > this.config.maxSliceChars
    )
      return { ok: false, error: "invalid_request" };
    const loaded = await this.load(cap, id);
    if (!loaded.ok) return loaded;
    const start = Math.min(offset, loaded.record.content.length);
    const end = Math.min(start + limit, loaded.record.content.length);
    return { ok: true, value: this.view(id, loaded.record, start, end, loaded.record.content.slice(start, end)) };
  }

  async findPassages(cap: Capability, id: string, query: string, maxPassages: number): Promise<ArtifactReadResult> {
    const needle = query.trim().toLocaleLowerCase();
    if (needle.length < 2 || needle.length > 200 || !Number.isInteger(maxPassages) || maxPassages < 1)
      return { ok: false, error: "invalid_request" };
    const loaded = await this.load(cap, id);
    if (!loaded.ok) return loaded;
    const content = loaded.record.content;
    const lower = content.toLocaleLowerCase();
    const passages: string[] = [];
    let cursor = 0;
    let first = content.length;
    let last = 0;
    const capCount = Math.min(maxPassages, this.config.maxPassages);
    while (passages.length < capCount) {
      const at = lower.indexOf(needle, cursor);
      if (at < 0) break;
      const start = Math.max(0, at - this.config.passageContextChars);
      const end = Math.min(content.length, at + query.length + this.config.passageContextChars);
      passages.push(content.slice(start, end));
      first = Math.min(first, start);
      last = Math.max(last, end);
      cursor = Math.max(at + needle.length, end);
    }
    const joined = passages.join("\n\n--- matching passage ---\n\n").slice(0, this.config.maxSliceChars);
    return {
      ok: true,
      value: {
        ...this.view(id, loaded.record, passages.length ? first : 0, passages.length ? last : 0, joined),
        matches: passages.length,
      },
    };
  }

  private view(id: string, record: ArtifactRecord, start: number, end: number, content: string) {
    return {
      id,
      sourceUrl: record.sourceUrl,
      finalUrl: record.finalUrl,
      title: record.title,
      contentType: record.contentType,
      totalChars: record.content.length,
      returnedStart: start,
      returnedEnd: end,
      content,
    };
  }

  private async load(
    cap: Capability,
    id: string,
  ): Promise<
    { ok: true; record: ArtifactRecord } | { ok: false; error: "malformed" | "not_found" | "expired" | "foreign" }
  > {
    if (!ID_RE.test(id)) return { ok: false, error: "malformed" };
    const path = join(artifactRoot(cap), `${id}.json`);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8"));
    } catch {
      return { ok: false, error: "not_found" };
    }
    const record = parseRecord(value);
    if (!record) return { ok: false, error: "not_found" };
    if (record.ownerUserId !== cap.ownerUserId) return { ok: false, error: "foreign" };
    if (this.now() - record.createdAt >= this.config.ttlMs) {
      await rm(path, { force: true });
      return { ok: false, error: "expired" };
    }
    return { ok: true, record };
  }

  private async evict(root: string): Promise<void> {
    const entries: { path: string; createdAt: number; bytes: number }[] = [];
    for (const name of await readdir(root)) {
      if (!ID_RE.test(name.replace(/\.json$/, ""))) continue;
      const path = join(root, name);
      try {
        const info = await stat(path);
        const raw = await readFile(path, "utf8");
        const record = parseRecord(JSON.parse(raw));
        if (!record || this.now() - record.createdAt >= this.config.ttlMs) {
          await rm(path, { force: true });
          continue;
        }
        entries.push({ path, createdAt: record.createdAt, bytes: info.size });
      } catch {
        // A concurrent cleanup won the race.
      }
    }
    entries.sort((a, b) => a.createdAt - b.createdAt);
    let bytes = entries.reduce((sum, e) => sum + e.bytes, 0);
    while (entries.length > this.config.maxEntries || bytes > this.config.maxBytes) {
      const oldest = entries.shift();
      if (!oldest) break;
      bytes -= oldest.bytes;
      await rm(oldest.path, { force: true });
    }
  }
}
