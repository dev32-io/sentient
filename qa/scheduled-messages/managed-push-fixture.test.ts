import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServiceRegistry } from "../../gateway/src/system-orchestrator/service-registry.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("fixture config replaces credential-bound Gorush with loopback native stand-in", () => {
  const root = mkdtempSync(join(tmpdir(), "push-qa-config-"));
  roots.push(root);
  const source = join(root, "source.yaml");
  const output = join(root, "fixture.yaml");
  writeFileSync(
    source,
    "access:\n  user_data_root: ~/.sentient/gateway/users\nmanaged_services:\n  inbound-proxy:\n    template: inbound-proxy.yaml\n  gorush:\n    secrets:\n      TOKEN: push.token\n",
  );
  const run = Bun.spawnSync([
    process.execPath,
    join(import.meta.dir, "prepare-managed-push-config.ts"),
    "--source",
    source,
    "--output",
    output,
    "--state-root",
    root,
  ]);
  expect(run.exitCode).toBe(0);
  const parsed = Bun.YAML.parse(readFileSync(output, "utf8"));
  const entry = parsed.managed_services.gorush;
  expect(entry).toMatchObject({
    launch: "native",
    healthcheck: { url: "http://127.0.0.1:8088/healthz" },
    optional: true,
  });
  expect(Object.keys(parsed.managed_services).sort()).toEqual(["gorush", "inbound-proxy"]);
  expect(parsed.access).toEqual({
    user_data_root: join(root, "gateway/users"),
    shared_data_root: join(root, "gateway/shared"),
  });
  expect(entry.secrets).toBeUndefined();
  expect(entry.exec[0]).toBe("/usr/bin/sandbox-exec");
  expect(entry.exec[2]).toEndWith("qa/scheduled-messages/no-outbound-network.sb");
  expect(entry.exec[4]).toEndWith("qa/scheduled-messages/managed-push-fixture.ts");
  expect(readFileSync(entry.exec[2], "utf8")).toContain("(deny network-outbound)");
});

test("generated real config builds public-door and managed-push registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "push-qa-registry-"));
  roots.push(root);
  const output = join(root, "fixture.yaml");
  const run = Bun.spawnSync([
    process.execPath,
    join(import.meta.dir, "prepare-managed-push-config.ts"),
    "--source",
    join(import.meta.dir, "../../gateway/config.yaml"),
    "--output",
    output,
    "--state-root",
    root,
  ]);
  expect(run.exitCode).toBe(0);
  const config = Bun.YAML.parse(readFileSync(output, "utf8"));
  const registry = await buildServiceRegistry({
    config: config.managed_services,
    readTemplate: (name) => readFile(join(import.meta.dir, "../../gateway/templates/services", name), "utf8"),
    secrets: { resolve: () => null },
    hostEnv: {
      INBOUND_CERT_DIR: join(root, "certs"),
      GATEWAY_CERTS_DIR: join(root, "certs"),
    },
  });
  expect(registry.ok).toBe(true);
  if (registry.ok) expect([...registry.value.keys()].sort()).toEqual(["gorush", "inbound-proxy"]);
});

test("fixture config refuses output outside disposable state root", () => {
  const root = mkdtempSync(join(tmpdir(), "push-qa-config-"));
  roots.push(root);
  const source = join(root, "source.yaml");
  writeFileSync(source, "access: {}\nmanaged_services:\n  inbound-proxy: {}\n");
  const run = Bun.spawnSync([
    process.execPath,
    join(import.meta.dir, "prepare-managed-push-config.ts"),
    "--source",
    source,
    "--output",
    join(tmpdir(), `outside-${crypto.randomUUID()}.yaml`),
    "--state-root",
    root,
  ]);
  expect(run.exitCode).not.toBe(0);
});
