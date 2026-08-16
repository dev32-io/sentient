import { z } from "zod";
import { ResponseTooLargeError, readBoundedResponseText } from "./bounded-response.js";

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

export type SearchRecency = "day" | "week" | "month" | "year";
export interface OutboundSearchItem {
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
}
export type OutboundSearchResult =
  | { ok: true; value: OutboundSearchItem[] }
  | { ok: false; error: { code: "search_unavailable" | "cancelled"; message: string } };

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
const searchSuccessSchema = z.object({
  ok: z.literal(true),
  results: z
    .array(
      z.object({
        title: z.string().max(1000),
        url: z.string().url().max(4096),
        snippet: z.string().max(10_000),
        publishedAt: z.string().max(100).nullable(),
      }),
    )
    .max(20),
});
const searchErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.enum(["search_unavailable", "cancelled"]), message: z.string().max(240) }),
});
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

  async search(
    input: {
      query: string;
      count: number;
      recency?: SearchRecency;
      includeDomains: string[];
      excludeDomains: string[];
    },
    signal: AbortSignal,
  ): Promise<OutboundSearchResult> {
    if (signal.aborted) return { ok: false, error: { code: "cancelled", message: "Search was cancelled." } };
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    try {
      const response = await this.fetchImpl(new URL("/v1/search", this.config.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.any([signal, timeout]),
      });
      const text = await readBoundedResponseText(
        response,
        this.config.maxResponseChars,
        AbortSignal.any([signal, timeout]),
      );
      const parsed = z.union([searchSuccessSchema, searchErrorSchema]).safeParse(JSON.parse(text));
      if (!parsed.success) throw new Error("schema");
      if (!parsed.data.ok) return { ok: false, error: parsed.data.error };
      if (!response.ok || parsed.data.results.length > input.count) throw new Error("invalid cap");
      return { ok: true, value: parsed.data.results };
    } catch {
      if (signal.aborted) return { ok: false, error: { code: "cancelled", message: "Search was cancelled." } };
      return {
        ok: false,
        error: {
          code: "search_unavailable",
          message: timeout.aborted ? "Web search timed out." : "Web search is unavailable.",
        },
      };
    }
  }

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
      const text = await readBoundedResponseText(response, this.config.maxResponseChars, combined);
      raw = JSON.parse(text);
    } catch (error) {
      if (signal.aborted) return { ok: false, error: { code: "cancelled", message: "Fetch was cancelled." } };
      if (timeout.aborted) return { ok: false, error: { code: "timeout", message: "The web fetch timed out." } };
      if (error instanceof ResponseTooLargeError) return unavailable("The web fetch service returned too much data.");
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
