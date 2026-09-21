import { type AttachmentRef, attachmentRefSchema } from "@sentient/protocol";

export class AttachmentsRestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`attachments REST error: ${code} (${status})`);
    this.name = "AttachmentsRestError";
  }
}

export interface AttachmentUploadRequest {
  readonly sendAttemptId: string;
  readonly fileIdentity: string;
  readonly displayName: string;
  readonly contentType: string;
  readonly blob: Blob;
  readonly signal?: AbortSignal;
  readonly onProgress?: (loaded: number, total: number) => void;
}

export interface AttachmentsRest {
  upload(request: AttachmentUploadRequest): Promise<AttachmentRef>;
  preview(attachmentId: string, signal?: AbortSignal): Promise<Blob>;
  download(attachmentId: string, signal?: AbortSignal): Promise<Blob>;
  delete(attachmentId: string, signal?: AbortSignal): Promise<void>;
}

export interface AttachmentsRestConfig {
  readonly baseUrl: string;
  readonly token: () => string;
  readonly fetchFn?: typeof globalThis.fetch;
  readonly createXhr?: () => XMLHttpRequest;
  readonly timeoutMs?: number;
}

function errorCode(body: unknown): string {
  return typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
    ? body.error
    : "unknown-error";
}

export function createAttachmentsRest(config: AttachmentsRestConfig): AttachmentsRest {
  const fetchFn = config.fetchFn ?? globalThis.fetch;
  const createXhr = config.createXhr ?? (() => new XMLHttpRequest());
  const timeoutMs = config.timeoutMs ?? 120_000;
  const itemUrl = (id: string) => `${config.baseUrl}/attachments/${encodeURIComponent(id)}`;
  const read = async (url: string, signal?: AbortSignal): Promise<Blob> => {
    let response: Response;
    try {
      response = await fetchFn(url, {
        headers: { authorization: `Bearer ${config.token()}` },
        signal: boundedSignal(signal),
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new AttachmentsRestError(0, "network-error");
    }
    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      throw new AttachmentsRestError(response.status, errorCode(body));
    }
    return response.blob();
  };
  const boundedSignal = (signal?: AbortSignal) =>
    signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

  return {
    upload(request) {
      const query = new URLSearchParams({
        sendAttemptId: request.sendAttemptId,
        fileIdentity: request.fileIdentity,
        displayName: request.displayName,
        contentType: request.contentType,
      });
      return new Promise<AttachmentRef>((resolve, reject) => {
        const xhr = createXhr();
        const abort = () => xhr.abort();
        xhr.open("POST", `${config.baseUrl}/attachments?${query}`);
        xhr.timeout = timeoutMs;
        xhr.setRequestHeader("authorization", `Bearer ${config.token()}`);
        xhr.setRequestHeader("content-type", request.contentType);
        xhr.upload.onprogress = (event) =>
          request.onProgress?.(event.loaded, event.lengthComputable ? event.total : request.blob.size);
        xhr.onerror = () => reject(new AttachmentsRestError(0, "network-error"));
        xhr.ontimeout = () => reject(new AttachmentsRestError(0, "timeout"));
        xhr.onabort = () => reject(new DOMException("Attachment upload cancelled", "AbortError"));
        xhr.onload = () => {
          let body: unknown;
          try {
            body = JSON.parse(xhr.responseText);
          } catch {
            reject(new AttachmentsRestError(xhr.status, "invalid-json"));
            return;
          }
          if (xhr.status < 200 || xhr.status >= 300) {
            reject(new AttachmentsRestError(xhr.status, errorCode(body)));
            return;
          }
          const parsed = attachmentRefSchema.safeParse(body);
          if (!parsed.success) reject(new AttachmentsRestError(xhr.status, "invalid-response"));
          else resolve(parsed.data);
        };
        request.signal?.addEventListener("abort", abort, { once: true });
        if (request.signal?.aborted) abort();
        else xhr.send(request.blob);
      });
    },

    preview(attachmentId, signal) {
      return read(`${itemUrl(attachmentId)}/preview`, signal);
    },

    download(attachmentId, signal) {
      return read(itemUrl(attachmentId), signal);
    },

    async delete(attachmentId, signal) {
      let response: Response;
      try {
        response = await fetchFn(itemUrl(attachmentId), {
          method: "DELETE",
          headers: { authorization: `Bearer ${config.token()}` },
          signal: boundedSignal(signal),
        });
      } catch (cause) {
        if (signal?.aborted) throw cause;
        throw new AttachmentsRestError(0, "network-error");
      }
      if (!response.ok) {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        throw new AttachmentsRestError(response.status, errorCode(body));
      }
    },
  };
}
