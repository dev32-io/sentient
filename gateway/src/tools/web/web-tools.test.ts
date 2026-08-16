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
    expect(tools.map((tool) => tool.definition.name)).toEqual(["fetch_content", "read_web_content"]);
    expect(tools.every((tool) => tool.definition.productGroup === "web" && tool.definition.tier === "read")).toBe(true);
    const [fetchTool, readTool] = tools;
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

  test("returns sanitized typed worker failures and validates bounded reads", async () => {
    const tools = createWebTools({
      capability: await capability(),
      config,
      client: {
        fetchContent: async () => ({
          ok: false,
          error: { code: "dns_failure", hostname: "a.test", message: "The hostname could not be resolved." },
        }),
      },
    });
    const [fetchTool, readTool] = tools;
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
