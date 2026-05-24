import { describe, expect, it } from "vitest";
import { PartialJsonFieldExtractor } from "./partial-json-field-extractor.ts";

describe("PartialJsonFieldExtractor", () => {
  it("extracts a simple string field arriving in one chunk", () => {
    const ex = new PartialJsonFieldExtractor("text");
    const out = ex.feed('{"summary":"x","text":"Hello"}');
    expect(out).toBe("Hello");
    expect(ex.isTerminated()).toBe(true);
  });

  it("streams the field value as it grows across chunks", () => {
    const ex = new PartialJsonFieldExtractor("text");
    expect(ex.feed('{"text":"Hel')).toBe("Hel");
    expect(ex.feed("lo, wor")).toBe("lo, wor");
    expect(ex.feed('ld!"}')).toBe("ld!");
    expect(ex.isTerminated()).toBe(true);
  });

  it("waits until the opening quote of the target field arrives", () => {
    const ex = new PartialJsonFieldExtractor("text");
    expect(ex.feed('{"summary":"foo","text":')).toBe("");
    expect(ex.feed('"Hi"}')).toBe("Hi");
  });

  it("returns empty when the field never appears", () => {
    const ex = new PartialJsonFieldExtractor("text");
    expect(ex.feed('{"summary":"foo"}')).toBe("");
    expect(ex.isTerminated()).toBe(false);
  });

  it("decodes simple escape sequences once fully resolved", () => {
    const ex = new PartialJsonFieldExtractor("text");
    expect(ex.feed('{"text":"a\\')).toBe("a");
    expect(ex.feed('nb"}')).toBe("\nb");
  });

  it("handles \\uXXXX unicode escape split across chunks", () => {
    const ex = new PartialJsonFieldExtractor("text");
    expect(ex.feed('{"text":"abc\\u00')).toBe("abc");
    expect(ex.feed('41def"}')).toBe("Adef");
  });

  it("handles an embedded escaped quote", () => {
    const ex = new PartialJsonFieldExtractor("text");
    const out = ex.feed('{"text":"She said \\"hi\\" back"}');
    expect(out).toBe('She said "hi" back');
    expect(ex.isTerminated()).toBe(true);
  });

  it("stops emitting after the terminating quote", () => {
    const ex = new PartialJsonFieldExtractor("text");
    ex.feed('{"text":"done"}');
    expect(ex.feed(",extra")).toBe("");
    expect(ex.isTerminated()).toBe(true);
  });

  it("does not cross-match fields whose name is a prefix of the target", () => {
    const ex = new PartialJsonFieldExtractor("text");
    // "text_hint" should not satisfy the "text" key lookup.
    const out = ex.feed('{"text_hint":"nope","text":"real"}');
    expect(out).toBe("real");
  });
});
