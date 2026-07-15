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
});
