import { expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { loadServiceTemplate } from "../system-orchestrator/template-loader.js";

it("pins an ARM64 Gorush image, loopback publish, APNs-only policy and hidden logs", async () => {
  const template = await readFile(new URL("../../templates/services/gorush.yaml", import.meta.url), "utf8");
  const loaded = await loadServiceTemplate({
    yamlBody: template,
    secretBindings: {
      GORUSH_APNS_KEY_BASE64: "push.apns_key_base64",
      GORUSH_APNS_KEY_ID: "push.apns_key_id",
      GORUSH_APNS_TEAM_ID: "push.apns_team_id",
    },
    secrets: { resolve: () => "protected-value" },
    hostEnv: { HOST_CONFIG_DIR: "/tmp/config" },
  });
  expect(loaded.ok).toBe(true);
  if (loaded.ok) {
    expect(loaded.value.image).toMatch(/^appleboy\/gorush:1\.22\.0@sha256:/);
    expect(loaded.value.ports).toEqual(["127.0.0.1:8088:8088"]);
  }
  const config = parse(await readFile(new URL("../../templates/services/gorush/config.yml", import.meta.url), "utf8"));
  expect(config.android.enabled).toBe(false);
  expect(config.ios).toMatchObject({ enabled: true, max_retry: 0, key_type: "p8" });
  expect(config.log).toMatchObject({ hide_token: true, hide_messages: true });
});
