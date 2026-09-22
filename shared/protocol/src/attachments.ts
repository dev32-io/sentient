import { z } from "zod";

export const attachmentIdSchema = z.string().regex(/^att_[a-f0-9]{32}$/);

/** Server-derived presentation metadata. Never a storage path or public URL. */
export const attachmentRefSchema = z.object({
  attachmentId: attachmentIdSchema,
  displayName: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100),
  mediaKind: z.enum(["image", "pdf", "text"]),
  size: z.number().int().nonnegative(),
});

export type AttachmentRef = z.infer<typeof attachmentRefSchema>;
