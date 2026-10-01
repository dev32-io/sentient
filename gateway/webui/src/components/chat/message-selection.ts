import type { RefObject } from "preact";
import { useLayoutEffect } from "preact/hooks";

const BLOCKS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "PRE",
  "BLOCKQUOTE",
  "UL",
  "OL",
  "LI",
  "TABLE",
  "DIV",
  "HR",
]);
interface TextSpan {
  node: Text;
  start: number;
  end: number;
}

/** Browser DOM remains display/selection authority. This projection only defines
 * Copy separators and UTF-16 positions; it never measures or paints content.
 */
export function messageProjection(root: Node): { plain: string; spans: TextSpan[] } {
  let plain = "";
  const spans: TextSpan[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const start = plain.length;
      plain += node.textContent ?? "";
      spans.push({ node: node as Text, start, end: plain.length });
      return;
    }
    if (!(node instanceof Element) && node !== root) return;
    if (node instanceof Element && node.hasAttribute("data-copy-ignore")) return;
    if (node.nodeName === "BR") {
      plain += "\n";
      return;
    }
    const children =
      node.nodeName === "TABLE"
        ? Array.from((node as HTMLTableElement).rows)
        : Array.from(node.childNodes).filter(
            (child) => !(child instanceof Element && child.hasAttribute("data-copy-ignore")),
          );
    children.forEach((child, index) => {
      const previous = children[index - 1];
      if (previous) {
        if (node.nodeName === "TR") plain += "\t";
        else if (node.nodeName === "TABLE" || BLOCKS.has(child.nodeName) || BLOCKS.has(previous.nodeName))
          plain += "\n";
      }
      visit(child);
    });
  };
  visit(root);
  return { plain, spans };
}

type Projection = ReturnType<typeof messageProjection>;
function offsetAt(projection: Projection, node: Node, offset: number): number {
  const own = projection.spans.find((span) => span.node === node);
  if (own) return own.start + Math.min(offset, own.end - own.start);
  const boundary = node.ownerDocument?.createRange();
  if (!boundary) return 0;
  boundary.setStart(node, offset);
  boundary.collapse(true);
  for (const span of projection.spans) {
    if (boundary.comparePoint(span.node, 0) >= 0) return span.start;
  }
  return projection.plain.length;
}
function pointAt(projection: Projection, offset: number): [Node, number] | undefined {
  const span = projection.spans.find((entry) => entry.end >= offset) ?? projection.spans.at(-1);
  return span ? [span.node, Math.max(0, Math.min(offset - span.start, span.end - span.start))] : undefined;
}

function ownedSelection(root: HTMLElement, clamp = false): Selection | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection?.anchorNode || !root.contains(selection.anchorNode)) return null;
  if (selection.focusNode && !root.contains(selection.focusNode)) {
    if (!clamp) return null;
    const projection = messageProjection(root);
    const end =
      root.compareDocumentPosition(selection.focusNode) & Node.DOCUMENT_POSITION_PRECEDING
        ? 0
        : projection.plain.length;
    const point = pointAt(projection, end);
    if (point) selection.setBaseAndExtent(selection.anchorNode, selection.anchorOffset, ...point);
  }
  return selection;
}

export function selectedMessageText(root: HTMLElement): string | null {
  const selection = ownedSelection(root, true);
  if (!selection?.anchorNode || !selection.focusNode || selection.isCollapsed) return null;
  const projection = messageProjection(root);
  const anchor = offsetAt(projection, selection.anchorNode, selection.anchorOffset);
  const focus = offsetAt(projection, selection.focusNode, selection.focusOffset);
  return projection.plain.slice(Math.min(anchor, focus), Math.max(anchor, focus));
}

/** Retain endpoints outside the changed middle; clamp positions inside replaced
 * text. Append-only streams therefore keep valid UTF-16 endpoints unchanged.
 */
function mappedOffset(old: string, next: string, offset: number): number {
  let prefix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < old.length - prefix &&
    suffix < next.length - prefix &&
    old[old.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix++;
  if (offset <= prefix) return offset;
  if (offset >= old.length - suffix) return offset + next.length - old.length;
  return Math.min(offset, next.length - suffix);
}

export function useMessageSelection(root: RefObject<HTMLDivElement>): void {
  // Capture before Preact's DOM diff, not after it invalidates native endpoints.
  const element = root.current;
  const selection = element && ownedSelection(element);
  const old = element && selection ? messageProjection(element) : null;
  const saved =
    old && selection?.anchorNode && selection.focusNode
      ? {
          plain: old.plain,
          anchor: offsetAt(old, selection.anchorNode, selection.anchorOffset),
          focus: offsetAt(old, selection.focusNode, selection.focusOffset),
        }
      : null;
  useLayoutEffect(() => {
    if (!root.current || !saved) return;
    const next = messageProjection(root.current);
    const anchor = pointAt(next, mappedOffset(saved.plain, next.plain, saved.anchor));
    const focus = pointAt(next, mappedOffset(saved.plain, next.plain, saved.focus));
    if (anchor && focus) {
      root.current.ownerDocument.getSelection()?.setBaseAndExtent(...anchor, ...focus);
    }
  });
  useLayoutEffect(() => {
    const current = root.current;
    if (!current) return;
    const document = current.ownerDocument;
    const bound = () => {
      ownedSelection(current, true);
    };
    const copy = (event: ClipboardEvent) => {
      const text = selectedMessageText(current);
      if (text === null || !event.clipboardData) return;
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
    };
    const selectAll = (event: KeyboardEvent) => {
      const selection =
        ownedSelection(current, true) ?? (current.contains(document.activeElement) ? document.getSelection() : null);
      if (!selection || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "a") return;
      const projection = messageProjection(current);
      const start = pointAt(projection, 0);
      const end = pointAt(projection, projection.plain.length);
      if (start && end) {
        selection.setBaseAndExtent(...start, ...end);
        event.preventDefault();
      }
    };
    document.addEventListener("selectionchange", bound);
    document.addEventListener("copy", copy);
    document.addEventListener("keydown", selectAll);
    return () => {
      document.removeEventListener("selectionchange", bound);
      document.removeEventListener("copy", copy);
      document.removeEventListener("keydown", selectAll);
    };
  }, [root]);
}

export function tableMarkdown(table: HTMLTableElement): string {
  const rows = Array.from(table.rows, (row) => Array.from(row.cells, (cell) => messageProjection(cell).plain));
  const renderRow = (cells: string[]) =>
    `| ${cells.map((cell) => cell.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", "<br>")).join(" | ")} |`;
  const header = rows[0];
  return header
    ? [renderRow(header), renderRow(header.map(() => "---")), ...rows.slice(1).map(renderRow)].join("\n")
    : "";
}
