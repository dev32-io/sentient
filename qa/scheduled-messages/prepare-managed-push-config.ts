#!/usr/bin/env bun
import { access, chmod, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const value = (name: string): string => {
  const index = process.argv.indexOf(name);
  const result = index >= 0 ? process.argv[index + 1] : undefined;
  if (!result) throw new Error(`missing ${name}`);
  return result;
};
const port = process.argv.includes("--port") ? Number(value("--port")) : 18088;
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 8088) {
  throw new Error("managed-push fixture port must be 1024–65535, excluding real Gorush port 8088");
}
const source = resolve(value("--source"));
const output = resolve(value("--output"));
const stateRootInput = value("--state-root");
if (!isAbsolute(stateRootInput)) throw new Error("--state-root must be an absolute disposable path");
const stateRoot = resolve(stateRootInput);
const outputRelative = relative(stateRoot, output);
if (source === output || outputRelative === ".." || outputRelative.startsWith("../")) {
  throw new Error("managed-push fixture config must stay inside disposable state root");
}
const config = Bun.YAML.parse(await readFile(source, "utf8"));
if (!config || typeof config !== "object" || !config.managed_services || !config.access) {
  throw new Error("invalid gateway config");
}
// Ephemeral fixture config is projected from current validated source. Keep
// operator migrations from re-adding production-only services after projection.
config.schema_version = "qa-managed-push-v1";
config.access.user_data_root = resolve(stateRoot, "gateway/users");
config.access.shared_data_root = resolve(stateRoot, "gateway/shared");
config.push = {
  ...config.push,
  provider_url: `http://127.0.0.1:${port}/api/push`,
};
const inboundProxy = config.managed_services["inbound-proxy"];
if (!inboundProxy) throw new Error("gateway config has no inbound-proxy policy");

const sandbox = "/usr/bin/sandbox-exec";
await access(sandbox, constants.X_OK).catch(() => {
  throw new Error("managed-push fixture requires sandbox-exec; outbound network must be denied before startup");
});
config.managed_services = {
  "inbound-proxy": inboundProxy,
  gorush: {
    launch: "native",
    exec: [
      sandbox,
      "-f",
      resolve(import.meta.dir, "no-outbound-network.sb"),
      process.execPath,
      resolve(import.meta.dir, "managed-push-fixture.ts"),
    ],
    env: { PUSH_QA_PORT: String(port) },
    healthcheck: { url: `http://127.0.0.1:${port}/healthz`, timeout_ms: 10_000 },
    depends_on: [],
    optional: true,
    // Fresh isolated roots are pre-wizard. This QA transport must join only
    // that fixture's infra-only boot; production Gorush remains non-infra.
    infra: true,
  },
};
await writeFile(output, Bun.YAML.stringify(config), { flag: "wx", mode: 0o600 });
await chmod(output, 0o600);
process.stdout.write(`${output}\n`);
