import { z } from "zod";

export const accessConfigSchema = z.object({
  // Root under which each user gets <root>/<userId>/. A leading ~ is expanded
  // at the gateway config-load boundary (path.* does not expand it).
  user_data_root: z.string().min(1),
  // OPTIONAL root for household-shared state (memory-system spec §2), keyed
  // by householdId under it: <shared_data_root>/<householdId>/. When absent,
  // consumers derive it as join(dirname(user_data_root), "shared") — a
  // sibling of the per-user root — so a config predating this key still
  // resolves a usable shared root.
  shared_data_root: z.string().min(1).optional(),
});
export type AccessConfig = z.output<typeof accessConfigSchema>;
