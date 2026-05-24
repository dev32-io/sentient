import { z } from "zod";

export const CLOSE_CODES = {
  AUTH_FAILED: 4001,
  SESSION_LIMIT: 4002,
  TOKEN_EXPIRED: 4003,
  PROTOCOL_ERROR: 4004,
} as const;

export type CloseCode = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES];

export const ERROR_TYPES = [
  "auth_failed",
  "session_limit",
  "token_expired",
  "protocol_error",
  "provider_error",
  "internal_error",
] as const;

export type ErrorType = (typeof ERROR_TYPES)[number];

export const errorMessageSchema = z.object({
  type: z.literal("error"),
  code: z.enum(ERROR_TYPES),
  message: z.string(),
});

export type ErrorMessage = z.infer<typeof errorMessageSchema>;

export function createErrorMessage(code: ErrorType, message: string): ErrorMessage {
  return { type: "error", code, message };
}
