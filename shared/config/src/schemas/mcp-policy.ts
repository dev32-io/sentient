import { z } from "zod";

/** A single policy rule: if tool + condition match, apply action. */
export const policyRuleSchema = z.object({
  name: z.string(),
  tool: z.string(),
  condition: z.string(),
  action: z.enum(["allow", "deny", "confirm"]),
  reason: z.string(),
});
export type PolicyRule = z.infer<typeof policyRuleSchema>;

/** Top-level MCP policy config — an ordered list of rules. */
export const mcpPolicySchema = z.object({
  rules: z.array(policyRuleSchema),
});
export type McpPolicy = z.infer<typeof mcpPolicySchema>;
