import { expect, test } from "bun:test";
import { buildServiceRegistry } from "./service-registry.js";
import type { SecretAccessor } from "./template-loader.js";
import { isDockerService } from "./types.js";

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
  const ha = r.value.get("ha-mcp");
  if (!ha || !isDockerService(ha)) throw new Error("expected ha-mcp to be a docker service");
  expect(ha.template.image).toBe("ghcr.io/homeassistant-ai/ha-mcp:stable");
});

// CONTRACT: a native entry produces a ManagedService with no template and with
// host-env placeholders in its argv resolved — the launch path never shells out,
// so an unresolved ${VAR} must stay literal and fail loudly at prepare().
test("buildServiceRegistry resolves host-env placeholders in a native service argv", async () => {
  const r = await buildServiceRegistry({
    config: {
      "local-tts": {
        launch: "native",
        exec: ["${SENTIENT_CODE}/local-tts/venv/bin/python", "-m", "local_tts"],
        python: "3.11",
        healthcheck: { tcp: "127.0.0.1:8770", timeout_ms: 30000 },
        depends_on: [],
        optional: false,
      },
    },
    readTemplate,
    secrets,
    hostEnv: { SENTIENT_CODE: "/opt/sentient/current" },
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const tts = r.value.get("local-tts");
  if (!tts || isDockerService(tts)) throw new Error("expected local-tts to be a native service");
  expect(tts.config.exec[0]).toBe("/opt/sentient/current/local-tts/venv/bin/python");
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

// CONTRACT: `readTemplate` is a bare readFile on the caller's side, so one
// missing or renamed template file used to REJECT the whole registry build.
// That rejection escaped the boot reconcile and left the post-boot health
// watchdog unarmed for the process lifetime — a typed error keeps the failure
// inside the Result the caller already handles.
test("an unreadable template is a typed registry error, not a rejection", async () => {
  const r = await buildServiceRegistry({
    config: { "ha-mcp": cfg["ha-mcp"] },
    readTemplate: async () => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    },
    secrets,
  });

  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("template-unreadable");
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
