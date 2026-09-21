import { describe, expect, it } from "bun:test";
import type { AttachmentInspectionDeps } from "../attachments/inspection.js";
import type { AttachmentManifestRecord } from "../store/session-store.js";
import { createAttachmentTools, parseDirectVisionMarker } from "./attachment-tools.js";

const ID = `att_${"b".repeat(32)}`;
const LIMITS = { maxPages: 2, maxTextBytes: 100, maxTextChars: 100, maxQuestionChars: 40, maxEdge: 800 };

function deps(status: AttachmentManifestRecord["status"] = "ready"): AttachmentInspectionDeps {
  const ref: AttachmentManifestRecord = {
    attachmentId: ID,
    ownerUserId: "u_owner",
    sendAttemptId: "send",
    fileIdentity: "file",
    displayName: "note.txt",
    contentType: "text/plain",
    mediaKind: "text",
    size: 5,
    sha256: "hash",
    stagedAt: 1,
    expiresAt: 2,
    status,
    sessionId: status === "staged" ? null : "session",
    entrySeq: status === "staged" ? null : 1,
  };
  return {
    capability: { ownerUserId: "u_owner", resource: "attachment-store", rootPath: "/synthetic" },
    sessionId: "session",
    store: { findAttachment: () => ref },
    storage: {
      async *read() {
        yield new TextEncoder().encode("hello");
      },
    },
    parser: { parse: async () => ({ ok: false, error: { code: "parser_error", operation: "pdf-header" } }) },
    resolveVision: async () => ({ ok: false, error: "unused" }),
    gate: {
      screen: (text) => ({ text, flagged: false, maxSeverity: null }),
      getRiskLevel: () => "none",
    },
    limits: LIMITS,
  };
}

function tool(input = deps()) {
  const runner = createAttachmentTools(input)[0];
  if (!runner) throw new Error("inspect_attachment missing");
  return runner;
}

describe("inspect_attachment tool", () => {
  it("advertises read-tier bounded schema and returns coverage JSON", async () => {
    const runner = tool();
    expect(runner.definition).toMatchObject({ name: "inspect_attachment", tier: "read", category: "foreground" });
    expect(runner.definition.parameters).toMatchObject({
      properties: { pages: { maxItems: 2, uniqueItems: true }, question: { maxLength: 40 } },
      additionalProperties: false,
    });
    const args = { attachmentId: ID, question: "What does it say?" };
    expect(runner.validate?.(args)).toBeNull();
    const result = await runner.run(args, { signal: new AbortController().signal });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({
      attachmentId: ID,
      pagesInspected: [1],
      totalPages: 1,
      partial: false,
      answer: "hello",
    });
  });

  it("rejects unknown, duplicate, excessive, and malformed page arguments before execution", () => {
    const runner = tool();
    for (const args of [
      { attachmentId: ID, question: "q", extra: true },
      { attachmentId: ID, question: "q", pages: [1, 1] },
      { attachmentId: ID, question: "q", pages: [1, 2, 3] },
      { attachmentId: ID, question: "q", pages: [0] },
      { attachmentId: ID, question: "q", region: { x: 0.8, y: 0, width: 0.3, height: 1 } },
      { attachmentId: ID, question: "q", frameIndex: 0, timeMs: 10 },
    ])
      expect(runner.validate?.(args)?.isError).toBe(true);
  });

  it("routes confirmed main vision directly and all non-direct or missing routes through auxiliary", async () => {
    let auxiliaryCalls = 0;
    const input = deps();
    const sourceRef = input.store.findAttachment(ID);
    if (!sourceRef) throw new Error("attachment fixture missing");
    const original = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAADElEQVR4nGNgoBwAAABEAAHX40j9AAAAAElFTkSuQmCC",
        "base64",
      ),
    );
    const cropped = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAC0lEQVR4nGNgQAcAABIAAXfx+gAAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const imageRef = { ...sourceRef, mediaKind: "image" as const, contentType: "image/png", size: original.byteLength };
    const visual: AttachmentInspectionDeps = {
      ...input,
      store: { findAttachment: () => imageRef },
      storage: {
        async *read() {
          yield original;
        },
      },
      parser: {
        parse: async () => ({
          ok: true,
          value: {
            requestId: "r",
            status: 200,
            headers: {
              "X-Sentient-Visual-Metadata": JSON.stringify({
                source: {
                  kind: "image",
                  mediaType: "image/png",
                  sizeBytes: original.byteLength,
                  originalAvailable: true,
                  width: 4,
                  height: 4,
                  storedWidth: 4,
                  storedHeight: 4,
                },
                view: {
                  kind: "crop",
                  width: 2,
                  height: 2,
                  sourceWidth: 4,
                  sourceHeight: 4,
                  region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
                  frameIndex: 0,
                  downsampled: false,
                  partialCoverage: true,
                },
              }),
            },
            contentType: "image/png",
            body: cropped,
          },
        }),
      },
      resolveVision: async () => ({
        ok: true,
        value: {
          inspect: async () => {
            auxiliaryCalls++;
            return { ok: true, value: { text: "seen", provenance: [] } };
          },
        },
      }),
    };
    const runner = tool(visual);
    const args = {
      attachmentId: ID,
      question: "q",
      mode: "visual",
      region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      frameIndex: 0,
    };
    const direct = await runner.run(args, {
      signal: new AbortController().signal,
      attachmentVisionRoute: "direct",
    });
    expect(JSON.parse(direct.content)).toEqual({
      kind: "sentient.visual-evidence",
      version: 1,
      status: "prepared",
      attachmentId: ID,
      pages: [1],
      totalPages: 1,
      partial: false,
      region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      frameIndex: 0,
    });
    expect(auxiliaryCalls).toBe(0);

    expect(
      (await runner.run(args, { signal: new AbortController().signal, attachmentVisionRoute: "auxiliary" })).isError,
    ).toBe(false);
    expect(auxiliaryCalls).toBe(1);
    expect((await runner.run(args, { signal: new AbortController().signal })).isError).toBe(false);
    expect(auxiliaryCalls).toBe(2);
  });

  it("accepts only strict versioned direct markers", () => {
    const valid = {
      kind: "sentient.visual-evidence" as const,
      version: 1 as const,
      status: "prepared" as const,
      attachmentId: ID,
      pages: [1],
      totalPages: 1,
      partial: false,
    };
    expect(parseDirectVisionMarker(JSON.stringify(valid))).toEqual(valid);
    const selected = {
      ...valid,
      region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      frameIndex: 0,
    };
    expect(parseDirectVisionMarker(JSON.stringify(selected))).toEqual(selected);
    for (const malformed of [
      { ...valid, version: 2 },
      { ...valid, attachmentId: "not-an-attachment" },
      { ...valid, pages: [2] },
      { ...valid, extra: true },
      "prepared",
    ])
      expect(parseDirectVisionMarker(JSON.stringify(malformed))).toBeNull();
  });

  it("returns one opaque unavailable error for staged refs", async () => {
    const runner = tool(deps("staged"));
    const result = await runner.run({ attachmentId: ID, question: "read" }, { signal: new AbortController().signal });
    expect(result).toEqual({ content: '{"code":"attachment_unavailable"}', isError: true });
  });
});
