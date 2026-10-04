#!/usr/bin/env bun
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { profileV1Schema } from "../../gateway/src/profile-store/profile-types.ts";
import { assertLoopbackFixtureTarget, cleanupDisposableUser, parseFixtureState, provisionDisposableUser, removeFixtureState, writeFixtureState, type FixtureUserAdapter } from "./fixture.ts";
import { assertTextOnlyFixtureTools, fixtureToolCatalogSchema, textOnlyFixtureTools } from "./text-only-tools.ts";

type LocalFetchInit = RequestInit & { tls?: { rejectUnauthorized: boolean } };
const textOnly = process.env.DESIGN_REFRESH_TEXT_ONLY === "1";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required local fixture input: ${name}`);
  return value;
}
async function localFetch(target: string, path: string, init: RequestInit = {}): Promise<Response> {
  const targetUrl = assertLoopbackFixtureTarget(target, process.env.DESIGN_REFRESH_ENVIRONMENT ?? "local");
  const url = new URL(path, targetUrl);
  const options: LocalFetchInit = { ...init };
  if (url.protocol === "https:") options.tls = { rejectUnauthorized: false };
  return fetch(url, options);
}
async function responseJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`local fixture request failed with HTTP ${response.status}`);
  return schema.parse(raw);
}
const authSchema = z.object({ token: z.string().min(1), user: z.object({ userId: z.string() }).passthrough() });
const userSchema = z.object({ user: z.object({ userId: z.string().min(1) }).passthrough() });
function bearer(token: string): Record<string, string> { return { authorization: `Bearer ${token}` }; }

async function login(target: string, userId = required("DESIGN_REFRESH_ADMIN_USER_ID"), pin = required("DESIGN_REFRESH_ADMIN_PIN")): Promise<string> {
  const result = await responseJson(await localFetch(target, "/api/v1/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, pin }),
  }), authSchema);
  return result.token;
}

function syntheticProfileBody(profile: z.infer<typeof profileV1Schema>, tools?: z.infer<typeof profileV1Schema>["tools"]): Record<string, unknown> {
  const { userId: _userId, schemaVersion: _schemaVersion, ...body } = profile;
  return {
    ...body,
    persona: { ...body.persona, overrides: "" },
    advanced: { ...body.advanced, extraSystemPrompt: "" },
    tools: tools ?? { ...(body.tools.toolsets ? { toolsets: body.tools.toolsets } : {}) },
  };
}

async function adapter(target: string, configureTextOnly = false) {
  const adminToken = await login(target);
  const profile = profileV1Schema.parse(await responseJson(
    await localFetch(target, "/api/v1/profile/me", { headers: bearer(adminToken) }),
    profileV1Schema,
  ));
  const tools = configureTextOnly ? textOnlyFixtureTools(await responseJson(
    await localFetch(target, "/api/v1/mcp-catalog", { headers: bearer(adminToken) }),
    fixtureToolCatalogSchema,
  )) : undefined;
  const profileBody = syntheticProfileBody(profile, tools);
  const users: FixtureUserAdapter = {
    createUser: async (input) => {
      const result = await responseJson(await localFetch(target, "/api/v1/admin/users", {
        method: "POST", headers: { ...bearer(adminToken), "content-type": "application/json" },
        body: JSON.stringify({ ...input, role: "adult", profile: profileBody }),
      }), userSchema);
      return { userId: result.user.userId };
    },
    deleteUser: async (userId) => {
      const response = await localFetch(target, `/api/v1/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE", headers: bearer(adminToken) });
      if (!response.ok && response.status !== 404) throw new Error(`local fixture cleanup failed with HTTP ${response.status}`);
    },
  };
  return {
    ...users,
    configureUser: async (userId: string, pin: string) => {
      if (!tools) return;
      // Creation refills empty toolsets; an owned-user PUT preserves the
      // explicit empty list without changing household creation defaults.
      const token = await login(target, userId, pin);
      const updated = profileV1Schema.parse(await responseJson(await localFetch(target, "/api/v1/profile/me", {
        method: "PUT", headers: { ...bearer(token), "content-type": "application/json" },
        body: JSON.stringify({ ...profileBody, userId, schemaVersion: profile.schemaVersion }),
      }), profileV1Schema));
      assertTextOnlyFixtureTools(updated.tools, tools);
      const catalog = await responseJson(await localFetch(target, "/api/v1/mcp-catalog", { headers: bearer(token) }), fixtureToolCatalogSchema);
      assertTextOnlyFixtureTools(tools, textOnlyFixtureTools(catalog));
      if (Object.values(catalog.groups).some(group => group.wildcardPermission !== "off" || group.tools.some(tool => tool.permission !== "off"))) {
        throw new Error("text-only fixture catalog has effective tools");
      }
    },
  };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const target = argument("--target");
  const statePath = argument("--state");
  assertLoopbackFixtureTarget(target, process.env.DESIGN_REFRESH_ENVIRONMENT ?? "local");
  if (command === "provision") {
    await stat(statePath).then(() => { throw new Error("fixture state file already exists"); }, () => undefined);
    const users = await adapter(target, textOnly);
    const pin = required("DESIGN_REFRESH_USER_PIN");
    const fixture = await provisionDisposableUser(users, pin);
    try { await writeFixtureState(statePath, fixture); }
    catch (error) { await cleanupDisposableUser(users, fixture); throw error; }
    try { await users.configureUser(fixture.userId, pin); }
    catch (error) {
      await cleanupDisposableUser(users, fixture);
      await removeFixtureState(statePath);
      throw error;
    }
    process.stdout.write(`${statePath}\n`);
    return;
  }
  if (command === "cleanup") {
    let fixture;
    try { fixture = parseFixtureState(JSON.parse(await readFile(statePath, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const users = await adapter(target);
    await cleanupDisposableUser(users, fixture);
    await removeFixtureState(statePath);
    process.stdout.write(`${statePath}\n`);
    return;
  }
  throw new Error("usage: fixture-control <provision|cleanup> --target <loopback-url> --state <temporary-file>");
}
await main();
