import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import {
  canonicalDenyRules,
  canonicalDomain,
  domainIsDenied,
  validateFetchUrl,
} from "../../../addons/outbound-worker/src/domain-policy.js";
import { fetchReadableContent } from "../../../addons/outbound-worker/src/fetch-content.js";
import { searchSearxng } from "../../../addons/outbound-worker/src/search-searxng.js";

const limits = { timeoutMs: 1000, maxCompressedBytes: 1000, maxDecompressedBytes: 5000, maxRedirects: 3 };
const rules = canonicalDenyRules(["example.test", "xn--bcher-kva.test"]);
const resolve = async () => [{}];

describe("outbound worker SearXNG boundary", () => {
  test("maps recency/domains/count and rejects malformed or excluded results", async () => {
    let requested: URL | undefined;
    const result = await searchSearxng(
      {
        query: "current news",
        count: 2,
        recency: "week",
        includeDomains: ["Example.COM"],
        excludeDomains: ["bad.example.com"],
      },
      new AbortController().signal,
      {
        baseUrl: "http://searxng:8080",
        fetchImpl: async (input) => {
          requested = new URL(input.toString());
          return Response.json({
            results: [
              { title: "Good", url: "https://example.com/a", content: "snippet", publishedDate: "today" },
              { title: "Excluded", url: "https://bad.example.com/b", content: "bad" },
              { title: 42, url: "https://example.com/c", content: "invalid" },
              { title: "Second", url: "https://www.example.com/d", content: "second" },
              { title: "Capped", url: "https://example.com/e", content: "third" },
            ],
          });
        },
      },
    );
    expect(result).toMatchObject({ ok: true, results: [{ title: "Good" }, { title: "Second" }] });
    expect(requested?.searchParams.get("time_range")).toBe("week");
    expect(requested?.searchParams.get("q")).toContain("site:example.com -site:bad.example.com");
  });

  test("cancels a missing or malformed-length SearXNG stream at the byte cap", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(600_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await searchSearxng(
      { query: "q", count: 1, includeDomains: [], excludeDomains: [] },
      new AbortController().signal,
      {
        fetchImpl: async () => new Response(body, { headers: { "content-length": "malformed" } }),
      },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "search_unavailable" } });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(3);
  });

  test("maps invalid SearXNG responses and cancellation to bounded failures", async () => {
    const bad = await searchSearxng(
      { query: "q", count: 1, includeDomains: [], excludeDomains: [] },
      new AbortController().signal,
      { fetchImpl: async () => Response.json({ unexpected: true }) },
    );
    expect(bad).toMatchObject({ ok: false, error: { code: "search_unavailable" } });
    const ctl = new AbortController();
    ctl.abort();
    expect(
      await searchSearxng({ query: "q", count: 1, includeDomains: [], excludeDomains: [] }, ctl.signal),
    ).toMatchObject({ ok: false, error: { code: "cancelled" } });
  });
});

describe("outbound worker URL and domain boundary", () => {
  test("canonicalizes case, trailing dots, and IDNA and applies suffix denial", () => {
    expect(canonicalDomain("BÜCHER.TEST.")).toBe("xn--bcher-kva.test");
    expect(domainIsDenied("Sub.Example.Test.", rules)).toBe(true);
    expect(domainIsDenied("notexample.test", rules)).toBe(false);
    expect(validateFetchUrl("https://SUB.EXAMPLE.TEST./x", rules)).toMatchObject({
      ok: false,
      error: { code: "blocked_domain", hostname: "sub.example.test" },
    });
  });

  test("rejects credentials, unsupported schemes, and nonstandard ports", () => {
    expect(validateFetchUrl("file:///etc/passwd", rules)).toMatchObject({ ok: false, error: { code: "invalid_url" } });
    expect(validateFetchUrl("https://user:pass@allowed.test", rules)).toMatchObject({
      ok: false,
      error: { code: "invalid_url" },
    });
    expect(validateFetchUrl("http://allowed.test:8080", rules)).toMatchObject({
      ok: false,
      error: { code: "unsupported_port" },
    });
  });

  test("maps DNS failure before issuing a request", async () => {
    let calls = 0;
    const result = await fetchReadableContent("https://allowed.test", rules, limits, new AbortController().signal, {
      resolve: async () => {
        throw new Error("private resolver detail");
      },
      fetchImpl: async () => {
        calls++;
        return new Response();
      },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "dns_failure", hostname: "allowed.test" } });
    expect(calls).toBe(0);
  });

  test("passes public traffic through the configured egress proxy", async () => {
    let observedProxy: string | URL | object | undefined;
    const result = await fetchReadableContent("https://allowed.test", rules, limits, new AbortController().signal, {
      resolve,
      proxyUrl: "http://sentient-egress-proxy:3128",
      fetchImpl: async (_url, init) => {
        observedProxy = init?.proxy;
        return new Response("ok", { headers: { "content-type": "text/plain" } });
      },
    });
    expect(result).toMatchObject({ ok: true });
    expect(observedProxy).toBe("http://sentient-egress-proxy:3128");
  });

  test("checks every redirect before following it", async () => {
    let calls = 0;
    const result = await fetchReadableContent("https://allowed.test", rules, limits, new AbortController().signal, {
      resolve,
      fetchImpl: async () => {
        calls++;
        return new Response(null, { status: 302, headers: { location: "https://Sub.Example.Test./secret" } });
      },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "blocked_domain", hostname: "sub.example.test" } });
    expect(calls).toBe(1);
  });

  test("extracts readable HTML as Markdown and handles JSON", async () => {
    const html = `<html><head><title>Example</title></head><body><article><h1>Useful heading</h1><p>${"Readable content. ".repeat(40)}</p></article></body></html>`;
    const htmlResult = await fetchReadableContent(
      "https://allowed.test/a",
      rules,
      limits,
      new AbortController().signal,
      {
        resolve,
        fetchImpl: async () => new Response(html, { headers: { "content-type": "text/html" } }),
      },
    );
    expect(htmlResult).toMatchObject({ ok: true, title: "Example", contentType: "text/html" });
    if (htmlResult.ok) expect(htmlResult.content).toContain("# Useful heading");

    const jsonResult = await fetchReadableContent(
      "https://allowed.test/j",
      rules,
      limits,
      new AbortController().signal,
      {
        resolve,
        fetchImpl: async () => new Response('{"safe":true}', { headers: { "content-type": "application/json" } }),
      },
    );
    expect(jsonResult).toMatchObject({ ok: true, content: '{\n  "safe": true\n}' });
  });

  test("bounds declared compressed size and streamed decompressed size", async () => {
    const compressed = gzipSync("x".repeat(10_000));
    expect(compressed.byteLength).toBeLessThan(1000);
    const declared = await fetchReadableContent("https://allowed.test", rules, limits, new AbortController().signal, {
      resolve,
      fetchImpl: async () =>
        new Response("small", { headers: { "content-type": "text/plain", "content-length": "1001" } }),
    });
    expect(declared).toMatchObject({ ok: false, error: { code: "oversize" } });
    const expanded = await fetchReadableContent("https://allowed.test", rules, limits, new AbortController().signal, {
      resolve,
      fetchImpl: async () =>
        new Response(compressed, { headers: { "content-type": "text/plain", "content-encoding": "gzip" } }),
    });
    expect(expanded).toMatchObject({ ok: false, error: { code: "oversize" } });
  });

  test("maps unsupported content, cancellation, and timeout to typed errors", async () => {
    const unsupported = await fetchReadableContent(
      "https://allowed.test",
      rules,
      limits,
      new AbortController().signal,
      {
        resolve,
        fetchImpl: async () => new Response("binary", { headers: { "content-type": "application/pdf" } }),
      },
    );
    expect(unsupported).toMatchObject({ ok: false, error: { code: "unsupported_content" } });

    const cancelled = new AbortController();
    cancelled.abort();
    const cancelResult = await fetchReadableContent("https://allowed.test", rules, limits, cancelled.signal, {
      resolve,
      fetchImpl: async () => {
        await Bun.sleep(20);
        return new Response();
      },
    });
    expect(cancelResult).toMatchObject({ ok: false, error: { code: "cancelled" } });

    const timeoutResult = await fetchReadableContent(
      "https://allowed.test",
      rules,
      { ...limits, timeoutMs: 5 },
      new AbortController().signal,
      {
        resolve,
        fetchImpl: async () => {
          await Bun.sleep(20);
          return new Response();
        },
      },
    );
    expect(timeoutResult).toMatchObject({ ok: false, error: { code: "timeout" } });
  });
});
