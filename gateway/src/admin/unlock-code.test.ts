import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// gateway/src/admin/unlock-code.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUnlockCode } from "./unlock-code.js";

describe("UnlockCode", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unlock-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("generates 6-digit code on first call", async () => {
    const svc = createUnlockCode({ codePath: join(dir, ".bootstrap-unlock") });
    const code = await svc.ensure();
    expect(code).toMatch(/^\d{6}$/);
    expect(existsSync(join(dir, ".bootstrap-unlock"))).toBe(true);
    const mode = statSync(join(dir, ".bootstrap-unlock")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("preserves existing code on second call", async () => {
    const svc = createUnlockCode({ codePath: join(dir, ".bootstrap-unlock") });
    const a = await svc.ensure();
    const b = await svc.ensure();
    expect(a).toBe(b);
  });

  it("verify returns true for matching code", async () => {
    const svc = createUnlockCode({ codePath: join(dir, ".bootstrap-unlock") });
    const code = await svc.ensure();
    expect(await svc.verify(code)).toBe(true);
  });

  it("verify returns false for non-matching code", async () => {
    const svc = createUnlockCode({ codePath: join(dir, ".bootstrap-unlock") });
    await svc.ensure();
    expect(await svc.verify("000000")).toBe(false);
  });

  it("clear() deletes the code file", async () => {
    const svc = createUnlockCode({ codePath: join(dir, ".bootstrap-unlock") });
    await svc.ensure();
    await svc.clear();
    expect(existsSync(join(dir, ".bootstrap-unlock"))).toBe(false);
  });
});
