import {
  type AttachmentInspectionDeps,
  type AttachmentInspectionMode,
  inspectAttachment,
  prepareAttachmentVisual,
} from "../attachments/inspection.js";
import type { AttachmentImageRegion } from "../attachments/visual-metadata.js";
import type { NativeToolRunner } from "./tool-broker.js";
import type { ToolResult } from "./tool-types.js";

export const ATTACHMENT_TOOL_NAME = "inspect_attachment";
export const DIRECT_VISION_MARKER_KIND = "sentient.visual-evidence";
export const DIRECT_VISION_MARKER_VERSION = 1;

export interface DirectVisionMarker {
  readonly kind: typeof DIRECT_VISION_MARKER_KIND;
  readonly version: typeof DIRECT_VISION_MARKER_VERSION;
  readonly status: "prepared";
  readonly attachmentId: string;
  readonly pages: readonly number[];
  readonly totalPages: number;
  readonly partial: boolean;
  readonly region?: AttachmentImageRegion;
  readonly frameIndex?: number;
  readonly timeMs?: number;
}

export function createAttachmentTools(deps: AttachmentInspectionDeps): readonly NativeToolRunner[] {
  const runner: NativeToolRunner = {
    definition: {
      name: ATTACHMENT_TOOL_NAME,
      description:
        "Inspect one committed attachment from conversation history when overview is insufficient. Supports specific PDF pages, embedded text, visual layout, and image regions or animation frames/times. Newly sent files already receive overview inspection; call this only for historical or detail-on-demand inspection. Results cover only reported selections.",
      parameters: {
        type: "object",
        properties: {
          attachmentId: { type: "string", description: "Opaque attachment id from conversation history." },
          question: { type: "string", minLength: 1, maxLength: deps.limits.maxQuestionChars },
          pages: {
            type: "array",
            description: "1-based PDF pages to inspect. Omit to inspect page 1 only.",
            items: { type: "integer", minimum: 1 },
            minItems: 1,
            maxItems: deps.limits.maxPages,
            uniqueItems: true,
          },
          mode: { type: "string", enum: ["text", "visual"] },
          region: {
            type: "object",
            description: "Normalized 0..1 rectangle in upright original image/frame coordinates.",
            properties: {
              x: { type: "number", minimum: 0, maximum: 1 },
              y: { type: "number", minimum: 0, maximum: 1 },
              width: { type: "number", exclusiveMinimum: 0, maximum: 1 },
              height: { type: "number", exclusiveMinimum: 0, maximum: 1 },
            },
            required: ["x", "y", "width", "height"],
            additionalProperties: false,
          },
          frameIndex: { type: "integer", minimum: 0, description: "Zero-based animation or motion frame." },
          timeMs: { type: "integer", minimum: 0, description: "Animation or motion time in milliseconds." },
        },
        required: ["attachmentId", "question"],
        additionalProperties: false,
      },
      category: "foreground",
      tier: "read",
      defaultExposure: "standard",
    },
    validate(args) {
      return parseArgs(args, deps) === null ? fail("Invalid inspect_attachment arguments.") : null;
    },
    async run(args, { signal, attachmentVisionRoute }) {
      const request = parseArgs(args, deps);
      if (!request) return fail("Invalid inspect_attachment arguments.");
      const ref = deps.store.findAttachment(request.attachmentId);
      const visual = request.mode === "visual" || (request.mode === undefined && ref?.mediaKind === "image");
      if (visual && attachmentVisionRoute === "direct") {
        const prepared = await prepareAttachmentVisual(deps, request, signal);
        if (!prepared.ok) return fail(JSON.stringify(prepared.error));
        const marker: DirectVisionMarker = {
          kind: DIRECT_VISION_MARKER_KIND,
          version: DIRECT_VISION_MARKER_VERSION,
          status: "prepared",
          attachmentId: prepared.value.attachmentId,
          pages: prepared.value.pages,
          totalPages: prepared.value.totalPages,
          partial: prepared.value.partial,
          ...(request.region ? { region: request.region } : {}),
          ...(request.frameIndex !== undefined ? { frameIndex: request.frameIndex } : {}),
          ...(request.timeMs !== undefined ? { timeMs: request.timeMs } : {}),
        };
        return { content: JSON.stringify(marker), isError: false };
      }
      const result = await inspectAttachment(deps, request, signal);
      return result.ok ? { content: JSON.stringify(result.value), isError: false } : fail(JSON.stringify(result.error));
    },
  };
  return [runner];
}

export function parseDirectVisionMarker(value: string): DirectVisionMarker | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const row = parsed as Record<string, unknown>;
    if (
      Object.keys(row).some(
        (key) =>
          ![
            "kind",
            "version",
            "status",
            "attachmentId",
            "pages",
            "totalPages",
            "partial",
            "region",
            "frameIndex",
            "timeMs",
          ].includes(key),
      ) ||
      row.kind !== DIRECT_VISION_MARKER_KIND ||
      row.version !== DIRECT_VISION_MARKER_VERSION ||
      row.status !== "prepared" ||
      typeof row.attachmentId !== "string" ||
      !/^att_[a-f0-9]{32}$/.test(row.attachmentId) ||
      !Array.isArray(row.pages) ||
      row.pages.length < 1 ||
      new Set(row.pages).size !== row.pages.length ||
      !row.pages.every((page) => Number.isSafeInteger(page) && (page as number) >= 1) ||
      !Number.isSafeInteger(row.totalPages) ||
      (row.totalPages as number) < 1 ||
      typeof row.partial !== "boolean" ||
      !validSelection(row)
    )
      return null;
    const pages = row.pages as number[];
    const totalPages = row.totalPages as number;
    if (pages.some((page) => page > totalPages) || row.partial !== pages.length < totalPages) return null;
    return {
      kind: DIRECT_VISION_MARKER_KIND,
      version: DIRECT_VISION_MARKER_VERSION,
      status: "prepared",
      attachmentId: row.attachmentId,
      pages,
      totalPages,
      partial: row.partial,
      ...(row.region !== undefined ? { region: row.region as AttachmentImageRegion } : {}),
      ...(row.frameIndex !== undefined ? { frameIndex: row.frameIndex as number } : {}),
      ...(row.timeMs !== undefined ? { timeMs: row.timeMs as number } : {}),
    };
  } catch {
    return null;
  }
}

function parseArgs(args: Record<string, unknown>, deps: AttachmentInspectionDeps) {
  if (
    Object.keys(args).some(
      (key) => !["attachmentId", "question", "pages", "mode", "region", "frameIndex", "timeMs"].includes(key),
    )
  )
    return null;
  const attachmentId = args.attachmentId;
  const question = args.question;
  const mode = args.mode;
  const pages = args.pages;
  if (
    typeof attachmentId !== "string" ||
    !/^att_[a-f0-9]{32}$/.test(attachmentId) ||
    typeof question !== "string" ||
    question.trim().length < 1 ||
    question.length > deps.limits.maxQuestionChars ||
    (mode !== undefined && mode !== "text" && mode !== "visual") ||
    (pages !== undefined &&
      (!Array.isArray(pages) ||
        pages.length < 1 ||
        pages.length > deps.limits.maxPages ||
        new Set(pages).size !== pages.length ||
        !pages.every((page) => typeof page === "number" && Number.isSafeInteger(page) && page >= 1))) ||
    !validSelection(args)
  )
    return null;
  return {
    attachmentId,
    question,
    ...(pages !== undefined ? { pages: pages as number[] } : {}),
    ...(mode !== undefined ? { mode: mode as AttachmentInspectionMode } : {}),
    ...(args.region !== undefined ? { region: args.region as AttachmentImageRegion } : {}),
    ...(args.frameIndex !== undefined ? { frameIndex: args.frameIndex as number } : {}),
    ...(args.timeMs !== undefined ? { timeMs: args.timeMs as number } : {}),
  };
}

function validSelection(value: Record<string, unknown>): boolean {
  const frameIndex = value.frameIndex;
  const timeMs = value.timeMs;
  if (frameIndex !== undefined && timeMs !== undefined) return false;
  if (
    frameIndex !== undefined &&
    (typeof frameIndex !== "number" || !Number.isSafeInteger(frameIndex) || frameIndex < 0)
  )
    return false;
  if (timeMs !== undefined && (typeof timeMs !== "number" || !Number.isSafeInteger(timeMs) || timeMs < 0)) return false;
  if (value.region === undefined) return true;
  if (!value.region || typeof value.region !== "object" || Array.isArray(value.region)) return false;
  const region = value.region as Record<string, unknown>;
  if (Object.keys(region).length !== 4 || !["x", "y", "width", "height"].every((key) => key in region)) return false;
  const { x, y, width, height } = region;
  return (
    [x, y, width, height].every((part) => typeof part === "number" && Number.isFinite(part)) &&
    (x as number) >= 0 &&
    (y as number) >= 0 &&
    (width as number) > 0 &&
    (height as number) > 0 &&
    (x as number) + (width as number) <= 1 &&
    (y as number) + (height as number) <= 1
  );
}

function fail(content: string): ToolResult {
  return { content, isError: true };
}
