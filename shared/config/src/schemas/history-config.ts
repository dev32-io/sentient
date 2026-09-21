import { z } from "zod";

/** Durable chat history, independent of resident runtime retention. */
export const historyConfigSchema = z.object({
  retention_days: z
    .number()
    .int()
    .refine((days) => days === 0 || (days >= 30 && days <= 36500), "must be 0 (disabled) or 30–36500 days")
    .default(90),
  /** Gateway host-local hour; recomputed each night to respect clock changes. */
  cleanup_hour: z.number().int().min(0).max(23).default(3),
  batch_size: z.number().int().min(1).max(1000).default(100),
});

export type HistoryConfig = z.output<typeof historyConfigSchema>;
