import { rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";

export interface DisposableUserFixture {
  readonly runId: string;
  readonly userId: string;
}

export interface FixtureUserAdapter {
  createUser(input: { displayName: string; pin: string }): Promise<{ userId: string }>;
  deleteUser(userId: string): Promise<void>;
}

export function assertLoopbackFixtureTarget(target: string, environment = "local"): URL {
  if (environment !== "local") throw new Error("design-refresh fixtures require an explicit local environment");
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error("fixture target must be an absolute loopback URL");
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error("fixture target must be an unauthenticated HTTP(S) loopback URL");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host !== "localhost" && host !== "::1" && !/^127(?:\.\d{1,3}){3}$/.test(host)) throw new Error("fixture target must resolve directly to loopback");
  return url;
}

export async function provisionDisposableUser(adapter: FixtureUserAdapter, pin: string): Promise<DisposableUserFixture> {
  if (!/^\d{4}$/.test(pin)) throw new Error("disposable fixture PIN must contain exactly four digits");
  const runId = `design-refresh-${crypto.randomUUID()}`;
  const user = await adapter.createUser({ displayName: `Synthetic Refresh ${runId.slice(-8)}`, pin });
  return { runId, userId: z.string().regex(/^u_[A-Za-z0-9_-]+$/).parse(user.userId) };
}

export async function cleanupDisposableUser(adapter: FixtureUserAdapter, fixture: DisposableUserFixture): Promise<void> {
  await adapter.deleteUser(fixture.userId);
}

export async function withDisposableUser<T>(adapter: FixtureUserAdapter, pin: string, run: (fixture: DisposableUserFixture) => Promise<T>): Promise<T> {
  const fixture = await provisionDisposableUser(adapter, pin);
  try {
    return await run(fixture);
  } finally {
    await cleanupDisposableUser(adapter, fixture);
  }
}

const stateSchema = z.object({ runId: z.string().startsWith("design-refresh-"), userId: z.string().regex(/^u_[A-Za-z0-9_-]+$/) });

export async function writeFixtureState(path: string, fixture: DisposableUserFixture): Promise<void> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(fixture, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

export async function removeFixtureState(path: string): Promise<void> {
  await rm(resolve(path), { force: true });
}

export function parseFixtureState(raw: unknown): DisposableUserFixture {
  return stateSchema.parse(raw);
}
