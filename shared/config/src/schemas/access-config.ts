import { z } from "zod";

export const accessConfigSchema = z.object({
  // Root under which each user gets <root>/<userId>/. A leading ~ is expanded
  // at the gateway config-load boundary (path.* does not expand it).
  user_data_root: z.string().min(1),
});
export type AccessConfig = z.output<typeof accessConfigSchema>;
