import { z } from "zod";

/** Per-event risk weights and threshold config for the session risk accumulator. */
export const riskConfigSchema = z.object({
  enabled: z.boolean().default(true),
  ttl_seconds: z.number().int().default(300),
  threshold_warn: z.number().int().default(50),
  threshold_escalate: z.number().int().default(80),
  threshold_block: z.number().int().default(100),
  weights: z
    .object({
      injection_pattern: z.number().int().default(30),
      repeated_offense: z.number().int().default(20),
      role_violation: z.number().int().default(60),
      ha_name_prompt_like: z.number().int().default(15),
      mutating_sensitive_domain: z.number().int().default(10),
      policy_rejection: z.number().int().default(25),
    })
    .default({}),
});
export type RiskConfig = z.infer<typeof riskConfigSchema>;
