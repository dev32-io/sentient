import { describe, expect, it } from "vitest";
import { createMarkdownStripper } from "./markdown-stripper.ts";
import { FLUSH_SIGNAL, type TtsChunk } from "./stage-types.ts";

async function* fromChunks(chunks: TtsChunk[]): AsyncGenerator<TtsChunk> {
  for (const c of chunks) yield c;
}

async function collect(input: TtsChunk[]): Promise<string> {
  const ctrl = new AbortController();
  const out: string[] = [];
  const stripper = createMarkdownStripper();
  for await (const chunk of stripper(fromChunks(input), ctrl.signal)) {
    if (chunk !== FLUSH_SIGNAL) out.push(chunk);
  }
  return out.join("");
}

describe("markdown-stripper", () => {
  // Regression: per-token streaming used to splinter `**bold.**` across slices
  // because the boundary heuristic split on `.` mid-construct. The first slice
  // (`**bold.`) had an unclosed bold marker and `removeMd` left the asterisks
  // intact; the closing `**` then orphaned in the next slice. See the comment
  // block at the top of markdown-stripper.ts.
  it("strips bold even when delivered token-by-token across a sentence-ending period", async () => {
    const out = await collect(["**", "bold", ".", "**", "\n"]);
    expect(out).not.toContain("*");
    expect(out).toContain("bold");
  });

  it("strips a list item delivered as separate tokens", async () => {
    const out = await collect(["- ", "**Lofi", " Music**", "\n"]);
    expect(out).not.toContain("*");
    expect(out).not.toContain("- ");
    expect(out).toContain("Lofi Music");
  });

  it("strips a link delivered as separate tokens", async () => {
    const out = await collect(["[", "Open ", "site", "](", "https://x.com", ")", "\n"]);
    expect(out).not.toMatch(/[[\]()]/);
    expect(out).toContain("Open site");
  });

  it("buffers across chunks with no newline, holding markdown markers until paragraph end", async () => {
    const ctrl = new AbortController();
    const stripper = createMarkdownStripper();
    const yields: TtsChunk[] = [];
    const iter = stripper(fromChunks(["This ", "is ", "**bold** ", "text"]), ctrl.signal);
    for await (const c of iter) yields.push(c);
    // No `\n` at all, so the only output is the final buffer-flush on stream end.
    expect(yields.join("")).toBe("This is bold text");
  });

  it("flushes buffered text on FLUSH_SIGNAL and re-emits the marker", async () => {
    const ctrl = new AbortController();
    const stripper = createMarkdownStripper();
    const out: TtsChunk[] = [];
    for await (const c of stripper(fromChunks(["Let me ", "check", FLUSH_SIGNAL]), ctrl.signal)) {
      out.push(c);
    }
    const strings = out.filter((c): c is string => c !== FLUSH_SIGNAL);
    expect(strings.join("")).toBe("Let me check");
    expect(out).toContain(FLUSH_SIGNAL);
  });

  it("stops yielding new text after abort fires mid-stream", async () => {
    const ctrl = new AbortController();
    const stripper = createMarkdownStripper();
    const out: TtsChunk[] = [];
    async function* slow(): AsyncGenerator<TtsChunk> {
      yield "first chunk\n";
      ctrl.abort();
      yield "second chunk that must be dropped\n";
    }
    for await (const c of stripper(slow(), ctrl.signal)) out.push(c);
    const joined = out.filter((c): c is string => c !== FLUSH_SIGNAL).join("");
    // First chunk may emit (it was processed before the abort fired); the
    // second chunk MUST NOT appear in the output once abort propagates.
    expect(joined).not.toContain("second chunk");
  });

  // Big code blocks are unintelligible to a TTS engine. Read aloud they sound
  // like ASCII soup. The streaming-markdown library tracks code fences across
  // chunks; the renderer suppresses every `add_text` while the stack contains
  // a CODE_BLOCK / CODE_FENCE token.
  it("skips fenced code blocks entirely", async () => {
    const out = await collect([
      "Here is some code:\n",
      "```ts\n",
      "const x = 1;\n",
      "function add(a: number, b: number) { return a + b; }\n",
      "```\n",
      "All done.\n",
    ]);
    expect(out).toContain("Here is some code");
    expect(out).toContain("All done");
    expect(out).not.toContain("const x");
    expect(out).not.toContain("function add");
    expect(out).not.toContain("```");
  });

  // Inline code is usually a short identifier (a function name, an ENV var)
  // and IS speakable, so we keep it. The parser eats the surrounding
  // backticks; only the inner text reaches `add_text`.
  it("reads inline code as plain text without backticks", async () => {
    const out = await collect(["Use the ", "`useState`", " hook.\n"]);
    expect(out).toContain("useState");
    expect(out).not.toContain("`");
  });

  // Raw URLs are awful when read aloud (https slash slash etc.). The library
  // detects them as RAW_URL tokens; the renderer suppresses their text.
  it("drops raw URLs", async () => {
    const out = await collect(["See https://example.com/foo for details.\n"]);
    expect(out).not.toContain("https");
    expect(out).not.toContain("example.com");
    expect(out).toContain("See");
    expect(out).toContain("for details");
  });

  // Markdown links keep the visible text but drop the URL — the user hears
  // the natural-language label, not the destination.
  it("reads link text without the URL", async () => {
    const out = await collect(["Check the ", "[docs](https://example.com)", " page.\n"]);
    expect(out).toContain("docs");
    expect(out).toContain("page");
    expect(out).not.toContain("https");
    expect(out).not.toContain("example.com");
  });
});
