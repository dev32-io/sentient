import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { expandHome } from "./startup-config.ts";

describe("expandHome", () => {
  it("expands a leading ~ to the home directory", () => {
    expect(expandHome("~/.sentient/gateway/users")).toBe(`${homedir()}/.sentient/gateway/users`);
  });
  it("leaves an absolute path unchanged", () => {
    expect(expandHome("/var/lib/sentient")).toBe("/var/lib/sentient");
  });
  it("does not expand a bare ~ inside the path", () => {
    expect(expandHome("/opt/~backup")).toBe("/opt/~backup");
  });
});
