import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devicesConfigSchema } from "@sentient/config";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createAccessManager } from "../../access/access-manager.js";
import { createDeviceRegistry } from "../../user-auth/device-registry.js";
import { createTokenService } from "../../user-auth/token-service.js";
import type { UserRecord } from "../../user-auth/types.js";
import { type DevicesHandlerDeps, createDevicesHandler } from "./devices.js";

let root: string;
let deps: DevicesHandlerDeps;
let handle: ReturnType<typeof createDevicesHandler>;
let token: string;
const secret = () => randomBytes(32).toString("base64url");
const enrollment = () => ({
  version: 1,
  deviceId: randomUUID(),
  attemptId: randomUUID(),
  enrollmentSecret: secret(),
  managerSecret: secret(),
});
const user: UserRecord = {
  userId: "u_00000001",
  displayName: "Test",
  role: "adult",
  pinHash: "unused",
  avatarTint: "sage",
  createdAt: "2026-01-01T00:00:00.000Z",
  credentialsValidFrom: "1970-01-01T00:00:00.000Z",
};
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "device-http-"));
  const key = randomBytes(32);
  const users = { get: async (id: string) => ({ ok: true as const, value: { ...user, userId: id } }) };
  const tokens = createTokenService({
    secret: key,
    ttlSeconds: 60,
    credentialFloor: { validFromMsFor: async () => 0 },
  });
  deps = {
    registry: createDeviceRegistry({
      path: join(root, "devices.db"),
      users,
      accessKey: key,
      escrowKey: randomBytes(32),
      accessTtlSeconds: 60,
      attemptTtlSeconds: 60,
    }),
    tokens,
    users,
    accessManager: createAccessManager({ userDataRoot: root }),
    config: devicesConfigSchema.parse({}),
    tlsEnabled: true,
  };
  handle = createDevicesHandler(deps);
  token = await tokens.issue({ userId: user.userId });
});
afterEach(() => {
  deps.registry.close();
  rmSync(root, { recursive: true, force: true });
});
function req(action = "", body?: unknown, bearer = token) {
  return new Request(`https://test/api/v1/devices${action ? `/${action}` : ""}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

it("owner enrollment → committed retry → activation → recovery/disable; human and device purposes never exchange", async () => {
  const input = enrollment();
  const begun = await handle(req("enroll", input));
  expect(begun.status).toBe(200);
  const status = await begun.json();
  const proof = {
    version: 1,
    deviceId: input.deviceId,
    attemptId: input.attemptId,
    generation: status.generation,
    renewalSecret: secret(),
  };
  const redeem = { ...proof, enrollmentSecret: input.enrollmentSecret };
  expect((await handle(req("redeem", redeem, ""))).status).toBe(200);
  expect((await handle(req("redeem", redeem, ""))).status).toBe(200);
  expect((await (await handle(req("renew", proof, ""))).json()).token).toBeUndefined();
  const active = await (await handle(req("activate", proof, ""))).json();
  expect(typeof active.token).toBe("string");
  expect((await deps.tokens.validate(active.token)).ok).toBe(false);
  expect((await handle(req("", undefined, active.token))).status).toBe(401);
  expect((await handle(req("enroll", enrollment(), active.token))).status).toBe(401);
  expect((await handle(req("renew", { token }))).status).toBe(400);
  expect((await (await handle(req())).json())[0].status).toBe("active");
  const ownerAction = { version: 1, deviceId: input.deviceId };
  const foreign = await deps.tokens.issue({ userId: "u_00000002" });
  expect(await (await handle(req("", undefined, foreign))).json()).toEqual([]);
  for (const action of ["recover", "disable"])
    expect((await handle(req(action, ownerAction, foreign))).status).toBe(403);
  expect((await handle(req("enroll", { ...input, attemptId: randomUUID() }, foreign))).status).toBe(403);
  expect((await handle(req("disable", ownerAction))).status).toBe(200);
  const recovered = await handle(req("recover", ownerAction));
  expect(recovered.headers.get("cache-control")).toBe("no-store");
  expect(await recovered.json()).toMatchObject({ status: "disabled", managerSecret: input.managerSecret });
  expect((await handle(req("renew", proof, ""))).status).toBe(403);
  expect((await handle(req("activate", proof, ""))).status).toBe(403);
});

it("strict schemas and server TLS fact reject spoofing without reserving devices", async () => {
  for (const body of [
    { ...enrollment(), version: 2 },
    { ...enrollment(), ownerId: "u_00000002" },
    { ...enrollment(), managerSecret: "bad" },
  ])
    expect((await handle(req("enroll", body))).status).toBe(400);
  for (const action of ["redeem", "activate", "renew", "recover", "disable"])
    expect((await handle(req(action, {}))).status).toBe(400);
  expect(await (await handle(req())).json()).toEqual([]);
  const insecure = createDevicesHandler({ ...deps, tlsEnabled: false });
  const spoofed = req("enroll", enrollment());
  spoofed.headers.set("x-forwarded-proto", "https");
  expect((await insecure(spoofed)).status).toBe(403);
});

it("bounds declared and streamed bytes, malformed JSON and stalled/aborted bodies; releases concurrency", async () => {
  handle = createDevicesHandler({
    ...deps,
    config: { ...deps.config, body_timeout_ms: 20, max_concurrent_requests: 1 },
  });
  const oversized = req("redeem", {});
  oversized.headers.set("content-length", "99999");
  expect((await handle(oversized)).status).toBe(413);
  const streamed = (body: ReadableStream<Uint8Array>, signal?: AbortSignal) =>
    new Request("https://test/api/v1/devices/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      ...(signal ? { signal } : {}),
    });
  expect(
    (
      await handle(
        streamed(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(4097));
              c.close();
            },
          }),
        ),
      )
    ).status,
  ).toBe(413);
  expect(
    (
      await handle(
        new Request("https://test/api/v1/devices/redeem", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
      )
    ).status,
  ).toBe(400);
  let cancelled = false;
  const stalled = handle(
    streamed(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  expect((await handle(req())).status).toBe(429);
  expect((await stalled).status).toBe(408);
  expect(cancelled).toBe(true);
  expect((await handle(req())).status).toBe(200);
  const controller = new AbortController();
  const aborted = handle(streamed(new ReadableStream(), controller.signal));
  controller.abort();
  expect((await aborted).status).toBe(408);
});

it("global rate budget cannot be bypassed with forwarded IPs, ids or invalid credentials", async () => {
  handle = createDevicesHandler({ ...deps, config: { ...deps.config, requests_per_minute: 1 } });
  expect((await handle(req("", undefined, "bad"))).status).toBe(401);
  const next = req("redeem", {});
  next.headers.set("x-forwarded-for", "192.0.2.2");
  const rejected = await handle(next);
  expect(rejected.status).toBe(429);
  expect(Number(rejected.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(await rejected.json()).toMatchObject({ retryable: true });
});

it("unexpected storage failures become sanitized retryable responses", async () => {
  handle = createDevicesHandler({
    ...deps,
    registry: {
      ...deps.registry,
      redeem: async () => {
        throw new Error("secret-must-not-escape");
      },
    },
  });
  const input = enrollment();
  const response = await handle(
    req("redeem", {
      version: 1,
      deviceId: input.deviceId,
      attemptId: input.attemptId,
      generation: 1,
      enrollmentSecret: input.enrollmentSecret,
      renewalSecret: secret(),
    }),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "unavailable", retryable: true });
});
