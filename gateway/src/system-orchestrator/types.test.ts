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
