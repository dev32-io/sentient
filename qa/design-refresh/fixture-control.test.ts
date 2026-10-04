import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { profileV1PutBodySchema, profileV1Schema } from "../../gateway/src/profile-store/profile-types.ts";
import { applyProfileUpdate } from "../../gateway/src/profile-store/profile-update.ts";
import { catalogTools, mcpCatalogSchema } from "../../shared/config/src/index.ts";
import { foundationProductToolMetadata } from "../../gateway/src/bootstrap/product-tool-metadata.ts";
import { loadShippedCatalog } from "../../gateway/src/testing/shipped-catalog.ts";
import { textOnlyFixtureTools, textOnlyRequiredGroups } from "./text-only-tools.ts";
import { defaultPermissionsFor } from "../../gateway/src/tools/role-defaults.ts";
import { resolveToolPermission } from "../../gateway/src/tools/resolve-tool-permission.ts";
import { writeFixtureState } from "./fixture.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const adminId = "u_fixture_admin";
const userId = "u_fixture_owned";
const adminProfile = profileV1Schema.parse({
  schemaVersion: 1, userId: adminId,
  model: { provider: "openrouter", id: "synthetic" }, voice: { provider: "local-tts", id: "default" },
  persona: { template: "default", overrides: "" },
  tools: { permissions: {}, toolsets: ["memory", "todo"] },
  compression: { threshold: 0.5 }, advanced: { extraSystemPrompt: "", maxTokens: 1024 },
});
const catalog = mcpCatalogSchema.parse({ ...loadShippedCatalog(), synthetic_transport: {
  product_group: "synthetic_extension", transport: "http", url: "http://127.0.0.1/unused",
  tools: { include: [{ name: "synthetic_query", tier: "read" }] },
} });
const permissionDefaults = defaultPermissionsFor("adult", catalog, { includeFoundationTools: true });
const expectedTextOnlyTools = textOnlyFixtureTools({
  wildcardPermissionKey: "*",
  groups: Object.fromEntries([...new Set([...textOnlyRequiredGroups, ...catalogTools(catalog).map(tool => tool.productGroup)])]
    .map(group => [group, { tools: [], wildcardPermission: null }])),
});

// Same CLI preload seam as the review repro: no socket, backend or real login.
async function cliFixture(root: string, textOnly: boolean) {
  const statePath = join(root, "user.json");
  const resultPath = join(root, "result.json");
  const preloadPath = join(root, "preload.ts");
  await writeFile(preloadPath, `
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { applyProfileDefaults } from ${JSON.stringify(join(repoRoot, "gateway/src/profile-store/profile-defaults.ts"))};
import { profileV1PutBodySchema, profileV1Schema } from ${JSON.stringify(join(repoRoot, "gateway/src/profile-store/profile-types.ts"))};
import { applyProfileUpdate } from ${JSON.stringify(join(repoRoot, "gateway/src/profile-store/profile-update.ts"))};
import { createMcpCatalogHandler } from ${JSON.stringify(join(repoRoot, "gateway/src/api/handlers/mcp-catalog.ts"))};
const adminProfile = ${JSON.stringify(adminProfile)};
const permissionDefaults = ${JSON.stringify(permissionDefaults)};
const userId = ${JSON.stringify(userId)};
const catalog = ${JSON.stringify(catalog)};
let stored = process.env.FIXTURE_TEST_OWNED === "1" ? { ...adminProfile, userId } : undefined;
let created = false, profilePuts = 0, deletes = 0, catalogGets = 0, creationTools = null, stateAtSetup = null, modeAtSetup = null;
const catalogHandler = createMcpCatalogHandler({
  catalog, hermesBuiltinTools: [],
  tokens: { validate: async token => ({ ok: true, value: { userId: token === process.env.FIXTURE_TEST_ADMIN_TOKEN ? adminProfile.userId : userId } }) },
  users: { get: async id => ({ ok: true, value: { userId: id, role: id === adminProfile.userId ? "admin" : "adult" } }) },
  profileStore: { get: async id => ({ ok: true, value: id === adminProfile.userId ? adminProfile : stored }) },
});
globalThis.fetch = async (url, init = {}) => {
  const request = new Request(url, init);
  const path = new URL(request.url).pathname;
  const admin = request.headers.get("authorization") === "Bearer " + process.env.FIXTURE_TEST_ADMIN_TOKEN;
  const owned = request.headers.get("authorization") === "Bearer " + process.env.FIXTURE_TEST_USER_TOKEN;
  if (path === "/api/v1/auth/login" && request.method === "POST") {
    const body = await request.json();
    const isAdmin = body.userId === adminProfile.userId && body.pin === process.env.DESIGN_REFRESH_ADMIN_PIN;
    const isOwned = body.userId === userId && body.pin === process.env.DESIGN_REFRESH_USER_PIN;
    if (!isAdmin && !isOwned) throw new Error("unexpected synthetic login");
    if (isOwned) {
      try {
        stateAtSetup = JSON.parse(readFileSync(process.env.FIXTURE_TEST_STATE, "utf8"));
        modeAtSetup = statSync(process.env.FIXTURE_TEST_STATE).mode & 0o777;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return Response.json({ token: isAdmin ? process.env.FIXTURE_TEST_ADMIN_TOKEN : process.env.FIXTURE_TEST_USER_TOKEN, user: { userId: body.userId } });
  }
  if (path === "/api/v1/profile/me" && request.method === "GET" && admin) return Response.json(adminProfile);
  if (path === "/api/v1/mcp-catalog" && request.method === "GET" && (admin || owned)) {
    catalogGets++;
    const body = await (await catalogHandler(request)).json();
    if (admin && process.env.FIXTURE_TEST_MISSING_GROUP === "1") delete body.groups.memory;
    if (owned && process.env.FIXTURE_TEST_UNCOVERED_GROUP === "1") body.groups.uncovered = { tools: [], wildcardPermission: "off" };
    if (owned && process.env.FIXTURE_TEST_EFFECTIVE_TOOL === "1") body.groups.web.tools[0].permission = "allow";
    return Response.json(body);
  }
  if (path === "/api/v1/admin/users" && request.method === "POST" && admin) {
    const body = await request.json();
    if (body.role !== "adult" || body.pin !== process.env.DESIGN_REFRESH_USER_PIN) throw new Error("unexpected synthetic creation");
    stored = applyProfileDefaults(profileV1Schema.parse({ ...body.profile, userId, schemaVersion: 1 }), { role: "adult", mcpCatalog: catalog });
    creationTools = stored.tools;
    created = true;
    return Response.json({ user: { userId } }, { status: 201 });
  }
  if (path === "/api/v1/profile/me" && request.method === "PUT" && owned) {
    profilePuts++;
    if (process.env.FIXTURE_TEST_FAIL_PUT === "1") return new Response(null, { status: 503 });
    stored = profileV1Schema.parse(JSON.parse(JSON.stringify(applyProfileUpdate(profileV1PutBodySchema.parse(await request.json()), { stored, permissionDefaults }))));
    if (process.env.FIXTURE_TEST_BAD_DENY === "1") stored.tools.permissions.native = {};
    return Response.json(stored);
  }
  if (path === "/api/v1/admin/users/" + userId && request.method === "DELETE" && admin) {
    deletes++;
    if (process.env.FIXTURE_TEST_FAIL_DELETE === "1") return new Response(null, { status: 503 });
    stored = undefined;
    return new Response(null, { status: 204 });
  }
  throw new Error("unexpected synthetic request");
};
process.on("exit", () => writeFileSync(process.env.FIXTURE_TEST_RESULT, JSON.stringify({ created, profilePuts, deletes, catalogGets, creationTools, stateAtSetup, modeAtSetup, stored })));
`);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    DESIGN_REFRESH_ENVIRONMENT: "local", DESIGN_REFRESH_ADMIN_USER_ID: adminId,
    DESIGN_REFRESH_ADMIN_PIN: "1234", DESIGN_REFRESH_USER_PIN: "1234",
    FIXTURE_TEST_ADMIN_TOKEN: "synthetic-admin", FIXTURE_TEST_USER_TOKEN: "synthetic-user",
    FIXTURE_TEST_STATE: statePath, FIXTURE_TEST_RESULT: resultPath,
  };
  // Legacy model-probe caller leaves flag absent, regardless of test shell.
  if (textOnly) env.DESIGN_REFRESH_TEXT_ONLY = "1";
  const run = async (command: string, overrides: NodeJS.ProcessEnv = {}) => {
    const stderrPath = join(root, "stderr.txt");
    const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", preloadPath, "qa/design-refresh/fixture-control.ts", command, "--target", "http://127.0.0.1/", "--state", statePath], {
      cwd: repoRoot, env: { ...env, ...overrides }, stdout: "pipe", stderr: Bun.file(stderrPath),
    });
    const timeout = setTimeout(() => child.kill(), 10000);
    try {
      const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      const stderr = await readFile(stderrPath, "utf8");
      const result = JSON.parse(await readFile(resultPath, "utf8"));
      const state = await readFile(statePath, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
      for (const value of [env.DESIGN_REFRESH_ADMIN_PIN!, env.FIXTURE_TEST_ADMIN_TOKEN!, env.FIXTURE_TEST_USER_TOKEN!]) {
        expect(stdout + stderr + state + JSON.stringify(result)).not.toContain(value);
      }
      return { exit, stdout, stderr, result, state };
    } finally { clearTimeout(timeout); }
  };
  return { run, statePath };
}

function expectOwnership(raw: unknown) {
  expect(raw).toEqual({ runId: expect.stringMatching(/^design-refresh-/), userId });
}

describe("fixture-control CLI tool safety", () => {
  for (const textOnly of [true, false]) {
    it(textOnly ? "persists everything-off for designated text-only callers" : "preserves starter tools for legacy tool-dependent callers", async () => {
      const root = await mkdtemp(join(tmpdir(), "design-refresh-cli-"));
      try {
        const { run, statePath } = await cliFixture(root, textOnly);
        const provision = await run("provision");
        expect(provision.exit).toBe(0);
        expectOwnership(JSON.parse(provision.state));
        expect((await stat(statePath)).mode & 0o777).toBe(0o600);
        const stored = provision.result.stored;
        expect(stored.tools.permissions).toEqual(textOnly ? expectedTextOnlyTools.permissions : permissionDefaults);
        expect(provision.result.creationTools.permissions).toEqual(stored.tools.permissions);
        expect(provision.result.creationTools.toolsets.length).toBeGreaterThan(0);
        expect(provision.result.catalogGets).toBe(textOnly ? 2 : 0);
        expect(stored.tools.toolsets).toEqual(textOnly ? [] : adminProfile.tools.toolsets);
        expect(provision.result.profilePuts).toBe(textOnly ? 1 : 0);
        if (textOnly) {
          expectOwnership(provision.result.stateAtSetup);
          expect(provision.result.modeAtSetup).toBe(0o600);
          const roundtrip = profileV1Schema.parse(JSON.parse(JSON.stringify(stored)));
          const updated = applyProfileUpdate(profileV1PutBodySchema.parse({ ...roundtrip, tools: { permissions: {}, toolsets: [] } }), { stored: roundtrip, permissionDefaults });
          expect(updated.tools).toEqual(expectedTextOnlyTools);
          for (const tool of [...catalogTools(catalog), ...foundationProductToolMetadata()]) {
            expect(resolveToolPermission({ toolName: tool.name, tier: tool.tier, productGroup: tool.productGroup,
              defaultExposure: tool.defaultExposure, storedPermissions: updated.tools.permissions, roleTemplate: permissionDefaults }).permission).toBe("off");
          }
        }
        expect(resolveToolPermission({
          toolName: "scheduled_message_create", tier: "write", productGroup: "scheduled", defaultExposure: "standard",
          storedPermissions: stored.tools.permissions, roleTemplate: permissionDefaults,
        }).permission).toBe(textOnly ? "off" : "ask");
        const cleanup = await run("cleanup", { FIXTURE_TEST_OWNED: "1" });
        expect(cleanup.exit).toBe(0);
        expect(cleanup.result.deletes).toBe(1);
        expect(cleanup.result.stored).toBeUndefined();
        expect(cleanup.state).toBe("");
      } finally { await rm(root, { recursive: true, force: true }); }
    }, 15000);
  }

  for (const [flag, created, reason] of [
    ["FIXTURE_TEST_MISSING_GROUP", false, "missing a current native product group"],
    ["FIXTURE_TEST_BAD_DENY", true, "differ from exact deny-all contract"],
    ["FIXTURE_TEST_UNCOVERED_GROUP", true, "differ from exact deny-all contract"],
    ["FIXTURE_TEST_EFFECTIVE_TOOL", true, "catalog has effective tools"],
  ] as const) {
    it(`refuses incomplete tool safety: ${flag}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "design-refresh-cli-"));
      try {
        const { run } = await cliFixture(root, true);
        const result = await run("provision", { [flag]: "1" });
        expect(result.exit).toBe(1);
        expect(result.stderr).toContain(reason);
        expect(result.result.created).toBe(created);
        expect(result.result.deletes).toBe(created ? 1 : 0);
        expect(result.result.stored).toBeUndefined();
        expect(result.state).toBe("");
      } finally { await rm(root, { recursive: true, force: true }); }
    }, 15000);
  }

  for (const failedDelete of [false, true]) {
    it(failedDelete ? "retains IDs-only ownership after failed PUT and rollback, then retries cleanup" : "removes ownership after failed PUT and successful rollback", async () => {
      const root = await mkdtemp(join(tmpdir(), "design-refresh-cli-"));
      try {
        const { run, statePath } = await cliFixture(root, true);
        const provision = await run("provision", { FIXTURE_TEST_FAIL_PUT: "1", FIXTURE_TEST_FAIL_DELETE: failedDelete ? "1" : "0" });
        expect(provision.exit).toBe(1);
        expect(provision.result.created).toBe(true);
        expect(provision.result.profilePuts).toBe(1);
        expect(provision.result.deletes).toBe(1);
        expect(provision.stderr).toContain(failedDelete ? "local fixture cleanup failed with HTTP 503" : "local fixture request failed with HTTP 503");
        // This assertion reproduces WV-7 before repair: missing retry identity.
        if (failedDelete) {
          expectOwnership(JSON.parse(provision.state || "null"));
          expect((await stat(statePath)).mode & 0o777).toBe(0o600);
          expect(provision.result.stored?.userId).toBe(userId);
          const failedCleanup = await run("cleanup", { FIXTURE_TEST_OWNED: "1", FIXTURE_TEST_FAIL_DELETE: "1" });
          expect(failedCleanup.exit).toBe(1);
          expect(failedCleanup.result.deletes).toBe(1);
          expect(failedCleanup.state).toBe(provision.state);
          const cleanup = await run("cleanup", { FIXTURE_TEST_OWNED: "1" });
          expect(cleanup.exit).toBe(0);
          expect(cleanup.result.deletes).toBe(1);
          expect(cleanup.result.stored).toBeUndefined();
          expect(cleanup.state).toBe("");
        } else {
          expect(provision.result.stored).toBeUndefined();
          expect(provision.state).toBe("");
        }
        expectOwnership(provision.result.stateAtSetup);
        expect(provision.result.modeAtSetup).toBe(0o600);
      } finally { await rm(root, { recursive: true, force: true }); }
    }, 15000);
  }
});

describe("fixture runner cleanup traps", () => {
  for (const runner of ["qa/design-refresh/run-web-text-only.sh", "qa/design-refresh/run-ios-text-only.sh", "qa/scheduled-messages/run-model-probe.sh"]) {
    for (const failedDelete of [true, false]) {
      it(`${runner}: ${failedDelete ? "retains failed-cleanup state" : "removes confirmed-cleanup state"}`, async () => {
        const root = await mkdtemp(join(tmpdir(), "design-refresh-trap-"));
        const statePath = join(root, "user.json");
        try {
          await writeFixtureState(statePath, { runId: "design-refresh-trap", userId });
          const before = await readFile(statePath, "utf8");
          const source = await readFile(join(repoRoot, runner), "utf8");
          const cleanup = source.slice(source.indexOf("cleanup() {"), source.indexOf("trap cleanup"));
          // Execute actual trap body only. No driver, native command or CLI/backend.
          const shell = `
STATE_DIR="$TEST_ROOT"; USER_STATE="$TEST_STATE"; STATE="$TEST_STATE"
CALENDAR_STATE="$TEST_ROOT/calendar.json"; ORIGINAL_TEXT_SIZE=""
TARGET="http://127.0.0.1/"; REPO="$TEST_ROOT"
SCHEDULE_QA_ADMIN_USER_ID="u_unused"; SCHEDULE_QA_ADMIN_PIN=""; SCHEDULE_QA_USER_PIN=""
bun() { if [[ "$TEST_FAIL_DELETE" == 1 ]]; then return 1; fi; rm -f "$TEST_STATE"; }
${cleanup}
true
cleanup
`;
          const stderrPath = join(root, "stderr.txt");
          const child = Bun.spawn(["bash", "-c", shell], { env: {
            PATH: process.env.PATH, TEST_ROOT: root, TEST_STATE: statePath, TEST_FAIL_DELETE: failedDelete ? "1" : "0",
          }, stdout: "pipe", stderr: Bun.file(stderrPath) });
          const exit = await child.exited;
          const stderr = failedDelete ? await readFile(stderrPath, "utf8") : "";
          const modelProbe = runner.includes("model-probe");
          expect(exit).toBe(failedDelete && !modelProbe ? 1 : 0);
          if (failedDelete) {
            expect(await readFile(statePath, "utf8").catch(() => "")).toBe(before);
            expect((await stat(statePath)).mode & 0o777).toBe(0o600);
            expect(stderr).toContain(root);
          } else {
            expect(await Bun.file(statePath).exists()).toBe(false);
          }
        } finally { await rm(root, { recursive: true, force: true }); }
      });
    }
  }
});
