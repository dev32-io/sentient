import { z } from "zod";

/** Optional gateway scheduling block. Every behavior knob is operator-owned when enabled. */
export const schedulingConfigSchema = z
  .object({
    tick_interval_ms: z.number().int().min(100).max(60_000),
    missed_grace_ms: z.number().int().min(0).max(86_400_000),
    claim_lease_ms: z.number().int().min(1_000).max(3_600_000),
    due_claim_limit: z.number().int().min(1).max(1_000),
    max_relative_delay_ms: z.number().int().min(1_000).max(31_536_000_000),
    max_message_chars: z.number().int().min(1).max(12_000),
    cards_default_page_size: z.number().int().min(1).max(100),
    cards_max_page_size: z.number().int().min(1).max(100),
    inbox_max_entries: z.number().int().min(1).max(10_000).default(500),
    inbox_retention_ms: z.number().int().min(60_000).max(31_536_000_000).default(2_592_000_000),
    outbox_claim_limit: z.number().int().min(1).max(1_000),
    outbox_lease_ms: z.number().int().min(1_000).max(3_600_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.claim_lease_ms <= value.tick_interval_ms)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claim_lease_ms"],
        message: "claim lease must exceed tick interval",
      });
    if (value.cards_default_page_size > value.cards_max_page_size)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cards_default_page_size"],
        message: "default card page size exceeds maximum",
      });
  });
export type SchedulingConfig = z.output<typeof schedulingConfigSchema>;
