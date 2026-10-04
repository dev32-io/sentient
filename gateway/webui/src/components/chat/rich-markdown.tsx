import { type ComponentChildren, type JSX, createElement } from "preact";
import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { type MarkdownImages, renderMarkdown } from "../../lib/render-markdown.ts";
import type { ChatAttachment } from "../../types.ts";
import { ActionButton } from "../common/foundation/buttons.tsx";
import { type AttachmentAsset, attachmentKey } from "./attachment-cards.tsx";
import { BubbleSelectionOwner, tableMarkdown, useMessageSelection } from "./message-selection.ts";

/** No new media loader: only this bubble's already-authorized attachment assets.
 * Markdown uses the existing preview endpoint; rendering uses its owned blob.
 */
export function messageImages(
  attachments: readonly ChatAttachment[] | undefined,
  assets: Readonly<Record<string, AttachmentAsset>>,
): MarkdownImages {
  const images = new Map<string, string>();
  for (const attachment of attachments ?? []) {
    if (attachment.kind !== "remote") continue;
    const preview = assets[attachmentKey(attachment)]?.previewUrl;
    if (!preview?.startsWith("blob:")) continue;
    images.set(`/api/v1/attachments/${encodeURIComponent(attachment.ref.attachmentId)}/preview`, preview);
  }
  return images;
}

function MarkdownTable({ children }: { children: ComponentChildren }): JSX.Element {
  const viewport = useRef<HTMLElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const offset = useRef(0);
  const [remaining, setRemaining] = useState({ left: false, right: false });
  const [copyState, setCopyState] = useState("Copy Markdown");
  const update = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    const max = Math.max(0, element.scrollWidth - element.clientWidth);
    element.scrollLeft = Math.min(Math.max(0, offset.current), max);
    offset.current = element.scrollLeft;
    const left = offset.current > 1;
    const right = max - offset.current > 1;
    setRemaining((previous) => (previous.left === left && previous.right === right ? previous : { left, right }));
  }, []);
  useLayoutEffect(update);
  useLayoutEffect(() => {
    if (!viewport.current || !globalThis.ResizeObserver) return;
    const observer = new ResizeObserver(update);
    observer.observe(viewport.current);
    if (table.current) observer.observe(table.current);
    return () => observer.disconnect();
  }, [update]);
  const copy = async () => {
    if (!table.current) return;
    try {
      await navigator.clipboard.writeText(tableMarkdown(table.current));
      setCopyState("Copied Markdown");
    } catch {
      setCopyState("Copy failed — try again");
    }
  };
  return (
    <div class="markdown-table">
      <div class="markdown-table__tools" data-copy-ignore>
        <ActionButton
          variant="quiet"
          onClick={() => {
            void copy();
          }}
          ariaLabel="Copy table as Markdown"
        >
          Copy Markdown
        </ActionButton>
        <output>{copyState === "Copy Markdown" ? "" : copyState}</output>
      </div>
      <div class="markdown-table__edges" data-left={remaining.left} data-right={remaining.right}>
        <section
          class="markdown-table__viewport"
          ref={viewport}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Scroll viewport needs native keyboard scrolling.
          tabIndex={0}
          aria-label="Scrollable table"
          onScroll={() => {
            offset.current = viewport.current?.scrollLeft ?? 0;
            update();
          }}
        >
          <table ref={table}>{children}</table>
        </section>
      </div>
    </div>
  );
}

/** Translate only sanitized DOM to ordinary Preact elements. Preact owns/reuses
 * nodes; no innerHTML replacement, second parser, layout or renderer substrate.
 */
function elements(node: Node, inPre = false): ComponentChildren {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    // marked emits formatting newlines between blocks; inline whitespace and
    // code whitespace remain content, not parser formatting.
    return !inPre && /^\s*\n\s*$/.test(text) ? null : text;
  }
  if (!(node instanceof Element)) return null;
  const children = Array.from(node.childNodes, (child) => elements(child, inPre || node.tagName === "PRE"));
  if (node.tagName === "TABLE") return <MarkdownTable>{children}</MarkdownTable>;
  const attributes = Object.fromEntries(Array.from(node.attributes, (attribute) => [attribute.name, attribute.value]));
  return createElement(node.tagName.toLowerCase(), attributes, children);
}

export function RichMarkdown({ text, images }: { text: string; images?: MarkdownImages | undefined }): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  useMessageSelection(root, !useContext(BubbleSelectionOwner));
  const children = useMemo(() => {
    const template = document.createElement("template");
    template.innerHTML = renderMarkdown(text, images);
    return Array.from(template.content.childNodes, (node) => elements(node));
  }, [text, images]);
  return (
    <div class="bubble-text__md" ref={root}>
      {children}
    </div>
  );
}
