import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentsConfigSchema } from "@sentient/config";
import type { SessionEntry } from "../store/entry-types.js";
import type { AttachmentManifestRecord } from "../store/session-store.js";
import { type DirectVisionDeps, assembleAutomaticVisualUnderstanding, assembleDirectVision } from "./direct-vision.js";
import type { AttachmentCapability } from "./storage.js";

const IMAGE = "att_11111111111111111111111111111111";
const PDF = "att_22222222222222222222222222222222";
const OLD = "att_33333333333333333333333333333333";
const PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
);
const capability = Object.freeze({
  resource: "attachment-store",
  ownerUserId: "u_12345678",
  rootPath: "/tmp/direct-vision",
  role: "adult",
}) as AttachmentCapability;

function manifest(attachmentId: string, mediaKind: "image" | "pdf", entrySeq: number): AttachmentManifestRecord {
  return {
    attachmentId,
    ownerUserId: capability.ownerUserId,
    sessionId: "session",
    entrySeq,
    status: "ready",
    mediaKind,
    contentType: mediaKind === "pdf" ? "application/pdf" : "image/png",
    displayName: "redacted",
    size: 9,
    sha256: "a".repeat(64),
    sendAttemptId: "attempt",
    fileIdentity: attachmentId,
    stagedAt: 1,
    expiresAt: 2,
  };
}

function entry(
  seq: number,
  kind: SessionEntry["kind"],
  turnId: string,
  fields: Partial<SessionEntry> = {},
): SessionEntry {
  return {
    seq,
    sessionId: "session",
    turnId,
    replyId: null,
    kind,
    createdAt: seq,
    text: kind === "user" ? "look" : null,
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    cutoff: null,
    compactedThroughSeq: null,
    pendingId: null,
    attachments: [],
    ...fields,
  };
}

function normalizedImageResponse(mediaType = "image/png", sizeBytes = 9) {
  return {
    requestId: "r",
    status: 200,
    headers: {
      "X-Sentient-Visual-Metadata": JSON.stringify({
        source: {
          kind: "image",
          mediaType,
          sizeBytes,
          originalAvailable: true,
          width: 1,
          height: 1,
          storedWidth: 1,
          storedHeight: 1,
        },
        view: {
          kind: "overview",
          width: 1,
          height: 1,
          sourceWidth: 1,
          sourceHeight: 1,
          downsampled: false,
          partialCoverage: false,
        },
      }),
    },
    contentType: "image/png",
    body: PNG,
  };
}

function deps(overrides: Partial<DirectVisionDeps> = {}): DirectVisionDeps {
  const refs = new Map([
    [IMAGE, manifest(IMAGE, "image", 3)],
    [PDF, manifest(PDF, "pdf", 4)],
    [OLD, manifest(OLD, "image", 1)],
  ]);
  return {
    capability,
    sessionId: "session",
    store: { findAttachment: (id) => refs.get(id) ?? null },
    storage: {
      async *read() {
        yield Uint8Array.from([1]);
      },
    },
    parser: {
      async parse(request) {
        if (request.operation.operation === "pdf-header") {
          return {
            ok: true,
            value: {
              requestId: "r",
              status: 200,
              headers: {},
              contentType: "application/json",
              body: new TextEncoder().encode('{"pageCount":3}'),
            },
          };
        }
        return { ok: true, value: normalizedImageResponse() };
      },
    },
    limits: { maxPages: 8, maxTextBytes: 1024, maxTextChars: 1000, maxQuestionChars: 2000, maxEdge: 1600 },
    config: attachmentsConfigSchema.parse({ inspection_max_pages: 3, vision_max_input_bytes: 1024 }),
    ...overrides,
  };
}

function imageParts(messages: readonly unknown[]): number {
  return JSON.stringify(messages).match(/"type":"image_url"/g)?.length ?? 0;
}

const REAL_CONTAINER = process.env.SENTIENT_PARSER_E2E_CONTAINER;
const REAL_CONTAINER_ID = process.env.SENTIENT_PARSER_E2E_CONTAINER_ID;

describe("assembleAutomaticVisualUnderstanding", () => {
  it("prepares screened auxiliary overview once across iterations without a model tool call", async () => {
    let inspections = 0;
    const configured = deps({
      auxiliary: {
        resolveVision: async () => ({
          ok: true,
          value: {
            inspect: async (request) => {
              inspections += 1;
              return {
                ok: true,
                value: { text: "screened overview", provenance: request.pages.map((p) => p.provenance) },
              };
            },
          },
        }),
        gate: {
          screen: (text) => ({ text, flagged: false, maxSeverity: null }),
          getRiskLevel: () => "none",
        },
      },
    });
    const entries = [
      entry(3, "user", "trigger", {
        attachments: [{ attachmentId: IMAGE, displayName: "x", contentType: "image/png", mediaKind: "image", size: 9 }],
      }),
    ];
    const state = { successfulInspectionCallSeqs: new Set<number>(), automaticInspections: new Map() };

    const first = await assembleAutomaticVisualUnderstanding(
      configured,
      entries,
      2,
      state,
      new AbortController().signal,
    );
    const second = await assembleAutomaticVisualUnderstanding(
      configured,
      entries,
      2,
      state,
      new AbortController().signal,
    );

    expect(inspections).toBe(1);
    expect(first.included).toEqual([`${IMAGE}#view=overview`]);
    expect(JSON.stringify(first.messages)).toContain("screened overview");
    expect(second.messages).toEqual(first.messages);
  });

  it("keeps screened partial success and labels auxiliary failure as unavailable", async () => {
    const second = `att_${"4".repeat(32)}`;
    const refs = new Map([
      [IMAGE, manifest(IMAGE, "image", 3)],
      [second, manifest(second, "image", 3)],
    ]);
    let resolutions = 0;
    const configured = deps({
      store: { findAttachment: (id) => refs.get(id) ?? null },
      auxiliary: {
        resolveVision: async () =>
          ++resolutions === 1
            ? {
                ok: true,
                value: {
                  inspect: async (request) => ({
                    ok: true,
                    value: { text: "raw overview", provenance: request.pages.map((p) => p.provenance) },
                  }),
                },
              }
            : { ok: false, error: "unavailable" },
        gate: {
          screen: (text) => ({ text: `screened:${text}`, flagged: true, maxSeverity: "suspicious" }),
          getRiskLevel: () => "warn",
        },
      },
    });
    const result = await assembleAutomaticVisualUnderstanding(
      configured,
      [
        entry(3, "user", "trigger", {
          attachments: [IMAGE, second].map((attachmentId) => ({
            attachmentId,
            displayName: "x",
            contentType: "image/png",
            mediaKind: "image" as const,
            size: 9,
          })),
        }),
      ],
      2,
      { successfulInspectionCallSeqs: new Set(), automaticInspections: new Map() },
      new AbortController().signal,
    );

    expect(result.included).toEqual([`${IMAGE}#view=overview`]);
    expect(result.omitted).toEqual([`${second}#view=overview`]);
    expect(JSON.stringify(result.messages)).toContain("screened:raw overview");
    expect(JSON.stringify(result.messages)).toContain("Visual overview unavailable (vision_unavailable)");
  });

  it("batches GIF and Live Photo overview plus bounded motion samples once per turn", async () => {
    for (const kind of ["animation", "live_photo"] as const) {
      const contentType = kind === "animation" ? "image/gif" : "application/vnd.sentient.live-photo+zip";
      const ref = manifest(IMAGE, "image", 3);
      const operations: unknown[] = [];
      let inspections = 0;
      let inspectedPages = 0;
      const configured = deps({
        config: attachmentsConfigSchema.parse({ inspection_max_pages: 4, vision_max_input_bytes: 1024 }),
        store: { findAttachment: () => ({ ...ref, contentType }) },
        parser: {
          async parse(request) {
            operations.push(request.operation);
            const frameIndex =
              request.operation.operation === "image-normalize" ? request.operation.frameIndex : undefined;
            const timeMs = request.operation.operation === "image-normalize" ? request.operation.timeMs : undefined;
            return {
              ok: true,
              value: {
                requestId: "r",
                status: 200,
                contentType: "image/png",
                headers: {
                  "X-Sentient-Visual-Metadata": JSON.stringify({
                    source: {
                      kind,
                      mediaType: contentType,
                      sizeBytes: 9,
                      originalAvailable: true,
                      width: 640,
                      height: 480,
                      storedWidth: 640,
                      storedHeight: 480,
                      ...(kind === "animation"
                        ? { frameCount: 3, durationMs: 300 }
                        : { durationMs: 300, motionAvailable: true }),
                    },
                    view: {
                      kind: frameIndex !== undefined || timeMs !== undefined ? "frame" : "overview",
                      width: 1,
                      height: 1,
                      sourceWidth: 640,
                      sourceHeight: 480,
                      ...(kind === "animation" ? { frameIndex: frameIndex ?? 0, timeMs: (frameIndex ?? 0) * 100 } : {}),
                      downsampled: true,
                      partialCoverage: kind === "live_photo" || frameIndex !== undefined || timeMs !== undefined,
                    },
                  }),
                },
                body: PNG,
              },
            };
          },
        },
        auxiliary: {
          resolveVision: async () => ({
            ok: true,
            value: {
              inspect: async (request) => {
                inspections++;
                inspectedPages = request.pages.length;
                return {
                  ok: true,
                  value: { text: "screened motion overview", provenance: request.pages.map((p) => p.provenance) },
                };
              },
            },
          }),
          gate: {
            screen: (text) => ({ text, flagged: false, maxSeverity: null }),
            getRiskLevel: () => "none",
          },
        },
      });
      const entries = [
        entry(3, "user", "trigger", {
          attachments: [{ attachmentId: IMAGE, displayName: "x", contentType, mediaKind: "image", size: 9 }],
        }),
      ];
      const state = {
        successfulInspectionCallSeqs: new Set<number>(),
        automaticInspections: new Map(),
        preparedVisuals: new Map(),
      };

      const first = await assembleAutomaticVisualUnderstanding(
        configured,
        entries,
        2,
        state,
        new AbortController().signal,
      );
      const second = await assembleAutomaticVisualUnderstanding(
        configured,
        entries,
        2,
        state,
        new AbortController().signal,
      );

      expect(inspections).toBe(1);
      expect(inspectedPages).toBe(kind === "animation" ? 3 : 4);
      expect(operations).toHaveLength(kind === "animation" ? 3 : 4);
      expect(second.messages).toEqual(first.messages);
      const encoded = JSON.stringify(first.messages);
      expect(encoded).toContain(`\\\"kind\\\":\\\"${kind}\\\"`);
      expect(encoded).toContain('\\"width\\":640');
      if (kind === "animation") {
        expect(encoded).toContain("timeMs=100");
        expect(encoded).toContain("timeMs=200");
      } else {
        expect(encoded).toContain("requested-timeMs=149");
        expect(encoded).not.toContain('\\"timeMs\\":149');
      }
    }
  });

  it.skipIf(!REAL_CONTAINER || !REAL_CONTAINER_ID)(
    "passes a real three-frame GIF through strict validation into one auxiliary call",
    async () => {
      if (!REAL_CONTAINER || !REAL_CONTAINER_ID) throw new Error("real parser fixture identity missing");
      const docker = "/usr/local/bin/docker";
      const temp = mkdtempSync(join(tmpdir(), "direct-vision-real-"));
      try {
        const identityPath = join(temp, "identity");
        const gifPath = join(temp, "fixture.gif");
        const probePath = join(temp, "probe.ts");
        await Bun.write(
          probePath,
          `const inspect = Bun.spawnSync([${JSON.stringify(docker)}, "inspect", ${JSON.stringify(REAL_CONTAINER_ID)}, "--format", ${JSON.stringify('{{.Id}}|{{.Name}}|{{index .Config.Labels "sentient.managed"}}|{{index .Config.Labels "sentient.service"}}|{{.State.Running}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}')}], { stdout: "pipe", stderr: "ignore" });
const generated = Bun.spawnSync([${JSON.stringify(docker)}, "exec", ${JSON.stringify(REAL_CONTAINER)}, "ffmpeg", "-v", "error", "-threads", "1", "-filter_threads", "1", "-f", "lavfi", "-i", "testsrc=size=24x18:rate=10:duration=0.3", "-f", "gif", "pipe:1"], { stdout: "pipe", stderr: "ignore" });
await Bun.write(${JSON.stringify(identityPath)}, inspect.stdout);
await Bun.write(${JSON.stringify(gifPath)}, generated.stdout);
process.exit(inspect.exitCode || generated.exitCode);`,
        );
        const probe = Bun.spawn([process.execPath, probePath], { stdout: "ignore", stderr: "ignore" });
        expect(await probe.exited).toBe(0);
        expect(readFileSync(identityPath, "utf8").trim()).toBe(
          `${REAL_CONTAINER_ID}|/${REAL_CONTAINER}|true|attachment-parser|true|none|true`,
        );
        expect(readFileSync(gifPath).byteLength).toBeGreaterThan(0);
        const resultPath = join(temp, "consumer-result.json");
        const consumerPath = join(temp, "consumer.ts");
        await Bun.write(
          consumerPath,
          `import { readFileSync } from "node:fs";
import { attachmentsConfigSchema } from ${JSON.stringify(join(import.meta.dir, "../../../shared/config/src/schemas/attachments-config.ts"))};
import { assembleAutomaticVisualUnderstanding } from ${JSON.stringify(join(import.meta.dir, "direct-vision.ts"))};
import { createAttachmentParserClient, createDockerCliAttachmentParserTransport } from ${JSON.stringify(join(import.meta.dir, "parser-client.ts"))};
const id = ${JSON.stringify(IMAGE)};
const gif = Uint8Array.from(readFileSync(${JSON.stringify(join(temp, "fixture.gif"))}));
const ref = { attachmentId: id, ownerUserId: "u_12345678", sessionId: "session", entrySeq: 3, status: "ready", mediaKind: "image", contentType: "image/gif", displayName: "redacted", size: gif.byteLength, sha256: "a".repeat(64), sendAttemptId: "attempt", fileIdentity: id, stagedAt: 1, expiresAt: 2 };
const parser = createAttachmentParserClient(createDockerCliAttachmentParserTransport(${JSON.stringify(docker)}), { containerName: ${JSON.stringify(REAL_CONTAINER)}, maxInputBytes: 1_000_000, maxOutputBytes: 1_000_000, maxHeaderBytes: 8192, deadlineMs: 5_000, cleanupTimeoutMs: 1_000, maxEdge: 1600 });
let auxiliaryCalls = 0;
let frames = [];
const result = await assembleAutomaticVisualUnderstanding({
  capability: Object.freeze({ resource: "attachment-store", ownerUserId: "u_12345678", rootPath: "/tmp/direct-vision", role: "adult" }), sessionId: "session",
  store: { findAttachment: () => ref }, storage: { async *read() { yield gif; } }, parser,
  limits: { maxPages: 8, maxTextBytes: 1024, maxTextChars: 1000, maxQuestionChars: 2000, maxEdge: 1600 },
  config: attachmentsConfigSchema.parse({ inspection_max_pages: 3, vision_max_input_bytes: 1_000_000 }),
  auxiliary: { resolveVision: async () => ({ ok: true, value: { inspect: async (request) => { auxiliaryCalls++; frames = request.pages.map((page) => page.metadata?.frameIndex); return { ok: true, value: { text: "screened motion overview", provenance: request.pages.map((page) => page.provenance) } }; } } }), gate: { screen: (text) => ({ text, flagged: false, maxSeverity: null }), getRiskLevel: () => "none" } }
}, [{ seq: 3, sessionId: "session", turnId: "trigger", replyId: null, kind: "user", createdAt: 3, text: "look", toolCallId: null, toolName: null, toolArgs: null, cutoff: null, compactedThroughSeq: null, pendingId: null, attachments: [{ attachmentId: id, displayName: "x", contentType: "image/gif", mediaKind: "image", size: gif.byteLength }] }], 2, { successfulInspectionCallSeqs: new Set(), automaticInspections: new Map(), preparedVisuals: new Map() }, new AbortController().signal);
await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({ auxiliaryCalls, frames, included: result.included, omitted: result.omitted, mainImages: JSON.stringify(result.messages).match(/"type":"image_url"/g)?.length ?? 0 }));`,
        );
        const consumer = Bun.spawn([process.execPath, consumerPath], { stdout: "ignore", stderr: "ignore" });
        expect(await consumer.exited).toBe(0);
        const result = JSON.parse(readFileSync(resultPath, "utf8"));
        expect(result).toEqual({
          auxiliaryCalls: 1,
          frames: [0, 1, 2],
          included: [
            `${IMAGE}#view=frame:frame=0:timeMs=0`,
            `${IMAGE}#view=frame:frame=1:timeMs=100`,
            `${IMAGE}#view=frame:frame=2:timeMs=200`,
          ],
          omitted: [],
          mainImages: 0,
        });
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it("invalidates prepared pixels when immutable manifest identity is replaced", async () => {
    let ref = manifest(IMAGE, "image", 3);
    let parses = 0;
    const configured = deps({
      store: { findAttachment: () => ref },
      parser: {
        async parse() {
          parses++;
          return {
            ok: true,
            value: normalizedImageResponse(),
          };
        },
      },
    });
    const entries = [
      entry(3, "user", "trigger", {
        attachments: [{ attachmentId: IMAGE, displayName: "x", contentType: "image/png", mediaKind: "image", size: 9 }],
      }),
    ];
    const state = { successfulInspectionCallSeqs: new Set<number>(), preparedVisuals: new Map() };

    await assembleDirectVision(configured, entries, "trigger", 2, state, new AbortController().signal);
    ref = { ...ref, sha256: "b".repeat(64) };
    await assembleDirectVision(configured, entries, "trigger", 2, state, new AbortController().signal);

    expect(parses).toBe(2);
    expect(state.preparedVisuals.size).toBe(1);
  });

  it("does not inspect or reuse evidence after admitted attachment is removed", async () => {
    const ref = manifest(IMAGE, "image", 3);
    let current: AttachmentManifestRecord | null = ref;
    let inspections = 0;
    const configured = deps({
      store: { findAttachment: () => current },
      auxiliary: {
        resolveVision: async () => ({
          ok: true,
          value: {
            inspect: async (request) => {
              inspections += 1;
              current = null;
              return { ok: true, value: { text: "stale", provenance: request.pages.map((p) => p.provenance) } };
            },
          },
        }),
        gate: {
          screen: (text) => ({ text, flagged: false, maxSeverity: null }),
          getRiskLevel: () => "none",
        },
      },
    });
    const result = await assembleAutomaticVisualUnderstanding(
      configured,
      [
        entry(3, "user", "trigger", {
          attachments: [
            { attachmentId: IMAGE, displayName: "x", contentType: "image/png", mediaKind: "image", size: 9 },
          ],
        }),
      ],
      2,
      { successfulInspectionCallSeqs: new Set(), automaticInspections: new Map() },
      new AbortController().signal,
    );

    expect(inspections).toBe(1);
    expect(result.included).toEqual([]);
    expect(JSON.stringify(result.messages)).not.toContain("stale");
  });
});

describe("assembleDirectVision", () => {
  it("hydrates only current admitted window and gives each attachment first-page coverage before PDF extras", async () => {
    const entries = [
      entry(1, "user", "old", {
        attachments: [{ attachmentId: OLD, displayName: "x", contentType: "image/png", mediaKind: "image", size: 9 }],
      }),
      entry(2, "compaction", "compact", { text: "summary" }),
      entry(3, "user", "trigger", {
        attachments: [{ attachmentId: IMAGE, displayName: "x", contentType: "image/png", mediaKind: "image", size: 9 }],
      }),
      entry(4, "user", "different-midturn-id", {
        attachments: [
          { attachmentId: PDF, displayName: "x", contentType: "application/pdf", mediaKind: "pdf", size: 9 },
        ],
      }),
    ];
    const result = await assembleDirectVision(
      deps(),
      entries,
      "trigger",
      2,
      { successfulInspectionCallSeqs: new Set() },
      new AbortController().signal,
    );

    expect(result.included).toEqual([`${IMAGE}#view=overview`, `${PDF}#view=page:page=1`, `${PDF}#view=page:page=2`]);
    expect(result.included.some((ref) => ref.startsWith(OLD))).toBe(false);
    expect(imageParts(result.messages)).toBe(3);
  });

  it("gives admitted overview priority over explicit detail under aggregate cap", async () => {
    const marker = JSON.stringify({
      kind: "sentient.visual-evidence",
      version: 1,
      status: "prepared",
      attachmentId: PDF,
      pages: [3],
      totalPages: 3,
      partial: true,
    });
    const entries = [
      entry(3, "user", "trigger", {
        attachments: [{ attachmentId: IMAGE, displayName: "x", contentType: "image/png", mediaKind: "image", size: 9 }],
      }),
      entry(4, "tool_call", "trigger", {
        toolCallId: "call",
        toolName: "inspect_attachment",
        toolArgs: JSON.stringify({ attachmentId: PDF, question: "q", pages: [3], mode: "visual" }),
      }),
      entry(5, "tool_result", "trigger", { toolCallId: "call", toolName: "inspect_attachment", toolArgs: marker }),
    ];
    const result = await assembleDirectVision(
      deps({ config: attachmentsConfigSchema.parse({ inspection_max_pages: 1, vision_max_input_bytes: 1024 }) }),
      entries,
      "trigger",
      2,
      { successfulInspectionCallSeqs: new Set([4]) },
      new AbortController().signal,
    );

    expect(result.included).toEqual([`${IMAGE}#view=overview`]);
    expect(result.omitted).toEqual([`${PDF}#view=page:page=3`]);
    expect(imageParts(result.messages)).toBe(1);
  });

  it("keeps current-window evidence across stateless requests regardless of question limit", async () => {
    const entries = [
      entry(3, "user", "trigger", {
        attachments: [
          { attachmentId: IMAGE, displayName: "x", contentType: "image/png", mediaKind: "image", size: 9 },
          ...Array.from({ length: 400 }, (_, index) => ({
            attachmentId: `att_${index.toString(16).padStart(32, "0")}`,
            displayName: "x",
            contentType: "image/png",
            mediaKind: "image" as const,
            size: 9,
          })),
        ],
      }),
    ];
    const state = { successfulInspectionCallSeqs: new Set<number>() };
    const configured = deps({
      config: attachmentsConfigSchema.parse({
        inspection_max_pages: 1,
        inspection_max_question_chars: 1,
        vision_max_input_bytes: 1024,
      }),
    });

    const first = await assembleDirectVision(configured, entries, "trigger", 2, state, new AbortController().signal);
    const second = await assembleDirectVision(configured, entries, "trigger", 2, state, new AbortController().signal);

    expect(imageParts(first.messages)).toBe(1);
    expect(imageParts(second.messages)).toBe(1);
    expect(JSON.stringify(first.messages).length).toBeLessThan(20_000);
  });

  it("requires successful dispatch provenance and lets a newer failed batch supersede old success", async () => {
    const marker = (attachmentId: string) =>
      JSON.stringify({
        kind: "sentient.visual-evidence",
        version: 1,
        status: "prepared",
        attachmentId,
        pages: [1],
        totalPages: 1,
        partial: false,
      });
    const call = (seq: number, id: string, attachmentId: string) =>
      entry(seq, "tool_call", "trigger", {
        toolCallId: id,
        toolName: "inspect_attachment",
        toolArgs: JSON.stringify({ attachmentId, question: "q", pages: [1], mode: "visual" }),
      });
    const result = (seq: number, id: string, attachmentId: string) =>
      entry(seq, "tool_result", "trigger", {
        toolCallId: id,
        toolName: "inspect_attachment",
        toolArgs: marker(attachmentId),
      });

    const deniedLatest = await assembleDirectVision(
      deps(),
      [call(3, "old", IMAGE), result(4, "old", IMAGE), call(5, "denied", PDF), result(6, "denied", PDF)],
      "trigger",
      2,
      { successfulInspectionCallSeqs: new Set<number>() },
      new AbortController().signal,
    );
    const errorWithMarker = await assembleDirectVision(
      deps(),
      [call(3, "error", IMAGE), result(4, "error", IMAGE)],
      "trigger",
      2,
      { successfulInspectionCallSeqs: new Set() },
      new AbortController().signal,
    );

    expect(deniedLatest.included).toEqual([]);
    expect(errorWithMarker.included).toEqual([]);
    expect(imageParts(deniedLatest.messages)).toBe(0);
  });

  it("hydrates successful default-mode image inspection", async () => {
    const marker = JSON.stringify({
      kind: "sentient.visual-evidence",
      version: 1,
      status: "prepared",
      attachmentId: IMAGE,
      pages: [1],
      totalPages: 1,
      partial: false,
    });
    const result = await assembleDirectVision(
      deps(),
      [
        entry(3, "tool_call", "trigger", {
          toolCallId: "default-image",
          toolName: "inspect_attachment",
          toolArgs: JSON.stringify({ attachmentId: IMAGE, question: "q" }),
        }),
        entry(4, "tool_result", "trigger", {
          toolCallId: "default-image",
          toolName: "inspect_attachment",
          toolArgs: marker,
        }),
      ],
      "trigger",
      2,
      { successfulInspectionCallSeqs: new Set([3]) },
      new AbortController().signal,
    );

    expect(result.included).toEqual([`${IMAGE}#view=overview`]);
    expect(imageParts(result.messages)).toBe(1);
  });

  it("preserves explicit ROI/frame selectors and actual metadata in provenance", async () => {
    const region = { x: 0.25, y: 0.5, width: 0.5, height: 0.5 };
    const marker = (selection: Record<string, unknown>) =>
      JSON.stringify({
        kind: "sentient.visual-evidence",
        version: 1,
        status: "prepared",
        attachmentId: IMAGE,
        pages: [1],
        totalPages: 1,
        partial: false,
        ...selection,
      });
    const operations: unknown[] = [];
    const configured = deps({
      store: { findAttachment: () => ({ ...manifest(IMAGE, "image", 3), contentType: "image/gif" }) },
      parser: {
        async parse(request) {
          operations.push(request.operation);
          const selectedByTime =
            request.operation.operation === "image-normalize" && request.operation.timeMs !== undefined;
          return {
            ok: true,
            value: {
              requestId: "r",
              status: 200,
              contentType: "image/png",
              headers: {
                "X-Sentient-Visual-Metadata": JSON.stringify({
                  source: {
                    kind: "animation",
                    mediaType: "image/gif",
                    sizeBytes: 9,
                    originalAvailable: true,
                    width: 1000,
                    height: 800,
                    storedWidth: 1000,
                    storedHeight: 800,
                    frameCount: 4,
                    durationMs: 400,
                  },
                  view: {
                    kind: selectedByTime ? "frame" : "crop",
                    width: 1,
                    height: 1,
                    sourceWidth: 1000,
                    sourceHeight: 800,
                    ...(selectedByTime ? {} : { region }),
                    frameIndex: selectedByTime ? 1 : 2,
                    timeMs: selectedByTime ? 100 : 200,
                    downsampled: true,
                    partialCoverage: true,
                  },
                }),
              },
              body: PNG,
            },
          };
        },
      },
    });
    const result = await assembleDirectVision(
      configured,
      [
        entry(3, "tool_call", "trigger", {
          toolCallId: "detail",
          toolName: "inspect_attachment",
          toolArgs: JSON.stringify({ attachmentId: IMAGE, question: "detail", mode: "visual", region, frameIndex: 2 }),
        }),
        entry(4, "tool_result", "trigger", {
          toolCallId: "detail",
          toolName: "inspect_attachment",
          toolArgs: marker({ region, frameIndex: 2 }),
        }),
        entry(5, "tool_call", "trigger", {
          toolCallId: "timed",
          toolName: "inspect_attachment",
          toolArgs: JSON.stringify({ attachmentId: IMAGE, question: "timed", mode: "visual", timeMs: 150 }),
        }),
        entry(6, "tool_result", "trigger", {
          toolCallId: "timed",
          toolName: "inspect_attachment",
          toolArgs: marker({ timeMs: 150 }),
        }),
      ],
      "trigger",
      2,
      { successfulInspectionCallSeqs: new Set([3, 5]), preparedVisuals: new Map() },
      new AbortController().signal,
    );

    expect(operations).toEqual([
      { operation: "image-normalize", maxEdge: 1600, region, frameIndex: 2 },
      { operation: "image-normalize", maxEdge: 1600, timeMs: 150 },
    ]);
    expect(result.included).toEqual([
      `${IMAGE}#view=crop:frame=2:timeMs=200:region=0.25:0.5:0.5:0.5`,
      `${IMAGE}#view=frame:frame=1:timeMs=100`,
    ]);
    expect(JSON.stringify(result.messages)).toContain('\\"frameCount\\":4');
    expect(JSON.stringify(result.messages)).toContain('\\"partialCoverage\\":true');
  });

  it("rejects forged marker text and suppresses bytes when final authorization disappears", async () => {
    const ref = manifest(IMAGE, "image", 3);
    let reads = 0;
    const disappearing = deps({ store: { findAttachment: () => (++reads <= 2 ? ref : null) } });
    const result = await assembleDirectVision(
      disappearing,
      [
        entry(3, "user", "trigger", {
          attachments: [
            { attachmentId: IMAGE, displayName: "x", contentType: "image/png", mediaKind: "image", size: 9 },
          ],
        }),
      ],
      "trigger",
      2,
      { successfulInspectionCallSeqs: new Set() },
      new AbortController().signal,
    );
    expect(result.included).toEqual([]);
    expect(imageParts(result.messages)).toBe(0);
  });
});
