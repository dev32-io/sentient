import { describe, expect, it } from "vitest";
import { CLOSE_CODES, createErrorMessage, errorMessageSchema } from "./errors.ts";

describe("CLOSE_CODES", () => {
  it("has expected values", () => {
    expect(CLOSE_CODES.AUTH_FAILED).toBe(4001);
    expect(CLOSE_CODES.SESSION_LIMIT).toBe(4002);
    expect(CLOSE_CODES.TOKEN_EXPIRED).toBe(4003);
    expect(CLOSE_CODES.PROTOCOL_ERROR).toBe(4004);
  });
});

describe("createErrorMessage", () => {
  it("creates valid error message", () => {
    const msg = createErrorMessage("auth_failed", "Invalid token");

    expect(msg.type).toBe("error");
    expect(msg.code).toBe("auth_failed");
    expect(msg.message).toBe("Invalid token");
  });

  it("passes schema validation", () => {
    const msg = createErrorMessage("provider_error", "Deepgram timeout");
    const result = errorMessageSchema.safeParse(msg);

    expect(result.success).toBe(true);
  });
});

describe("errorMessageSchema", () => {
  it("rejects unknown error codes", () => {
    const result = errorMessageSchema.safeParse({
      type: "error",
      code: "unknown_code",
      message: "test",
    });

    expect(result.success).toBe(false);
  });
});
