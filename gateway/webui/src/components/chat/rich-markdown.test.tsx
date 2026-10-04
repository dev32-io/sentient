import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { R0_MARKDOWN, R0_PLAIN, R0_TABLE_MARKDOWN } from "../../qa/rich-message-fixture.ts";
import { MessageBubble } from "./message-bubble.tsx";
import { MessageContent } from "./message-content.tsx";
import { messageProjection, selectedMessageText, tableMarkdown } from "./message-selection.ts";

function documentRoot(container: Element): HTMLElement {
  const root = container.querySelector<HTMLElement>(".bubble-text__md");
  if (!root) throw new Error("Missing message document");
  return root;
}
function textNode(element: Element | null): Text {
  const node = element?.firstChild;
  if (!(node instanceof Text)) throw new Error("Missing text");
  return node;
}
function select(anchor: Node, anchorOffset: number, focus: Node, focusOffset: number): void {
  document.getSelection()?.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  cleanup();
  vi.unstubAllGlobals();
});

describe("rich message native document", () => {
  it("renders only this bubble's authorized inline preview and preserves selection on asset arrival/removal", () => {
    const attachmentId = "att_0123456789abcdef0123456789abcdef";
    const path = `/api/v1/attachments/${attachmentId}/preview`;
    const message = {
      id: "media",
      role: "user" as const,
      text: `${R0_MARKDOWN}\n\n![Owned](${path}) ![Other](/api/v1/attachments/other/preview)`,
      isStreaming: false,
      timestamp: 0,
      attachments: [
        {
          kind: "remote" as const,
          ref: { attachmentId, displayName: "Image", contentType: "image/png", mediaKind: "image" as const, size: 68 },
        },
      ],
    };
    const currentUser = { displayName: "Fixture", avatarTint: "terra" as const };
    const view = render(<MessageBubble message={message} currentUser={currentUser} identityState="idle" />);
    const root = documentRoot(view.container);
    select(textNode(root.querySelector("p")), 7, textNode(root.querySelectorAll("td")[1] ?? null), 15);
    const selected = selectedMessageText(root);
    view.rerender(
      <MessageBubble
        message={message}
        currentUser={currentUser}
        identityState="idle"
        attachmentAssets={{
          [attachmentId]: { previewUrl: "blob:http://localhost/owned" },
          other: { previewUrl: "blob:http://localhost/other" },
        }}
      />,
    );
    expect(root.querySelectorAll("img")).toHaveLength(1);
    expect(root.querySelector("img")?.getAttribute("src")).toBe("blob:http://localhost/owned");
    expect(root.textContent).toContain("Other");
    expect(selectedMessageText(root)).toBe(selected);
    view.rerender(<MessageBubble message={message} currentUser={currentUser} identityState="idle" />);
    expect(root.querySelector("img")).toBeNull();
    expect(selectedMessageText(root)).toBe(selected);
  });
  it("exports the literal R0 UTF-16 document and partial-cell range, preserving tabs/newlines/Unicode", () => {
    const { container } = render(<MessageContent text={R0_MARKDOWN} isStreaming={false} />);
    const root = documentRoot(container);
    expect(messageProjection(root).plain).toBe(R0_PLAIN);
    expect(tableMarkdown(root.querySelector("table") as HTMLTableElement)).toBe(R0_TABLE_MARKDOWN);
    const before = textNode(root.querySelector("p"));
    const partial = textNode(root.querySelectorAll("td")[1] ?? null);
    select(before, 7, partial, 15);
    const expected =
      "café 👩🏽‍💻 — select from here into any cell.\nName\tObservation\tValue\nAlpha café\tpartial 👩🏽‍💻";
    expect(selectedMessageText(root)).toBe(expected);
    select(partial, 15, before, 7);
    expect(selectedMessageText(root)).toBe(expected);
  });

  it("retains DOM, valid selection and table offset during append, finalization, and syntax reinterpretation", () => {
    const view = render(<MessageContent text={R0_MARKDOWN} isStreaming />);
    const root = documentRoot(view.container);
    const table = root.querySelector("table");
    const viewport = root.querySelector<HTMLElement>(".markdown-table__viewport");
    if (!viewport) throw new Error("Missing viewport");
    Object.defineProperties(viewport, { scrollWidth: { value: 900, configurable: true }, clientWidth: { value: 300 } });
    viewport.scrollLeft = 130;
    fireEvent.scroll(viewport);
    select(textNode(root.querySelector("p")), 7, textNode(root.querySelectorAll("td")[1] ?? null), 15);
    const selected = selectedMessageText(root);
    view.rerender(<MessageContent text={`${R0_MARKDOWN}new **content`} isStreaming />);
    expect(root.querySelector("table")).toBe(table);
    expect(viewport.scrollLeft).toBe(130);
    expect(selectedMessageText(root)).toBe(selected);
    view.rerender(<MessageContent text={`${R0_MARKDOWN}new **content**`} isStreaming={false} />);
    expect(root.querySelector("table")).toBe(table);
    expect(viewport.scrollLeft).toBe(130);
    expect(selectedMessageText(root)).toBe(selected);
    expect(root.querySelector("strong")?.textContent).toBe("content");
    Object.defineProperty(viewport, "scrollWidth", { value: 250 });
    view.rerender(
      <MessageContent
        text={R0_MARKDOWN.replace("Readable wide column with retained horizontal position", "Short")}
        isStreaming={false}
      />,
    );
    expect(root.querySelector("table")).toBe(table);
    expect(viewport.scrollLeft).toBe(0);
    expect(selectedMessageText(root)).toBe(selected);
  });

  it("maps selected text when Markdown syntax changes its DOM, instead of dropping native endpoints", () => {
    const view = render(<MessageContent text="Start **word" isStreaming />);
    const root = documentRoot(view.container);
    const node = textNode(root.querySelector("p"));
    select(node, 8, node, 12);
    view.rerender(<MessageContent text="Start **word**" isStreaming />);
    expect(selectedMessageText(root)).toBe("word");
  });

  it("bounds forward/backward ranges to one bubble and intercepts Copy as plain text only", () => {
    const { container } = render(
      <>
        <MessageContent text={R0_MARKDOWN} isStreaming={false} />
        <MessageContent text="Other message" isStreaming={false} />
      </>,
    );
    const root = documentRoot(container);
    const other = container.querySelectorAll(".bubble-text__md")[1];
    const before = textNode(root.querySelector("p"));
    const last = textNode(root.querySelector("p:last-child"));
    select(before, 7, textNode(other?.querySelector("p") ?? null), 5);
    fireEvent(document, new Event("selectionchange"));
    expect(root.contains(document.getSelection()?.focusNode ?? null)).toBe(true);
    const setData = vi.fn();
    const copy = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copy, "clipboardData", { value: { setData } });
    fireEvent(document, copy);
    expect(setData.mock.calls).toEqual([["text/plain", R0_PLAIN.slice(7)]]);
    expect(copy.defaultPrevented).toBe(true);
    document.getSelection()?.removeAllRanges();
    root.querySelector<HTMLElement>(".markdown-table__viewport")?.focus();
    fireEvent.keyDown(document, { key: "a", ctrlKey: true });
    expect(selectedMessageText(root)).toBe(R0_PLAIN);
    select(last, 10, before, 7);
    expect(selectedMessageText(root)).toBe(R0_PLAIN.slice(7, R0_PLAIN.lastIndexOf("After") + 10));
  });

  it("copies a whole table as escaped Markdown, with readable failure and multiline cells", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { container } = render(<MessageContent text={R0_MARKDOWN} isStreaming={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy table as Markdown" }));
    expect(writeText).toHaveBeenCalledWith(R0_TABLE_MARKDOWN);
    await screen.findByText("Copied Markdown");
    writeText.mockRejectedValue(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "Copy table as Markdown" }));
    await screen.findByText("Copy failed — try again");
    const table = container.querySelector("table");
    if (!table) throw new Error("Missing table");
    const cell = table.rows[1]?.cells[0];
    if (!cell) throw new Error("Missing cell");
    cell.replaceChildren(
      document.createTextNode("first"),
      document.createElement("br"),
      document.createTextNode("second"),
    );
    expect(tableMarkdown(table)).toContain("| first<br>second | partial");
  });
});
