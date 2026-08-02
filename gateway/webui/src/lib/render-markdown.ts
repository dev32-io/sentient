import DOMPurify from "isomorphic-dompurify";
import { type Token, type Tokens, marked } from "marked";

// Configure marked once at module load.
// - gfm + breaks: GitHub-flavored markdown with soft-line-breaks -> <br>.
// - async: false — streaming re-renders on every delta; must be sync.
// - walkTokens: rescues terse assistant replies from a CommonMark quirk
//   that renders them as nothing. See rescueBareListMarker below.
marked.use({ gfm: true, breaks: true, async: false, walkTokens: rescueBareListMarker });

/**
 * CommonMark treats a bare list marker with nothing after it — "84.", "3.",
 * "-" — as valid syntax for a single list item with an EMPTY body: marked
 * parses it as `{ type: "list", items: [{ text: "", tokens: [] }] }`, which
 * renders as `<ol start="84"><li></li></ol>` — visually nothing. The digits
 * became the list's start number, not the answer.
 *
 * This is not an edge case for a voice-first assistant: a terse factual
 * reply ("what's the thermostat set to?" -> "68.") is the COMMON shape, not
 * a rare one, so silently blanking it is severe — the user sees an empty
 * bubble with no indication anything went wrong.
 *
 * Fixed here, in the markdown layer, rather than with a "is this whole
 * reply a bare number" guard in renderMarkdown: a token-shape check
 * generalizes to every marker CommonMark treats this way (ordered
 * "84."/"84)", unordered "-"/"*"), it composes for free with streaming
 * (mid-list-item punctuation resolves itself as more tokens arrive), and it
 * cannot regress a genuine list — a real list's first item always has
 * content, so "one item, empty text, empty tokens" only ever matches the
 * swallowed-answer shape. Re-parses the token in place as a paragraph
 * carrying the original marker text verbatim (e.g. "84.").
 */
function rescueBareListMarker(token: Token): void {
  if (token.type !== "list") return;
  if (token.items.length !== 1) return;
  const [item] = token.items;
  if (item.text !== "" || item.tokens.length > 0) return;
  const paragraph = token as unknown as Tokens.Paragraph;
  paragraph.type = "paragraph";
  paragraph.text = token.raw;
  paragraph.tokens = [{ type: "text", raw: token.raw, text: token.raw, escaped: false }];
}

const ALLOWED_TAGS = [
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "ul",
  "del",
  "span",
];

const ALLOWED_ATTR = ["href", "title", "target", "rel"];

/**
 * Parse assistant markdown text and return sanitized HTML.
 * Runs on every streaming render; keep it cheap and synchronous.
 */
export function renderMarkdown(text: string): string {
  const rawHtml = marked.parse(text) as string;
  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
  });
}
