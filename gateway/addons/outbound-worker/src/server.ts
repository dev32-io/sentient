import { z } from "zod";
import { loadDomainRules } from "./domain-policy.js";
import { fetchReadableContent } from "./fetch-content.js";
import { searchSearxng } from "./search-searxng.js";

const HARD_MAX_TIMEOUT_MS = 120_000;
const HARD_MAX_COMPRESSED_BYTES = 20_000_000;
const HARD_MAX_DECOMPRESSED_BYTES = 50_000_000;
const requestSchema = z.object({
  url: z.string().min(1).max(4096),
  timeoutMs: z.number().int().min(500).max(HARD_MAX_TIMEOUT_MS),
  maxCompressedBytes: z.number().int().min(1024).max(HARD_MAX_COMPRESSED_BYTES),
  maxDecompressedBytes: z.number().int().min(1024).max(HARD_MAX_DECOMPRESSED_BYTES),
  maxRedirects: z.number().int().min(0).max(10),
});
const domainSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9.-]+$/);
const searchSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    count: z.number().int().min(1).max(20),
    recency: z.enum(["day", "week", "month", "year"]).optional(),
    includeDomains: z.array(domainSchema).max(10).default([]),
    excludeDomains: z.array(domainSchema).max(10).default([]),
  })
  .refine((v) => !v.includeDomains.some((d) => v.excludeDomains.includes(d)), "conflicting domains");

const bundled = process.env.DANGEROUS_DOMAINS_BUNDLED ?? new URL("dangerous-domains.txt", import.meta.url).pathname;
const additions = process.env.DANGEROUS_DOMAINS_ADDITIONS;
const rules = await loadDomainRules(bundled, additions);

Bun.serve({
  hostname: "0.0.0.0",
  port: Number(process.env.PORT ?? 8090),
  idleTimeout: 125,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health")
      return Response.json({ status: "ok", service: "outbound-worker" });
    if (request.method !== "POST" || (url.pathname !== "/v1/fetch" && url.pathname !== "/v1/search"))
      return new Response("not found", { status: 404 });
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > 16_384)
      return Response.json(
        { ok: false, error: { code: "invalid_url", message: "Request too large." } },
        { status: 413 },
      );
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ ok: false, error: { code: "invalid_url", message: "Invalid request." } }, { status: 400 });
    }
    const controller = new AbortController();
    request.signal.addEventListener("abort", () => controller.abort(), { once: true });
    if (url.pathname === "/v1/search") {
      const parsed = searchSchema.safeParse(body);
      if (!parsed.success)
        return Response.json(
          { ok: false, error: { code: "search_unavailable", message: "Invalid search operation." } },
          { status: 400 },
        );
      server.timeout(request, 35);
      const result = await searchSearxng(parsed.data, controller.signal);
      return Response.json(result, { status: result.ok ? 200 : 502, headers: { "cache-control": "no-store" } });
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success)
      return Response.json(
        { ok: false, error: { code: "invalid_url", message: "Invalid fetch operation." } },
        { status: 400 },
      );
    server.timeout(request, Math.ceil(parsed.data.timeoutMs / 1000) + 5);
    const result = await fetchReadableContent(parsed.data.url, rules, parsed.data, controller.signal);
    return Response.json(result, { status: result.ok ? 200 : 422, headers: { "cache-control": "no-store" } });
  },
});
