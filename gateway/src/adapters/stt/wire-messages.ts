import { z } from "zod";

export const readySchema = z.object({
  type: z.literal("ready"),
  connId: z.string().optional(),
  sampleRate: z.number().optional(),
  sileroChunkSamples: z.number().optional(),
  pcmFormat: z.string().optional(),
  stt: z.string().optional(),
});

export const vadStartSchema = z.object({
  type: z.literal("vad_start"),
  turnIdx: z.number().int().min(1),
});

export const transcriptReadySchema = z.object({
  type: z.literal("transcript_ready"),
  turnIdx: z.number().int().min(1),
  text: z.string(),
  emotion: z.string().optional(),
  event: z.string().optional(),
  decodeMs: z.number().optional(),
  audioSeconds: z.number().optional(),
  pauses: z.array(z.number()).default([]),
});

export const turnRejectedSchema = z.object({
  type: z.literal("turn_rejected"),
  turnIdx: z.number().int().min(1),
  reason: z.string().optional(),
  text: z.string().optional(),
  audioEvent: z.string().optional(),
  decodeMs: z.number().optional(),
  audioSeconds: z.number().optional(),
});

export const sttServerMessageSchema = z.discriminatedUnion("type", [
  readySchema,
  vadStartSchema,
  transcriptReadySchema,
  turnRejectedSchema,
]);

export type SttServerMessage = z.infer<typeof sttServerMessageSchema>;
