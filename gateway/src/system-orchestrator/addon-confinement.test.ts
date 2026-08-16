import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { MANAGED_NETWORK_TOPOLOGY, type ServiceTemplate, ServiceTemplateSchema } from "./types.js";

// SECURITY BOUNDARY over the SHIPPED artifacts, not over a fixture.
//
// The confinement these tests pin has already been lost once on this branch:
// docker silently drops port publishing when every attached network is
// `internal: true` (verified on docker 29.2.1), so making the MCPs
// host-reachable by joining them to `sentient-external` looked like the only
// option — and that downgraded fetch-mcp's egress from network-enforced to
// env-advisory on the one addon whose whole job is dereferencing untrusted URLs.
// `ingress-proxy` exists so no MCP has to make that trade. Nothing else in the
// suite reads the real templates, so nothing else would notice them drifting
// back.
const GATEWAY_ROOT = join(import.meta.dir, "..", "..");
const TEMPLATE_DIR = join(GATEWAY_ROOT, "templates", "services");

/** Every MCP that dereferences untrusted content. These MUST be reachable only
 *  through ingress-proxy, never by publishing a port themselves. */
const CONFINED_ADDONS = ["fetch-mcp", "searxng-mcp", "outbound-worker"] as const;
const INTERNAL_NET = "sentient-internal";
const EXTERNAL_NET = "sentient-external";
/** `127.0.0.1:<host>:<container>` — host port is what a caller can reach. */
const HOST_PORT_RE = /^127\.0\.0\.1:(\d+):\d+$/;
/** A catalog endpoint the gateway dials over loopback, e.g.
 *  `http://127.0.0.1:8088/mcp`. Native services (whisper-stt, local-tts) are
 *  loopback too but publish nothing — they are not in mcp_catalog. */
const LOOPBACK_MCP_URL_RE = /^http:\/\/127\.0\.0\.1:(\d+)\//;

function loadTemplate(name: string): ServiceTemplate {
  const body = readFileSync(join(TEMPLATE_DIR, `${name}.yaml`), "utf-8");
  return ServiceTemplateSchema.parse(parseYaml(body));
}

function hostPortsOf(t: ServiceTemplate): number[] {
  return t.ports.map((p) => Number(HOST_PORT_RE.exec(p)?.[1] ?? Number.NaN));
}

for (const name of CONFINED_ADDONS) {
  test(`SECURITY: ${name} is confined to the no-egress network and publishes no host port`, () => {
    const t = loadTemplate(name);
    // Membership of a non-internal network is what makes egress physically
    // possible, so the assertion is on the whole list, not on `includes`.
    expect(t.networks).toEqual([INTERNAL_NET]);
    expect(MANAGED_NETWORK_TOPOLOGY[INTERNAL_NET]?.internal).toBe(true);
    // A publish here would be the tell that someone re-added the external join
    // to make it take effect — docker drops the publish without it.
    expect(t.ports).toEqual([]);
  });
}

// ingress-proxy is the ONE container allowed to span both networks. It holds the
// publish the MCPs gave up, so if it ever loses either membership the addons are
// unreachable (no external ⇒ publish dropped) or unfrontable (no internal ⇒ no
// route to the MCPs).
test("SECURITY: ingress-proxy spans both networks and is the only publisher for confined addons", () => {
  const proxy = loadTemplate("ingress-proxy");
  expect(proxy.networks).toEqual([INTERNAL_NET, EXTERNAL_NET]);
  expect(MANAGED_NETWORK_TOPOLOGY[EXTERNAL_NET]?.internal).toBe(false);
  expect(hostPortsOf(proxy).length).toBe(CONFINED_ADDONS.length);
});

// WIRE CONTRACT (gateway → addon, across the loopback boundary). The gateway
// dials `http://127.0.0.1:<port>/mcp` from mcp_catalog; something must publish
// that exact port or the tool call fails with ECONNREFUSED that names no cause.
// The two halves live in different files, so a port edit on one side alone is
// invisible until a tool call fails at runtime.
test("CONTRACT: every loopback port mcp_catalog dials is published by exactly one service template", () => {
  const config = parseYaml(readFileSync(join(GATEWAY_ROOT, "config.yaml"), "utf-8")) as {
    mcp_catalog?: Record<string, { url?: string }>;
  };
  const catalogPorts = new Set<number>();
  for (const entry of Object.values(config.mcp_catalog ?? {})) {
    const port = LOOPBACK_MCP_URL_RE.exec(entry.url ?? "")?.[1];
    if (port !== undefined) catalogPorts.add(Number(port));
  }
  expect(catalogPorts.size).toBeGreaterThan(0);

  const publishers = new Map<number, string[]>();
  for (const file of new Bun.Glob("*.yaml").scanSync(TEMPLATE_DIR)) {
    const name = file.replace(/\.yaml$/, "");
    for (const port of hostPortsOf(loadTemplate(name))) {
      publishers.set(port, [...(publishers.get(port) ?? []), name]);
    }
  }

  for (const port of catalogPorts) {
    expect(publishers.get(port) ?? []).toHaveLength(1);
  }
});
