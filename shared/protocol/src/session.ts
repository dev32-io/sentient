import { z } from "zod";
import { userRoleSchema } from "./roles.ts";

// ---------------------------------------------------------------------------
// Session — the gateway's handle on a single connected client.
//
// Identity fields (`userId`, `deviceId`, `role`) are retained for downstream
// consumers (memory, context, logs) but are populated with anonymous values
// until a proper login flow is reintroduced. See gateway/src/auth/session-
// manager.ts for the defaults.
// ---------------------------------------------------------------------------

export const sessionSchema = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  role: userRoleSchema,
  deviceId: z.string().min(1),
  createdAt: z.number(),
  expiresAt: z.number(),
});

export type Session = z.infer<typeof sessionSchema>;
