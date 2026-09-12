#!/usr/bin/env bun
import { chmod, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { assertLoopbackFixtureTarget } from "../design-refresh/fixture.ts";

type LocalFetchInit = RequestInit & { tls?: { rejectUnauthorized: boolean } };
const arg = (name: string): string => {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
};
const target = assertLoopbackFixtureTarget(arg("--target"), "local");
const output = arg("--output");
const userId = arg("--user-id-b");
const scheduleIdA = arg("--schedule-id-a");
const sessionIdA = arg("--session-id-a");
const revisionA = Number(arg("--schedule-revision-a"));
if (!Number.isInteger(revisionA) || revisionA < 1) throw new Error("invalid --schedule-revision-a");
const pin = process.env.SCHEDULE_QA_USER_PIN_B?.trim();
if (!pin) throw new Error("missing SCHEDULE_QA_USER_PIN_B");

async function localFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(path, target);
  const options: LocalFetchInit = { ...init };
  if (url.protocol === "https:") options.tls = { rejectUnauthorized: false };
  return fetch(url, options);
}
const login = await localFetch("/api/v1/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ userId, pin }),
});
if (!login.ok) throw new Error(`fixture B login failed: HTTP ${login.status}`);
const token = z.object({ token: z.string().min(1) }).passthrough().parse(await login.json()).token;
const headers = { authorization: `Bearer ${token}` };
const ownSchedules = await localFetch("/api/v1/schedules?limit=100", { headers });
const ownSessions = await localFetch("/api/v1/sessions?limit=100", { headers });
const ownCards = await localFetch("/api/v1/scheduled-session-cards?limit=100", { headers });
if (![ownSchedules, ownSessions, ownCards].every((response) => response.ok)) {
  throw new Error("fixture B authorized baseline failed");
}
const schedulePage = z.object({ schedules: z.array(z.object({ scheduleId: z.string() }).passthrough()) }).passthrough().parse(await ownSchedules.json());
const cardPage = z.object({ cards: z.array(z.object({ scheduleId: z.string(), sessionId: z.string() }).passthrough()) }).passthrough().parse(await ownCards.json());
const crossSchedule = await localFetch(`/api/v1/schedules/${encodeURIComponent(scheduleIdA)}`, {
  method: "PATCH",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify({ expectedRevision: revisionA, changes: { enabled: false } }),
});
const crossSession = await localFetch(`/api/v1/sessions/${encodeURIComponent(sessionIdA)}/messages`, { headers });
const report = {
  schemaVersion: 1,
  testedCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  fixtureBAuthenticatedBaseline: {
    schedulesStatus: ownSchedules.status,
    sessionsStatus: ownSessions.status,
    cardsStatus: ownCards.status,
  },
  crossAccount: {
    scheduleMutationStatus: crossSchedule.status,
    sessionReadStatus: crossSession.status,
    ownerScheduleAbsentFromList: !schedulePage.schedules.some((schedule) => schedule.scheduleId === scheduleIdA),
    ownerDestinationAbsentFromCards: !cardPage.cards.some(
      (card) => card.scheduleId === scheduleIdA || card.sessionId === sessionIdA,
    ),
  },
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await chmod(output, 0o600);
process.stdout.write(`${output}\n`);
