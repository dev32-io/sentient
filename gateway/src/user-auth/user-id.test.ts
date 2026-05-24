import { describe, expect, it } from "vitest";
import { assertUserId, isValidUserId } from "./user-id.ts";

describe("isValidUserId", () => {
  it("accepts u_<8hex>", () => {
    expect(isValidUserId("u_2f754c90")).toBe(true);
    expect(isValidUserId("u_00000000")).toBe(true);
    expect(isValidUserId("u_ffffffff")).toBe(true);
  });

  it("rejects wrong prefix", () => {
    expect(isValidUserId("v_2f754c90")).toBe(false);
    expect(isValidUserId("2f754c90")).toBe(false);
  });

  it("rejects wrong length", () => {
    expect(isValidUserId("u_2f754c9")).toBe(false);
    expect(isValidUserId("u_2f754c901")).toBe(false);
  });

  it("rejects uppercase hex", () => {
    expect(isValidUserId("u_2F754C90")).toBe(false);
  });

  it("rejects non-hex chars", () => {
    expect(isValidUserId("u_2f754czz")).toBe(false);
    expect(isValidUserId("u_2f754c.0")).toBe(false);
  });

  it("rejects path-traversal and shell-injection attempts", () => {
    expect(isValidUserId("u_../etc")).toBe(false);
    expect(isValidUserId("u_2f754c90;")).toBe(false);
    expect(isValidUserId("u_$(whoami)")).toBe(false);
    expect(isValidUserId("u_2f75/c90")).toBe(false);
    expect(isValidUserId("u_\nf754c90")).toBe(false);
  });
});

describe("assertUserId", () => {
  it("returns void on valid id", () => {
    expect(() => assertUserId("u_2f754c90")).not.toThrow();
  });

  it("throws on invalid id", () => {
    expect(() => assertUserId("admin")).toThrow(/invalid userId/);
    expect(() => assertUserId("")).toThrow(/invalid userId/);
  });
});
