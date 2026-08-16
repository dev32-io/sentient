import { z } from "zod";
import { loadDomainRules } from "./domain-policy.js";
import { fetchReadableContent } from "./fetch-content.js";

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
    if (request.method !== "POST" || url.pathname !== "/v1/fetch") return new Response("not found", { status: 404 });
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
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success)
      return Response.json(
        { ok: false, error: { code: "invalid_url", message: "Invalid fetch operation." } },
        { status: 400 },
      );
    const controller = new AbortController();
    request.signal.addEventListener("abort", () => controller.abort(), { once: true });
    server.timeout(request, Math.ceil(parsed.data.timeoutMs / 1000) + 5);
    const result = await fetchReadableContent(parsed.data.url, rules, parsed.data, controller.signal);
    return Response.json(result, { status: result.ok ? 200 : 422, headers: { "cache-control": "no-store" } });
  },
});
