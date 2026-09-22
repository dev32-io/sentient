import { describe, expect, it } from "vitest";
import { attachmentsConfigSchema } from "./attachments-config";

describe("attachmentsConfigSchema", () => {
  it("aligns original upload and parser admission at the finite 512 MiB source cap", () => {
    const config = attachmentsConfigSchema.parse({});
    expect(config.max_file_bytes).toBe(512 * 1024 * 1024);
    expect(config.max_request_bytes).toBe(config.max_file_bytes);
    expect(attachmentsConfigSchema.safeParse({ max_file_bytes: config.max_file_bytes + 1 }).success).toBe(false);
    expect(config.max_user_bytes).toBe(2 * 1024 * 1024 * 1024);
  });
});
