import { expect, test } from "bun:test";
import { ManagedServiceConfigSchema, ServiceTemplateSchema } from "./types.js";

test("ManagedServiceConfigSchema parses a valid entry", () => {
  const r = ManagedServiceConfigSchema.safeParse({
    template: "ha-mcp.yaml",
    allowed_images: ["ghcr.io/homeassistant-ai/ha-mcp:stable"],
    networks: ["sentient-internal"],
    secrets: { HOMEASSISTANT_TOKEN: "home_assistant.mcp_server_token" },
    healthcheck: { url: "http://ha-mcp:8086/health", timeout_ms: 30000 },
    depends_on: ["egress-proxy"],
    optional: true,
  });
  expect(r.success).toBe(true);
});

// CONTRACT: `launch` is the discriminator between the docker and native
// backends. Every pre-existing config.yaml entry omits it, so the default must
// hold byte-identically or the cutover breaks eight services at once.
test("an entry with no `launch` key parses as docker", () => {
  const parsed = ManagedServiceConfigSchema.parse({
    template: "ha-mcp.yaml",
    allowed_images: ["sentient/ha-mcp:local"],
    networks: ["sentient-internal"],
    healthcheck: { tcp: "127.0.0.1:8086", timeout_ms: 30000 },
  });
  expect(parsed.launch).toBe("docker");
});

test("a native entry needs neither allowed_images nor networks", () => {
  const parsed = ManagedServiceConfigSchema.parse({
    launch: "native",
    exec: ["/opt/sentient/current/whisper-stt/venv/bin/python", "-m", "whisper_stt"],
    python: "3.14",
    healthcheck: { tcp: "127.0.0.1:8766", timeout_ms: 30000 },
  });
  expect(parsed.launch).toBe("native");
  if (parsed.launch !== "native") throw new Error("unreachable");
  expect(parsed.exec[0]).toContain("whisper-stt");
});

test("rejects a native entry with an empty exec argv", () => {
  const r = ManagedServiceConfigSchema.safeParse({
    launch: "native",
    exec: [],
    healthcheck: { noop: true },
  });
  expect(r.success).toBe(false);
});

test("rejects a native entry whose pinned python is not major.minor", () => {
  const r = ManagedServiceConfigSchema.safeParse({
    launch: "native",
    exec: ["/usr/bin/python3"],
    python: "3.11.9",
    healthcheck: { noop: true },
  });
  expect(r.success).toBe(false);
});

test("ManagedServiceConfigSchema rejects empty allowed_images", () => {
  const r = ManagedServiceConfigSchema.safeParse({
    template: "x.yaml",
    allowed_images: [],
    networks: ["sentient-internal"],
    healthcheck: { url: "http://x/health", timeout_ms: 1000 },
  });
  expect(r.success).toBe(false);
});

test("ServiceTemplateSchema parses a minimal spec", () => {
  const r = ServiceTemplateSchema.safeParse({
    image: "alpine:latest",
    container_name: "test",
    networks: ["sentient-internal"],
    env: { FOO: "bar" },
  });
  expect(r.success).toBe(true);
});

test("ServiceTemplateSchema rejects port bindings", () => {
  const r = ServiceTemplateSchema.safeParse({
    image: "alpine:latest",
    container_name: "test",
    networks: ["sentient-internal"],
    ports: ["80:80"],
  });
  expect(r.success).toBe(false);
});
