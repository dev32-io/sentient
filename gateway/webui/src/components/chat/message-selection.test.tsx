import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { R0_MARKDOWN, R0_PLAIN, R0_TABLE_MARKDOWN } from "../../qa/rich-message-fixture.ts";
import type { ChatMessage } from "../../types.ts";
import { MessageBubble } from "./message-bubble.tsx";

const currentUser = { displayName: "Synthetic", avatarTint: "terra" as const };
const attachment = {
  kind: "remote" as const,
  ref: {
    attachmentId: "att_fixture",
    displayName: "Owned document.txt",
    contentType: "text/plain",
    mediaKind: "text" as const,
    size: 1,
  },
};
function bubble(message: ChatMessage, onAttachmentPreview = vi.fn()) {
  return (
    <MessageBubble
      message={message}
      currentUser={currentUser}
      identityState="idle"
      continuation
      onAttachmentPreview={onAttachmentPreview}
    />
  );
}
function message(id: string, role: ChatMessage["role"], text = "First message body"): ChatMessage {
  return { id, role, text, timestamp: 0, isStreaming: true, attachments: [attachment] };
}
function element(root: ParentNode, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}
function text(root: ParentNode, selector: string): Text {
  const node = element(root, selector).firstChild;
  if (!(node instanceof Text)) throw new Error(`Missing text in ${selector}`);
  return node;
}
function select(anchor: Node, anchorOffset: number, focus: Node, focusOffset: number): Selection {
  const selection = document.getSelection();
  if (!selection) throw new Error("Missing selection");
  selection.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
  fireEvent(document, new Event("selectionchange"));
  return selection;
}
function expectCopy(expected: string): void {
  const setData = vi.fn();
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { setData } });
  fireEvent(document, event);
  expect(setData.mock.calls).toEqual([["text/plain", expected]]);
  expect(event.defaultPrevented).toBe(true);
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  cleanup();
});

describe.each(["user", "assistant"] as const)("%s bubble selection boundary", (role) => {
  it("keeps body ↔ filename endpoints in one bubble and copies exact plain bytes", () => {
    const onPreview = vi.fn();
    const { container } = render(bubble(message("one", role), onPreview));
    const filename = text(container, ".message-attachment__name");
    const body = text(container, ".bubble-text__md p");
    for (const backward of [false, true]) {
      const selection = backward ? select(body, 5, filename, 6) : select(filename, 6, body, 5);
      expect(selection.anchorNode).toBe(backward ? body : filename);
      expect(selection.anchorOffset).toBe(backward ? 5 : 6);
      expect(selection.focusNode).toBe(backward ? filename : body);
      expect(selection.focusOffset).toBe(backward ? 6 : 5);
      expectCopy("document.txtTEXT · 1 KB\nFirst");
    }
    fireEvent.click(screen.getByRole("button", { name: "Preview Owned document.txt" }));
    expect(onPreview).toHaveBeenCalledWith(attachment);
  });

  it("clamps filename-origin ranges toward previous and next messages without reversing anchor", () => {
    const { container } = render(
      <>
        {bubble({ ...message("previous", "user", "Previous message"), attachments: [] })}
        {bubble(message("owned", role))}
        {bubble({ ...message("next", "assistant", "Next message"), attachments: [] })}
      </>,
    );
    const owned = element(container, '[data-message-key="owned"]');
    const filename = text(owned, ".message-attachment__name");
    const body = text(owned, ".bubble-text__md p");
    for (const [id, expectedNode, expectedOffset, expectedCopy] of [
      ["previous", filename, 0, "Owned "],
      ["next", body, body.length, "document.txtTEXT · 1 KB\nFirst message body"],
    ] as const) {
      const other = text(element(container, `[data-message-key="${id}"]`), ".bubble-text__md p");
      const selection = select(filename, 6, other, 5);
      expect(selection.anchorNode).toBe(filename);
      expect(selection.anchorOffset).toBe(6);
      expect(selection.focusNode).toBe(expectedNode);
      expect(selection.focusOffset).toBe(expectedOffset);
      expectCopy(expectedCopy);
      // Copy itself must clamp, even if selectionchange has not fired yet.
      selection.setBaseAndExtent(filename, 6, other, 5);
      expectCopy(expectedCopy);
      expect(selection.focusNode).toBe(expectedNode);
    }
  });

  it("retains mixed-content endpoints, table DOM/scroll and plain partial-cell Copy through streaming", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const original = message("one", role, R0_MARKDOWN);
    const view = render(bubble(original));
    const root = element(view.container, ".message-bubble__text-inner");
    const filename = text(root, ".message-attachment__name");
    const cell = text(root, "tbody tr td:nth-child(2)");
    const table = element(root, "table");
    const viewport = element(root, ".markdown-table__viewport");
    Object.defineProperties(viewport, { scrollWidth: { value: 900 }, clientWidth: { value: 300 } });
    viewport.scrollLeft = 130;
    fireEvent.scroll(viewport);
    const partial =
      "document.txtTEXT · 1 KB\nBefore café \u{1F469}\u{1F3FD}\u200D\u{1F4BB} — select from here into any cell.\nName\tObservation\tValue\nAlpha café\tpartial \u{1F469}\u{1F3FD}\u200D\u{1F4BB}";
    const selection = select(cell, 15, filename, 6);
    expectCopy(partial);
    for (const next of [
      { ...original, text: `${R0_MARKDOWN}new **content` },
      { ...original, text: `${R0_MARKDOWN}new **content**`, isStreaming: false },
    ]) {
      view.rerender(bubble(next));
      expect(element(view.container, ".message-bubble__text-inner")).toBe(root);
      expect(element(root, "table")).toBe(table);
      expect(element(root, ".markdown-table__viewport")).toBe(viewport);
      expect(text(root, ".message-attachment__name")).toBe(filename);
      expect(selection.anchorNode).toBe(cell);
      expect(selection.anchorOffset).toBe(15);
      expect(selection.focusNode).toBe(filename);
      expect(selection.focusOffset).toBe(6);
      expect(viewport.scrollLeft).toBe(130);
      expectCopy(partial);
    }
    fireEvent.click(screen.getByRole("button", { name: "Copy table as Markdown" }));
    expect(writeText.mock.calls).toEqual([[R0_TABLE_MARKDOWN]]);
    await screen.findByText("Copied Markdown");
    expectCopy(partial);
    document.getSelection()?.removeAllRanges();
    viewport.focus();
    fireEvent.keyDown(document, { key: "a", ctrlKey: true });
    expectCopy(`Owned document.txtTEXT · 1 KB\n${R0_PLAIN}new content`);
  });
});

it("excludes attachment action controls from range Copy and leaves control-origin interactions native", () => {
  const onRetry = vi.fn();
  const failed: ChatMessage = {
    ...message("failed", "user", R0_MARKDOWN),
    attachments: [
      {
        kind: "local",
        id: "local_fixture",
        name: "Owned document.txt",
        type: "text/plain",
        blob: new Blob(["synthetic"]),
        status: "failed",
        onRetry,
      },
    ],
  };
  const { container } = render(bubble(failed));
  const filename = text(container, ".message-attachment__name");
  const body = text(container, ".bubble-text__md p");
  select(filename, 6, body, 6);
  expectCopy("document.txtTEXT · 1 KBfailed\nBefore");
  const retry = screen.getByRole("button", { name: "Retry" });
  fireEvent.click(retry);
  expect(onRetry).toHaveBeenCalledOnce();
  const controlText = retry.firstChild;
  if (!controlText) throw new Error("Missing control text");
  select(controlText, 0, controlText, 3);
  const setData = vi.fn();
  const copy = new Event("copy", { cancelable: true });
  Object.defineProperty(copy, "clipboardData", { value: { setData } });
  fireEvent(document, copy);
  expect(copy.defaultPrevented).toBe(false);
  expect(setData).not.toHaveBeenCalled();
  retry.focus();
  expect(fireEvent.keyDown(retry, { key: "a", ctrlKey: true })).toBe(true);
});

it.each(["input", "textarea", "contenteditable"])(
  "leaves focused %s Copy/Select All native despite a retained bubble range",
  (kind) => {
    const { container } = render(bubble(message("one", "assistant")));
    const body = text(container, ".bubble-text__md p");
    const selection = select(body, 0, body, 5);
    const editor = document.createElement(kind === "contenteditable" ? "div" : kind);
    if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
      editor.value = "Synthetic draft";
      editor.setSelectionRange(2, 7);
    } else {
      editor.setAttribute("contenteditable", "true");
      editor.tabIndex = 0;
      editor.innerHTML = "<span>Synthetic draft</span>";
    }
    container.append(editor);
    editor.focus();
    expect(document.activeElement).toBe(editor);
    // Focus can collapse ranges in jsdom; pin the retained-range precondition.
    selection.setBaseAndExtent(body, 0, body, 5);
    expect(selection.toString()).toBe("First");
    const target = editor.firstElementChild ?? editor;
    for (const eventTarget of [target, document]) {
      for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
        const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "a", ...modifier });
        fireEvent(eventTarget, event);
        expect(event.defaultPrevented).toBe(false);
        expect(selection.toString()).toBe("First");
      }
      const setData = vi.fn();
      const copy = new Event("copy", { bubbles: true, cancelable: true });
      Object.defineProperty(copy, "clipboardData", { value: { setData } });
      fireEvent(eventTarget, copy);
      expect(copy.defaultPrevented).toBe(false);
      expect(setData).not.toHaveBeenCalled();
    }
    // Actual editor target must also be excluded without relying on focus.
    editor.blur();
    selection.setBaseAndExtent(body, 0, body, 5);
    expect(fireEvent.keyDown(target, { key: "a", ctrlKey: true })).toBe(true);
    const setData = vi.fn();
    const copy = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copy, "clipboardData", { value: { setData } });
    fireEvent(target, copy);
    expect(copy.defaultPrevented).toBe(false);
    expect(setData).not.toHaveBeenCalled();
    expect(selection.toString()).toBe("First");
  },
);
