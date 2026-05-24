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

test("returns policy-violation when template carries ports", async () => {
  const r = await loadServiceTemplate({
    yamlBody: `image: alpine\ncontainer_name: x\nnetworks: [sentient-internal]\nports: ["80:80"]\n`,
    secretBindings: {},
    secrets: accessor,
  });
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.kind).toBe("policy-violation");
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
