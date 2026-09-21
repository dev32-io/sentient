import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, realpath, rm, stat, unlink, utimes } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { classifyTiffSource } from "./source-classifier.js";

const ATTACHMENT_ID_RE = /^att_[a-f0-9]{32}$/;
const SAFE_TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv"]);
const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/avif",
  "image/webp",
  "image/gif",
  "image/tiff",
  "image/bmp",
  "image/jp2",
  "image/jxl",
  "application/vnd.sentient.live-photo+zip",
]);
const ROOT_DIR = "attachments";
const STAGING_DIR = "staging";
const SESSION_DIR = "sessions";
const locks = new Map<string, Promise<void>>();

export interface AttachmentCapability {
  readonly ownerUserId: string;
  readonly resource: "attachment-store";
  readonly rootPath: string;
}

export interface AttachmentStorageLimits {
  readonly maxFileBytes: number;
  readonly maxFilesPerAttempt: number;
  readonly maxRequestBytes: number;
  readonly maxUserBytes: number;
  readonly stagingTtlMs: number;
}

export interface AttachmentUpload {
  readonly attachmentId: string;
  readonly fileIdentity: string;
  readonly displayName: string;
  readonly contentType: string;
  readonly bytes: AsyncIterable<Uint8Array>;
}

export interface StagedAttachment {
  readonly status: "staged";
  readonly attachmentId: string;
  readonly ownerUserId: string;
  readonly sendAttemptId: string;
  readonly fileIdentity: string;
  readonly displayName: string;
  readonly contentType: string;
  readonly mediaKind: "image" | "pdf" | "text";
  readonly size: number;
  readonly sha256: string;
  readonly stagedAt: number;
}

export interface DurableAttachment extends Omit<StagedAttachment, "status" | "stagedAt"> {
  readonly status: "durable";
  readonly sessionId: string;
}

export interface CleanupIntentSource {
  listFileCleanupIntents(limit: number, afterSessionId?: string): Array<{ sessionId: string }>;
  ackFileCleanupIntent(sessionId: string): boolean;
}

export interface AttachmentStorage {
  stageAttempt(
    sendAttemptId: string,
    files: readonly AttachmentUpload[],
    signal?: AbortSignal,
  ): Promise<StagedAttachment[]>;
  publishCommitted(
    ref: StagedAttachment,
    sessionId: string,
    isStillCommitted?: () => boolean,
  ): Promise<DurableAttachment>;
  read(ref: DurableAttachment, signal?: AbortSignal): AsyncGenerator<Uint8Array>;
  deleteStaged(ref: StagedAttachment): Promise<void>;
  deleteDurable(ref: DurableAttachment): Promise<void>;
  expireStaging(retainAttachmentIds?: ReadonlySet<string>): Promise<{ expired: number; refused: number }>;
  cleanupSession(sessionId: string): Promise<void>;
}

export class AttachmentStorageError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "unsupported_type"
      | "file_too_large"
      | "request_too_large"
      | "quota_exceeded"
      | "identity_conflict"
      | "not_found"
      | "foreign"
      | "unsafe_path",
    message: string,
  ) {
    super(message);
    this.name = "AttachmentStorageError";
  }
}

export function mintAttachmentId(): string {
  return `att_${randomUUID().replaceAll("-", "")}`;
}

export function sanitizeAttachmentName(name: string): string {
  const clean = Array.from(basename(name.replaceAll("\\", "/")).normalize("NFC"))
    .filter((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127)
    .join("")
    .trim()
    .slice(0, 255);
  return clean && clean !== "." && clean !== ".." ? clean : "attachment";
}

function validateLimits(limits: AttachmentStorageLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`attachment limit ${name} must be a positive integer`);
  }
}

function validateIdentity(value: string, label: string): void {
  if (value.length < 1 || value.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new AttachmentStorageError("invalid_request", `${label} is invalid`);
  }
}

function sessionDirectoryName(sessionId: string): string {
  validateIdentity(sessionId, "sessionId");
  return createHash("sha256").update(sessionId).digest("hex");
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

async function withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  locks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

function mediaKind(contentType: string): StagedAttachment["mediaKind"] {
  if (IMAGE_TYPES.has(contentType)) return "image";
  if (contentType === "application/pdf") return "pdf";
  if (SAFE_TEXT_TYPES.has(contentType)) return "text";
  throw new AttachmentStorageError("unsupported_type", "attachment type is not allowed");
}

function matchesType(contentType: string, prefix: Uint8Array, textValid: boolean): boolean {
  if (contentType === "image/jpeg") return prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
  if (contentType === "image/png")
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => prefix[index] === byte);
  if (contentType === "application/pdf") return new TextDecoder().decode(prefix.subarray(0, 5)) === "%PDF-";
  if (contentType === "image/heic" || contentType === "image/heif" || contentType === "image/avif") {
    if (new TextDecoder().decode(prefix.subarray(4, 8)) !== "ftyp") return false;
    const brands = new TextDecoder().decode(prefix.subarray(8));
    const allowed =
      contentType === "image/avif"
        ? ["avif", "avis"]
        : contentType === "image/heic"
          ? ["heic", "heix", "hevc", "hevx"]
          : ["mif1", "msf1", "heic", "heif"];
    return allowed.some((brand) => brands.includes(brand));
  }
  if (contentType === "image/webp")
    return (
      new TextDecoder().decode(prefix.subarray(0, 4)) === "RIFF" &&
      new TextDecoder().decode(prefix.subarray(8, 12)) === "WEBP"
    );
  if (contentType === "image/gif") return new TextDecoder().decode(prefix.subarray(0, 4)) === "GIF8";
  if (contentType === "image/tiff")
    return ["II*\0", "MM\0*", "II+\0", "MM\0+"].includes(new TextDecoder().decode(prefix.subarray(0, 4)));
  if (contentType === "image/bmp") return new TextDecoder().decode(prefix.subarray(0, 2)) === "BM";
  if (contentType === "image/jp2")
    return (
      Buffer.from(prefix.subarray(0, 12)).equals(
        Buffer.from([0, 0, 0, 12, 0x6a, 0x50, 0x20, 0x20, 13, 10, 0x87, 10]),
      ) || Buffer.from(prefix.subarray(0, 4)).equals(Buffer.from([0xff, 0x4f, 0xff, 0x51]))
    );
  if (contentType === "image/jxl")
    return (
      Buffer.from(prefix.subarray(0, 2)).equals(Buffer.from([0xff, 0x0a])) ||
      Buffer.from(prefix.subarray(0, 12)).equals(Buffer.from([0, 0, 0, 12, 0x4a, 0x58, 0x4c, 0x20, 13, 10, 0x87, 10]))
    );
  if (contentType === "application/vnd.sentient.live-photo+zip")
    return Buffer.from(prefix.subarray(0, 4)).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  return SAFE_TEXT_TYPES.has(contentType) && textValid;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createAttachmentStorage(cap: AttachmentCapability, limits: AttachmentStorageLimits): AttachmentStorage {
  if (cap.resource !== "attachment-store") throw new Error("attachment storage requires attachment-store capability");
  validateLimits(limits);

  const root = join(cap.rootPath, ROOT_DIR);
  const stagingRoot = join(root, STAGING_DIR);
  const sessionsRoot = join(root, SESSION_DIR);

  async function ensureDirectory(path: string, parentReal?: string): Promise<string> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new AttachmentStorageError("unsafe_path", "attachment path refused");
    await chmod(path, 0o700);
    const resolved = await realpath(path);
    if (parentReal && !isWithin(resolved, parentReal))
      throw new AttachmentStorageError("unsafe_path", "attachment path escaped storage root");
    return resolved;
  }

  async function ensureRoots(): Promise<{ root: string; staging: string; sessions: string }> {
    const capRoot = await ensureDirectory(cap.rootPath);
    const attachmentRoot = await ensureDirectory(root, capRoot);
    return {
      root: attachmentRoot,
      staging: await ensureDirectory(stagingRoot, attachmentRoot),
      sessions: await ensureDirectory(sessionsRoot, attachmentRoot),
    };
  }

  async function safeFile(path: string, expectedRoot: string) {
    const parentPath = dirname(path);
    const parent = await realpath(parentPath).catch(async () => {
      const parentInfo = await lstat(parentPath).catch(() => null);
      if (parentInfo?.isSymbolicLink())
        throw new AttachmentStorageError("unsafe_path", "attachment parent path refused");
      throw new AttachmentStorageError("not_found", "attachment not found");
    });
    if (!isWithin(parent, expectedRoot))
      throw new AttachmentStorageError("unsafe_path", "attachment parent path refused");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new AttachmentStorageError("not_found", "attachment not found");
      throw new AttachmentStorageError("unsafe_path", "attachment path refused");
    });
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      throw new AttachmentStorageError("unsafe_path", "attachment is not a regular file");
    }
    return { handle, info };
  }

  async function digestFile(path: string, expectedRoot: string): Promise<{ sha256: string; size: number }> {
    const { handle, info } = await safeFile(path, expectedRoot);
    const hash = createHash("sha256");
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      return { sha256: hash.digest("hex"), size: info.size };
    } finally {
      await handle.close();
    }
  }

  async function safeUnlink(path: string, expectedRoot: string): Promise<void> {
    const parentPath = dirname(path);
    const parent = await realpath(parentPath).catch(async () => {
      const parentInfo = await lstat(parentPath).catch(() => null);
      if (parentInfo?.isSymbolicLink())
        throw new AttachmentStorageError("unsafe_path", "attachment delete path refused");
      return null;
    });
    if (!parent) return;
    if (!isWithin(parent, expectedRoot))
      throw new AttachmentStorageError("unsafe_path", "attachment delete path refused");
    const info = await lstat(path).catch(() => null);
    if (!info) return;
    if (info.isSymbolicLink()) throw new AttachmentStorageError("unsafe_path", "attachment symlink refused");
    await unlink(path);
  }

  async function diskUsage(path: string): Promise<number> {
    let total = 0;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink())
        throw new AttachmentStorageError("unsafe_path", "symlink found in attachment storage");
      if (entry.isDirectory()) total += await diskUsage(child);
      else if (entry.isFile()) total += (await stat(child)).size;
      else throw new AttachmentStorageError("unsafe_path", "non-file found in attachment storage");
    }
    return total;
  }

  async function stageOne(
    roots: { root: string; staging: string; sessions: string },
    sendAttemptId: string,
    file: AttachmentUpload,
    requestBytes: { value: number },
    signal?: AbortSignal,
  ): Promise<StagedAttachment> {
    if (!ATTACHMENT_ID_RE.test(file.attachmentId))
      throw new AttachmentStorageError("invalid_request", "attachmentId is invalid");
    validateIdentity(file.fileIdentity, "fileIdentity");
    const kind = mediaKind(file.contentType);
    for (const entry of await readdir(roots.sessions, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory())
        throw new AttachmentStorageError("unsafe_path", "invalid session entry in attachment storage");
      const committed = await lstat(join(roots.sessions, entry.name, file.attachmentId)).catch(() => null);
      if (committed) throw new AttachmentStorageError("identity_conflict", "attachmentId is already committed");
    }
    const target = join(roots.staging, file.attachmentId);
    const temp = join(roots.staging, `.tmp-${randomUUID()}`);
    const hash = createHash("sha256");
    const decoder = kind === "text" ? new TextDecoder("utf-8", { fatal: true }) : null;
    const prefix: number[] = [];
    let size = 0;
    let textValid = true;
    const output = await open(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      for await (const raw of file.bytes) {
        signal?.throwIfAborted();
        const chunk = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        size += chunk.byteLength;
        requestBytes.value += chunk.byteLength;
        if (size > limits.maxFileBytes)
          throw new AttachmentStorageError("file_too_large", "attachment exceeds file limit");
        if (requestBytes.value > limits.maxRequestBytes)
          throw new AttachmentStorageError("request_too_large", "attachment request exceeds byte limit");
        for (let index = 0; index < chunk.length && prefix.length < 32; index++) {
          const byte = chunk[index];
          if (byte !== undefined) prefix.push(byte);
        }
        hash.update(chunk);
        if (decoder) {
          try {
            decoder.decode(chunk, { stream: true });
          } catch {
            textValid = false;
          }
        }
        let offset = 0;
        while (offset < chunk.byteLength) offset += (await output.write(chunk, offset)).bytesWritten;
      }
      if (decoder) {
        try {
          decoder.decode();
        } catch {
          textValid = false;
        }
      }
      if (!matchesType(file.contentType, Uint8Array.from(prefix), textValid))
        throw new AttachmentStorageError("unsupported_type", "attachment bytes do not match allowed type");
      await output.sync();
      if (file.contentType === "image/tiff" && (await classifyTiffSource(temp)) !== "supported")
        throw new AttachmentStorageError("unsupported_type", "RAW or unresolved TIFF images are not supported");
    } catch (error) {
      await output.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      throw error;
    }
    await output.close();

    const sha256 = hash.digest("hex");
    try {
      const existing = await digestFile(target, roots.root).catch((error) => {
        if (error instanceof AttachmentStorageError && error.code === "not_found") return null;
        throw error;
      });
      if (existing) {
        if (existing.size !== size || existing.sha256 !== sha256)
          throw new AttachmentStorageError("identity_conflict", "attachmentId already names different bytes");
        await utimes(target, new Date(), new Date());
      } else {
        if ((await diskUsage(roots.root)) > limits.maxUserBytes)
          throw new AttachmentStorageError("quota_exceeded", "attachment storage quota exceeded");
        await link(temp, target);
        await chmod(target, 0o600);
        await syncDirectory(roots.staging);
      }
    } finally {
      await unlink(temp).catch(() => undefined);
    }
    const stagedAt = (await stat(target)).mtimeMs;
    return {
      status: "staged",
      attachmentId: file.attachmentId,
      ownerUserId: cap.ownerUserId,
      sendAttemptId,
      fileIdentity: file.fileIdentity,
      displayName: sanitizeAttachmentName(file.displayName),
      contentType: file.contentType,
      mediaKind: kind,
      size,
      sha256,
      stagedAt,
    };
  }

  function assertOwner(ref: StagedAttachment | DurableAttachment): void {
    if (ref.ownerUserId !== cap.ownerUserId) throw new AttachmentStorageError("foreign", "attachment not found");
    if (!ATTACHMENT_ID_RE.test(ref.attachmentId))
      throw new AttachmentStorageError("invalid_request", "attachmentId is invalid");
  }

  function durablePath(ref: DurableAttachment): string {
    return join(sessionsRoot, sessionDirectoryName(ref.sessionId), ref.attachmentId);
  }

  return {
    async stageAttempt(sendAttemptId, files, signal) {
      validateIdentity(sendAttemptId, "sendAttemptId");
      if (files.length < 1 || files.length > limits.maxFilesPerAttempt)
        throw new AttachmentStorageError("invalid_request", "attachment count exceeds attempt limit");
      if (new Set(files.map((file) => file.attachmentId)).size !== files.length)
        throw new AttachmentStorageError("invalid_request", "duplicate attachmentId in attempt");
      return withLock(root, async () => {
        const roots = await ensureRoots();
        const requestBytes = { value: 0 };
        const staged: StagedAttachment[] = [];
        for (const file of files) staged.push(await stageOne(roots, sendAttemptId, file, requestBytes, signal));
        return staged;
      });
    },

    async publishCommitted(ref, sessionId, isStillCommitted) {
      assertOwner(ref);
      return withLock(root, async () => {
        if (isStillCommitted && !isStillCommitted())
          throw new AttachmentStorageError("identity_conflict", "attachment is no longer committed");
        const roots = await ensureRoots();
        const source = join(roots.staging, ref.attachmentId);
        const sessionRoot = await ensureDirectory(join(roots.sessions, sessionDirectoryName(sessionId)), roots.root);
        const destination = join(sessionRoot, ref.attachmentId);
        const opened = await safeFile(source, roots.root).catch(async (error) => {
          if (!(error instanceof AttachmentStorageError) || error.code !== "not_found") throw error;
          const existing = await digestFile(destination, roots.root);
          if (existing.size !== ref.size || existing.sha256 !== ref.sha256)
            throw new AttachmentStorageError(
              "identity_conflict",
              "durable attachment bytes differ from committed metadata",
            );
          return null;
        });
        if (opened) {
          const temp = join(sessionRoot, `.tmp-${randomUUID()}`);
          const hash = createHash("sha256");
          let size = 0;
          let output: Awaited<ReturnType<typeof open>> | undefined;
          try {
            output = await open(
              temp,
              constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
              0o600,
            );
            for await (const chunk of opened.handle.createReadStream({ autoClose: false })) {
              hash.update(chunk);
              size += chunk.byteLength;
              let offset = 0;
              while (offset < chunk.byteLength) offset += (await output.write(chunk, offset)).bytesWritten;
            }
            await output.sync();
            if (size !== ref.size || hash.digest("hex") !== ref.sha256)
              throw new AttachmentStorageError(
                "identity_conflict",
                "staged attachment bytes differ from committed metadata",
              );
            try {
              await link(temp, destination);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
              const existing = await digestFile(destination, roots.root);
              if (existing.size !== ref.size || existing.sha256 !== ref.sha256)
                throw new AttachmentStorageError("identity_conflict", "durable attachment identity conflict");
            }
            await syncDirectory(sessionRoot);
            await unlink(source);
            await syncDirectory(roots.staging);
          } finally {
            await opened.handle.close();
            await output?.close();
            await unlink(temp).catch(() => undefined);
          }
        }
        return { ...ref, status: "durable", sessionId };
      });
    },

    async *read(ref, signal) {
      assertOwner(ref);
      const roots = await ensureRoots();
      const { handle } = await safeFile(durablePath(ref), roots.root);
      try {
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          signal?.throwIfAborted();
          yield chunk;
        }
      } finally {
        await handle.close();
      }
    },

    async deleteStaged(ref) {
      assertOwner(ref);
      await withLock(root, async () => {
        const roots = await ensureRoots();
        await safeUnlink(join(roots.staging, ref.attachmentId), roots.root);
      });
    },

    async deleteDurable(ref) {
      assertOwner(ref);
      await withLock(root, async () => {
        const roots = await ensureRoots();
        await safeUnlink(durablePath(ref), roots.root);
      });
    },

    async expireStaging(retainAttachmentIds = new Set()) {
      return withLock(root, async () => {
        const roots = await ensureRoots();
        const cutoff = Date.now() - limits.stagingTtlMs;
        let expired = 0;
        let refused = 0;
        for (const entry of await readdir(roots.staging, { withFileTypes: true })) {
          if (entry.isSymbolicLink() || !entry.isFile()) {
            refused++;
            continue;
          }
          const isAttachment = ATTACHMENT_ID_RE.test(entry.name);
          const isTemp = entry.name.startsWith(".tmp-");
          if ((!isAttachment && !isTemp) || (isAttachment && retainAttachmentIds.has(entry.name))) continue;
          const path = join(roots.staging, entry.name);
          if ((await lstat(path)).mtimeMs >= cutoff) continue;
          await unlink(path);
          expired++;
        }
        return { expired, refused };
      });
    },

    async cleanupSession(sessionId) {
      await withLock(root, async () => {
        const roots = await ensureRoots();
        const path = join(roots.sessions, sessionDirectoryName(sessionId));
        const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!info) return;
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new AttachmentStorageError("unsafe_path", "session attachment path refused");
        const resolved = await realpath(path);
        if (!isWithin(resolved, roots.root))
          throw new AttachmentStorageError("unsafe_path", "session path escaped storage root");
        await rm(path, { recursive: true });
        await syncDirectory(roots.sessions);
      });
    },
  };
}

export async function consumeAttachmentCleanupIntents(
  source: CleanupIntentSource,
  storage: Pick<AttachmentStorage, "cleanupSession">,
  limit: number,
): Promise<{ cleaned: number; failed: number }> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("cleanup limit must be a positive integer");
  let cleaned = 0;
  let failed = 0;
  let afterSessionId: string | undefined;
  for (;;) {
    const intents = source.listFileCleanupIntents(limit, afterSessionId);
    for (const intent of intents) {
      afterSessionId = intent.sessionId;
      try {
        await storage.cleanupSession(intent.sessionId);
        if (source.ackFileCleanupIntent(intent.sessionId)) cleaned++;
      } catch {
        failed++;
      }
    }
    if (intents.length < limit) break;
  }
  return { cleaned, failed };
}
