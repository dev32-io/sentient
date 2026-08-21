import { describe, expect, it } from "vitest";
import { type EventPreviewAnchorRect, calculateEventPreviewPosition } from "./event-preview-position.ts";

const size = { width: 320, height: 240 };
const viewport = { width: 1440, height: 1000 };
const anchor = (left: number, top: number, width = 40, height = 28): EventPreviewAnchorRect => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

describe("calculateEventPreviewPosition", () => {
  it("prefers the right side when the measured panel fits", () => {
    const result = calculateEventPreviewPosition(anchor(400, 300), viewport, size);
    expect(result.placement).toBe("right");
    expect(result.left).toBe(452);
    expect(result.top).toBe(194);
  });

  it("falls back to the left side when the right edge is unavailable", () => {
    const result = calculateEventPreviewPosition(anchor(1120, 300), viewport, size);
    expect(result.placement).toBe("left");
    expect(result.left).toBe(788);
    expect(result.top).toBe(194);
  });

  it("falls back below when neither side has enough horizontal room", () => {
    const result = calculateEventPreviewPosition(anchor(180, 300), { width: 390, height: 844 }, size);
    expect(result.placement).toBe("below");
    expect(result.left).toBe(58);
    expect(result.top).toBe(340);
  });

  it("clamps a panel near every viewport edge without changing its placement contract", () => {
    const result = calculateEventPreviewPosition(anchor(-20, -50), { width: 390, height: 844 }, size, {
      margin: 12,
    });
    expect(result.left).toBe(32);
    expect(result.top).toBe(12);
    expect(result.left + result.width).toBeLessThanOrEqual(378);
    expect(result.top + result.height).toBeLessThanOrEqual(832);

    const bottom = calculateEventPreviewPosition(anchor(110, 820), { width: 390, height: 844 }, size);
    expect(bottom.top).toBe(592);
    expect(bottom.top + bottom.height).toBe(832);
  });

  it("shrinks width and bounds height to the reachable viewport", () => {
    const result = calculateEventPreviewPosition(
      anchor(120, 400),
      { width: 280, height: 180 },
      { width: 480, height: 900 },
    );
    expect(result.width).toBe(256);
    expect(result.maxHeight).toBe(156);
    expect(result.height).toBe(156);
    expect(result.left).toBe(12);
    expect(result.top).toBe(12);
  });

  it("keeps the arrow coordinate inside the panel when clamping", () => {
    const result = calculateEventPreviewPosition(anchor(380, 20), viewport, size);
    expect(result.arrowX).toBeGreaterThanOrEqual(20);
    expect(result.arrowX).toBeLessThanOrEqual(size.width - 20);
    expect(result.arrowY).toBeGreaterThanOrEqual(20);
    expect(result.arrowY).toBeLessThanOrEqual(size.height - 20);
  });
});
