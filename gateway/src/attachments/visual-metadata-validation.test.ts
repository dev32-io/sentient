import { describe, expect, it } from "bun:test";
import { validateVisualMetadata } from "./visual-metadata-validation.js";

const PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
);

const source = {
  kind: "animation",
  mediaType: "image/gif",
  sizeBytes: 123,
  originalAvailable: true,
  width: 4000,
  height: 3000,
  storedWidth: 4000,
  storedHeight: 3000,
  frameCount: 3,
  durationMs: 300,
  hasAlpha: true,
};
const view = {
  kind: "crop",
  width: 1,
  height: 1,
  sourceWidth: 4000,
  sourceHeight: 3000,
  region: { x: 0.5, y: 0, width: 0.5, height: 1 },
  frameIndex: 1,
  timeMs: 100,
  downsampled: true,
  partialCoverage: true,
};
const expected = {
  mediaType: "image/gif",
  sizeBytes: 123,
  png: PNG,
  maxEdge: 800,
  region: { x: 0.5, y: 0, width: 0.5, height: 1 },
  frameIndex: 1,
};
const raw = (sourceOverride = {}, viewOverride = {}) =>
  JSON.stringify({ source: { ...source, ...sourceOverride }, view: { ...view, ...viewOverride } });

describe("visual metadata validation", () => {
  it("accepts exact identity, PNG dimensions, selector semantics, and pixel-rounded ROI", () => {
    expect(validateVisualMetadata(raw(), expected)).not.toBeNull();
    expect(
      validateVisualMetadata(raw({}, { region: { x: 0.4998, y: 0, width: 0.5002, height: 1 } }), expected),
    ).not.toBeNull();
    expect(validateVisualMetadata(raw({}, { region: { x: 0.49, y: 0, width: 0.51, height: 1 } }), expected)).toBeNull();
  });

  it("fails closed for missing, malformed, extra/private, MIME, size, and PNG dimension mismatches", () => {
    expect(validateVisualMetadata(undefined, expected)).toBeNull();
    expect(validateVisualMetadata("{", expected)).toBeNull();
    expect(validateVisualMetadata(JSON.stringify({ source, view, private: true }), expected)).toBeNull();
    expect(validateVisualMetadata(raw({ privatePath: "/tmp/source" }), expected)).toBeNull();
    expect(validateVisualMetadata(raw({ mediaType: "image/png" }), expected)).toBeNull();
    expect(validateVisualMetadata(raw({ sizeBytes: 122 }), expected)).toBeNull();
    expect(validateVisualMetadata(raw({}, { sourceWidth: 3999 }), expected)).toBeNull();
    expect(validateVisualMetadata(raw({}, { width: 2 }), expected)).toBeNull();
  });

  it("requires exact frame selection, bounded dimensions, and truthful output scaling", () => {
    expect(validateVisualMetadata(raw({}, { frameIndex: 2 }), expected)).toBeNull();
    expect(validateVisualMetadata(raw({ width: Number.POSITIVE_INFINITY }), expected)).toBeNull();
    expect(validateVisualMetadata(raw({ width: 20_000, height: 20_000 }), expected)).toBeNull();
    expect(validateVisualMetadata(raw({}, { downsampled: false }), expected)).toBeNull();
  });

  it("accepts static frame zero and TIFF page selection without inventing motion or equal page dimensions", () => {
    const staticSource = { kind: "image", mediaType: "image/png", frameCount: undefined, durationMs: undefined };
    const staticExpected = { ...expected, mediaType: "image/png", frameIndex: 0 };
    expect(
      validateVisualMetadata(raw(staticSource, { frameIndex: 0, timeMs: undefined }), staticExpected),
    ).not.toBeNull();
    expect(
      validateVisualMetadata(raw(staticSource, { frameIndex: 1, timeMs: undefined }), {
        ...staticExpected,
        frameIndex: 1,
      }),
    ).toBeNull();

    expect(validateVisualMetadata(raw(staticSource, { frameIndex: 0, timeMs: 0 }), staticExpected)).toBeNull();
    expect(
      validateVisualMetadata(
        raw({ ...staticSource, durationMs: 100 }, { frameIndex: 0, timeMs: undefined }),
        staticExpected,
      ),
    ).toBeNull();
    const pagedSource = { ...staticSource, kind: "multi_page_image", mediaType: "image/tiff", pageCount: 3 };
    const pageExpected = { ...expected, mediaType: "image/tiff" };
    const selectedView = { sourceWidth: 2000, sourceHeight: 1000, timeMs: undefined };
    expect(validateVisualMetadata(raw(pagedSource, selectedView), pageExpected)).not.toBeNull();
    expect(validateVisualMetadata(raw(pagedSource, { ...selectedView, timeMs: 0 }), pageExpected)).toBeNull();
    expect(
      validateVisualMetadata(raw(pagedSource, { ...selectedView, frameIndex: 3 }), { ...pageExpected, frameIndex: 3 }),
    ).toBeNull();
    const { frameIndex: _frameIndex, ...withoutFrame } = pageExpected;
    expect(validateVisualMetadata(raw(pagedSource, selectedView), { ...withoutFrame, timeMs: 100 })).toBeNull();
  });

  it("allows unknown actual time but rejects impossible timestamps", () => {
    const { frameIndex: _frameIndex, ...withoutFrame } = expected;
    const timed = { ...withoutFrame, timeMs: 150 };
    expect(validateVisualMetadata(raw({}, { frameIndex: undefined, timeMs: undefined }), timed)).not.toBeNull();
    expect(validateVisualMetadata(raw({}, { frameIndex: undefined, timeMs: 301 }), timed)).toBeNull();

    const liveSource = {
      ...source,
      kind: "live_photo",
      mediaType: "application/vnd.sentient.live-photo+zip",
      motionAvailable: true,
      frameCount: undefined,
    };
    const liveExpected = { ...timed, mediaType: "application/vnd.sentient.live-photo+zip" };
    expect(
      validateVisualMetadata(
        JSON.stringify({ source: liveSource, view: { ...view, frameIndex: undefined, timeMs: undefined } }),
        liveExpected,
      ),
    ).not.toBeNull();
    expect(
      validateVisualMetadata(
        JSON.stringify({ source: liveSource, view: { ...view, frameIndex: undefined, timeMs: 150 } }),
        liveExpected,
      ),
    ).toBeNull();
  });
});
