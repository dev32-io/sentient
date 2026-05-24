import { z } from "zod";

/**
 * Schema for ambient events produced by sensor observers (e.g. HomeAssistantObserver).
 * These events accumulate in AmbientEventLog and feed salience evaluation.
 * They are NOT dispatched to sessions in v1 (D-17 decision).
 */
export const ambientEventSchema = z.object({
  id: z.string(),
  ts: z.number().int(),
  source: z.string(),
  salienceKey: z.string(),
  entityId: z.string().optional(),
  summary: z.string(),
  raw: z.unknown(),
});

export type AmbientEvent = z.infer<typeof ambientEventSchema>;
