import { lookup } from "node:dns/promises";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { validateFetchUrl } from "./domain-policy.js";

type WorkerErrorCode =
  | "invalid_url"
  | "blocked_domain"
  | "unsupported_port"
  | "dns_failure"
  | "timeout"
  | "oversize"
  | "unsupported_content"
  | "http_error"
  | "cancelled";

export interface WorkerFetchLimits {
  timeoutMs: number;
  maxCompressedBytes: number;
  maxDecompressedBytes: number;
  maxRedirects: number;
}
export interface WorkerFetchDeps {
  fetchImpl?: (input: string | URL | Request, init?: BunFetchRequestInit) => Promise<Response>;
  resolve?: (hostname: string) => Promise<unknown>;
  proxyUrl?: string;
}
export type WorkerFetchResult =
  | {
      ok: true;
      sourceUrl: string;
      finalUrl: string;
      title: string | null;
      byline: string | null;
      contentType: string;
      content: string;
    }
  | {
      ok: false;
      error: { code: WorkerErrorCode; hostname?: string; message: string };
    };

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SUPPORTED_TEXT = new Set(["text/plain", "text/markdown", "application/json", "text/json"]);
const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

function failure(code: WorkerErrorCode, message: string, hostname?: string): WorkerFetchResult {
  return { ok: false, error: { code, message, ...(hostname ? { hostname } : {}) } };
}

async function boundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function decompressBody(
  body: Uint8Array,
  encoding: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  const normalized = encoding.trim().toLocaleLowerCase();
  if (!normalized || normalized === "identity") return body.byteLength <= maxBytes ? body : null;
  const decoder =
    normalized === "gzip"
      ? createGunzip()
      : normalized === "deflate"
        ? createInflate()
        : normalized === "br"
          ? createBrotliDecompress()
          : null;
  if (!decoder) throw new Error("unsupported content encoding");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const raw of Readable.from([body]).pipe(decoder)) {
    if (signal.aborted) {
      decoder.destroy();
      throw signal.reason;
    }
    const chunk = new Uint8Array(raw as Buffer);
    total += chunk.byteLength;
    if (total > maxBytes) {
      decoder.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function extract(contentType: string, body: Uint8Array, finalUrl: string): WorkerFetchResult {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLocaleLowerCase() ?? "";
  const text = new TextDecoder("utf-8", { fatal: false }).decode(body).replaceAll("\0", "");
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
    try {
      const dom = new JSDOM(text, { url: finalUrl });
      const article = new Readability(dom.window.document, { maxElemsToParse: 20_000 }).parse();
      dom.window.close();
      if (!article?.content || !article.textContent?.trim())
        return failure("unsupported_content", "No readable page content was found.");
      const markdown = turndown.turndown(article.content).trim();
      if (!markdown) return failure("unsupported_content", "No readable page content was found.");
      return {
        ok: true,
        sourceUrl: "",
        finalUrl,
        title: article.title?.trim() || null,
        byline: article.byline?.trim() || null,
        contentType: mediaType,
        content: markdown,
      };
    } catch {
      return failure("unsupported_content", "The HTML page could not be extracted safely.");
    }
  }
  if (!SUPPORTED_TEXT.has(mediaType)) return failure("unsupported_content", "This content type is not supported.");
  if (mediaType === "application/json" || mediaType === "text/json") {
    try {
      return {
        ok: true,
        sourceUrl: "",
        finalUrl,
        title: null,
        byline: null,
        contentType: mediaType,
        content: JSON.stringify(JSON.parse(text), null, 2),
      };
    } catch {
      return failure("unsupported_content", "The response was not valid JSON.");
    }
  }
  return { ok: true, sourceUrl: "", finalUrl, title: null, byline: null, contentType: mediaType, content: text.trim() };
}

/** Fetches one URL with manual redirects. Each hop is normalized, policy
 * checked, and DNS-resolved before any request is emitted. */
export async function fetchReadableContent(
  rawUrl: string,
  rules: ReadonlySet<string>,
  limits: WorkerFetchLimits,
  signal: AbortSignal,
  deps: WorkerFetchDeps = {},
): Promise<WorkerFetchResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolve = deps.resolve ?? ((hostname: string) => lookup(hostname, { all: true }));
  const proxyUrl = deps.proxyUrl ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (signal.aborted) return failure("cancelled", "Fetch was cancelled.");
  const source = validateFetchUrl(rawUrl, rules);
  if (!source.ok) return { ok: false, error: source.error };
  if (!deps.fetchImpl && !proxyUrl) return failure("http_error", "The outbound proxy is unavailable.");
  const sourceUrl = source.url.toString();
  let current = source.url;
  const deadline = AbortSignal.timeout(limits.timeoutMs);
  const combined = AbortSignal.any([signal, deadline]);

  for (let redirects = 0; ; redirects += 1) {
    const checked = validateFetchUrl(current.toString(), rules);
    if (!checked.ok) return { ok: false, error: checked.error };
    current = checked.url;
    try {
      await resolve(current.hostname);
    } catch {
      return failure("dns_failure", "The hostname could not be resolved.", current.hostname);
    }
    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        signal: combined,
        headers: {
          accept: "text/html,application/xhtml+xml,application/json,text/plain,text/markdown;q=0.9,*/*;q=0.1",
          "user-agent": "Sentient-Outbound-Worker/1.0",
        },
        ...(proxyUrl ? { proxy: proxyUrl } : {}),
        decompress: false,
      });
    } catch {
      if (signal.aborted) return failure("cancelled", "Fetch was cancelled.");
      if (deadline.aborted) return failure("timeout", "The web fetch timed out.");
      return failure("http_error", "The remote server could not be reached.");
    }
    if (signal.aborted) return failure("cancelled", "Fetch was cancelled.");
    if (deadline.aborted) return failure("timeout", "The web fetch timed out.");
    if (REDIRECTS.has(response.status)) {
      if (redirects >= limits.maxRedirects) return failure("http_error", "The response redirected too many times.");
      const location = response.headers.get("location");
      if (!location) return failure("http_error", "The redirect response had no destination.");
      try {
        current = new URL(location, current);
      } catch {
        return failure("invalid_url", "The redirect destination was invalid.");
      }
      await response.body?.cancel();
      continue;
    }
    if (!response.ok) return failure("http_error", `The remote server returned HTTP ${response.status}.`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limits.maxCompressedBytes)
      return failure("oversize", "The compressed response is too large.");
    try {
      const compressed = await boundedBody(response, limits.maxCompressedBytes, combined);
      if (!compressed) return failure("oversize", "The compressed response is too large.");
      const body = await decompressBody(
        compressed,
        response.headers.get("content-encoding") ?? "identity",
        limits.maxDecompressedBytes,
        combined,
      );
      if (!body) return failure("oversize", "The decompressed response is too large.");
      const extracted = extract(response.headers.get("content-type") ?? "", body, current.toString());
      if (extracted.ok) {
        if (new TextEncoder().encode(extracted.content).byteLength > limits.maxDecompressedBytes)
          return failure("oversize", "The extracted response is too large.");
        extracted.sourceUrl = sourceUrl;
      }
      return extracted;
    } catch {
      if (signal.aborted) return failure("cancelled", "Fetch was cancelled.");
      if (deadline.aborted) return failure("timeout", "The web fetch timed out.");
      return failure("http_error", "The response body could not be read.");
    }
  }
}
