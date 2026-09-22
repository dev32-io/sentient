import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import type { AttachmentRef } from "@sentient/protocol";
import type { AttachmentsRest } from "@sentient/web-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachmentMetadata } from "./attachment-cards.tsx";
import { ChatView } from "./chat-view.tsx";

const refs: AttachmentRef[] = [
  { attachmentId: "att_11111111111111111111111111111111", displayName: "image.png", contentType: "image/png", mediaKind: "image", size: 10 },
  { attachmentId: "att_22222222222222222222222222222222", displayName: "document.pdf", contentType: "application/pdf", mediaKind: "pdf", size: 20 },
];
const textRef: AttachmentRef = {
  attachmentId: "att_33333333333333333333333333333333",
  displayName: "notes.txt",
  contentType: "text/plain",
  mediaKind: "text",
  size: 30,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("authenticated attachment previews", () => {
  it("loads only bounded previews until user explicitly downloads an original", async () => {
    let sequence = 0;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => `blob:fixture-${++sequence}`),
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const attachmentsRest = {
      preview: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
      download: vi.fn(async (_id: string) => new Blob(["original"])),
      upload: vi.fn(),
      delete: vi.fn(),
    } as unknown as AttachmentsRest;

    const view = render(
      <ChatView
        messages={[{
          id: "message-1",
          role: "user",
          text: "files",
          timestamp: 1,
          isStreaming: false,
          attachments: refs.map((ref) => ({ kind: "remote" as const, ref })),
        }]}
        transcript=""
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={{ displayName: "Synthetic", avatarTint: "sage" }}
        attachmentsRest={attachmentsRest}
      />,
    );

    await waitFor(() => expect(view.container.querySelectorAll(".message-attachment__image")).toHaveLength(2));
    expect(attachmentsRest.preview).toHaveBeenCalledTimes(2);
    expect(attachmentsRest.download).not.toHaveBeenCalled();
    expect(view.container.querySelectorAll(".message-attachment__download")).toHaveLength(0);
    expect(view.queryByRole("button", { name: /^Download/ })).toBeNull();
    expect(view.queryByRole("link", { name: /^Download/ })).toBeNull();
    expect(view.getByRole("button", { name: "Preview image.png" }).querySelector("a,button")).toBeNull();

    const trigger = view.getByRole("button", { name: "Preview image.png" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "image.png" });
    expect(within(dialog).getByRole("img", { name: "image.png preview" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Download image.png" }));
    await waitFor(() => expect(attachmentsRest.download).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "image.png" })).toBeNull());
    expect(document.activeElement).toBe(trigger);

    view.rerender(
      <ChatView
        messages={[]}
        transcript=""
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={{ displayName: "Synthetic", avatarTint: "sage" }}
        attachmentsRest={attachmentsRest}
      />,
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "image.png" })).toBeNull());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fixture-1");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fixture-2");
  });

  it("publishes local and download assets before a slow preview, then aborts stale route work", async () => {
    let sequence = 0;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => `blob:slow-${++sequence}`),
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const resolvePreviews: ((blob: Blob) => void)[] = [];
    const resolveDownloads: ((blob: Blob) => void)[] = [];
    const previewSignals: AbortSignal[] = [];
    const downloadSignals: AbortSignal[] = [];
    const attachmentsRest = {
      preview: vi.fn((_id: string, signal?: AbortSignal) => {
        if (signal) previewSignals.push(signal);
        return new Promise<Blob>((resolve) => { resolvePreviews.push(resolve); });
      }),
      download: vi.fn((_id: string, signal?: AbortSignal) => {
        if (signal) downloadSignals.push(signal);
        return new Promise<Blob>((resolve) => { resolveDownloads.push(resolve); });
      }),
      upload: vi.fn(),
      delete: vi.fn(),
    } as unknown as AttachmentsRest;
    const local = {
      kind: "local" as const,
      id: "local-note",
      name: "draft.txt",
      type: "text/plain",
      blob: new Blob(["draft"], { type: "text/plain" }),
      status: "uploaded" as const,
    };
    const view = render(
      <ChatView
        messages={[{
          id: "message-slow",
          role: "user",
          text: "slow preview",
          timestamp: 1,
          isStreaming: false,
          attachments: [{ kind: "remote" as const, ref: refs[0]! }, local],
        }]}
        transcript=""
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={{ displayName: "Synthetic", avatarTint: "sage" }}
        attachmentsRest={attachmentsRest}
        sessionBoundaryKey="session-a"
      />,
    );

    await waitFor(() => expect(attachmentsRest.preview).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Preview draft.txt" }));
    const localDialog = await screen.findByRole("dialog", { name: "draft.txt" });
    expect(within(localDialog).getByRole("link", { name: "Download draft.txt" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "Preview image.png" }));
    const remoteDialog = await screen.findByRole("dialog", { name: "image.png" });
    fireEvent.click(within(remoteDialog).getByRole("button", { name: "Download image.png" }));
    await waitFor(() => expect(attachmentsRest.download).toHaveBeenCalledOnce());

    view.rerender(
      <ChatView
        messages={[{
          id: "message-slow",
          role: "user",
          text: "slow preview",
          timestamp: 1,
          isStreaming: false,
          attachments: [{ kind: "remote" as const, ref: refs[0]! }, local],
        }]}
        transcript=""
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={{ displayName: "Synthetic", avatarTint: "sage" }}
        attachmentsRest={attachmentsRest}
        sessionBoundaryKey="session-b"
      />,
    );
    expect(previewSignals[0]?.aborted).toBe(true);
    expect(downloadSignals[0]?.aborted).toBe(true);
    resolvePreviews[0]!(new Blob(["preview"], { type: "image/png" }));
    resolveDownloads[0]!(new Blob(["original"], { type: "image/png" }));
    await act(async () => {});
    expect(click).not.toHaveBeenCalled();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
  });

  it("keeps local and remote download actions inside preview dialog", async () => {
    let sequence = 0;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => `blob:mixed-${++sequence}`),
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const attachmentsRest = {
      preview: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
      download: vi.fn(async () => new Blob(["original"])),
      upload: vi.fn(),
      delete: vi.fn(),
    } as unknown as AttachmentsRest;
    const local = {
      kind: "local" as const,
      id: "local-note",
      name: "draft.txt",
      type: "text/plain",
      blob: new Blob(["draft"], { type: "text/plain" }),
      status: "uploaded" as const,
    };
    const view = render(
      <ChatView
        messages={[{
          id: "message-mixed",
          role: "user",
          text: "mixed files",
          timestamp: 1,
          isStreaming: false,
          attachments: [{ kind: "remote", ref: refs[0]! }, local],
        }]}
        transcript=""
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={{ displayName: "Synthetic", avatarTint: "sage" }}
        attachmentsRest={attachmentsRest}
      />,
    );

    await waitFor(() => expect(view.container.querySelectorAll(".message-attachment__image")).toHaveLength(1));
    expect(view.container.querySelectorAll(".message-attachment__download")).toHaveLength(0);
    expect(view.queryByRole("button", { name: /^Download/ })).toBeNull();
    expect(view.queryByRole("link", { name: /^Download/ })).toBeNull();
  });

  it("classifies local Live Photo archives as images", () => {
    expect(attachmentMetadata({
      kind: "local",
      id: "live-photo",
      name: "memory.livephoto.zip",
      type: "application/vnd.sentient.live-photo+zip",
      blob: new Blob(["live-photo"]),
      status: "uploaded",
    })).toMatchObject({
      contentType: "application/vnd.sentient.live-photo+zip",
      mediaKind: "image",
    });
  });

  it("uses metadata fallback for text attachments without requesting a preview", async () => {
    const attachmentsRest = {
      preview: vi.fn(),
      download: vi.fn(async () => new Blob(["original"])),
      upload: vi.fn(),
      delete: vi.fn(),
    } as unknown as AttachmentsRest;
    render(
      <ChatView
        messages={[{
          id: "message-text",
          role: "user",
          text: "notes",
          timestamp: 1,
          isStreaming: false,
          attachments: [{ kind: "remote", ref: textRef }],
        }]}
        transcript=""
        currentTurnId={null}
        activeCycleState="idle"
        currentUser={{ displayName: "Synthetic", avatarTint: "sage" }}
        attachmentsRest={attachmentsRest}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Preview notes.txt" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "notes.txt" });
    expect(within(dialog).getByText(/Preview unavailable/)).toBeTruthy();
    expect(attachmentsRest.preview).not.toHaveBeenCalled();
  });
});
