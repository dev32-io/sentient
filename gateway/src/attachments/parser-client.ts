import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, accessSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";

const log = getLog(["sentient", "attachments", "parser-client"]);

const CLIENT_PATH = "/app/exec_client.py";
const MAX_EXEC_DEADLINE_MS = 35_000;
const METADATA_MAX_BYTES = 16 * 1024;
const METADATA_MAX_DEADLINE_MS = 3_000;
const ERROR_REASON_RE = /^[a-z0-9_]{1,64}$/;
const METADATA_VERSION_RE =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const METADATA_MAX_VERSION_CHARS = 64;
const METADATA_KEYS = new Set(["name", "version", "protocolVersion", "description", "state"]);

export const ATTACHMENT_PARSER_NAME = "attachment-parser" as const;
export const ATTACHMENT_PARSER_PROTOCOL_VERSION = 2 as const;
const CONTENT_TYPES = new Set([
  "application/json",
  "application/octet-stream",
  "text/plain; charset=utf-8",
  "image/png",
]);
const FORWARDED_HEADERS = new Set(["X-Sentient-Page", "X-Sentient-Page-Range", "X-Sentient-Visual-Metadata"]);
const SAFE_PARSER_REASONS = new Set([
  "body_too_large",
  "busy",
  "content_length_required",
  "deadline_exceeded",
  "decode_failed",
  "decoder_unavailable",
  "image_pixel_limit",
  "archive_entry_limit",
  "archive_expanded_limit",
  "invalid_frame_index",
  "invalid_frame_selection",
  "invalid_live_photo",
  "invalid_region",
  "invalid_time_ms",
  "incomplete_body",
  "input_too_large",
  "internal_error",
  "invalid_arguments",
  "invalid_deadline",
  "invalid_first_page",
  "invalid_last_page",
  "invalid_max_edge",
  "invalid_page",
  "invalid_page_range",
  "invalid_parser_response",
  "invalid_request_id",
  "mime_magic_mismatch",
  "not_found",
  "parser_error",
  "parser_response_too_large",
  "parser_unavailable",
  "pdf_page_limit",
  "request_aborted",
  "request_already_running",
  "response_too_large",
  "unsafe_archive",
  "unsupported_media_type",
]);

export type AttachmentParserMediaType =
  | "application/pdf"
  | "image/jpeg"
  | "image/png"
  | "image/heic"
  | "image/heif"
  | "image/avif"
  | "image/webp"
  | "image/gif"
  | "image/tiff"
  | "image/bmp"
  | "image/jp2"
  | "image/jxl"
  | "application/vnd.sentient.live-photo+zip";

export type AttachmentParserOperation =
  | { readonly operation: "pdf-header" }
  | { readonly operation: "pdf-text"; readonly firstPage?: number; readonly lastPage?: number }
  | { readonly operation: "pdf-render"; readonly page: number; readonly maxEdge?: number }
  | { readonly operation: "image-header" }
  | {
      readonly operation: "image-normalize";
      readonly maxEdge?: number;
      readonly region?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
      readonly frameIndex?: number;
      readonly timeMs?: number;
    };

export interface AttachmentParserRequest {
  readonly mediaType: AttachmentParserMediaType;
  readonly contentLength: number;
  /** Byte source already authorized by caller. Adapter never discovers private files. */
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly operation: AttachmentParserOperation;
  /** Safe identifiers only. Never filenames, paths, image metadata, or user content. */
  readonly diagnosticContext?: {
    readonly attachmentId: string;
    readonly sessionId: string;
    readonly entrySeq?: number;
  };
  readonly signal?: AbortSignal;
}

export interface AttachmentParserResponse {
  readonly requestId: string;
  readonly status: number;
  readonly contentType: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface AttachmentParserMetadata {
  readonly name: typeof ATTACHMENT_PARSER_NAME;
  readonly version: string;
  readonly protocolVersion: typeof ATTACHMENT_PARSER_PROTOCOL_VERSION;
  readonly description: string;
  readonly state: "ephemeral";
}

export type AttachmentParserCompatibilityReason =
  | "metadata_unavailable"
  | "metadata_timeout"
  | "metadata_cancelled"
  | "metadata_unsupported"
  | "metadata_malformed"
  | "metadata_too_large"
  | "name_mismatch"
  | "protocol_mismatch"
  | "version_malformed"
  | "description_malformed"
  | "state_mismatch";

export type AttachmentParserMetadataErrorCode = "cancelled" | "timeout" | "unavailable" | "malformed" | "incompatible";

export interface AttachmentParserMetadataError {
  readonly code: AttachmentParserMetadataErrorCode;
  readonly reason: AttachmentParserCompatibilityReason;
}

export type AttachmentParserErrorCode =
  | "invalid_request"
  | "cancelled"
  | "timeout"
  | "unavailable"
  | "protocol_error"
  | "output_too_large"
  | "incompatible"
  | "parser_error";

export interface AttachmentParserError {
  readonly code: AttachmentParserErrorCode;
  readonly operation: AttachmentParserOperation["operation"];
  readonly requestId?: string;
  readonly status?: number;
  /** Parser reason is accepted only from its restricted machine-readable alphabet. */
  readonly reason?: string;
  /** Present only when metadata/contract validation failed. */
  readonly compatibilityReason?: AttachmentParserCompatibilityReason;
}

export interface AttachmentParserClient {
  parse(request: AttachmentParserRequest): Promise<Result<AttachmentParserResponse, AttachmentParserError>>;
  /** Fresh bounded probe. No identity is cached across container recreation. */
  readonly getMetadata?: (
    signal?: AbortSignal,
  ) => Promise<Result<AttachmentParserMetadata, AttachmentParserMetadataError>>;
}

export interface AttachmentParserClientOptions {
  readonly containerName: string;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxHeaderBytes: number;
  readonly deadlineMs: number;
  readonly cleanupTimeoutMs: number;
  readonly maxEdge: number;
}

export interface ParserExecHandle {
  readonly stdin: Writable | undefined;
  readonly stdout: Readable;
  inspect(signal?: AbortSignal): Promise<{ Running: boolean; ExitCode: number | null }>;
  destroy(): void;
}

/** Narrow Docker exec boundary. Tests inject synthetic framed streams, never a live provider/container. */
export interface AttachmentParserTransport {
  start(
    containerName: string,
    argv: readonly string[],
    attachStdin: boolean,
    signal?: AbortSignal,
  ): Promise<ParserExecHandle>;
}

const HOST_PROCESS_KILL_GRACE_MS = 100;

export function createDockerCliAttachmentParserTransport(dockerPath = resolveDockerCli()): AttachmentParserTransport {
  return {
    async start(containerName, argv, attachStdin, signal) {
      signal?.throwIfAborted();
      const child = spawn(dockerPath, ["exec", ...(attachStdin ? ["-i"] : []), containerName, ...argv], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      let running = true;
      let exitCode: number | null = null;
      let destroyed = false;
      let forceKill: ReturnType<typeof setTimeout> | undefined;
      const terminate = () => {
        if (!running || child.pid === undefined) return;
        try {
          child.kill("SIGTERM");
        } catch {
          // The child can exit between the running check and kill.
        }
        forceKill ??= setTimeout(() => {
          if (!running) return;
          try {
            child.kill("SIGKILL");
          } catch {
            // The child exited while the grace timer was pending.
          }
        }, HOST_PROCESS_KILL_GRACE_MS);
        forceKill.unref();
      };
      const destroy = () => {
        if (destroyed) return;
        destroyed = true;
        signal?.removeEventListener("abort", onAbort);
        child.stdin.destroy();
        child.stdout.destroy();
        terminate();
      };
      const onAbort = () => destroy();
      signal?.addEventListener("abort", onAbort, { once: true });
      child.once("exit", (code) => {
        running = false;
        exitCode = code ?? 1;
      });
      child.once("error", () => {
        running = false;
        exitCode = 1;
        child.stdout.destroy(new Error("docker exec failed"));
      });
      child.stdin.on("error", () => child.stdout.destroy(new Error("docker exec input failed")));
      const spawnedPromise = new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          child.removeListener("error", onError);
          if (destroyed) terminate();
          resolve();
        };
        const onError = (error: Error) => {
          child.removeListener("spawn", onSpawn);
          reject(error);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
      try {
        await (signal ? abortable(spawnedPromise, signal, () => destroy()) : spawnedPromise);
        if (!attachStdin) child.stdin.end();
        return {
          stdin: attachStdin ? child.stdin : undefined,
          stdout: child.stdout,
          inspect: async (inspectSignal) => {
            inspectSignal?.throwIfAborted();
            return { Running: running, ExitCode: exitCode };
          },
          destroy,
        };
      } catch (error) {
        destroy();
        throw error;
      }
    },
  };
}

function resolveDockerCli(): string {
  const candidates = [
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, "docker")),
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try next known host installation path. Spawn reports unavailable if none exists.
    }
  }
  return "docker";
}

class ParserAdmissionQueue {
  private active = false;
  private readonly waiting: Array<{ grant: (release: () => void) => void; signal: AbortSignal }> = [];

  constructor(private readonly maxWaiting: number) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (!this.active) {
      this.active = true;
      return Promise.resolve(() => this.release());
    }
    if (this.waiting.length >= this.maxWaiting) throw new BoundaryFailure("unavailable");
    return new Promise((resolve, reject) => {
      const waiter = {
        signal,
        grant: (release: () => void) => {
          signal.removeEventListener("abort", abort);
          resolve(release);
        },
      };
      const abort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiting.push(waiter);
    });
  }

  private release(): void {
    for (;;) {
      const next = this.waiting.shift();
      if (!next) {
        this.active = false;
        return;
      }
      if (!next.signal.aborted) {
        next.grant(() => this.release());
        return;
      }
    }
  }
}

class BoundaryFailure extends Error {
  constructor(readonly code: AttachmentParserErrorCode) {
    super(code);
  }
}

interface FrameHeader {
  version: 1;
  requestId: string;
  status: number;
  contentType: string;
  contentLength: number;
  headers: Record<string, string>;
  error: string | null;
}

export function createAttachmentParserClient(
  transport: AttachmentParserTransport,
  options: AttachmentParserClientOptions,
): AttachmentParserClient {
  validateOptions(options);
  const admission = new ParserAdmissionQueue(3);
  const metadataAdmission = new ParserAdmissionQueue(3);
  const getMetadata = (signal?: AbortSignal) =>
    probeAttachmentParserMetadata(metadataAdmission, transport, options, signal);

  return {
    getMetadata,
    async parse(request) {
      const operation = request.operation.operation;
      const requestId = randomUUID();
      const startedAt = performance.now();
      let outputBytes = 0;
      const fail = (error: AttachmentParserError): { ok: false; error: AttachmentParserError } => {
        if (error.code !== "cancelled" && !request.signal?.aborted) {
          log.warn("attachment_parser.failed", {
            requestId,
            operation,
            code: error.code,
            ...(error.status !== undefined ? { status: error.status } : {}),
            ...(error.reason ? { reason: safeParserReason(error.reason) } : {}),
            ...(error.compatibilityReason ? { compatibilityReason: error.compatibilityReason } : {}),
            ...(Number.isSafeInteger(request.contentLength) ? { inputBytes: request.contentLength } : {}),
            outputBytes,
            durationMs: Math.round(performance.now() - startedAt),
            ...(request.diagnosticContext
              ? {
                  attachmentId: request.diagnosticContext.attachmentId,
                  sessionId: request.diagnosticContext.sessionId,
                  ...(Number.isSafeInteger(request.diagnosticContext.entrySeq)
                    ? { entrySeq: request.diagnosticContext.entrySeq }
                    : {}),
                }
              : {}),
          });
        }
        return { ok: false, error };
      };
      const args = requestArgs(request, options);
      if (!args.ok) return fail({ code: "invalid_request", operation });

      const deadline = AbortSignal.timeout(options.deadlineMs);
      const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
      let handle: ParserExecHandle | undefined;
      let releaseSlot: (() => void) | undefined;
      let abortListening = false;
      let cancelStarted: Promise<void> | undefined;
      const cancel = () => {
        if (!cancelStarted) {
          cancelStarted = cancelRequest(transport, options, requestId, handle).catch(() => {
            handle?.destroy();
          });
        }
        return cancelStarted;
      };
      const onAbort = () => void cancel();

      try {
        releaseSlot = await admission.acquire(signal);
        signal.throwIfAborted();
        const metadata = await getMetadata(signal);
        if (!metadata.ok) {
          if (signal.aborted) throw signal.reason;
          const code = metadata.error.code;
          if (code === "cancelled" || code === "timeout" || code === "unavailable") {
            return fail({ code, operation, requestId });
          }
          return fail({
            code: "incompatible",
            operation,
            requestId,
            compatibilityReason: metadata.error.reason,
          });
        }
        signal.addEventListener("abort", onAbort, { once: true });
        abortListening = true;
        handle = await abortable(
          transport.start(
            options.containerName,
            [
              "python3",
              CLIENT_PATH,
              "request",
              requestId,
              operation,
              request.mediaType,
              String(request.contentLength),
              ...args.value,
              "--deadline-ms",
              String(options.deadlineMs),
            ],
            true,
            signal,
          ),
          signal,
          (lateHandle) => lateHandle.destroy(),
        );
        if (!handle.stdin) throw new BoundaryFailure("unavailable");
        await pumpExact(handle.stdin, request.bytes, request.contentLength, signal);

        const reader = new BoundedReader(
          handle.stdout,
          4 + options.maxHeaderBytes + options.maxOutputBytes + 1,
          signal,
        );
        const header = await readHeader(reader, requestId, options);
        outputBytes = header.contentLength;
        const body = await readBody(reader, header.contentLength);
        await reader.requireEof();
        const exit = await waitForExit(handle, signal);
        if (header.status < 400 && exit.ExitCode !== 0) throw new BoundaryFailure("protocol_error");
        if (header.status >= 400) {
          const code = header.status === 408 ? "timeout" : header.status >= 500 ? "unavailable" : "parser_error";
          return fail({
            code,
            operation,
            requestId,
            status: header.status,
            ...(header.error ? { reason: header.error } : {}),
          });
        }
        return {
          ok: true,
          value: {
            requestId,
            status: header.status,
            contentType: header.contentType,
            headers: header.headers,
            body,
          },
        };
      } catch (error) {
        if (signal.aborted) {
          if (handle) await cancel();
          return fail({ code: request.signal?.aborted ? "cancelled" : "timeout", operation, requestId });
        }
        handle?.destroy();
        return fail({
          code: error instanceof BoundaryFailure ? error.code : "unavailable",
          operation,
          requestId,
        });
      } finally {
        if (abortListening) signal.removeEventListener("abort", onAbort);
        handle?.destroy();
        releaseSlot?.();
      }
    },
  };
}

function validateOptions(options: AttachmentParserClientOptions): void {
  if (!options.containerName || /[\0\r\n]/.test(options.containerName))
    throw new Error("invalid parser container identity");
  for (const [name, value] of Object.entries(options).filter(([name]) => name !== "containerName")) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid parser budget: ${name}`);
  }
  if (options.deadlineMs > MAX_EXEC_DEADLINE_MS) throw new Error("parser deadline exceeds exec client limit");
}

async function probeAttachmentParserMetadata(
  admission: ParserAdmissionQueue,
  transport: AttachmentParserTransport,
  options: AttachmentParserClientOptions,
  callerSignal?: AbortSignal,
): Promise<Result<AttachmentParserMetadata, AttachmentParserMetadataError>> {
  const deadline = AbortSignal.timeout(Math.min(options.deadlineMs, METADATA_MAX_DEADLINE_MS));
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  let release: (() => void) | undefined;
  try {
    release = await admission.acquire(signal);
    signal.throwIfAborted();
    return await readAttachmentParserMetadata(transport, options, callerSignal, deadline);
  } catch {
    if (callerSignal?.aborted) return metadataFailure("cancelled", "metadata_cancelled");
    if (deadline.aborted) return metadataFailure("timeout", "metadata_timeout");
    return metadataFailure("unavailable", "metadata_unavailable");
  } finally {
    release?.();
  }
}

async function readAttachmentParserMetadata(
  transport: AttachmentParserTransport,
  options: AttachmentParserClientOptions,
  callerSignal?: AbortSignal,
  metadataDeadline?: AbortSignal,
): Promise<Result<AttachmentParserMetadata, AttachmentParserMetadataError>> {
  const deadline = metadataDeadline ?? AbortSignal.timeout(Math.min(options.deadlineMs, METADATA_MAX_DEADLINE_MS));
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  const requestId = randomUUID();
  let handle: ParserExecHandle | undefined;
  try {
    signal.throwIfAborted();
    handle = await abortable(
      transport.start(options.containerName, ["python3", CLIENT_PATH, "metadata", requestId], false, signal),
      signal,
      (lateHandle) => lateHandle.destroy(),
    );
    const reader = new BoundedReader(handle.stdout, 4 + options.maxHeaderBytes + METADATA_MAX_BYTES + 1, signal);
    const header = await readHeader(reader, requestId, { ...options, maxOutputBytes: METADATA_MAX_BYTES });
    const body = await readBody(reader, header.contentLength);
    await reader.requireEof();
    const exit = await waitForExit(handle, signal);
    if (exit.ExitCode !== 0) return metadataFailureForExit(exit.ExitCode);
    if (header.status !== 200 || header.contentType !== "application/json" || header.error !== null) {
      return metadataFailure("unavailable", "metadata_unavailable");
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      return metadataFailure("malformed", "metadata_malformed");
    }
    return validateAttachmentParserMetadata(value);
  } catch (error: unknown) {
    if (callerSignal?.aborted) return metadataFailure("cancelled", "metadata_cancelled");
    if (deadline.aborted) return metadataFailure("timeout", "metadata_timeout");
    if (error instanceof BoundaryFailure && handle) {
      let exit: { Running: false; ExitCode: number };
      try {
        exit = await waitForExit(handle, signal);
      } catch {
        if (callerSignal?.aborted) return metadataFailure("cancelled", "metadata_cancelled");
        if (signal.aborted) return metadataFailure("timeout", "metadata_timeout");
        return metadataFailure("unavailable", "metadata_unavailable");
      }
      if (exit.ExitCode !== 0) return metadataFailureForExit(exit.ExitCode);
      return error.code === "output_too_large"
        ? metadataFailure("malformed", "metadata_too_large")
        : metadataFailure("malformed", "metadata_malformed");
    }
    return metadataFailure("unavailable", "metadata_unavailable");
  } finally {
    handle?.destroy();
  }
}

export function validateAttachmentParserMetadata(
  value: unknown,
): Result<AttachmentParserMetadata, AttachmentParserMetadataError> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== METADATA_KEYS.size ||
    !Object.keys(value).every((key) => METADATA_KEYS.has(key))
  )
    return metadataFailure("malformed", "metadata_malformed");
  if (typeof value.name !== "string") return metadataFailure("malformed", "metadata_malformed");
  if (value.name !== ATTACHMENT_PARSER_NAME) return metadataFailure("incompatible", "name_mismatch");
  const version = typeof value.version === "string" ? value.version : undefined;
  const versionMatch = version === undefined ? null : METADATA_VERSION_RE.exec(version);
  if (version === undefined || version.length > METADATA_MAX_VERSION_CHARS || versionMatch?.[0] !== version)
    return metadataFailure("incompatible", "version_malformed");
  if (!Number.isSafeInteger(value.protocolVersion)) return metadataFailure("malformed", "metadata_malformed");
  if (value.protocolVersion !== ATTACHMENT_PARSER_PROTOCOL_VERSION)
    return metadataFailure("incompatible", "protocol_mismatch");
  if (
    typeof value.description !== "string" ||
    Array.from(value.description).length < 1 ||
    Array.from(value.description).length > 256
  )
    return metadataFailure("incompatible", "description_malformed");
  if (value.state !== "ephemeral") return metadataFailure("incompatible", "state_mismatch");
  return {
    ok: true,
    value: value as unknown as AttachmentParserMetadata,
  };
}

function metadataFailure(
  code: AttachmentParserMetadataErrorCode,
  reason: AttachmentParserCompatibilityReason,
): { ok: false; error: AttachmentParserMetadataError } {
  return { ok: false, error: { code, reason } };
}

function metadataFailureForExit(exitCode: number): { ok: false; error: AttachmentParserMetadataError } {
  return exitCode === 2
    ? metadataFailure("incompatible", "metadata_unsupported")
    : metadataFailure("unavailable", "metadata_unavailable");
}

async function readBody(reader: BoundedReader, length: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let remaining = length;
  while (remaining > 0) {
    const chunk = await reader.read(Math.min(64 * 1024, remaining));
    chunks.push(chunk);
    remaining -= chunk.byteLength;
  }
  return Buffer.concat(chunks, length);
}

function requestArgs(
  request: AttachmentParserRequest,
  options: AttachmentParserClientOptions,
): Result<string[], undefined> {
  if (
    !Number.isSafeInteger(request.contentLength) ||
    request.contentLength < 1 ||
    request.contentLength > options.maxInputBytes
  )
    return { ok: false, error: undefined };
  const op = request.operation;
  if (op.operation.startsWith("pdf-") !== (request.mediaType === "application/pdf"))
    return { ok: false, error: undefined };
  const args: string[] = [];
  const add = (name: string, value: number | undefined, max?: number): boolean => {
    if (value === undefined) return true;
    if (!Number.isSafeInteger(value) || value < 1 || (max !== undefined && value > max)) return false;
    args.push(name, String(value));
    return true;
  };
  if (op.operation === "pdf-text") {
    if (!add("--first-page", op.firstPage) || !add("--last-page", op.lastPage)) return { ok: false, error: undefined };
    if (op.firstPage !== undefined && op.lastPage !== undefined && op.firstPage > op.lastPage)
      return { ok: false, error: undefined };
  } else if (op.operation === "pdf-render") {
    if (!add("--page", op.page) || !add("--max-edge", op.maxEdge, options.maxEdge))
      return { ok: false, error: undefined };
  } else if (op.operation === "image-normalize") {
    if (!add("--max-edge", op.maxEdge, options.maxEdge)) return { ok: false, error: undefined };
    if (op.frameIndex !== undefined && op.timeMs !== undefined) return { ok: false, error: undefined };
    const addNonnegative = (name: string, value: number | undefined): boolean => {
      if (value === undefined) return true;
      if (!Number.isSafeInteger(value) || value < 0) return false;
      args.push(name, String(value));
      return true;
    };
    if (!addNonnegative("--frame-index", op.frameIndex) || !addNonnegative("--time-ms", op.timeMs))
      return { ok: false, error: undefined };
    if (op.region) {
      const { x, y, width, height } = op.region;
      if (
        ![x, y, width, height].every(Number.isFinite) ||
        x < 0 ||
        y < 0 ||
        width <= 0 ||
        height <= 0 ||
        x + width > 1 ||
        y + height > 1
      )
        return { ok: false, error: undefined };
      args.push(
        "--region-x",
        String(x),
        "--region-y",
        String(y),
        "--region-width",
        String(width),
        "--region-height",
        String(height),
      );
    }
  }
  return { ok: true, value: args };
}

async function pumpExact(
  output: Writable,
  source: AsyncIterable<Uint8Array>,
  expected: number,
  signal: AbortSignal,
): Promise<void> {
  const iterator = source[Symbol.asyncIterator]();
  let sent = 0;
  try {
    while (true) {
      const next = await abortable(iterator.next(), signal);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0)
        throw new BoundaryFailure("invalid_request");
      sent += next.value.byteLength;
      if (sent > expected) throw new BoundaryFailure("invalid_request");
      if (!output.write(next.value))
        await abortable(new Promise<void>((resolve) => output.once("drain", resolve)), signal);
    }
    if (sent !== expected) throw new BoundaryFailure("invalid_request");
    output.end();
  } finally {
    if (sent !== expected) {
      output.destroy();
      void iterator.return?.().catch(() => undefined);
    }
  }
}

class BoundedReader {
  private readonly iterator: AsyncIterator<unknown>;
  private buffered = new Uint8Array();
  private received = 0;
  private ended = false;

  constructor(
    stream: Readable,
    private readonly limit: number,
    private readonly signal: AbortSignal,
  ) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  async read(length: number): Promise<Uint8Array> {
    while (this.buffered.byteLength < length && !this.ended) await this.pull();
    if (this.buffered.byteLength < length) throw new BoundaryFailure("protocol_error");
    const value = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return value;
  }

  async requireEof(): Promise<void> {
    if (this.buffered.byteLength > 0) throw new BoundaryFailure("protocol_error");
    if (!this.ended) await this.pull();
    if (!this.ended || this.buffered.byteLength > 0) throw new BoundaryFailure("protocol_error");
  }

  private async pull(): Promise<void> {
    const next = await abortable(this.iterator.next(), this.signal);
    if (next.done) {
      this.ended = true;
      return;
    }
    if (!(next.value instanceof Uint8Array)) throw new BoundaryFailure("protocol_error");
    this.received += next.value.byteLength;
    if (this.received > this.limit) throw new BoundaryFailure("output_too_large");
    const merged = new Uint8Array(this.buffered.byteLength + next.value.byteLength);
    merged.set(this.buffered);
    merged.set(next.value, this.buffered.byteLength);
    this.buffered = merged;
  }
}

async function readHeader(
  reader: BoundedReader,
  requestId: string,
  options: AttachmentParserClientOptions,
): Promise<FrameHeader> {
  const prefix = await reader.read(4);
  const length = new DataView(prefix.buffer, prefix.byteOffset, 4).getUint32(0);
  if (length < 1 || length > options.maxHeaderBytes) throw new BoundaryFailure("protocol_error");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await reader.read(length)));
  } catch {
    throw new BoundaryFailure("protocol_error");
  }
  if (!isRecord(value)) throw new BoundaryFailure("protocol_error");
  if (
    !Object.keys(value).every((key) =>
      ["version", "requestId", "status", "contentType", "contentLength", "headers", "error"].includes(key),
    ) ||
    Object.keys(value).length !== 7
  )
    throw new BoundaryFailure("protocol_error");
  if (!Number.isSafeInteger(value.contentLength) || (value.contentLength as number) < 0)
    throw new BoundaryFailure("protocol_error");
  if ((value.contentLength as number) > options.maxOutputBytes) throw new BoundaryFailure("output_too_large");
  const headers = value.headers;
  const error = value.error;
  if (
    value.version !== 1 ||
    value.requestId !== requestId ||
    !Number.isInteger(value.status) ||
    ((value.status as number) !== 200 && ((value.status as number) < 400 || (value.status as number) > 599)) ||
    typeof value.contentType !== "string" ||
    !CONTENT_TYPES.has(value.contentType) ||
    !isRecord(headers) ||
    !Object.entries(headers).every(
      ([name, headerValue]) =>
        FORWARDED_HEADERS.has(name) &&
        typeof headerValue === "string" &&
        headerValue.length <= (name === "X-Sentient-Visual-Metadata" ? options.maxHeaderBytes : 128),
    ) ||
    (error !== null && (typeof error !== "string" || !ERROR_REASON_RE.test(error))) ||
    ((value.status as number) >= 400 && ((value.contentLength as number) !== 0 || typeof error !== "string")) ||
    ((value.status as number) < 400 && error !== null)
  ) {
    throw new BoundaryFailure("protocol_error");
  }
  return value as unknown as FrameHeader;
}

async function cancelRequest(
  transport: AttachmentParserTransport,
  options: AttachmentParserClientOptions,
  requestId: string,
  requestHandle?: ParserExecHandle,
): Promise<void> {
  const cleanupSignal = AbortSignal.timeout(options.cleanupTimeoutMs);
  let cancelHandle: ParserExecHandle | undefined;
  try {
    cancelHandle = await abortable(
      transport.start(options.containerName, ["python3", CLIENT_PATH, "cancel", requestId], false, cleanupSignal),
      cleanupSignal,
      (lateHandle) => lateHandle.destroy(),
    );
    const reader = new BoundedReader(cancelHandle.stdout, 4 + options.maxHeaderBytes + 1, cleanupSignal);
    const header = await readHeader(reader, requestId, { ...options, maxOutputBytes: 0 });
    await reader.requireEof();
    const exit = await waitForExit(cancelHandle, cleanupSignal);
    if (header.status !== 200 || exit.ExitCode !== 0) throw new BoundaryFailure("protocol_error");
  } finally {
    cancelHandle?.destroy();
    requestHandle?.destroy();
  }
}

async function waitForExit(
  handle: ParserExecHandle,
  signal: AbortSignal,
): Promise<{ Running: false; ExitCode: number }> {
  while (true) {
    const state = await abortable(handle.inspect(signal), signal);
    if (!state.Running && state.ExitCode !== null) return state as { Running: false; ExitCode: number };
    await abortable(new Promise<void>((resolve) => setTimeout(resolve, 10)), signal);
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal, onLateResolve?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (settled) {
          try {
            onLateResolve?.(value);
          } catch {
            // Late cleanup cannot change an already-delivered cancellation.
          }
          return;
        }
        settled = true;
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        if (!settled) {
          settled = true;
          reject(error);
        }
      },
    );
    if (signal.aborted) abort();
  });
}

function safeParserReason(reason: string): string {
  return SAFE_PARSER_REASONS.has(reason) ? reason : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
