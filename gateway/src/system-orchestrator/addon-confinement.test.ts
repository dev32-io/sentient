import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { MANAGED_NETWORK_TOPOLOGY, type ServiceTemplate, ServiceTemplateSchema } from "./types.js";

const GATEWAY_ROOT = join(import.meta.dir, "..", "..");
const TEMPLATE_DIR = join(GATEWAY_ROOT, "templates", "services");
const INTERNAL_NET = "sentient-internal";
const EXTERNAL_NET = "sentient-external";

function loadTemplate(name: string): ServiceTemplate {
  return ServiceTemplateSchema.parse(parseYaml(readFileSync(join(TEMPLATE_DIR, `${name}.yaml`), "utf-8")));
}

test("SECURITY: outbound-worker has network-enforced egress confinement", () => {
  const worker = loadTemplate("outbound-worker");
  expect(worker.networks).toEqual([INTERNAL_NET]);
  expect(worker.ports).toEqual([]);
  expect(MANAGED_NETWORK_TOPOLOGY[INTERNAL_NET]?.internal).toBe(true);
});

test("SECURITY: ingress publishes only the native worker API on loopback", () => {
  const proxy = loadTemplate("ingress-proxy");
  expect(proxy.networks).toEqual([INTERNAL_NET, EXTERNAL_NET]);
  expect(MANAGED_NETWORK_TOPOLOGY[EXTERNAL_NET]?.internal).toBe(false);
  expect(proxy.ports).toEqual(["127.0.0.1:8090:8090"]);
});

test("CONTRACT: native web config and ingress agree on the outbound-worker port", () => {
  const config = parseYaml(readFileSync(join(GATEWAY_ROOT, "config.yaml"), "utf-8")) as {
    orchestrator?: { web?: { worker_url?: string } };
    mcp_catalog?: Record<string, { url?: string }>;
  };
  expect(config.orchestrator?.web?.worker_url).toBe("http://127.0.0.1:8090");
  expect(
    Object.values(config.mcp_catalog ?? {})
      .map((entry) => entry.url)
      .filter(Boolean),
  ).toEqual([]);
});
