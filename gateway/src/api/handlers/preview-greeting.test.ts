import { describe, expect, it } from "bun:test";
import { pickPreviewGreeting } from "./preview-greeting.ts";

const G = { en: ["hi-en"], zh: ["你好-zh"] };
describe("pickPreviewGreeting", () => {
  it("uses the requested language's list", () => {
    expect(pickPreviewGreeting(G, "zh")).toBe("你好-zh");
  });
  it("falls back to English for unset/unknown/absent lang", () => {
    expect(pickPreviewGreeting(G, "")).toBe("hi-en");
    expect(pickPreviewGreeting(G, "th")).toBe("hi-en");
    expect(pickPreviewGreeting({ zh: ["只有中文"] }, "th")).toBe("只有中文"); // no en → any available
  });
  it("falls through a present-but-empty en to another populated language", () => {
    expect(pickPreviewGreeting({ en: [], zh: ["只有中文"] }, "th")).toBe("只有中文");
    expect(pickPreviewGreeting({ en: [], zh: ["只有中文"] }, "en")).toBe("只有中文");
  });
  it("returns the bare fallback when everything is empty", () => {
    expect(pickPreviewGreeting({ en: [], zh: [] }, "zh")).toBe("Hello.");
    expect(pickPreviewGreeting({}, "en")).toBe("Hello.");
  });
});
