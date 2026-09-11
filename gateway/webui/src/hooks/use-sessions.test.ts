import type { SessionsConnector } from "@sentient/web-sdk";
import { describe, expect, it, vi } from "vitest";
import { createUseSessions } from "./use-sessions.ts";

describe("session action outcomes", () => {
  it.each(["switchTo", "newChat"] as const)(
    "%s reports failure without changing the pointer, then succeeds on retry",
    async (action) => {
      const connector = {
        onSessionsChanged: vi.fn(() => vi.fn()),
        switchTo: vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce(undefined),
        newChat: vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce({ draftKey: "draft-2" }),
      };
      const sessions = createUseSessions(connector as unknown as SessionsConnector);
      sessions.currentId.value = "session-1";
      const run = () => (action === "switchTo" ? sessions.switchTo("session-2") : sessions.newChat());

      expect(await run()).toBe(false);
      expect(sessions.currentId.value).toBe("session-1");
      expect(sessions.error.value).toBe("unavailable");
      expect(await run()).toBe(true);
      expect(sessions.error.value).toBeNull();
      expect(sessions.currentId.value).toBe(action === "switchTo" ? "session-2" : "draft-2");
      expect(sessions.items.value).toEqual([]);
      sessions.dispose();
    },
  );
});
