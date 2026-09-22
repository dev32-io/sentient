import { act, render, waitFor } from "@testing-library/preact";
import type { AttachmentRef } from "@sentient/protocol";
import {
  type AttachmentsRest,
  DraftConflictError,
  type DraftRecord,
  type DraftStore,
  type PendingSendRecord,
} from "@sentient/web-sdk";
import { describe, expect, it, vi } from "vitest";
import { useLocalDrafts } from "./use-local-drafts.ts";

const refs: AttachmentRef[] = [
  { attachmentId: "att_0123456789abcdef0123456789abcdef", displayName: "one.txt", contentType: "text/plain", mediaKind: "text", size: 3 },
  { attachmentId: "att_fedcba9876543210fedcba9876543210", displayName: "two.txt", contentType: "text/plain", mediaKind: "text", size: 3 },
];

function memoryStore(): DraftStore {
  let draft: DraftRecord | null = {
    id: "d_fixture", sessionId: null, text: "", revision: 1, createdAt: 1, updatedAt: 1,
    attachments: [
      { id: "file-1", name: "one.txt", type: "text/plain", blob: new Blob(["one"], { type: "text/plain" }) },
      { id: "file-2", name: "two.txt", type: "text/plain", blob: new Blob(["two"], { type: "text/plain" }) },
    ],
  };
  let pending: PendingSendRecord | null = null;
  let pendingSequence = 0;
  return {
    async list() { return { drafts: draft ? [draft] : [], pendingSends: pending ? [pending] : [], deleteIntents: [] }; },
    async save(input) {
      const timestamp = Date.now();
      draft = {
        id: input.id ?? draft?.id ?? "d_fixture",
        sessionId: input.sessionId,
        text: input.text,
        attachments: input.attachments,
        revision: (draft?.revision ?? 0) + 1,
        createdAt: draft?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      return draft;
    },
    async remove() { draft = null; },
    async beginSend(_id, _revision, _surfaceId) {
      if (!draft) throw new Error("missing draft");
      pending ??= {
        pendingId: `pending-${++pendingSequence}`, mintKey: draft.id, surfaceId: _surfaceId, draftId: draft.id, draftRevision: draft.revision,
        sessionId: null, text: draft.text, attachments: draft.attachments, uploadedRefs: {}, createdAt: 2,
      };
      return pending;
    },
    async saveUploadedRef(_pendingId, fileIdentity, ref) {
      if (!pending) throw new Error("missing pending");
      pending = { ...pending, uploadedRefs: { ...pending.uploadedRefs, [fileIdentity]: ref } };
      return pending;
    },
    async bindPendingSession(_pendingId, sessionId) {
      if (!pending) throw new Error("missing pending");
      pending = { ...pending, sessionId };
      return pending;
    },
    async reconcileSend() { pending = null; return true; },
    async detachSession() { return null; },
    async saveDeleteIntent(sessionId) { return { sessionId, createdAt: 1, updatedAt: 1, failureCode: null }; },
    async removeDeleteIntent() {},
    async close() {},
  };
}

describe("draft route lifecycle", () => {
  it("saves first edit after route render into new draft without overwriting previous draft", async () => {
    const first: DraftRecord = {
      id: "d_first", sessionId: null, text: "first", attachments: [], revision: 1, createdAt: 1, updatedAt: 1,
    };
    const records = new Map([[first.id, first]]);
    const store = {
      async list() { return { drafts: [...records.values()], pendingSends: [], deleteIntents: [] }; },
      async save(input: { id?: string; sessionId: string | null; text: string; attachments: readonly [] }) {
        const id = input.id ?? crypto.randomUUID();
        const previous = records.get(id);
        const saved: DraftRecord = {
          id,
          sessionId: input.sessionId,
          text: input.text,
          attachments: input.attachments,
          revision: (previous?.revision ?? 0) + 1,
          createdAt: previous?.createdAt ?? 2,
          updatedAt: 2,
        };
        records.set(id, saved);
        return saved;
      },
      async remove() {},
      async close() {},
    } as unknown as DraftStore;
    const attachments = { upload: vi.fn(), download: vi.fn(), delete: vi.fn() } as unknown as AttachmentsRest;

    let authoritativeId = "d_first";
    let drafts: ReturnType<typeof useLocalDrafts> | null = null;
    function Harness() {
      drafts = useLocalDrafts({
        store,
        attachments,
        currentId: "d_first",
        getCurrentId: () => authoritativeId,
        connectionReady: false,
        isConnectionBoundTo: () => true,
        recoverPendingRoute: vi.fn(),
        sendText: vi.fn(),
      });
      return null;
    }

    const view = render(<Harness />);
    await waitFor(() => expect(records.get("d_first")?.text).toBe("first"));
    authoritativeId = "d_second";
    (drafts as ReturnType<typeof useLocalDrafts> | null)?.save("second");
    await waitFor(() => expect(records.get("d_second")?.text).toBe("second"));
    expect([...records.values()].map(({ id, text }) => ({ id, text }))).toEqual([
      { id: "d_first", text: "first" },
      { id: "d_second", text: "second" },
    ]);
    view.unmount();
  });

  it("reports save conflict so send cannot submit another tab's draft", async () => {
    const base = memoryStore();
    const store: DraftStore = {
      ...base,
      async save(input, expectedRevision) {
        if (input.id === "d_fixture") {
          const current = (await base.list()).drafts[0]!;
          const latest = await base.save({ ...current, text: "other tab", attachments: [] }, current.revision);
          throw new DraftConflictError(latest);
        }
        return base.save(input, expectedRevision);
      },
    };
    const attachments = { upload: vi.fn(), download: vi.fn(), delete: vi.fn() } as unknown as AttachmentsRest;
    const sendText = vi.fn();
    let drafts: ReturnType<typeof useLocalDrafts> | null = null;
    function Harness() {
      drafts = useLocalDrafts({
        store,
        attachments,
        currentId: "d_fixture",
        connectionReady: false,
        isConnectionBoundTo: () => true,
        recoverPendingRoute: vi.fn(),
        sendText,
      });
      return null;
    }

    const view = render(<Harness />);
    await waitFor(() => expect(drafts?.activeAttachments.value).toHaveLength(2));
    let saved = true;
    await act(async () => {
      saved = (await drafts?.save("mine")) ?? false;
      if (saved) await drafts?.submit();
    });

    expect(saved).toBe(false);
    expect((drafts as ReturnType<typeof useLocalDrafts> | null)?.value.value).toBe("other tab");
    expect(sendText).not.toHaveBeenCalled();
    view.unmount();
  });
});

describe("attachment send pipeline", () => {
  it("merges mixed paste text with a queued file add instead of overwriting either", async () => {
    const store = memoryStore();
    await store.save({ id: "d_fixture", sessionId: null, text: "", attachments: [] }, 1);
    const attachments = { upload: vi.fn(), download: vi.fn(), delete: vi.fn() } as unknown as AttachmentsRest;
    let drafts: ReturnType<typeof useLocalDrafts> | null = null;
    function Harness() {
      drafts = useLocalDrafts({
        store,
        attachments,
        currentId: "d_fixture",
        connectionReady: false,
        isConnectionBoundTo: () => true,
        recoverPendingRoute: vi.fn(),
        sendText: vi.fn(),
      });
      return null;
    }
    const file = new File(["pasted"], "pasted.txt", { type: "text/plain" });
    const view = render(<Harness />);
    await waitFor(() => expect(drafts?.activeAttachments.value).toHaveLength(0));

    act(() => {
      drafts?.addFiles([file]);
      drafts?.save("pasted text");
    });
    await act(async () => { await drafts?.flush(); });

    const saved = (await store.list()).drafts[0]!;
    expect(saved.text).toBe("pasted text");
    expect(saved.attachments.map((item) => item.blob)).toEqual([file]);
    view.unmount();
  });

  it("accepts a pasted file when fresh draft route arrives after composer mount", async () => {
    const store = memoryStore();
    const attachments = { upload: vi.fn(), download: vi.fn(), delete: vi.fn() } as unknown as AttachmentsRest;
    let currentId: string | null = null;
    let drafts: ReturnType<typeof useLocalDrafts> | null = null;
    function Harness() {
      drafts = useLocalDrafts({
        store,
        attachments,
        currentId: null,
        getCurrentId: () => currentId,
        connectionReady: false,
        isConnectionBoundTo: () => true,
        recoverPendingRoute: vi.fn(),
        sendText: vi.fn(),
      });
      return null;
    }
    const file = new File(["fresh"], "fresh.txt", { type: "text/plain" });
    const view = render(<Harness />);
    await waitFor(() => expect(drafts?.activeAttachments.value).toHaveLength(0));

    act(() => drafts?.addFiles([file]));
    currentId = "d_fresh";
    await act(async () => { await drafts?.flush(); });

    const saved = (await store.list()).drafts.find((draft) => draft.id === "d_fresh");
    expect(saved?.attachments).toEqual([
      expect.objectContaining({ name: "fresh.txt", blob: file }),
    ]);
    view.unmount();
  });

  it("imports broad image formats by extension while retaining each original File", async () => {
    const store = memoryStore();
    await store.save({ id: "d_fixture", sessionId: null, text: "", attachments: [] }, 1);
    const attachments = { upload: vi.fn(), download: vi.fn(), delete: vi.fn() } as unknown as AttachmentsRest;
    let drafts: ReturnType<typeof useLocalDrafts> | null = null;
    function Harness() {
      drafts = useLocalDrafts({
        store,
        attachments,
        currentId: "d_fixture",
        connectionReady: false,
        isConnectionBoundTo: () => true,
        recoverPendingRoute: vi.fn(),
        sendText: vi.fn(),
      });
      return null;
    }
    const files = [
      new File(["avif"], "one.avif"),
      new File(["webp"], "two.webp"),
      new File(["gif"], "three.gif"),
      new File(["tiff"], "four.tiff"),
      new File(["bmp"], "five.bmp"),
      new File(["jp2"], "six.j2k"),
      new File(["jxl"], "seven.jxl"),
      new File(["live"], "eight.livephoto.zip", { type: "application/zip" }),
    ];
    const view = render(<Harness />);
    await waitFor(() => expect(drafts?.activeAttachments.value).toHaveLength(0));

    act(() => drafts?.addFiles(files));
    await act(async () => { await drafts?.flush(); });

    const saved = (await store.list()).drafts[0]!.attachments;
    expect(saved.map((file) => file.type)).toEqual([
      "image/avif",
      "image/webp",
      "image/gif",
      "image/tiff",
      "image/bmp",
      "image/jp2",
      "image/jxl",
      "application/vnd.sentient.live-photo+zip",
    ]);
    expect(saved.map((file) => file.blob)).toEqual(files);
    view.unmount();
  });

  it("checks source size metadata and retries without reading or replacing a large original", async () => {
    const store = memoryStore();
    await store.save({ id: "d_fixture", sessionId: null, text: "", attachments: [] }, 1);
    let failUpload = true;
    const upload = vi.fn(async (_request: { blob: Blob }) => {
      if (failUpload) throw new Error("offline");
      return refs[0]!;
    });
    const attachments = { upload, download: vi.fn(), delete: vi.fn() } as unknown as AttachmentsRest;
    let drafts: ReturnType<typeof useLocalDrafts> | null = null;
    function Harness() {
      drafts = useLocalDrafts({
        store,
        attachments,
        currentId: "d_fixture",
        connectionReady: false,
        isConnectionBoundTo: () => true,
        recoverPendingRoute: vi.fn(),
        sendText: vi.fn(),
      });
      return null;
    }
    const file = new File(["stub"], "large.jxl", { type: "image/jxl" });
    Object.defineProperty(file, "size", { value: 512 * 1024 * 1024 });
    const arrayBuffer = vi.fn();
    Object.defineProperty(file, "arrayBuffer", { value: arrayBuffer });
    const view = render(<Harness />);
    await waitFor(() => expect(drafts?.activeAttachments.value).toHaveLength(0));

    act(() => drafts?.addFiles([file]));
    await act(async () => { await drafts?.flush(); });
    expect((await store.list()).drafts[0]!.attachments[0]!.blob).toBe(file);
    expect(arrayBuffer).not.toHaveBeenCalled();

    const tooLarge = new File(["stub"], "too-large.avif", { type: "image/avif" });
    Object.defineProperty(tooLarge, "size", { value: 512 * 1024 * 1024 + 1 });
    act(() => drafts?.addFiles([tooLarge]));
    await act(async () => { await drafts?.flush(); });
    expect((drafts as ReturnType<typeof useLocalDrafts> | null)?.error.value).toBe("too-large.avif exceeds 512 MiB.");
    expect((await store.list()).drafts[0]!.attachments).toHaveLength(1);

    await act(async () => { await drafts?.submit(); });
    failUpload = false;
    await act(async () => { await drafts?.retryPending((await store.list()).pendingSends[0]!); });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls.every(([request]) => request.blob === file)).toBe(true);
    expect(arrayBuffer).not.toHaveBeenCalled();
    view.unmount();
  });

  it("rejects RAW, ordinary video, and arbitrary archives", async () => {
    const store = memoryStore();
    await store.save({ id: "d_fixture", sessionId: null, text: "", attachments: [] }, 1);
    const attachments = { upload: vi.fn(), download: vi.fn(), delete: vi.fn() } as unknown as AttachmentsRest;
    let drafts: ReturnType<typeof useLocalDrafts> | null = null;
    function Harness() {
      drafts = useLocalDrafts({
        store,
        attachments,
        currentId: "d_fixture",
        connectionReady: false,
        isConnectionBoundTo: () => true,
        recoverPendingRoute: vi.fn(),
        sendText: vi.fn(),
      });
      return null;
    }
    const view = render(<Harness />);
    await waitFor(() => expect(drafts?.activeAttachments.value).toHaveLength(0));

    for (const file of [
      new File(["raw"], "camera.dng", { type: "image/tiff" }),
      new File(["video"], "clip.mp4", { type: "video/mp4" }),
      new File(["zip"], "photos.zip", { type: "application/zip" }),
    ]) {
      act(() => drafts?.addFiles([file]));
      await act(async () => { await drafts?.flush(); });
      expect((drafts as ReturnType<typeof useLocalDrafts> | null)?.error.value).toBe(`${file.name} is not a supported file type.`);
    }
    expect((await store.list()).drafts[0]!.attachments).toEqual([]);
    view.unmount();
  });

  it("persists successful refs and never sends while any file failed", async () => {
    const store = memoryStore();
    let failSecond = true;
    const upload = vi.fn(async ({ fileIdentity }: { fileIdentity: string }) => {
      if (fileIdentity === "file-2" && failSecond) throw new Error("offline");
      return refs[fileIdentity === "file-1" ? 0 : 1]!;
    });
    const attachments = { upload, download: vi.fn(), delete: vi.fn() } as unknown as AttachmentsRest;
    const sendText = vi.fn();
    let drafts: ReturnType<typeof useLocalDrafts> | null = null;
    function Harness() {
      drafts = useLocalDrafts({
        store,
        attachments,
        currentId: "d_fixture",
        connectionReady: false,
        isConnectionBoundTo: () => true,
        recoverPendingRoute: vi.fn(),
        sendText,
      });
      return null;
    }
    const view = render(<Harness />);
    await waitFor(() => expect(drafts?.activeAttachments.value).toHaveLength(2));

    await act(async () => { await drafts?.submit(); });
    expect(sendText).not.toHaveBeenCalled();
    expect((await store.list()).pendingSends[0]?.uploadedRefs["file-1"]).toEqual(refs[0]);

    failSecond = false;
    await act(async () => { await drafts?.retryPending((await store.list()).pendingSends[0]!); });
    expect(sendText).toHaveBeenCalledWith("", "pending-1", refs.map((ref) => ref.attachmentId));
    expect(upload.mock.calls.filter(([request]) => request.fileIdentity === "file-1")).toHaveLength(1);
    view.unmount();
  });

  it("restores a definitively rejected send and allows a fresh pending attempt", async () => {
    const store = memoryStore();
    await store.save({ id: "d_fixture", sessionId: null, text: "rejected text", attachments: [] }, 1);
    const attachments = { upload: vi.fn(), download: vi.fn(), delete: vi.fn() } as unknown as AttachmentsRest;
    const sendText = vi.fn();
    let drafts: ReturnType<typeof useLocalDrafts> | null = null;
    function Harness() {
      drafts = useLocalDrafts({
        store,
        attachments,
        currentId: "d_fixture",
        connectionReady: true,
        isConnectionBoundTo: () => true,
        recoverPendingRoute: vi.fn(),
        sendText,
      });
      return null;
    }
    const view = render(<Harness />);
    await waitFor(() => expect(drafts?.value.value).toBe("rejected text"));

    await act(async () => { await drafts?.submit(); });
    const first = (await store.list()).pendingSends[0];
    expect(first).toBeDefined();
    expect(sendText).toHaveBeenCalledOnce();

    await act(async () => { await drafts?.reconcileRejected(first!.pendingId); });
    expect((await store.list()).pendingSends).toEqual([]);
    expect((await store.list()).drafts[0]?.text).toBe("rejected text");
    expect((drafts as ReturnType<typeof useLocalDrafts> | null)?.value.value).toBe("rejected text");

    await act(async () => { await drafts?.submit(); });
    const second = (await store.list()).pendingSends[0];
    expect(second?.pendingId).not.toBe(first!.pendingId);
    expect(sendText).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("keeps failed upload settled until explicit retry", async () => {
    const store = memoryStore();
    const upload = vi.fn(async ({ fileIdentity }: { fileIdentity: string }) => {
      if (fileIdentity === "file-2") throw new Error("offline");
      return refs[0]!;
    });
    const attachments = { upload, download: vi.fn(), delete: vi.fn() } as unknown as AttachmentsRest;
    let drafts: ReturnType<typeof useLocalDrafts> | null = null;
    function Harness() {
      drafts = useLocalDrafts({
        store,
        attachments,
        currentId: "d_fixture",
        connectionReady: true,
        isConnectionBoundTo: () => true,
        recoverPendingRoute: vi.fn(),
        sendText: vi.fn(),
      });
      return null;
    }
    const view = render(<Harness />);
    await waitFor(() => expect(drafts?.activeAttachments.value).toHaveLength(2));

    await act(async () => { await drafts?.submit(); });
    await waitFor(() => expect(drafts?.uploadStates.value["pending-1:file-2"]?.status).toBe("failed"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(upload.mock.calls.filter(([request]) => request.fileIdentity === "file-2")).toHaveLength(1);

    await act(async () => { await drafts?.retryPending((await store.list()).pendingSends[0]!); });
    expect(upload.mock.calls.filter(([request]) => request.fileIdentity === "file-2")).toHaveLength(2);
    view.unmount();
  });

  it("thaws a failed attempt for removal and mints a new identity for revised payload", async () => {
    const store = memoryStore();
    let failSecond = true;
    const attachments = {
      upload: vi.fn(async ({ fileIdentity }: { fileIdentity: string }) => {
        if (fileIdentity === "file-2" && failSecond) throw new Error("offline");
        return refs[fileIdentity === "file-1" ? 0 : 1]!;
      }),
      download: vi.fn(),
      preview: vi.fn(),
      delete: vi.fn(async () => undefined),
    } as unknown as AttachmentsRest;
    const sendText = vi.fn();
    let drafts: ReturnType<typeof useLocalDrafts> | null = null;
    function Harness() {
      drafts = useLocalDrafts({
        store,
        attachments,
        currentId: "d_fixture",
        connectionReady: false,
        isConnectionBoundTo: () => true,
        recoverPendingRoute: vi.fn(),
        sendText,
      });
      return null;
    }
    const view = render(<Harness />);
    await waitFor(() => expect(drafts?.activeAttachments.value).toHaveLength(2));
    await act(async () => { await drafts?.submit(); });
    const oldPending = (await store.list()).pendingSends[0]!;

    await act(async () => { await drafts?.revisePending(oldPending.pendingId, "file-2"); });
    expect((await store.list()).pendingSends).toEqual([]);
    expect((drafts as ReturnType<typeof useLocalDrafts> | null)?.activeAttachments.value.map((file) => file.id)).toEqual(["file-1"]);
    expect(attachments.delete).toHaveBeenCalledWith(refs[0]!.attachmentId);

    failSecond = false;
    await act(async () => { await drafts?.submit(); });
    const revised = (await store.list()).pendingSends[0]!;
    expect(revised.pendingId).not.toBe(oldPending.pendingId);
    expect(sendText).toHaveBeenCalledWith("", revised.pendingId, [refs[0]!.attachmentId]);
    view.unmount();
  });

  it("keeps pending draft identity when navigating directly to an existing session", async () => {
    const base = memoryStore();
    let other: DraftRecord = {
      id: "draft-b", sessionId: "session-b", text: "B", attachments: [], revision: 1, createdAt: 1, updatedAt: 1,
    };
    const store: DraftStore = {
      ...base,
      async list() {
        const snapshot = await base.list();
        return { ...snapshot, drafts: [...snapshot.drafts, other] };
      },
      async save(input, expectedRevision) {
        if (input.sessionId === "session-b") {
          other = { ...other, text: input.text, attachments: input.attachments, revision: other.revision + 1 };
          return other;
        }
        return base.save(input, expectedRevision);
      },
    };
    const attachments = {
      upload: vi.fn(async ({ fileIdentity }: { fileIdentity: string }) => {
        if (fileIdentity === "file-2") throw new Error("offline");
        return refs[0]!;
      }),
      download: vi.fn(),
      delete: vi.fn(),
    } as unknown as AttachmentsRest;
    const sendText = vi.fn();
    let drafts: ReturnType<typeof useLocalDrafts> | null = null;
    function Harness({ currentId }: { currentId: string }) {
      drafts = useLocalDrafts({
        store,
        attachments,
        currentId,
        connectionReady: false,
        isConnectionBoundTo: (target) => target === currentId,
        recoverPendingRoute: vi.fn(),
        sendText,
      });
      return null;
    }
    const view = render(<Harness currentId="d_fixture" />);
    await waitFor(() => expect(drafts?.activeAttachments.value).toHaveLength(2));
    await act(async () => { await drafts?.submit(); });
    const pending = (await base.list()).pendingSends[0]!;

    view.rerender(<Harness currentId="session-b" />);
    await waitFor(() => expect(drafts?.value.value).toBe("B"));

    expect((await base.list()).pendingSends[0]).toEqual(pending);
    expect((await base.list()).drafts[0]).toMatchObject({ id: "d_fixture", sessionId: null });
    expect(other).toMatchObject({ sessionId: "session-b", text: "B", revision: 1 });
    await act(async () => { await drafts?.retryPending(pending); });
    expect(sendText).not.toHaveBeenCalled();
    expect((drafts as ReturnType<typeof useLocalDrafts> | null)?.error.value).toContain("conversation");
    view.unmount();
  });

  it("binds a mint receipt once, preserves newer edits, and does not overwrite another active route", async () => {
    const base = memoryStore();
    await base.beginSend("d_fixture", 1, "surface-a");
    await base.save({ sessionId: null, text: "A newer", attachments: [] }, 1);
    let other: DraftRecord = {
      id: "draft-b", sessionId: "session-b", text: "B", attachments: [], revision: 1, createdAt: 1, updatedAt: 1,
    };
    let releaseBind!: () => void;
    const bindGate = new Promise<void>((resolve) => { releaseBind = resolve; });
    const bindStarted = vi.fn();
    const store: DraftStore = {
      ...base,
      async list() {
        const snapshot = await base.list();
        return { ...snapshot, drafts: [...snapshot.drafts, other] };
      },
      async save(input, expectedRevision) {
        if (input.sessionId === "session-b") {
          other = { ...other, text: input.text, attachments: input.attachments, revision: other.revision + 1 };
          return other;
        }
        return base.save(input, expectedRevision);
      },
      async bindPendingSession(pendingId, sessionId) {
        bindStarted();
        await bindGate;
        return base.bindPendingSession(pendingId, sessionId);
      },
    };
    const attachments = { upload: vi.fn(), download: vi.fn(), preview: vi.fn(), delete: vi.fn() } as unknown as AttachmentsRest;
    let drafts: ReturnType<typeof useLocalDrafts> | null = null;
    function Harness({ currentId }: { currentId: string }) {
      drafts = useLocalDrafts({
        store,
        attachments,
        currentId,
        connectionReady: false,
        isConnectionBoundTo: () => true,
        recoverPendingRoute: vi.fn(),
        sendText: vi.fn(),
      });
      return null;
    }
    const view = render(<Harness currentId="d_fixture" />);
    await waitFor(() => expect(drafts?.value.value).toBe("A newer"));
    const pendingId = (await base.list()).pendingSends[0]!.pendingId;
    void (drafts as ReturnType<typeof useLocalDrafts> | null)?.reconcile(new Map([[pendingId, "session-a"]]));
    await waitFor(() => expect(bindStarted).toHaveBeenCalledOnce());
    view.rerender(<Harness currentId="session-b" />);
    await waitFor(() => expect(drafts?.value.value).toBe("B"));
    releaseBind();
    await act(async () => { await drafts?.flush(); });
    await act(async () => {
      await drafts?.reconcile(new Map([[pendingId, "session-a"]]));
    });
    expect(bindStarted).toHaveBeenCalledOnce();
    expect((drafts as ReturnType<typeof useLocalDrafts> | null)?.value.value).toBe("B");
    expect(other.text).toBe("B");
    expect((await base.list()).drafts[0]).toMatchObject({ id: "d_fixture", sessionId: "session-a", text: "A newer" });
    expect((await base.list()).pendingSends).toEqual([]);
    view.unmount();
  });

  it("preserves newer edits as recovery when accepted session already has another draft", async () => {
    const base = memoryStore();
    const pending = await base.beginSend("d_fixture", 1, "surface-a");
    await base.save({ sessionId: null, text: "A newer", attachments: [] }, 1);
    const other: DraftRecord = {
      id: "draft-existing",
      sessionId: "session-a",
      text: "Existing edit",
      attachments: [],
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    let recovery: DraftRecord | null = null;
    const store: DraftStore = {
      ...base,
      async list() {
        const snapshot = await base.list();
        return { ...snapshot, drafts: [...snapshot.drafts, other, ...(recovery ? [recovery] : [])] };
      },
      async save(input, expectedRevision) {
        if (input.id === "d_fixture" && input.sessionId === "session-a") {
          recovery = {
            id: "d_recovery",
            sessionId: null,
            text: input.text,
            attachments: input.attachments,
            revision: 1,
            createdAt: 2,
            updatedAt: 2,
          };
          throw new DraftConflictError(other, recovery);
        }
        return base.save(input, expectedRevision);
      },
    };
    const attachments = { upload: vi.fn(), download: vi.fn(), preview: vi.fn(), delete: vi.fn() } as unknown as AttachmentsRest;
    let drafts: ReturnType<typeof useLocalDrafts> | null = null;
    function Harness() {
      drafts = useLocalDrafts({
        store,
        attachments,
        currentId: "session-a",
        connectionReady: false,
        isConnectionBoundTo: () => true,
        recoverPendingRoute: vi.fn(),
        sendText: vi.fn(),
      });
      return null;
    }
    const view = render(<Harness />);
    await waitFor(() => expect(drafts?.pendingSends.value).toHaveLength(1));

    await act(async () => {
      await drafts?.reconcile(new Map([[pending.pendingId, "session-a"]]));
    });

    expect((await store.list()).pendingSends).toEqual([]);
    expect(other.text).toBe("Existing edit");
    expect(recovery).toMatchObject({ sessionId: null, text: "A newer" });
    view.unmount();
  });

  it("keeps known-session pending frozen when same pending id arrives from another session", async () => {
    const store = memoryStore();
    const pending = await store.beginSend("d_fixture", 1, "surface-a");
    await store.bindPendingSession(pending.pendingId, "session-a");
    const attachments = { upload: vi.fn(), download: vi.fn(), preview: vi.fn(), delete: vi.fn() } as unknown as AttachmentsRest;
    let drafts: ReturnType<typeof useLocalDrafts> | null = null;
    function Harness() {
      drafts = useLocalDrafts({
        store,
        attachments,
        currentId: "session-a",
        connectionReady: false,
        isConnectionBoundTo: () => true,
        recoverPendingRoute: vi.fn(),
        sendText: vi.fn(),
      });
      return null;
    }
    const view = render(<Harness />);
    await waitFor(() => expect(drafts?.pendingSends.value).toHaveLength(1));

    await act(async () => {
      await drafts?.reconcile(new Map([[pending.pendingId, "session-b"]]));
    });

    expect((await store.list()).pendingSends).toHaveLength(1);
    expect((await store.list()).drafts[0]).toMatchObject({ id: "d_fixture", sessionId: null });
    view.unmount();
  });

  it("reconciles a reopened mint from committed feed provenance without a created event", async () => {
    const store = memoryStore();
    const pending = await store.beginSend("d_fixture", 1, "surface-a");
    const attachments = { upload: vi.fn(), download: vi.fn(), preview: vi.fn(), delete: vi.fn() } as unknown as AttachmentsRest;
    let drafts: ReturnType<typeof useLocalDrafts> | null = null;
    function Harness() {
      drafts = useLocalDrafts({
        store,
        attachments,
        currentId: "session-a",
        connectionReady: false,
        isConnectionBoundTo: () => true,
        recoverPendingRoute: vi.fn(),
        sendText: vi.fn(),
      });
      return null;
    }
    const view = render(<Harness />);
    await waitFor(() => expect(drafts?.pendingSends.value).toHaveLength(1));

    await act(async () => {
      await drafts?.reconcile(new Map([[pending.pendingId, "session-a"]]));
    });

    expect((await store.list()).pendingSends).toEqual([]);
    view.unmount();
  });

  it("restores original route and surface before fresh browser-session retry", async () => {
    const store = memoryStore();
    const original = await store.beginSend("d_fixture", 1, "surface-original");
    const attachments = {
      upload: vi.fn(async ({ fileIdentity }: { fileIdentity: string }) => refs[fileIdentity === "file-1" ? 0 : 1]!),
      download: vi.fn(),
      preview: vi.fn(),
      delete: vi.fn(),
    } as unknown as AttachmentsRest;
    const sendText = vi.fn();
    const recoverPendingRoute = vi.fn();
    let boundSurface = "surface-fresh";
    function Harness({ generation }: { generation: number }) {
      useLocalDrafts({
        store,
        attachments,
        currentId: original.mintKey,
        connectionReady: generation > 0,
        isConnectionBoundTo: (_target, surface) => surface === boundSurface,
        recoverPendingRoute,
        sendText,
      });
      return null;
    }
    const view = render(<Harness generation={1} />);
    await act(async () => {});
    view.rerender(<Harness generation={2} />);
    await waitFor(() => expect(recoverPendingRoute).toHaveBeenCalledWith(original.mintKey, "surface-original"));
    expect(sendText).not.toHaveBeenCalled();

    boundSurface = "surface-original";
    view.rerender(<Harness generation={3} />);
    await waitFor(() => expect(sendText).toHaveBeenCalledWith("", original.pendingId, refs.map((ref) => ref.attachmentId)));
    view.unmount();
  });

  it("resends same pending identity after connection generation changes", async () => {
    const store = memoryStore();
    const attachments = {
      upload: vi.fn(async ({ fileIdentity }: { fileIdentity: string }) => refs[fileIdentity === "file-1" ? 0 : 1]!),
      download: vi.fn(),
      delete: vi.fn(),
    } as unknown as AttachmentsRest;
    const sendText = vi.fn();
    let drafts: ReturnType<typeof useLocalDrafts> | null = null;
    function Harness({ ready }: { ready: boolean }) {
      drafts = useLocalDrafts({
        store,
        attachments,
        currentId: "d_fixture",
        connectionReady: ready,
        isConnectionBoundTo: () => ready,
        recoverPendingRoute: vi.fn(),
        sendText,
      });
      return null;
    }
    const view = render(<Harness ready />);
    await waitFor(() => expect(drafts?.activeAttachments.value).toHaveLength(2));
    await act(async () => { await drafts?.submit(); });
    await waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
    view.rerender(<Harness ready={false} />);
    view.rerender(<Harness ready />);
    await waitFor(() => expect(sendText).toHaveBeenCalledTimes(2));
    expect(sendText.mock.calls.map((call) => call[1])).toEqual(["pending-1", "pending-1"]);
    view.unmount();
  });
});
