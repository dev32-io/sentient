import { describe, expect, test } from "bun:test";
import { OutboundWorkerClient } from "./outbound-worker-client.js";

const config = {
  baseUrl: "http://127.0.0.1:8090",
  timeoutMs: 10,
  maxResponseChars: 1000,
  maxCompressedBytes: 100,
  maxDecompressedBytes: 500,
  maxRedirects: 2,
};

function oversizedStream(contentLength?: string): { response: Response; cancelled: Promise<void> } {
  let markCancelled: () => void = () => undefined;
  const cancelled = new Promise<void>((resolve) => {
    markCancelled = resolve;
  });
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent++;
      controller.enqueue(new Uint8Array(600));
      if (sent >= 4) controller.close();
    },
    cancel() {
      markCancelled();
    },
  });
  return {
    response: new Response(body, { headers: contentLength === undefined ? {} : { "content-length": contentLength } }),
    cancelled,
  };
}

describe("OutboundWorkerClient boundary", () => {
  test("validates successful external responses", async () => {
    const client = new OutboundWorkerClient(config, async () =>
      Response.json({
        ok: true,
        sourceUrl: "https://a.test/",
        finalUrl: "https://a.test/final",
        title: null,
        byline: null,
        contentType: "text/plain",
        content: "bounded",
      }),
    );
    const result = await client.fetchContent("https://a.test", new AbortController().signal);
    expect(result).toMatchObject({ ok: true, value: { content: "bounded" } });
  });

  test("maps invalid schemas and outages without leaking internal errors", async () => {
    const invalidClient = new OutboundWorkerClient(config, async () =>
      Response.json({ ok: true, content: "missing metadata" }),
    );
    expect(await invalidClient.fetchContent("https://a.test", new AbortController().signal)).toEqual({
      ok: false,
      error: { code: "worker_unavailable", message: "The web fetch service returned an invalid response." },
    });

    const outageClient = new OutboundWorkerClient(config, async () => {
      throw new Error("ECONNREFUSED at secret-internal-host");
    });
    const outage = await outageClient.fetchContent("https://a.test", new AbortController().signal);
    expect(outage).toEqual({
      ok: false,
      error: { code: "worker_unavailable", message: "The web fetch service is unavailable." },
    });
    expect(JSON.stringify(outage)).not.toContain("secret-internal-host");
  });

  test("cancels streamed fetch and search responses as soon as byte limits are exceeded", async () => {
    const fetchBody = oversizedStream();
    const fetchClient = new OutboundWorkerClient(config, async () => fetchBody.response);
    expect(await fetchClient.fetchContent("https://a.test", new AbortController().signal)).toMatchObject({
      ok: false,
      error: { code: "worker_unavailable" },
    });
    await fetchBody.cancelled;

    const searchBody = oversizedStream("not-a-number");
    const searchClient = new OutboundWorkerClient(config, async () => searchBody.response);
    expect(
      await searchClient.search(
        { query: "q", count: 1, includeDomains: [], excludeDomains: [] },
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: false, error: { code: "search_unavailable" } });
    await searchBody.cancelled;
  });

  test("distinguishes caller cancellation from bounded timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await new OutboundWorkerClient(config).fetchContent("https://a.test", controller.signal)).toMatchObject({
      ok: false,
      error: { code: "cancelled" },
    });

    const timeoutClient = new OutboundWorkerClient(config, async (_input, init) => {
      await new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
      return new Response();
    });
    expect(await timeoutClient.fetchContent("https://a.test", new AbortController().signal)).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
  });
});
