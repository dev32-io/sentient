import type { AttachmentImageRegion, AttachmentSourceMetadata, AttachmentViewMetadata } from "./visual-metadata.js";

const SOURCE_KEYS = new Set([
  "kind",
  "mediaType",
  "sizeBytes",
  "originalAvailable",
  "width",
  "height",
  "storedWidth",
  "storedHeight",
  "orientation",
  "pageCount",
  "frameCount",
  "durationMs",
  "hasAlpha",
  "motionAvailable",
]);
const VIEW_KEYS = new Set([
  "kind",
  "width",
  "height",
  "sourceWidth",
  "sourceHeight",
  "region",
  "frameIndex",
  "timeMs",
  "page",
  "downsampled",
  "partialCoverage",
]);
const REGION_KEYS = new Set(["x", "y", "width", "height"]);
const SOURCE_KINDS = new Set(["image", "animation", "multi_page_image", "live_photo"]);
const VIEW_KINDS = new Set(["overview", "crop", "frame", "page"]);
const MAX_SOURCE_PIXELS = 225_000_000;

export interface VisualMetadataExpectation {
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly png: Uint8Array;
  readonly maxEdge: number;
  readonly region?: AttachmentImageRegion;
  readonly frameIndex?: number;
  readonly timeMs?: number;
}

export interface ValidatedVisualMetadata {
  readonly source: AttachmentSourceMetadata;
  readonly view: AttachmentViewMetadata;
}

export function validateVisualMetadata(
  raw: string | undefined,
  expected: VisualMetadataExpectation,
): ValidatedVisualMetadata | null {
  if (
    !raw ||
    expected.png.byteLength < 24 ||
    !Buffer.from(expected.png.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return null;
  try {
    const root: unknown = JSON.parse(raw);
    if (!record(root) || !keys(root, new Set(["source", "view"])) || !record(root.source) || !record(root.view))
      return null;
    const source = root.source;
    const view = root.view;
    if (
      !keys(source, SOURCE_KEYS) ||
      !keys(view, VIEW_KEYS) ||
      !SOURCE_KINDS.has(String(source.kind)) ||
      !VIEW_KINDS.has(String(view.kind))
    )
      return null;
    if (
      source.mediaType !== expected.mediaType ||
      source.sizeBytes !== expected.sizeBytes ||
      source.originalAvailable !== true
    )
      return null;
    if (
      !dimensionPair(source.width, source.height, MAX_SOURCE_PIXELS) ||
      !dimensionPair(source.storedWidth, source.storedHeight, MAX_SOURCE_PIXELS)
    )
      return null;
    if (
      expected.mediaType === "application/vnd.sentient.live-photo+zip"
        ? source.kind !== "live_photo" || source.motionAvailable !== true
        : source.kind === "live_photo"
    )
      return null;
    if (
      !optionalInteger(source.orientation, 1, 8) ||
      !optionalInteger(source.pageCount, 1) ||
      !optionalInteger(source.frameCount, 1) ||
      !optionalInteger(source.durationMs, 0)
    )
      return null;
    if (
      (source.hasAlpha !== undefined && typeof source.hasAlpha !== "boolean") ||
      (source.motionAvailable !== undefined && typeof source.motionAvailable !== "boolean")
    )
      return null;
    if (source.kind === "animation" && (!integer(source.frameCount, 2) || source.pageCount !== undefined)) return null;
    if (source.kind === "multi_page_image" && (!integer(source.pageCount, 2) || source.frameCount !== undefined))
      return null;
    if (
      source.kind === "image" &&
      (source.pageCount !== undefined || source.frameCount !== undefined || source.motionAvailable !== undefined)
    )
      return null;

    if (
      !dimensionPair(view.width, view.height, expected.maxEdge * expected.maxEdge) ||
      Math.max(view.width as number, view.height as number) > expected.maxEdge
    )
      return null;
    if (!dimensionPair(view.sourceWidth, view.sourceHeight, MAX_SOURCE_PIXELS)) return null;
    const motionSelection =
      source.kind === "live_photo" && (expected.frameIndex !== undefined || expected.timeMs !== undefined);
    const selectedPage = source.kind === "multi_page_image" && expected.frameIndex !== undefined;
    if (!motionSelection && !selectedPage && (view.sourceWidth !== source.width || view.sourceHeight !== source.height))
      return null;
    const png = new DataView(expected.png.buffer, expected.png.byteOffset, expected.png.byteLength);
    if (view.width !== png.getUint32(16) || view.height !== png.getUint32(20)) return null;
    if (!optionalInteger(view.frameIndex, 0) || !optionalInteger(view.timeMs, 0) || !optionalInteger(view.page, 1))
      return null;
    if (typeof view.downsampled !== "boolean" || typeof view.partialCoverage !== "boolean") return null;

    const region = parseRegion(view.region);
    if (view.region !== undefined && !region) return null;
    if (expected.region) {
      if (
        !region ||
        view.kind !== "crop" ||
        !roundedRegionMatches(expected.region, region, view.sourceWidth as number, view.sourceHeight as number)
      )
        return null;
    } else if (region || view.kind === "crop") return null;
    if (expected.frameIndex !== undefined && view.frameIndex !== expected.frameIndex) return null;
    const frameCount =
      source.kind === "image" ? 1 : source.kind === "multi_page_image" ? source.pageCount : source.frameCount;
    if (
      view.frameIndex !== undefined &&
      frameCount !== undefined &&
      (view.frameIndex as number) >= (frameCount as number)
    )
      return null;
    if (
      (expected.timeMs !== undefined || view.timeMs !== undefined || source.durationMs !== undefined) &&
      source.kind !== "animation" &&
      source.kind !== "live_photo"
    )
      return null;
    if (motionSelection && expected.timeMs !== undefined && view.timeMs !== undefined) return null;
    if (
      view.timeMs !== undefined &&
      source.durationMs !== undefined &&
      (view.timeMs as number) > (source.durationMs as number)
    )
      return null;
    if (
      (expected.frameIndex !== undefined || expected.timeMs !== undefined) &&
      view.kind !== (expected.region ? "crop" : "frame")
    )
      return null;
    if (
      view.kind === "page" &&
      (source.kind !== "multi_page_image" ||
        !integer(view.page, 1) ||
        (view.page as number) > (source.pageCount as number))
    )
      return null;

    const selectedWidth = region ? region.width * (view.sourceWidth as number) : (view.sourceWidth as number);
    const selectedHeight = region ? region.height * (view.sourceHeight as number) : (view.sourceHeight as number);
    if ((view.width as number) > Math.ceil(selectedWidth) || (view.height as number) > Math.ceil(selectedHeight))
      return null;
    const downsampled =
      (view.width as number) < selectedWidth - 1e-9 || (view.height as number) < selectedHeight - 1e-9;
    if (view.downsampled !== downsampled) return null;
    return { source: source as unknown as AttachmentSourceMetadata, view: view as unknown as AttachmentViewMetadata };
  } catch {
    return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function integer(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function optionalInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): boolean {
  return value === undefined || (integer(value, minimum) && (value as number) <= maximum);
}

function dimensionPair(width: unknown, height: unknown, maxPixels: number): boolean {
  return integer(width, 1) && integer(height, 1) && width * height <= maxPixels;
}

function parseRegion(value: unknown): AttachmentImageRegion | null {
  if (!record(value) || !keys(value, REGION_KEYS)) return null;
  const numbers = [value.x, value.y, value.width, value.height];
  if (!numbers.every((item) => typeof item === "number" && Number.isFinite(item))) return null;
  const x = value.x as number;
  const y = value.y as number;
  const width = value.width as number;
  const height = value.height as number;
  return x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 1 + 1e-12 && y + height <= 1 + 1e-12
    ? { x, y, width, height }
    : null;
}

function roundedRegionMatches(
  requested: AttachmentImageRegion,
  actual: AttachmentImageRegion,
  width: number,
  height: number,
): boolean {
  return (
    Math.abs(requested.x - actual.x) <= 1 / width + 1e-12 &&
    Math.abs(requested.y - actual.y) <= 1 / height + 1e-12 &&
    Math.abs(requested.x + requested.width - actual.x - actual.width) <= 1 / width + 1e-12 &&
    Math.abs(requested.y + requested.height - actual.y - actual.height) <= 1 / height + 1e-12
  );
}
