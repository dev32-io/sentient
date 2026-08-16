import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "../../access/capability.js";
import { createWebTools } from "./web-tools.js";

const roots: string[] = [];
const config = {
  worker: {
    baseUrl: "http://127.0.0.1:8090",
    timeoutMs: 100,
    maxResponseChars: 10000,
    maxCompressedBytes: 1000,
    maxDecompressedBytes: 9000,
    maxRedirects: 3,
  },
  artifacts: {
    ttlMs: 1000,
    maxEntries: 5,
    maxBytes: 100000,
    maxSliceChars: 100,
    maxPassages: 3,
    passageContextChars: 10,
  },
  initialExtractChars: 20,
  search: {
    maxResults: 5,
    sourceCount: 3,
    passageBudgetChars: 300,
    summary: {
      fallbackModel: "deepseek-v4-flash:cloud",
      deadlineMs: 1000,
      maxInputChars: 2000,
      maxOutputTokens: 200,
      maxAnswerChars: 500,
    },
  },
};
async function capability(user = "u_aaaaaaaa" as const): Promise<Capability> {
  const rootPath = await mkdtemp(join(tmpdir(), "web-tools-"));
  roots.push(rootPath);
  return { ownerUserId: user, rootPath, resource: "web-artifact", role: "adult" };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("native web tools", () => {
  test("exist independently of MCP discovery and never return the complete extraction", async () => {
    const full = "complete extraction must stay outside conversation";
    const tools = createWebTools({
      capability: await capability(),
      config,
      client: {
        search: async () => ({ ok: true as const, value: [] }),
        fetchContent: async () => ({
          ok: true,
          value: {
            sourceUrl: "https://a.test/",
            finalUrl: "https://a.test/final",
            title: "Title",
            byline: "Author",
            contentType: "text/plain",
            content: full,
          },
        }),
      },
    });
    expect(tools.map((tool) => tool.definition.name)).toEqual(["web_search", "fetch_content", "read_web_content"]);
    expect(tools.every((tool) => tool.definition.productGroup === "web" && tool.definition.tier === "read")).toBe(true);
    const [, fetchTool, readTool] = tools;
    if (!fetchTool || !readTool) throw new Error("web tools missing");
    const fetched = await fetchTool.run({ url: "https://a.test" }, { signal: new AbortController().signal });
    expect(fetched.isError).toBe(false);
    expect(fetched.content).not.toContain(full);
    const payload = JSON.parse(fetched.content) as {
      artifact_id: string;
      content: string;
      total_chars: number;
      continuation: string;
    };
    expect(payload.content).toBe(full.slice(0, 20));
    expect(payload.total_chars).toBe(full.length);
    expect(payload.continuation).toContain("read_web_content");

    const read = await readTool.run(
      { artifact_id: payload.artifact_id, offset: 20, limit: 10 },
      { signal: new AbortController().signal },
    );
    expect(JSON.parse(read.content)).toMatchObject({
      content: full.slice(20, 30),
      returned_range: { start: 20, end: 30 },
      total_chars: full.length,
    });
  });

  test("short fetches still return only a partial extract with continuation guidance", async () => {
    const full = "short page";
    const tools = createWebTools({
      capability: await capability(),
      config,
      client: {
        search: async () => ({ ok: true as const, value: [] }),
        fetchContent: async () => ({
          ok: true,
          value: {
            sourceUrl: "https://short.test/",
            finalUrl: "https://short.test/",
            title: "Short",
            byline: null,
            contentType: "text/plain",
            content: full,
          },
        }),
      },
    });
    const fetchTool = tools[1];
    if (!fetchTool) throw new Error("fetch tool missing");
    const response = await fetchTool.run({ url: "https://short.test/" }, { signal: new AbortController().signal });
    const payload = JSON.parse(response.content) as {
      artifact_id: string;
      content: string;
      returned_range: { start: number; end: number };
      continuation: string;
    };
    expect(response.content).not.toContain(full);
    expect(payload.content.length).toBeLessThan(full.length);
    expect(payload.returned_range.end).toBe(payload.content.length);
    expect(payload.continuation).toContain("read_web_content");
  });

  test("grounded search preserves partial fetches, scans passages, and returns artifact references", async () => {
    const seenPrompts: string[] = [];
    const fullPage = "UNTRUSTED grounded body that must not be returned complete";
    const tools = createWebTools({
      capability: await capability(),
      config,
      screen: (text) => text.replaceAll("UNTRUSTED", "[screened]"),
      summaryPrompt: "Summarize sources as JSON.",
      provider: {
        async *stream(req) {
          seenPrompts.push(req.messages[0]?.content ?? "");
          yield { type: "text" as const, content: '{"answer":"Useful [1] and snippet [2]","citations":[1,2]}' };
          yield { type: "done" as const, finishReason: "stop" };
        },
      },
      client: {
        search: async () => ({
          ok: true,
          value: [
            { title: "One", url: "https://one.test/", snippet: "first", publishedAt: null },
            { title: "Two", url: "https://two.test/", snippet: "UNTRUSTED fallback", publishedAt: null },
          ],
        }),
        fetchContent: async (url) =>
          url.includes("one")
            ? {
                ok: true,
                value: {
                  sourceUrl: url,
                  finalUrl: url,
                  title: "One",
                  byline: null,
                  contentType: "text/plain",
                  content: fullPage,
                },
              }
            : { ok: false, error: { code: "timeout", message: "The web fetch timed out." } },
      },
    });
    const search = tools[0];
    if (!search) throw new Error("web search tool missing");
    const response = await search.run(
      { query: "current fact", mode: "grounded", result_count: 2 },
      { signal: new AbortController().signal },
    );
    const payload = JSON.parse(response.content) as {
      answer: string;
      sources: Array<{
        status: string;
        artifact_id?: string;
        total_chars?: number;
        returned_range?: { start: number; end: number };
        continuation?: string;
      }>;
      research_id: string;
    };
    expect(payload.answer).toBe("Useful [1] and snippet [2]");
    expect(payload.sources).toMatchObject([{ status: "fetched" }, { status: "timeout" }]);
    expect(payload.sources[0]?.artifact_id).toMatch(/^wa_/);
    expect(payload.sources[0]?.total_chars).toBe(fullPage.length);
    expect(payload.sources[0]?.returned_range?.end).toBeLessThan(fullPage.length);
    expect(payload.sources[0]?.continuation).toContain("read_web_content");
    expect(payload.research_id).toMatch(/^wr_/);
    expect(response.content).not.toContain(fullPage);
    expect(seenPrompts[0]).toContain("[screened] grounded body");
    expect(seenPrompts[0]).toContain("[screened] fallback");
    expect(seenPrompts[0]).not.toContain("[screened] grounded body that must not be returned complete");
    expect(seenPrompts[0]).toContain("Returned range: 0-");
    expect(seenPrompts[0]).toContain("Continuation: Call read_web_content");
  });

  test("returns sanitized typed worker failures and validates bounded reads", async () => {
    const tools = createWebTools({
      capability: await capability(),
      config,
      client: {
        search: async () => ({ ok: true as const, value: [] }),
        fetchContent: async () => ({
          ok: false,
          error: { code: "dns_failure", hostname: "a.test", message: "The hostname could not be resolved." },
        }),
      },
    });
    const [, fetchTool, readTool] = tools;
    if (!fetchTool || !readTool) throw new Error("web tools missing");
    const failure = await fetchTool.run({ url: "https://a.test" }, { signal: new AbortController().signal });
    expect(failure).toEqual({
      content: '{"error":"dns_failure","message":"The hostname could not be resolved.","hostname":"a.test"}',
      isError: true,
    });
    expect(readTool.validate?.({ artifact_id: "wa_bad", offset: 0, limit: 101 })).toMatchObject({ isError: true });
    expect(readTool.validate?.({ artifact_id: "wa_bad", passage: "needle", offset: 0 })).toMatchObject({
      isError: true,
    });
  });
});
