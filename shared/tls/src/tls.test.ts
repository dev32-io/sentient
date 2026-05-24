import { describe, expect, it } from "vitest";
import { buildSanString, classifySan } from "./tls.ts";

describe("classifySan", () => {
  it("returns IP prefix for an IPv4 address", () => {
    expect(classifySan("192.168.0.240")).toBe("IP:192.168.0.240");
  });

  it("returns IP prefix for an IPv6 address", () => {
    expect(classifySan("fe80::1")).toBe("IP:fe80::1");
  });

  it("returns DNS prefix for a DNS hostname", () => {
    expect(classifySan("sentient.local")).toBe("DNS:sentient.local");
  });

  it("returns DNS prefix for bare localhost", () => {
    expect(classifySan("localhost")).toBe("DNS:localhost");
  });
});

describe("buildSanString", () => {
  it("auto-includes localhost and 127.0.0.1 for in-container healthchecks", () => {
    const result = buildSanString(["192.168.0.240"]);
    expect(result).toContain("IP:192.168.0.240");
    expect(result).toContain("DNS:localhost");
    expect(result).toContain("IP:127.0.0.1");
  });

  it("deduplicates when loopback entries are already in the list", () => {
    const result = buildSanString(["localhost", "127.0.0.1", "192.168.0.240"]);
    expect(result.split(",").length).toBe(3);
  });

  it("emits only loopback entries when hostnames is empty", () => {
    expect(buildSanString([])).toBe("DNS:localhost,IP:127.0.0.1");
  });

  it("joins entries with commas for openssl subjectAltName syntax", () => {
    const result = buildSanString(["sentient.local", "192.168.0.240"]);
    expect(result).toBe("DNS:sentient.local,IP:192.168.0.240,DNS:localhost,IP:127.0.0.1");
  });
});
