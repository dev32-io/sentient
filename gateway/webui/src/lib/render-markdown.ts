import DOMPurify from "isomorphic-dompurify";
import { marked } from "marked";

// Configure marked once at module load.
// - gfm + breaks: GitHub-flavored markdown with soft-line-breaks -> <br>.
// - async: false — streaming re-renders on every delta; must be sync.
marked.use({ gfm: true, breaks: true, async: false });

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
