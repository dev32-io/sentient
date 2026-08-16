import { domainToASCII } from "node:url";
import { readBoundedResponseText } from "./bounded-response.js";

export type SearchRecency = "day" | "week" | "month" | "year";
export interface SearxSearchRequest {
  query: string;
  count: number;
  recency?: SearchRecency;
  includeDomains: string[];
  excludeDomains: string[];
}
export interface SearxSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
}
export type SearxSearchResponse =
  | { ok: true; results: SearxSearchResult[] }
  | { ok: false; error: { code: "search_unavailable" | "cancelled"; message: string } };

const MAX_SEARX_RESULTS = 20;
const MAX_RESPONSE_BYTES = 1_000_000;

function canonicalDomain(raw: string): string | null {
  const value = domainToASCII(raw.trim().replace(/^\.+|\.+$/g, "")).toLowerCase();
  if (!value || value.length > 253 || value.split(".").some((label) => !label || label.length > 63)) return null;
  return value;
}
function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Internal SearXNG JSON operation. SearXNG owns metasearch egress; this worker
 * remains the only gateway-visible execution surface and validates its output. */
export async function searchSearxng(
  input: SearxSearchRequest,
  signal: AbortSignal,
  deps: {
    fetchImpl?: (input: string | URL | Request, init?: BunFetchRequestInit) => Promise<Response>;
    baseUrl?: string;
  } = {},
): Promise<SearxSearchResponse> {
  if (signal.aborted) return { ok: false, error: { code: "cancelled", message: "Search was cancelled." } };
  const include = input.includeDomains.map(canonicalDomain);
  const exclude = input.excludeDomains.map(canonicalDomain);
  if (include.some((v) => v === null) || exclude.some((v) => v === null))
    return { ok: false, error: { code: "search_unavailable", message: "Invalid search operation." } };
  const included = include.filter((domain): domain is string => domain !== null);
  const excluded = exclude.filter((domain): domain is string => domain !== null);
  const query = [input.query, ...included.map((d) => `site:${d}`), ...excluded.map((d) => `-site:${d}`)].join(" ");
  const url = new URL("/search", deps.baseUrl ?? process.env.SEARXNG_URL ?? "http://sentient-searxng:8080");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("categories", "general");
  if (input.recency) url.searchParams.set("time_range", input.recency);
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(url, { signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("bad status");
    const text = await readBoundedResponseText(response, MAX_RESPONSE_BYTES, signal);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { results?: unknown }).results))
      throw new Error("schema");
    const out: SearxSearchResult[] = [];
    for (const raw of (parsed as { results: unknown[] }).results) {
      if (!raw || typeof raw !== "object") continue;
      const v = raw as Record<string, unknown>;
      if (typeof v.title !== "string" || typeof v.url !== "string" || typeof v.content !== "string") continue;
      if (v.title.length > 1000 || v.url.length > 4096 || v.content.length > 10_000) continue;
      let resultUrl: URL;
      try {
        resultUrl = new URL(v.url);
      } catch {
        continue;
      }
      if (resultUrl.protocol !== "http:" && resultUrl.protocol !== "https:") continue;
      const host = canonicalDomain(resultUrl.hostname);
      if (
        !host ||
        (included.length && !included.some((d) => hostMatches(host, d))) ||
        excluded.some((d) => hostMatches(host, d))
      )
        continue;
      const published = v.publishedDate ?? v.published_date;
      out.push({
        title: v.title.trim(),
        url: resultUrl.toString(),
        snippet: v.content.trim(),
        publishedAt: typeof published === "string" && published.length <= 100 ? published : null,
      });
      if (out.length >= Math.min(input.count, MAX_SEARX_RESULTS)) break;
    }
    return { ok: true, results: out };
  } catch {
    if (signal.aborted) return { ok: false, error: { code: "cancelled", message: "Search was cancelled." } };
    return { ok: false, error: { code: "search_unavailable", message: "Web search is unavailable." } };
  }
}
