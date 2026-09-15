import { z } from "zod";

/** Optional iOS/APNs delivery policy. Credentials intentionally have no YAML schema here. */
export const pushConfigSchema = z
  .object({
    // Optional, not default-materialized: older binaries must still read existing operator YAML.
    provider_url: z
      .string()
      .url()
      .refine((value) => {
        if (!URL.canParse(value)) return false;
        const url = new URL(value);
        return (
          url.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(url.hostname) &&
          url.port !== "0" &&
          url.pathname === "/api/push" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }, "Push provider must be a credential-free loopback HTTP /api/push endpoint")
      .optional(),
    request_timeout_ms: z.number().int().min(100).max(60_000),
    drain_interval_ms: z.number().int().min(100).max(60_000),
    drain_claim_limit: z.number().int().min(1).max(1_000),
    max_attempts: z.number().int().min(1).max(20),
    retry_base_ms: z.number().int().min(100).max(3_600_000),
    retry_max_ms: z.number().int().min(100).max(86_400_000),
    payload_max_bytes: z.number().int().min(512).max(4_096),
    content_preview_max_chars: z.number().int().min(1).max(280),
    revocation_ttl_ms: z.number().int().min(60_000).max(31_536_000_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.retry_base_ms > value.retry_max_ms)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retry_base_ms"],
        message: "retry base exceeds retry maximum",
      });
  });
export type PushConfig = z.output<typeof pushConfigSchema>;
