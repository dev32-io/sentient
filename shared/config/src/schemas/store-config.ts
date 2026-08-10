import { z } from "zod";

export const storeConfigSchema = z.object({
  // SQLite filename created inside each user's home dir.
  db_filename: z.string().min(1).default("sessions.db"),
});
export type StoreConfig = z.output<typeof storeConfigSchema>;
