import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import type { Capability } from "./capability.js";
import { PathOutsideScopeError, WrongResourceClassError, createFileScope } from "./file-scope.js";

const ROOT = "/tmp/sentient-filescope-test";
const aliceRoot = `${ROOT}/u_aaaaaaaa`;
const bobRoot = `${ROOT}/u_bbbbbbbb`;

mkdirSync(aliceRoot, { recursive: true });
mkdirSync(bobRoot, { recursive: true });

const aliceCap: Capability = Object.freeze({
  ownerUserId: "u_aaaaaaaa",
  resource: "file-scope",
  rootPath: aliceRoot,
  role: "adult",
});

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("FileScope", () => {
  it("round-trips a file inside the grant", async () => {
    const scope = createFileScope(aliceCap);
    await scope.writeText("notes.md", "hello");
    expect(await scope.readText("notes.md")).toBe("hello");
  });

  it("SECURITY: refuses to read outside the grant via traversal", async () => {
    const scope = createFileScope(aliceCap);
    await expect(scope.readText("../u_bbbbbbbb/secret.md")).rejects.toBeInstanceOf(PathOutsideScopeError);
  });

  it("SECURITY: refuses to write outside the grant via traversal", async () => {
    const scope = createFileScope(aliceCap);
    await expect(scope.writeText("../u_bbbbbbbb/evil.md", "x")).rejects.toBeInstanceOf(PathOutsideScopeError);
  });

  it("SECURITY: refuses an absolute path outside the grant", () => {
    const scope = createFileScope(aliceCap);
    expect(() => scope.resolve("/etc/passwd")).toThrow(PathOutsideScopeError);
  });

  it("SECURITY: refuses a capability minted for a DIFFERENT resource class (confused-deputy)", () => {
    // A `session-store` capability for the same user shares aliceRoot exactly,
    // so the path guard alone would pass — the class check is what refuses it.
    const sessionStoreCap: Capability = Object.freeze({
      ownerUserId: "u_aaaaaaaa",
      resource: "session-store",
      rootPath: aliceRoot,
      role: "adult",
    });
    expect(() => createFileScope(sessionStoreCap)).toThrow(WrongResourceClassError);
  });
});
