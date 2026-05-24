// Tag: @live — only runs with RUN_LIVE=1
import Dockerode from "dockerode";
import { describe, expect, it } from "vitest";

import { type DockerodeLike, createDockerDriver } from "../../src/system-orchestrator/docker-driver.js";
import type { ManagedService } from "../../src/system-orchestrator/types.js";

const RUN_LIVE = process.env.RUN_LIVE === "1";

describe.skipIf(!RUN_LIVE)("[live] dockerDriver against real daemon", () => {
  const docker = new Dockerode() as unknown as DockerodeLike;
  const driver = createDockerDriver({ docker });

  const ms: ManagedService = {
    name: "smoke-noop",
    config: {
      template: "x",
      allowed_images: ["alpine:3.20"],
      networks: ["bridge"],
      secrets: {},
      healthcheck: { tcp: "smoke-noop:1", timeout_ms: 1000 },
      depends_on: [],
      optional: true,
    },
    template: {
      image: "alpine:3.20",
      container_name: "sentient-smoke-noop",
      networks: ["bridge"],
      env: {},
      volumes: [],
      command: ["sleep", "60"],
      extra_hosts: [],
      group_add: [],
    },
  };

  it("recreates a container with the sentient.managed label", async () => {
    const r = await driver.recreate(ms);
    expect(r.ok).toBe(true);
    const live = await driver.listManaged();
    expect(live.find((c) => c.service === "smoke-noop")).toBeTruthy();

    // cleanup
    await driver.remove("sentient-smoke-noop");
  }, 30_000);

  it("rejects a spec whose image is not in allowed_images", async () => {
    const bad = { ...ms, template: { ...ms.template, image: "evil/image:v1" } };
    const r = await driver.recreate(bad);
    expect(r.ok).toBe(false);
  });
});
