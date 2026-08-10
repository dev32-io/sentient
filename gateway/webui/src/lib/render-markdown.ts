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
 * "-" — as valid syntax for a list item with an EMPTY body: marked parses
 * "84." as `{ type: "list", items: [{ text: "", tokens: [] }] }`, which
 * renders as `<ol start="84"><li></li></ol>` — visually nothing. The digits
 * became the list's start number, not the answer.
 *
 * This is not an edge case for a voice-first assistant: a terse factual
 * reply ("what's the thermostat set to?" -> "68.") is the COMMON shape, not
 * a rare one, so silently blanking it is severe — the user sees an empty
 * bubble with no indication anything went wrong.
 *
 * The property that identifies the defect is "this list item has a marker
 * and no content" — an item where `text === "" && tokens.length === 0`.
 * That is independent of how many siblings the item has: a bare marker
 * followed immediately by a genuine list of the SAME marker type (e.g.
 * "84." then a blank line then "1. check the batteries") is not two
 * tokens, it's one CommonMark list with the bare item as its first
 * element — so a guard that only looked at single-item lists missed every
 * merged case.
 *
 * Two shapes, handled differently:
 * - Every item in the list is bare (the whole "list" is really just terse
 *   plain text, e.g. "84." alone, or "84." then "85."): re-parse the whole
 *   token in place as a paragraph carrying the original text verbatim, so
 *   it renders with no `<ol>`/`<ul>` wrapper at all.
 * - Only SOME items are bare (a real list merged with a bare marker):
 *   rescue just those items in place — give each one the marker text as
 *   its own content — and leave the list token and the genuine items
 *   untouched, so the real list still renders as a list.
 *
 * Fixed here, in the markdown layer, rather than with a "is this whole
 * reply a bare number" guard in renderMarkdown: a token-shape check
 * generalizes to every marker CommonMark treats this way (ordered
 * "84."/"84)", unordered "-"/"*"), it composes for free with streaming
 * (mid-list-item punctuation resolves itself as more tokens arrive), and it
 * cannot regress a genuine list — a real list item always has content, so
 * "empty text, empty tokens" only ever matches the swallowed-answer shape.
 */
function rescueBareListMarker(token: Token): void {
  if (token.type !== "list") return;
  const bareItems = token.items.filter(isBareMarkerItem);
  if (bareItems.length === 0) return;

  if (bareItems.length === token.items.length) {
    const paragraph = token as unknown as Tokens.Paragraph;
    paragraph.type = "paragraph";
    paragraph.text = token.raw;
    paragraph.tokens = [{ type: "text", raw: token.raw, text: token.raw, escaped: false }];
    return;
  }

  for (const item of bareItems) {
    const markerText = item.raw.trimEnd();
    item.text = markerText;
    item.tokens = [{ type: "text", raw: markerText, text: markerText, escaped: false }];
  }
}

function isBareMarkerItem(item: Tokens.ListItem): boolean {
  return item.text === "" && item.tokens.length === 0;
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

// "start" is needed so a rescued bare marker merged into a real ordered list
// (see rescueBareListMarker) keeps its correct numbering instead of the
// <ol> silently renumbering from 1 once DOMPurify strips the attribute.
const ALLOWED_ATTR = ["href", "title", "target", "rel", "start"];

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
