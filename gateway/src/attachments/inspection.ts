import type { Result } from "@sentient/protocol";
import type { InboundGate } from "../security/inbound-gate.js";
import type { AttachmentManifestRecord, AttachmentSessionStore } from "../store/session-store.js";
import type {
  AttachmentParserClient,
  AttachmentParserCompatibilityReason,
  AttachmentParserError,
  AttachmentParserMediaType,
} from "./parser-client.js";
import type { AttachmentCapability, AttachmentStorage, DurableAttachment } from "./storage.js";
import type { VisionAdapter, VisionMediaType } from "./vision.js";
import { validateVisualMetadata } from "./visual-metadata-validation.js";
import type { AttachmentImageRegion, AttachmentSourceMetadata, AttachmentViewMetadata } from "./visual-metadata.js";

export type AttachmentInspectionMode = "text" | "visual";

export interface AttachmentInspectionRequest {
  readonly attachmentId: string;
  readonly question: string;
  readonly pages?: readonly number[];
  readonly mode?: AttachmentInspectionMode;
  readonly region?: AttachmentImageRegion;
  readonly frameIndex?: number;
  readonly timeMs?: number;
}

export interface AttachmentInspectionLimits {
  readonly maxPages: number;
  readonly maxTextBytes: number;
  readonly maxTextChars: number;
  readonly maxQuestionChars: number;
  readonly maxEdge: number;
}

export interface PreparedVisualEvidence {
  readonly attachmentId: string;
  readonly source?: AttachmentSourceMetadata;
  readonly pages: readonly number[];
  readonly totalPages: number;
  readonly partial: boolean;
  /** Transient exact manifest identity used only for final reauthorization. */
  readonly identity: { readonly entrySeq: number; readonly sha256: string; readonly size: number };
  readonly images: readonly {
    readonly pageRef: string;
    readonly mediaType: VisionMediaType;
    readonly bytes: Uint8Array;
    readonly provenance: string;
    readonly metadata?: AttachmentViewMetadata;
  }[];
}

export interface AttachmentInspectionResult {
  readonly attachmentId: string;
  readonly mode: AttachmentInspectionMode;
  readonly pagesInspected: readonly number[];
  readonly totalPages: number;
  readonly partial: boolean;
  readonly uncertainty: string;
  readonly answer: string;
  readonly source?: AttachmentSourceMetadata;
  readonly views?: readonly AttachmentViewMetadata[];
}

export type AttachmentInspectionErrorCode =
  | "invalid_request"
  | "attachment_unavailable"
  | "unsupported_mode"
  | "cancelled"
  | "parser_unavailable"
  | "parser_incompatible"
  | "parser_error"
  | "vision_unavailable"
  | "vision_error";

export interface AttachmentInspectionError {
  readonly code: AttachmentInspectionErrorCode;
  readonly reason?: AttachmentParserCompatibilityReason;
}

export interface AttachmentInspectionDeps {
  readonly capability: AttachmentCapability;
  readonly sessionId: string;
  readonly store: Pick<AttachmentSessionStore, "findAttachment">;
  readonly storage: Pick<AttachmentStorage, "read">;
  readonly parser: AttachmentParserClient;
  /** Resolve on every visual request. Resolver must enforce configured-provider match and must not fall back. */
  readonly resolveVision: () => Promise<Result<VisionAdapter, unknown>>;
  readonly gate: InboundGate;
  readonly limits: AttachmentInspectionLimits;
}

export async function inspectAttachment(
  deps: AttachmentInspectionDeps,
  request: AttachmentInspectionRequest,
  signal?: AbortSignal,
): Promise<Result<AttachmentInspectionResult, AttachmentInspectionError>> {
  if (
    deps.capability.resource !== "attachment-store" ||
    !validLimits(deps.limits) ||
    !validRequest(request, deps.limits)
  )
    return failure("invalid_request");
  if (signal?.aborted) return failure("cancelled");

  const initial = readyRef(deps, request.attachmentId);
  if (!initial) return failure("attachment_unavailable");
  const mode = request.mode ?? (initial.mediaKind === "image" ? "visual" : "text");
  if (
    initial.mediaKind !== "image" &&
    (request.region || request.frameIndex !== undefined || request.timeMs !== undefined)
  )
    return failure("unsupported_mode");

  try {
    const result =
      initial.mediaKind === "text"
        ? await inspectText(deps, initial, mode, signal)
        : initial.mediaKind === "pdf"
          ? await inspectPdf(deps, initial, request, mode, signal)
          : await inspectImage(deps, initial, request, mode, signal);
    signal?.throwIfAborted();
    if (!sameReadyRef(readyRef(deps, request.attachmentId), initial)) return failure("attachment_unavailable");
    return result;
  } catch {
    return failure(signal?.aborted ? "cancelled" : "attachment_unavailable");
  }
}

async function inspectText(
  deps: AttachmentInspectionDeps,
  ref: AttachmentManifestRecord,
  mode: AttachmentInspectionMode,
  signal?: AbortSignal,
): Promise<Result<AttachmentInspectionResult, AttachmentInspectionError>> {
  if (mode !== "text") return failure("unsupported_mode");
  const decoded = await readBoundedText(deps.storage.read(durable(ref), signal), deps.limits, signal);
  if (!decoded.ok) return decoded;
  const answer = screen(deps, decoded.value.text, ref.attachmentId);
  return success({
    attachmentId: ref.attachmentId,
    mode,
    pagesInspected: [1],
    totalPages: 1,
    partial: decoded.value.partial,
    uncertainty: decoded.value.partial ? "Text was truncated at the inspection limit." : "UTF-8 text only.",
    answer,
  });
}

async function inspectPdf(
  deps: AttachmentInspectionDeps,
  ref: AttachmentManifestRecord,
  request: AttachmentInspectionRequest,
  mode: AttachmentInspectionMode,
  signal?: AbortSignal,
): Promise<Result<AttachmentInspectionResult, AttachmentInspectionError>> {
  const header = await deps.parser.parse({
    mediaType: "application/pdf",
    contentLength: ref.size,
    bytes: deps.storage.read(durable(ref), signal),
    operation: { operation: "pdf-header" },
    diagnosticContext: parserDiagnosticContext(deps.sessionId, ref),
    ...(signal ? { signal } : {}),
  });
  if (!header.ok) return parserFailure(header.error, signal);
  const totalPages = pdfPageCount(header.value.body, header.value.contentType);
  if (totalPages === null) return failure("parser_error");
  const pages = selectedPages(request.pages, totalPages, deps.limits.maxPages);
  if (!pages) return failure("invalid_request");

  if (mode === "text") return inspectPdfText(deps, ref, pages, totalPages, signal);
  if (request.region || request.frameIndex !== undefined || request.timeMs !== undefined)
    return failure("unsupported_mode");
  return inspectPdfVisual(deps, ref, request.question, pages, totalPages, signal);
}

async function inspectPdfText(
  deps: AttachmentInspectionDeps,
  ref: AttachmentManifestRecord,
  pages: readonly number[],
  totalPages: number,
  signal?: AbortSignal,
): Promise<Result<AttachmentInspectionResult, AttachmentInspectionError>> {
  const sections: string[] = [];
  let partial = pages.length < totalPages;
  for (const page of pages) {
    signal?.throwIfAborted();
    const parsed = await deps.parser.parse({
      mediaType: "application/pdf",
      contentLength: ref.size,
      bytes: deps.storage.read(durable(ref), signal),
      operation: { operation: "pdf-text", firstPage: page, lastPage: page },
      diagnosticContext: parserDiagnosticContext(deps.sessionId, ref),
      ...(signal ? { signal } : {}),
    });
    if (!parsed.ok) return parserFailure(parsed.error, signal);
    if (parsed.value.contentType !== "text/plain; charset=utf-8") return failure("parser_error");
    const decoded = decodeBounded(parsed.value.body, deps.limits);
    if (!decoded.ok) return decoded;
    partial ||= decoded.value.partial;
    sections.push(`Page ${page}:\n${screen(deps, decoded.value.text, `${ref.attachmentId}#page=${page}`)}`);
  }
  return success({
    attachmentId: ref.attachmentId,
    mode: "text",
    pagesInspected: pages,
    totalPages,
    partial,
    uncertainty: "Embedded text only; visual content and layout were not inspected.",
    answer: sections.join("\n\n"),
  });
}

async function inspectPdfVisual(
  deps: AttachmentInspectionDeps,
  ref: AttachmentManifestRecord,
  question: string,
  pages: readonly number[],
  totalPages: number,
  signal?: AbortSignal,
): Promise<Result<AttachmentInspectionResult, AttachmentInspectionError>> {
  const prepared = await prepareVisualRef(deps, ref, pages, totalPages, undefined, signal);
  if (!prepared.ok) return prepared;
  return runVision(deps, ref, question, prepared.value.images, pages, totalPages, prepared.value.source, signal);
}

async function inspectImage(
  deps: AttachmentInspectionDeps,
  ref: AttachmentManifestRecord,
  request: AttachmentInspectionRequest,
  mode: AttachmentInspectionMode,
  signal?: AbortSignal,
): Promise<Result<AttachmentInspectionResult, AttachmentInspectionError>> {
  if (mode !== "visual" || (request.pages && (request.pages.length !== 1 || request.pages[0] !== 1)))
    return failure("unsupported_mode");
  const mediaType = parserMediaType(ref.contentType);
  if (!mediaType) return failure("unsupported_mode");
  const prepared = await prepareVisualRef(deps, ref, [1], 1, request, signal);
  if (!prepared.ok) return prepared;
  return runVision(deps, ref, request.question, prepared.value.images, [1], 1, prepared.value.source, signal);
}

export async function inspectPreparedVisual(
  deps: AttachmentInspectionDeps,
  prepared: readonly PreparedVisualEvidence[],
  question: string,
  signal?: AbortSignal,
): Promise<Result<AttachmentInspectionResult, AttachmentInspectionError>> {
  if (
    signal?.aborted ||
    prepared.length < 1 ||
    prepared.length > deps.limits.maxPages ||
    question.trim().length < 1 ||
    question.length > deps.limits.maxQuestionChars
  )
    return failure(signal?.aborted ? "cancelled" : "invalid_request");
  const first = prepared[0];
  if (
    !first ||
    prepared.some(
      (item) =>
        item.attachmentId !== first.attachmentId ||
        item.identity.entrySeq !== first.identity.entrySeq ||
        item.identity.sha256 !== first.identity.sha256 ||
        item.identity.size !== first.identity.size ||
        !isPreparedVisualAuthorized(deps, item),
    )
  )
    return failure("attachment_unavailable");
  const ref = readyRef(deps, first.attachmentId);
  if (!ref) return failure("attachment_unavailable");
  try {
    const images = prepared.flatMap((item) => item.images);
    if (images.length < 1 || images.length > deps.limits.maxPages) return failure("invalid_request");
    const pages = [...new Set(prepared.flatMap((item) => item.pages))];
    const result = await runVision(
      deps,
      ref,
      question,
      images,
      pages,
      Math.max(...prepared.map((item) => item.totalPages)),
      first.source,
      signal,
    );
    signal?.throwIfAborted();
    if (!prepared.every((item) => isPreparedVisualAuthorized(deps, item))) return failure("attachment_unavailable");
    return result;
  } catch {
    return failure(signal?.aborted ? "cancelled" : "attachment_unavailable");
  }
}

export async function prepareAttachmentVisual(
  deps: Pick<AttachmentInspectionDeps, "capability" | "sessionId" | "store" | "storage" | "parser" | "limits">,
  request: Pick<AttachmentInspectionRequest, "attachmentId" | "pages" | "region" | "frameIndex" | "timeMs">,
  signal?: AbortSignal,
): Promise<Result<PreparedVisualEvidence, AttachmentInspectionError>> {
  if (signal?.aborted) return failure("cancelled");
  const ref = readyRef(deps, request.attachmentId);
  if (!ref || ref.mediaKind === "text") return failure("attachment_unavailable");
  if (ref.mediaKind === "image") {
    if (request.pages && (request.pages.length !== 1 || request.pages[0] !== 1)) return failure("unsupported_mode");
    if (!validVisualSelection(request)) return failure("invalid_request");
    return prepareVisualRef(deps, ref, [1], 1, request, signal);
  }
  if (request.region || request.frameIndex !== undefined || request.timeMs !== undefined)
    return failure("unsupported_mode");
  const header = await deps.parser.parse({
    mediaType: "application/pdf",
    contentLength: ref.size,
    bytes: deps.storage.read(durable(ref), signal),
    operation: { operation: "pdf-header" },
    diagnosticContext: parserDiagnosticContext(deps.sessionId, ref),
    ...(signal ? { signal } : {}),
  });
  if (!header.ok) return parserFailure(header.error, signal);
  const totalPages = pdfPageCount(header.value.body, header.value.contentType);
  if (totalPages === null) return failure("parser_error");
  const pages = selectedPages(request.pages, totalPages, deps.limits.maxPages);
  if (!pages) return failure("invalid_request");
  return prepareVisualRef(deps, ref, pages, totalPages, undefined, signal);
}

async function prepareVisualRef(
  deps: Pick<AttachmentInspectionDeps, "capability" | "sessionId" | "store" | "storage" | "parser" | "limits">,
  ref: AttachmentManifestRecord,
  pages: readonly number[],
  totalPages: number,
  selection?: Pick<AttachmentInspectionRequest, "region" | "frameIndex" | "timeMs">,
  signal?: AbortSignal,
): Promise<Result<PreparedVisualEvidence, AttachmentInspectionError>> {
  const images: PreparedVisualEvidence["images"][number][] = [];
  let source: AttachmentSourceMetadata | undefined =
    ref.mediaKind === "pdf"
      ? {
          kind: "pdf",
          mediaType: "application/pdf",
          sizeBytes: ref.size,
          originalAvailable: true,
          pageCount: totalPages,
        }
      : undefined;
  for (const page of pages) {
    signal?.throwIfAborted();
    const parsed =
      ref.mediaKind === "pdf"
        ? await deps.parser.parse({
            mediaType: "application/pdf",
            contentLength: ref.size,
            bytes: deps.storage.read(durable(ref), signal),
            operation: { operation: "pdf-render", page, maxEdge: deps.limits.maxEdge },
            diagnosticContext: parserDiagnosticContext(deps.sessionId, ref),
            ...(signal ? { signal } : {}),
          })
        : await deps.parser.parse({
            mediaType: parserMediaType(ref.contentType) ?? "image/png",
            contentLength: ref.size,
            bytes: deps.storage.read(durable(ref), signal),
            operation: {
              operation: "image-normalize",
              maxEdge: deps.limits.maxEdge,
              ...(selection?.region ? { region: selection.region } : {}),
              ...(selection?.frameIndex !== undefined ? { frameIndex: selection.frameIndex } : {}),
              ...(selection?.timeMs !== undefined ? { timeMs: selection.timeMs } : {}),
            },
            diagnosticContext: parserDiagnosticContext(deps.sessionId, ref),
            ...(signal ? { signal } : {}),
          });
    if (!parsed.ok) return parserFailure(parsed.error, signal);
    if (parsed.value.contentType !== "image/png") return failure("parser_error");
    const metadata =
      ref.mediaKind === "pdf"
        ? pdfViewMetadata(parsed.value.body, page)
        : validateVisualMetadata(parsed.value.headers["X-Sentient-Visual-Metadata"], {
            mediaType: ref.contentType,
            sizeBytes: ref.size,
            png: parsed.value.body,
            maxEdge: deps.limits.maxEdge,
            ...(selection?.region ? { region: selection.region } : {}),
            ...(selection?.frameIndex !== undefined ? { frameIndex: selection.frameIndex } : {}),
            ...(selection?.timeMs !== undefined ? { timeMs: selection.timeMs } : {}),
          });
    if (!metadata) return failure("parser_error");
    const provenance = visualProvenance(ref.attachmentId, metadata.view, page, selection, ref.mediaKind);
    if (ref.mediaKind === "image") source = metadata.source;
    images.push({
      pageRef: provenance,
      mediaType: "image/png",
      bytes: parsed.value.body,
      provenance,
      metadata: metadata.view,
    });
  }
  if (!sameReadyRef(readyRef(deps, ref.attachmentId), ref)) return failure("attachment_unavailable");
  return {
    ok: true,
    value: {
      attachmentId: ref.attachmentId,
      ...(source ? { source } : {}),
      pages: [...pages],
      totalPages,
      partial: pages.length < totalPages,
      identity: { entrySeq: ref.entrySeq as number, sha256: ref.sha256, size: ref.size },
      images,
    },
  };
}

export function isPreparedVisualAuthorized(
  deps: Pick<AttachmentInspectionDeps, "capability" | "sessionId" | "store">,
  prepared: PreparedVisualEvidence,
): boolean {
  const ref = readyRef(deps, prepared.attachmentId);
  return (
    ref !== null &&
    ref.mediaKind !== "text" &&
    ref.entrySeq === prepared.identity.entrySeq &&
    ref.sha256 === prepared.identity.sha256 &&
    ref.size === prepared.identity.size
  );
}

async function runVision(
  deps: AttachmentInspectionDeps,
  ref: AttachmentManifestRecord,
  question: string,
  images: readonly {
    pageRef: string;
    mediaType: VisionMediaType;
    bytes: Uint8Array;
    provenance: string;
    metadata?: AttachmentViewMetadata;
  }[],
  pages: readonly number[],
  totalPages: number,
  source?: AttachmentSourceMetadata,
  signal?: AbortSignal,
): Promise<Result<AttachmentInspectionResult, AttachmentInspectionError>> {
  if (!sameReadyRef(readyRef(deps, ref.attachmentId), ref)) return failure("attachment_unavailable");
  const screenedQuestion = screen(deps, question, "inspect_attachment.question");
  const resolved = await deps.resolveVision();
  if (!resolved.ok) return failure("vision_unavailable");
  if (!sameReadyRef(readyRef(deps, ref.attachmentId), ref)) return failure("attachment_unavailable");
  const answer = await resolved.value.inspect({
    question: screenedQuestion,
    pages: images,
    ...(signal ? { signal } : {}),
  });
  if (!answer.ok) return failure(answer.error.code === "cancelled" ? "cancelled" : "vision_error");
  return success({
    attachmentId: ref.attachmentId,
    mode: "visual",
    pagesInspected: pages,
    totalPages,
    partial: pages.length < totalPages,
    uncertainty: "Visual model interpretation may be incomplete or uncertain.",
    answer: screen(deps, answer.value.text, images.map((image) => image.provenance).join(",")),
    ...(source ? { source } : {}),
    ...(images[0]?.metadata ? { views: images.flatMap((image) => (image.metadata ? [image.metadata] : [])) } : {}),
  });
}

function readyRef(
  deps: Pick<AttachmentInspectionDeps, "capability" | "sessionId" | "store">,
  attachmentId: string,
): AttachmentManifestRecord | null {
  const ref = deps.store.findAttachment(attachmentId);
  return ref?.status === "ready" &&
    ref.ownerUserId === deps.capability.ownerUserId &&
    ref.sessionId === deps.sessionId &&
    ref.entrySeq !== null
    ? ref
    : null;
}

function sameReadyRef(current: AttachmentManifestRecord | null, initial: AttachmentManifestRecord): boolean {
  return (
    current !== null &&
    current.attachmentId === initial.attachmentId &&
    current.ownerUserId === initial.ownerUserId &&
    current.sessionId === initial.sessionId &&
    current.entrySeq === initial.entrySeq &&
    current.sha256 === initial.sha256 &&
    current.size === initial.size
  );
}

function parserDiagnosticContext(sessionId: string, ref: AttachmentManifestRecord) {
  return { attachmentId: ref.attachmentId, sessionId, ...(ref.entrySeq === null ? {} : { entrySeq: ref.entrySeq }) };
}

function durable(ref: AttachmentManifestRecord): DurableAttachment {
  if (!ref.sessionId) throw new Error("attachment is not committed");
  return { ...ref, status: "durable", sessionId: ref.sessionId };
}

function selectedPages(pages: readonly number[] | undefined, total: number, max: number): number[] | null {
  const selected = pages ?? [1];
  if (selected.length < 1 || selected.length > max) return null;
  if (new Set(selected).size !== selected.length) return null;
  return selected.every((page) => Number.isSafeInteger(page) && page >= 1 && page <= total) ? [...selected] : null;
}

async function readBoundedText(
  bytes: AsyncIterable<Uint8Array>,
  limits: AttachmentInspectionLimits,
  signal?: AbortSignal,
): Promise<Result<{ text: string; partial: boolean }, AttachmentInspectionError>> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let read = 0;
  let partial = false;
  try {
    for await (const chunk of bytes) {
      signal?.throwIfAborted();
      const remaining = limits.maxTextBytes - read;
      if (remaining <= 0) {
        partial = true;
        break;
      }
      const selected = chunk.subarray(0, remaining);
      read += selected.byteLength;
      text += decoder.decode(selected, { stream: true });
      if (selected.byteLength < chunk.byteLength || text.length > limits.maxTextChars) {
        partial = true;
        break;
      }
    }
    if (!partial) text += decoder.decode();
  } catch {
    return failure(signal?.aborted ? "cancelled" : "parser_error");
  }
  if (text.length > limits.maxTextChars) text = text.slice(0, limits.maxTextChars);
  return { ok: true, value: { text, partial } };
}

function decodeBounded(
  body: Uint8Array,
  limits: AttachmentInspectionLimits,
): Result<{ text: string; partial: boolean }, AttachmentInspectionError> {
  try {
    const bytesPartial = body.byteLength > limits.maxTextBytes;
    const selected = body.subarray(0, limits.maxTextBytes);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = decoder.decode(selected, { stream: bytesPartial });
    if (!bytesPartial) text += decoder.decode();
    const partial = bytesPartial || text.length > limits.maxTextChars;
    return { ok: true, value: { text: text.slice(0, limits.maxTextChars), partial } };
  } catch {
    return failure("parser_error");
  }
}

function pdfPageCount(body: Uint8Array, contentType: string): number | null {
  if (contentType !== "application/json") return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const pageCount = (value as Record<string, unknown>).pageCount;
    return Number.isSafeInteger(pageCount) && (pageCount as number) >= 1 ? (pageCount as number) : null;
  } catch {
    return null;
  }
}

function pdfViewMetadata(
  bytes: Uint8Array,
  page: number,
): { source: AttachmentSourceMetadata; view: AttachmentViewMetadata } | null {
  if (
    bytes.byteLength < 24 ||
    ![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)
  )
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1) return null;
  return {
    source: { kind: "pdf", mediaType: "application/pdf", sizeBytes: bytes.byteLength, originalAvailable: true },
    view: { kind: "page", width, height, page },
  };
}

function visualProvenance(
  attachmentId: string,
  view: AttachmentViewMetadata | undefined,
  page: number,
  selection: Pick<AttachmentInspectionRequest, "region" | "frameIndex" | "timeMs"> | undefined,
  mediaKind: AttachmentManifestRecord["mediaKind"],
): string {
  if (!view) return mediaKind === "pdf" ? `${attachmentId}#view=page:page=${page}` : `${attachmentId}#view=overview`;
  const parts = [`${attachmentId}#view=${view.kind}`];
  if (view.page !== undefined) parts.push(`page=${view.page}`);
  if (view.frameIndex !== undefined) parts.push(`frame=${view.frameIndex}`);
  else if (selection?.frameIndex !== undefined) parts.push(`requested-frame=${selection.frameIndex}`);
  if (view.timeMs !== undefined) parts.push(`timeMs=${view.timeMs}`);
  else if (selection?.timeMs !== undefined) parts.push(`requested-timeMs=${selection.timeMs}`);
  const region = view.region ?? selection?.region;
  if (region) parts.push(`region=${region.x}:${region.y}:${region.width}:${region.height}`);
  return parts.join(":").slice(0, 128);
}

function parserMediaType(contentType: string): AttachmentParserMediaType | null {
  return contentType === "image/jpeg" ||
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

function screen(deps: AttachmentInspectionDeps, text: string, source: string): string {
  return deps.gate.screen(text, { channel: "tool_result", source }, { sessionId: deps.sessionId }).text;
}

function validLimits(limits: AttachmentInspectionLimits): boolean {
  return Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0);
}

function validRequest(request: AttachmentInspectionRequest, limits: AttachmentInspectionLimits): boolean {
  return (
    /^att_[a-f0-9]{32}$/.test(request.attachmentId) &&
    request.question.trim().length > 0 &&
    request.question.length <= limits.maxQuestionChars &&
    (request.mode === undefined || request.mode === "text" || request.mode === "visual") &&
    (request.pages === undefined ||
      (request.pages.length >= 1 &&
        request.pages.length <= limits.maxPages &&
        request.pages.every((page) => Number.isSafeInteger(page) && page >= 1))) &&
    validVisualSelection(request)
  );
}

function validVisualSelection(request: Pick<AttachmentInspectionRequest, "region" | "frameIndex" | "timeMs">): boolean {
  if (request.frameIndex !== undefined && request.timeMs !== undefined) return false;
  if (request.frameIndex !== undefined && (!Number.isSafeInteger(request.frameIndex) || request.frameIndex < 0))
    return false;
  if (request.timeMs !== undefined && (!Number.isSafeInteger(request.timeMs) || request.timeMs < 0)) return false;
  if (!request.region) return true;
  const { x, y, width, height } = request.region;
  return (
    [x, y, width, height].every(Number.isFinite) &&
    x >= 0 &&
    y >= 0 &&
    width > 0 &&
    height > 0 &&
    x + width <= 1 &&
    y + height <= 1
  );
}

function parserFailure(
  error: Pick<AttachmentParserError, "code" | "compatibilityReason">,
  signal?: AbortSignal,
): { ok: false; error: AttachmentInspectionError } {
  if (signal?.aborted || error.code === "cancelled") return failure("cancelled");
  if (error.code === "incompatible") return failure("parser_incompatible", error.compatibilityReason);
  return failure(error.code === "unavailable" || error.code === "timeout" ? "parser_unavailable" : "parser_error");
}

function success(value: AttachmentInspectionResult): { ok: true; value: AttachmentInspectionResult } {
  return { ok: true, value };
}

function failure(
  code: AttachmentInspectionErrorCode,
  reason?: AttachmentParserCompatibilityReason,
): { ok: false; error: AttachmentInspectionError } {
  return { ok: false, error: { code, ...(reason ? { reason } : {}) } };
}
