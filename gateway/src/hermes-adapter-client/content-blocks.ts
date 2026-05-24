import { z } from "zod";

// ---------------------------------------------------------------------------
// ACP ContentBlock — discriminated union of the five upstream block types.
// Mirrors the `ContentBlock` alias in `acp/schema.py` (v0.11.2):
//   Union[TextContentBlock, ImageContentBlock, AudioContentBlock,
//         ResourceContentBlock, EmbeddedResourceContentBlock]
// keyed on the `type` literal.
//
// Wire payloads look like `{"type":"text","text":"hello"}` — a single block,
// NOT a bare string and NOT an array. The previous gateway shape
// (`string | unknown[]`) was wrong on both branches.
//
// Audio + resource_link + embedded resource are passthrough today: the
// gateway translator (T4.4) only renders text + image. The literal strings
// match upstream EXACTLY:
//   AudioContentBlock        -> "audio"
//   ResourceContentBlock     -> "resource_link"
//   EmbeddedResourceContentBlock -> "resource"
// ---------------------------------------------------------------------------

const metaSchema = z.record(z.unknown()).optional();

export const textContentBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  annotations: z.unknown().optional(),
  _meta: metaSchema,
});
export type TextContentBlock = z.infer<typeof textContentBlockSchema>;

export const imageContentBlockSchema = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
  uri: z.string().optional(),
  annotations: z.unknown().optional(),
  _meta: metaSchema,
});
export type ImageContentBlock = z.infer<typeof imageContentBlockSchema>;

// Passthrough variants — gateway does not render these today; the translator
// will log+skip them. Keeping the discriminator pinned ensures unknown `type`
// literals fail loud.
export const audioContentBlockSchema = z.object({ type: z.literal("audio") }).passthrough();
export type AudioContentBlock = z.infer<typeof audioContentBlockSchema>;

export const resourceLinkContentBlockSchema = z.object({ type: z.literal("resource_link") }).passthrough();
export type ResourceLinkContentBlock = z.infer<typeof resourceLinkContentBlockSchema>;

export const embeddedResourceContentBlockSchema = z.object({ type: z.literal("resource") }).passthrough();
export type EmbeddedResourceContentBlock = z.infer<typeof embeddedResourceContentBlockSchema>;

export const contentBlockSchema = z.discriminatedUnion("type", [
  textContentBlockSchema,
  imageContentBlockSchema,
  audioContentBlockSchema,
  resourceLinkContentBlockSchema,
  embeddedResourceContentBlockSchema,
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;
