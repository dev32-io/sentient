import { describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import { unbindDeletedSession } from "./session-binding.js";
import type { Attachment } from "./session-registry.js";
import { type SessionData, createEmptySessionData } from "./ws-helpers.js";

describe("session binding — deleted session unmount", () => {
  it("moves an affected window to a fresh draft without waiting for client detach", () => {
    let discarded = 0;
    const data = createEmptySessionData();
    data.conversationId = "s_deleted";
    data.attachment = { sessionId: "s_deleted", attachmentId: "a1", generation: 1 } as unknown as Attachment;
    data.runtime = {} as never;
    data.journal = {} as never;
    data.epoch = 9;
    data.audioCapture = {} as never;
    data.stt = { discard: () => discarded++ } as never;
    const ws = { data } as ServerWebSocket<SessionData>;

    const draftKey = unbindDeletedSession(ws, "s_deleted");

    expect(draftKey).toMatch(/^d_[0-9a-f]{32}$/);
    expect(data.conversationId).toBeNull();
    expect(data.draftKey).toBe(draftKey);
    expect(data.attachment).toBeNull();
    expect(data.runtime).toBeNull();
    expect(data.journal).toBeNull();
    expect(data.epoch).toBe(0);
    expect(data.audioCapture).toBeNull();
    expect(discarded).toBe(1);
  });

  it("does not unbind a window that moved before delayed deletion coordination reached it", () => {
    const data = createEmptySessionData();
    data.conversationId = "s_new";
    data.attachment = { sessionId: "s_new", attachmentId: "a2", generation: 2 } as unknown as Attachment;
    const ws = { data } as ServerWebSocket<SessionData>;

    expect(unbindDeletedSession(ws, "s_deleted")).toBeNull();
    expect(data.conversationId).toBe("s_new");
    expect(data.attachment?.sessionId).toBe("s_new");
  });
});
