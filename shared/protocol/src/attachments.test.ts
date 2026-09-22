import { describe, expect, it } from "vitest";
import type { AttachmentRef } from "./attachments.ts";
import { conversationFeedItemSchema } from "./conversation.ts";
import { clientMessageSchema, textInputSchema } from "./messages.ts";

const id = "att_0123456789abcdef0123456789abcdef";

describe("attachment wire contract", () => {
  it("accepts attachment-only messages but refuses empty or malformed references", () => {
    for (const schema of [clientMessageSchema, textInputSchema]) {
      expect(schema.safeParse({ type: "text.input", text: "", attachmentIds: [id] }).success).toBe(true);
      expect(schema.safeParse({ type: "text.input", text: " " }).success).toBe(false);
      expect(schema.safeParse({ type: "text.input", text: "", attachmentIds: [] }).success).toBe(false);
      expect(schema.safeParse({ type: "text.input", text: "hi", attachmentIds: ["../private"] }).success).toBe(false);
      expect(schema.safeParse({ type: "text.input", text: "legacy text" }).success).toBe(true);
    }
  });

  it("restores user-bubble asset metadata without exposing storage locations", () => {
    const attachment: AttachmentRef = {
      attachmentId: id,
      displayName: "fixture.txt",
      contentType: "text/plain",
      mediaKind: "text",
      size: 5,
    };
    const parsed = conversationFeedItemSchema.parse({
      kind: "user",
      entryId: "1",
      ts: 1,
      channel: "text",
      content: "",
      sessionId: "s_authoritative",
      attachments: [attachment],
    });
    expect(parsed.kind).toBe("user");
    if (parsed.kind === "user") {
      expect(parsed.sessionId).toBe("s_authoritative");
      expect(parsed.attachments).toEqual([attachment]);
    }
  });
});
