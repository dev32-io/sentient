import { z } from "zod";

export const attachmentsConfigSchema = z.object({
  max_file_bytes: z
    .number()
    .int()
    .min(1)
    .max(512 * 1024 * 1024)
    .default(512 * 1024 * 1024),
  max_files_per_message: z.number().int().min(1).max(64).default(8),
  max_request_bytes: z
    .number()
    .int()
    .min(1)
    .max(512 * 1024 * 1024)
    .default(512 * 1024 * 1024),
  max_user_bytes: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .default(2 * 1024 * 1024 * 1024),
  /** Only uncommitted uploads expire by age. Committed assets follow history. */
  staging_ttl_ms: z
    .number()
    .int()
    .min(60_000)
    .max(7 * 86400_000)
    .default(86400_000),
  parser_max_output_bytes: z
    .number()
    .int()
    .min(1024)
    .max(64 * 1024 * 1024)
    .default(16 * 1024 * 1024),
  parser_max_header_bytes: z
    .number()
    .int()
    .min(1024)
    .max(1024 * 1024)
    .default(16 * 1024),
  parser_deadline_ms: z.number().int().min(1000).max(35_000).default(30_000),
  parser_cleanup_timeout_ms: z.number().int().min(100).max(10_000).default(2000),
  inspection_max_pages: z.number().int().min(1).max(50).default(8),
  inspection_max_text_bytes: z
    .number()
    .int()
    .min(1024)
    .max(16 * 1024 * 1024)
    .default(2 * 1024 * 1024),
  inspection_max_text_chars: z.number().int().min(1000).max(2_000_000).default(200_000),
  inspection_max_question_chars: z.number().int().min(1).max(10_000).default(2000),
  inspection_max_edge: z.number().int().min(64).max(4096).default(1600),
  vision_deadline_ms: z.number().int().min(1000).max(120_000).default(60_000),
  vision_max_output_tokens: z.number().int().min(32).max(4000).default(1000),
  vision_max_output_chars: z.number().int().min(1000).max(100_000).default(12_000),
  vision_max_input_bytes: z
    .number()
    .int()
    .min(1024)
    .max(64 * 1024 * 1024)
    .default(16 * 1024 * 1024),
});

export type AttachmentsConfig = z.output<typeof attachmentsConfigSchema>;
