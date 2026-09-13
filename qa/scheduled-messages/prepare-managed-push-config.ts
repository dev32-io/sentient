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
config.access.user_data_root = resolve(stateRoot, "gateway/users");
config.access.shared_data_root = resolve(stateRoot, "gateway/shared");
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
    healthcheck: { url: "http://127.0.0.1:8088/healthz", timeout_ms: 10_000 },
    depends_on: [],
    optional: true,
  },
};
await writeFile(output, Bun.YAML.stringify(config), { flag: "wx", mode: 0o600 });
await chmod(output, 0o600);
process.stdout.write(`${output}\n`);
