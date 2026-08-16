import { z } from "zod";

export type OutboundFetchErrorCode =
  | "invalid_url"
  | "blocked_domain"
  | "unsupported_port"
  | "dns_failure"
  | "timeout"
  | "oversize"
  | "unsupported_content"
  | "http_error"
  | "worker_unavailable"
  | "cancelled";

export type OutboundFetchResult =
  | {
      ok: true;
      value: {
        sourceUrl: string;
        finalUrl: string;
        title: string | null;
        byline: string | null;
        contentType: string;
        content: string;
      };
    }
  | { ok: false; error: { code: OutboundFetchErrorCode; hostname?: string; message: string } };

const successSchema = z.object({
  ok: z.literal(true),
  sourceUrl: z.string().url().max(4096),
  finalUrl: z.string().url().max(4096),
  title: z.string().max(1000).nullable(),
  byline: z.string().max(1000).nullable(),
  contentType: z.string().max(200),
  content: z.string(),
});
const errorCodeSchema = z.enum([
  "invalid_url",
  "blocked_domain",
  "unsupported_port",
  "dns_failure",
  "timeout",
  "oversize",
  "unsupported_content",
  "http_error",
  "cancelled",
]);
const errorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: errorCodeSchema,
    hostname: z.string().max(253).optional(),
    message: z.string().max(240),
  }),
});

export interface OutboundWorkerClientConfig {
  baseUrl: string;
  timeoutMs: number;
  maxResponseChars: number;
  maxCompressedBytes: number;
  maxDecompressedBytes: number;
  maxRedirects: number;
}

function unavailable(message: string): OutboundFetchResult {
  return { ok: false, error: { code: "worker_unavailable", message } };
}

/** Narrow adapter for the confined worker. This is the gateway's only public-URL
 * dereference seam: it sends validated operation parameters to a loopback
 * service and validates every byte of the external response before use. */
export class OutboundWorkerClient {
  constructor(
    private readonly config: OutboundWorkerClientConfig,
    private readonly fetchImpl: (input: string | URL | Request, init?: BunFetchRequestInit) => Promise<Response> = (
      input,
      init,
    ) => fetch(input, init),
  ) {}

  async fetchContent(url: string, signal: AbortSignal): Promise<OutboundFetchResult> {
    if (signal.aborted) return { ok: false, error: { code: "cancelled", message: "Fetch was cancelled." } };
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await this.fetchImpl(new URL("/v1/fetch", this.config.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url,
          maxCompressedBytes: this.config.maxCompressedBytes,
          maxDecompressedBytes: this.config.maxDecompressedBytes,
          maxRedirects: this.config.maxRedirects,
          timeoutMs: this.config.timeoutMs,
        }),
        signal: combined,
      });
    } catch {
      if (signal.aborted) return { ok: false, error: { code: "cancelled", message: "Fetch was cancelled." } };
      if (timeout.aborted) return { ok: false, error: { code: "timeout", message: "The web fetch timed out." } };
      return unavailable("The web fetch service is unavailable.");
    }

    let raw: unknown;
    try {
      const text = await response.text();
      if (text.length > this.config.maxResponseChars)
        return unavailable("The web fetch service returned too much data.");
      raw = JSON.parse(text);
    } catch {
      return unavailable("The web fetch service returned an invalid response.");
    }
    const parsed = z.union([successSchema, errorSchema]).safeParse(raw);
    if (!parsed.success) return unavailable("The web fetch service returned an invalid response.");
    if (!parsed.data.ok)
      return {
        ok: false,
        error: {
          code: parsed.data.error.code,
          message: parsed.data.error.message,
          ...(parsed.data.error.hostname === undefined ? {} : { hostname: parsed.data.error.hostname }),
        },
      };
    if (!response.ok || parsed.data.content.length > this.config.maxResponseChars) {
      return unavailable("The web fetch service returned an invalid response.");
    }
    return {
      ok: true,
      value: {
        sourceUrl: parsed.data.sourceUrl,
        finalUrl: parsed.data.finalUrl,
        title: parsed.data.title,
        byline: parsed.data.byline,
        contentType: parsed.data.contentType,
        content: parsed.data.content,
      },
    };
  }
}
