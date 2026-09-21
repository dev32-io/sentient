import { createHash } from "node:crypto";
import type { AttachmentRef } from "@sentient/protocol";
import type { AccessManager } from "../../access/access-manager.js";
import type { AttachmentParserClient, AttachmentParserMediaType } from "../../attachments/parser-client.js";
import {
  type AttachmentCapability,
  type AttachmentStorage,
  AttachmentStorageError,
  type AttachmentStorageLimits,
  createAttachmentStorage,
  mintAttachmentId,
} from "../../attachments/storage.js";
import { type UserPrincipal, createUserPrincipal } from "../../identity/user-principal.js";
import {
  AttachmentAdmissionError,
  type AttachmentManifestRecord,
  type AttachmentSessionStore,
  openSessionStore,
} from "../../store/session-store.js";
import type { TokenPayload, TokenResult } from "../../user-auth/types.js";
import type { UserStore } from "../../user-auth/user-store.js";

const ROOT = "/api/v1/attachments";
const ITEM = /^\/api\/v1\/attachments\/([^/]+)$/;
const PREVIEW = /^\/api\/v1\/attachments\/([^/]+)\/preview$/;
const HOUSEHOLD_ID = "home";

export interface AttachmentsHandlerDeps {
  tokens: { validate(token: string): Promise<TokenResult<TokenPayload>> };
  users: Pick<UserStore, "get">;
  accessManager: AccessManager;
  dbFileName: string;
  limits: AttachmentStorageLimits;
  parser?: AttachmentParserClient;
  previewMaxEdge?: number;
  openStore?: (cap: ReturnType<AccessManager["grant"]>, dbFileName: string) => AttachmentSessionStore;
  openStorage?: (cap: AttachmentCapability, limits: AttachmentStorageLimits) => AttachmentStorage;
}

export function createAttachmentsHandler(deps: AttachmentsHandlerDeps): (request: Request) => Promise<Response> {
  return (request) => handleAttachments(deps, request);
}

async function handleAttachments(deps: AttachmentsHandlerDeps, request: Request): Promise<Response> {
  const token = bearer(request);
  if (!token) return error(401, "missing_token");

  let valid: TokenResult<TokenPayload>;
  try {
    valid = await deps.tokens.validate(token);
  } catch {
    return error(503, "io_error");
  }
  if (!valid.ok) return error(401, "invalid_token");

  let user: Awaited<ReturnType<UserStore["get"]>>;
  try {
    user = await deps.users.get(valid.value.userId);
  } catch {
    return error(503, "io_error");
  }
  if (!user.ok || user.value === null) return error(401, "user_not_found");

  let principal: UserPrincipal;
  try {
    principal = createUserPrincipal(valid.value.userId, user.value.role, HOUSEHOLD_ID);
  } catch {
    return error(401, "invalid_user_record");
  }

  const url = new URL(request.url);
  const match = ITEM.exec(url.pathname);
  const previewMatch = PREVIEW.exec(url.pathname);
  if (url.pathname !== ROOT && !match && !previewMatch) return error(404, "not_found");
  if (url.pathname === ROOT && request.method !== "POST") return error(405, "method_not_allowed");
  if (match && request.method !== "GET" && request.method !== "DELETE") return error(405, "method_not_allowed");
  if (previewMatch && request.method !== "GET") return error(405, "method_not_allowed");

  const openStore = deps.openStore ?? openSessionStore;
  const openStorage = deps.openStorage ?? createAttachmentStorage;
  let store: AttachmentSessionStore | undefined;
  try {
    store = openStore(deps.accessManager.grant(principal, "session-store"), deps.dbFileName);
    const storage = openStorage(
      deps.accessManager.grant(principal, "attachment-store") as AttachmentCapability,
      deps.limits,
    );
    if (url.pathname === ROOT) return await upload(request, url, store, storage, deps.limits);
    const attachmentId = decode(previewMatch?.[1] ?? match?.[1] ?? "");
    if (attachmentId === null) return error(404, "not_found");
    if (previewMatch)
      // UI thumbnails share the composer's pixel bound, not the model's inspection resolution.
      return await preview(
        request,
        attachmentId,
        store,
        storage,
        deps.parser,
        Math.min(deps.previewMaxEdge ?? 640, 640),
      );
    return request.method === "GET"
      ? await download(request, attachmentId, store, storage)
      : await remove(attachmentId, store, storage);
  } catch (cause) {
    return expectedError(cause);
  } finally {
    store?.close();
  }
}

async function upload(
  request: Request,
  url: URL,
  store: AttachmentSessionStore,
  storage: AttachmentStorage,
  limits: AttachmentStorageLimits,
): Promise<Response> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > limits.maxFileBytes))
    return error(413, "file_too_large");
  if (!request.body) return error(422, "invalid_request");

  const sendAttemptId = oneParam(url, "sendAttemptId", 200, /^[A-Za-z0-9._:-]+$/);
  const fileIdentity = oneParam(url, "fileIdentity", 200, /^[A-Za-z0-9._:-]+$/);
  const displayName = oneParam(url, "displayName", 255);
  const contentType = oneParam(url, "contentType", 100);
  if (!sendAttemptId || !fileIdentity || !displayName || !contentType) return error(422, "invalid_request");

  const existing = store.findAttachmentByAttempt(sendAttemptId, fileIdentity);
  if (existing) {
    const retry = await digestUploadBody(request.body, limits, request.signal);
    if (retry.size !== existing.size || retry.sha256 !== existing.sha256)
      throw new AttachmentStorageError("identity_conflict", "retry bytes differ from existing attachment");
    return Response.json(ref(existing), { status: 200 });
  }

  const staged = (
    await storage.stageAttempt(
      sendAttemptId,
      [
        {
          attachmentId: mintAttachmentId(),
          fileIdentity,
          displayName,
          contentType,
          bytes: request.body,
        },
      ],
      request.signal,
    )
  )[0];
  if (!staged) throw new AttachmentStorageError("invalid_request", "attachment upload produced no file");
  try {
    const saved = store.registerStagedAttachment(staged, staged.stagedAt + limits.stagingTtlMs);
    return Response.json(ref(saved), { status: 201 });
  } catch (cause) {
    await storage.deleteStaged(staged).catch(() => undefined);
    if (cause instanceof AttachmentAdmissionError && cause.code === "attachment_conflict") {
      const winner = store.findAttachmentByAttempt(sendAttemptId, fileIdentity);
      if (winner && winner.size === staged.size && winner.sha256 === staged.sha256)
        return Response.json(ref(winner), { status: 200 });
    }
    throw cause;
  }
}

async function digestUploadBody(
  body: ReadableStream<Uint8Array>,
  limits: AttachmentStorageLimits,
  signal: AbortSignal,
): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of body) {
    signal.throwIfAborted();
    size += chunk.byteLength;
    if (size > limits.maxFileBytes) throw new AttachmentStorageError("file_too_large", "attachment exceeds file limit");
    if (size > limits.maxRequestBytes)
      throw new AttachmentStorageError("request_too_large", "attachment request exceeds byte limit");
    hash.update(chunk);
  }
  return { size, sha256: hash.digest("hex") };
}

async function download(
  request: Request,
  attachmentId: string,
  store: AttachmentSessionStore,
  storage: AttachmentStorage,
): Promise<Response> {
  const record = store.findAttachment(attachmentId);
  if (!record || record.status !== "ready" || !record.sessionId) return error(404, "not_found");
  const iterator = storage.read({ ...record, status: "durable", sessionId: record.sessionId }, request.signal);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (cause) {
        controller.error(cause);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
  return new Response(body, {
    headers: {
      "content-type": record.contentType,
      "content-length": String(record.size),
      "content-disposition": `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(record.displayName)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "cache-control": "private, no-store",
    },
  });
}

async function preview(
  request: Request,
  attachmentId: string,
  store: AttachmentSessionStore,
  storage: AttachmentStorage,
  parser: AttachmentParserClient | undefined,
  maxEdge: number,
): Promise<Response> {
  const record = store.findAttachment(attachmentId);
  if (!record || record.status !== "ready" || !record.sessionId) return error(404, "not_found");
  if (!parser) return error(503, "parser_unavailable");
  const mediaType = parserMediaType(record.contentType);
  if (!mediaType) return error(415, "preview_unsupported");
  const parsed = await parser.parse({
    diagnosticContext: {
      attachmentId: record.attachmentId,
      sessionId: record.sessionId,
      ...(record.entrySeq !== null ? { entrySeq: record.entrySeq } : {}),
    },
    mediaType,
    contentLength: record.size,
    bytes: storage.read({ ...record, status: "durable", sessionId: record.sessionId }, request.signal),
    operation:
      mediaType === "application/pdf"
        ? { operation: "pdf-render", page: 1, maxEdge }
        : { operation: "image-normalize", maxEdge },
    signal: request.signal,
  });
  if (!parsed.ok) {
    if (parsed.error.code === "cancelled") return error(499, "cancelled");
    if (parsed.error.code === "unavailable" || parsed.error.code === "timeout") return error(503, "parser_unavailable");
    return error(422, "preview_failed");
  }
  const current = store.findAttachment(attachmentId);
  if (
    !current ||
    current.status !== "ready" ||
    current.entrySeq !== record.entrySeq ||
    current.sha256 !== record.sha256 ||
    current.size !== record.size
  )
    return error(404, "not_found");
  // Keep protected UI thumbnail limit separate from model inspection resolution and original storage limits.
  if (parsed.value.body.byteLength > 5 * 1024 * 1024) return error(422, "preview_too_large");
  if (parsed.value.contentType !== "image/png" || !isPng(parsed.value.body)) return error(422, "preview_failed");
  return new Response(Buffer.from(parsed.value.body), {
    headers: {
      "content-type": "image/png",
      "content-length": String(parsed.value.body.byteLength),
      "content-disposition": 'inline; filename="attachment-preview.png"',
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "cache-control": "private, no-store",
    },
  });
}

function parserMediaType(contentType: string): AttachmentParserMediaType | null {
  return contentType === "application/pdf" ||
    contentType === "image/jpeg" ||
    contentType === "image/png" ||
    contentType === "image/heic" ||
    contentType === "image/heif" ||
    contentType === "image/avif" ||
    contentType === "image/webp" ||
    contentType === "image/gif" ||
    contentType === "image/tiff" ||
    contentType === "image/bmp" ||
    contentType === "image/jp2" ||
    contentType === "image/jxl" ||
    contentType === "application/vnd.sentient.live-photo+zip"
    ? contentType
    : null;
}

function isPng(bytes: Uint8Array): boolean {
  return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte);
}

async function remove(
  attachmentId: string,
  store: AttachmentSessionStore,
  storage: AttachmentStorage,
): Promise<Response> {
  const record = store.findAttachment(attachmentId);
  if (!record || record.status !== "staged") return error(404, "not_found");
  // Manifest deletion wins atomically against message admission. Any unlink failure
  // leaves only an unreferenced staging file, which normal staging expiry removes.
  if (!store.deleteStagedAttachment(attachmentId)) return error(404, "not_found");
  await storage.deleteStaged({ ...record, status: "staged" });
  return new Response(null, { status: 204 });
}

function ref(record: AttachmentManifestRecord): AttachmentRef {
  return {
    attachmentId: record.attachmentId,
    displayName: record.displayName,
    contentType: record.contentType,
    mediaKind: record.mediaKind,
    size: record.size,
  };
}

function oneParam(url: URL, name: string, max: number, pattern?: RegExp): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1) return null;
  const value = values[0] ?? "";
  return value.length > 0 && value.length <= max && (!pattern || pattern.test(value)) ? value : null;
}

function bearer(request: Request): string | null {
  const match = /^Bearer ([^ ]+)$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function expectedError(cause: unknown): Response {
  if (cause instanceof AttachmentStorageError) {
    if (cause.code === "file_too_large" || cause.code === "request_too_large") return error(413, cause.code);
    if (cause.code === "quota_exceeded") return error(507, cause.code);
    if (cause.code === "not_found" || cause.code === "foreign") return error(404, "not_found");
    if (cause.code === "identity_conflict") return error(409, cause.code);
    return error(422, cause.code);
  }
  if (cause instanceof AttachmentAdmissionError) {
    return error(cause.code === "attachment_conflict" ? 409 : 422, cause.code);
  }
  if (cause instanceof DOMException && cause.name === "AbortError") return error(499, "cancelled");
  return error(503, "io_error");
}

function error(status: number, code: string): Response {
  return Response.json({ error: code }, { status });
}
