import { expect, test } from "bun:test";
import { buildServiceRegistry } from "./service-registry.js";
import type { SecretAccessor } from "./template-loader.js";

const cfg = {
  "ha-mcp": {
    template: "ha-mcp.yaml",
    allowed_images: ["ghcr.io/homeassistant-ai/ha-mcp:stable"],
    networks: ["sentient-internal"],
    secrets: { HOMEASSISTANT_TOKEN: "home_assistant.mcp_server_token" },
    healthcheck: { url: "http://ha-mcp:8086/health", timeout_ms: 30000 },
    depends_on: ["egress-proxy"],
    optional: true,
  },
  "egress-proxy": {
    template: "egress-proxy.yaml",
    allowed_images: ["kalaksi/tinyproxy:latest"],
    networks: ["sentient-internal", "sentient-external"],
    healthcheck: { tcp: "egress-proxy:3128", timeout_ms: 5000 },
    depends_on: [],
    optional: false,
  },
};

const templates: Record<string, string> = {
  "ha-mcp.yaml":
    "image: ghcr.io/homeassistant-ai/ha-mcp:stable\ncontainer_name: sentient-ha-mcp\nnetworks: [sentient-internal]\nenv:\n  HOMEASSISTANT_TOKEN: ${HOMEASSISTANT_TOKEN}\n",
  "egress-proxy.yaml":
    "image: kalaksi/tinyproxy:latest\ncontainer_name: sentient-egress-proxy\nnetworks: [sentient-internal, sentient-external]\n",
};

const secrets: SecretAccessor = { resolve: () => "tok" };
const readTemplate = async (name: string) => templates[name] ?? "";

test("buildServiceRegistry returns one ManagedService per config entry", async () => {
  const r = await buildServiceRegistry({ config: cfg, readTemplate, secrets });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.size).toBe(2);
  expect(r.value.get("ha-mcp")?.template.image).toBe("ghcr.io/homeassistant-ai/ha-mcp:stable");
});

test("rejects entry whose template image is not in allowed_images", async () => {
  const bad = {
    x: {
      ...cfg["ha-mcp"],
      allowed_images: ["different/image:v1"],
    },
  };
  const r = await buildServiceRegistry({ config: bad, readTemplate, secrets });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("policy-violation");
});

test("rejects entry whose template uses a network not in config.networks", async () => {
  const bad = {
    x: {
      ...cfg["ha-mcp"],
      networks: ["sentient-external"], // template uses sentient-internal
    },
  };
  const r = await buildServiceRegistry({ config: bad, readTemplate, secrets });
  expect(r.ok).toBe(false);
});

test("rejects unknown depends_on target", async () => {
  const bad = {
    "ha-mcp": { ...cfg["ha-mcp"], depends_on: ["does-not-exist"] },
  };
  const r = await buildServiceRegistry({ config: bad, readTemplate, secrets });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("invalid-dependency");
});
