import { expect, test } from "bun:test";
import { type SecretAccessor, loadServiceTemplate } from "./template-loader.js";

const yaml = `
image: ghcr.io/homeassistant-ai/ha-mcp:stable
container_name: sentient-ha-mcp
networks: [sentient-internal]
env:
  HOMEASSISTANT_TOKEN: \${HOMEASSISTANT_TOKEN}
  HOMEASSISTANT_URL: \${HOMEASSISTANT_URL}
`;

const secretsMap: Record<string, string | null> = {
  "home_assistant.mcp_server_token": "tok_abc",
  "home_assistant.url": "http://ha:8123",
};

const accessor: SecretAccessor = {
  resolve: (path) => secretsMap[path] ?? null,
};

test("substitutes env vars from secret bindings", async () => {
  const r = await loadServiceTemplate({
    yamlBody: yaml,
    secretBindings: {
      HOMEASSISTANT_TOKEN: "home_assistant.mcp_server_token",
      HOMEASSISTANT_URL: "home_assistant.url",
    },
    secrets: accessor,
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.env.HOMEASSISTANT_TOKEN).toBe("tok_abc");
  expect(r.value.env.HOMEASSISTANT_URL).toBe("http://ha:8123");
});

test("returns missing-secret error when a binding has no value", async () => {
  const r = await loadServiceTemplate({
    yamlBody: yaml,
    secretBindings: {
      HOMEASSISTANT_TOKEN: "home_assistant.mcp_server_token",
      HOMEASSISTANT_URL: "home_assistant.url",
    },
    secrets: { resolve: () => null },
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("missing-secret");
});

test("returns parse-error for bad yaml", async () => {
  const r = await loadServiceTemplate({
    yamlBody: "image: [unterminated",
    secretBindings: {},
    secrets: accessor,
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("parse-error");
});

// SECURITY: a template may publish a host port only on loopback. Docker's
// default bind for a bare "80:80" is 0.0.0.0 — LAN-wide exposure of an addon
// that is supposed to be reachable only by the native gateway.
test("SECURITY: returns policy-violation when a template port omits the loopback bind", async () => {
  const r = await loadServiceTemplate({
    yamlBody: `image: alpine\ncontainer_name: x\nnetworks: [sentient-internal]\nports: ["80:80"]\n`,
    secretBindings: {},
    secrets: accessor,
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("policy-violation");
});

test("SECURITY: returns policy-violation when a template port binds the wildcard address", async () => {
  const r = await loadServiceTemplate({
    yamlBody: `image: alpine\ncontainer_name: x\nnetworks: [sentient-internal]\nports: ["0.0.0.0:80:80"]\n`,
    secretBindings: {},
    secrets: accessor,
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("policy-violation");
});

test("accepts a loopback-bound template port", async () => {
  const r = await loadServiceTemplate({
    yamlBody: `image: alpine\ncontainer_name: x\nnetworks: [sentient-internal]\nports: ["127.0.0.1:8086:8086"]\n`,
    secretBindings: {},
    secrets: accessor,
  });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.ports).toEqual(["127.0.0.1:8086:8086"]);
});

test("missing-secret error carries envVar + path payload", async () => {
  const r = await loadServiceTemplate({
    yamlBody: "image: x\nenv:\n  TOKEN: ${HOMEASSISTANT_TOKEN}\n",
    secretBindings: { HOMEASSISTANT_TOKEN: "home_assistant.mcp_server_token" },
    secrets: { resolve: () => null },
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("missing-secret");
  if (r.error.kind !== "missing-secret") return;
  expect(r.error.envVar).toBe("HOMEASSISTANT_TOKEN");
  expect(r.error.path).toBe("home_assistant.mcp_server_token");
});

test("redacts substituted secret values from parse-error reason", async () => {
  // The secret value starts with "- " which makes YAML interpret it as a
  // block-sequence indicator on the same line as a key, causing a parse-error.
  // The error snippet includes the offending line — the secret must NOT appear
  // in the returned reason or logs.
  const SECRET = "- bad_secret_value_xyz";
  const secretAccessor: SecretAccessor = { resolve: () => SECRET };
  const r = await loadServiceTemplate({
    yamlBody: "image: alpine\ntoken: ${BAD}\n",
    secretBindings: { BAD: "p" },
    secrets: secretAccessor,
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("parse-error");
  if (r.error.kind !== "parse-error") return;
  expect(r.error.reason.includes(SECRET)).toBe(false);
});

test("redacts substituted secret values from schema-error reason", async () => {
  // Substituted secret lands in `env.TOKEN` (valid type), but `networks` is
  // missing — schema requires nonempty networks. zod's error includes a JSON
  // dump of the parsed object via inputs/path; redaction must scrub the
  // secret value before logging or returning.
  const SECRET = "leaky_token_xyz_should_not_appear";
  const r = await loadServiceTemplate({
    yamlBody: "image: alpine\ncontainer_name: x\nenv:\n  TOKEN: ${SECRET}\n",
    secretBindings: { SECRET: "p" },
    secrets: { resolve: () => SECRET },
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("schema-error");
  if (r.error.kind !== "schema-error") return;
  expect(r.error.reason.includes(SECRET)).toBe(false);
});

// SECURITY: the public-port exception (§2.3) is the one narrow hole in the
// loopback rule. It must stay fail-closed on its own — no policy grant means
// no wildcard publish, full stop.
const noSecrets: SecretAccessor = { resolve: () => null };

function templateWithPorts(ports: string[]): string {
  return [
    "image: nginx:1.30-alpine",
    "container_name: c",
    "networks: [sentient-edge]",
    `ports: [${ports.map((p) => `"${p}"`).join(", ")}]`,
  ].join("\n");
}

test("SECURITY: rejects a 0.0.0.0 publish when public_ports is not granted", async () => {
  const r = await loadServiceTemplate({
    yamlBody: templateWithPorts(["0.0.0.0:443:8443"]),
    secretBindings: {},
    secrets: noSecrets,
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("policy-violation");
});

test("SECURITY: accepts 0.0.0.0:443 and 0.0.0.0:80 when public_ports is granted", async () => {
  const r = await loadServiceTemplate({
    yamlBody: templateWithPorts(["0.0.0.0:443:8443", "0.0.0.0:80:8080"]),
    secretBindings: {},
    secrets: noSecrets,
    allowPublicPorts: true,
  });
  expect(r.ok).toBe(true);
});

test("SECURITY: rejects a public port other than 80 or 443 even when public_ports is granted", async () => {
  const r = await loadServiceTemplate({
    yamlBody: templateWithPorts(["0.0.0.0:8888:8888"]),
    secretBindings: {},
    secrets: noSecrets,
    allowPublicPorts: true,
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("policy-violation");
});

test("SECURITY: still accepts loopback publishes when public_ports is granted", async () => {
  const r = await loadServiceTemplate({
    yamlBody: templateWithPorts(["127.0.0.1:8088:8088"]),
    secretBindings: {},
    secrets: noSecrets,
    allowPublicPorts: true,
  });
  expect(r.ok).toBe(true);
});
