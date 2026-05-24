import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { clearSignalEnv, mergeSignalEnv } from "./env-writer";

describe("env-writer", () => {
  let dir: string;
  let envPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "envwriter-"));
    envPath = join(dir, ".env");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("mergeSignalEnv adds SIGNAL_* keys to empty file", async () => {
    writeFileSync(envPath, "");
    await mergeSignalEnv(envPath, {
      httpUrl: "http://127.0.0.1:10650",
      account: "+15551234567",
      allowedUsers: "+15551234567",
      homeChannel: "+15551234567",
    });
    const out = readFileSync(envPath, "utf8");
    expect(out).toContain("SIGNAL_HTTP_URL=http://127.0.0.1:10650");
    expect(out).toContain("SIGNAL_ACCOUNT=+15551234567");
    expect(out).toContain("SIGNAL_ALLOWED_USERS=+15551234567");
    expect(out).toContain("SIGNAL_ALLOW_ALL_USERS=false");
    expect(out).toContain("SIGNAL_HOME_CHANNEL=+15551234567");
  });

  test("mergeSignalEnv preserves unrelated lines", async () => {
    writeFileSync(envPath, "FOO=bar\nBAZ=qux\n");
    await mergeSignalEnv(envPath, {
      httpUrl: "http://127.0.0.1:10650",
      account: "+15551234567",
      allowedUsers: "+15551234567",
      homeChannel: "+15551234567",
    });
    const out = readFileSync(envPath, "utf8");
    expect(out).toContain("FOO=bar");
    expect(out).toContain("BAZ=qux");
    expect(out).toContain("SIGNAL_HTTP_URL=");
  });

  test("mergeSignalEnv overwrites existing SIGNAL_* keys, not duplicates", async () => {
    writeFileSync(envPath, "SIGNAL_ACCOUNT=+10000000000\nOTHER=stay\n");
    await mergeSignalEnv(envPath, {
      httpUrl: "http://127.0.0.1:10650",
      account: "+15551234567",
      allowedUsers: "+15551234567",
      homeChannel: "+15551234567",
    });
    const out = readFileSync(envPath, "utf8");
    const matches = out.match(/^SIGNAL_ACCOUNT=/gm);
    expect(matches).toHaveLength(1);
    expect(out).toContain("SIGNAL_ACCOUNT=+15551234567");
    expect(out).toContain("OTHER=stay");
  });

  test("clearSignalEnv removes only SIGNAL_* keys", async () => {
    writeFileSync(
      envPath,
      "FOO=bar\nSIGNAL_HTTP_URL=http://x\nSIGNAL_ACCOUNT=+1\nSIGNAL_ALLOWED_USERS=+1\nSIGNAL_ALLOW_ALL_USERS=false\nSIGNAL_HOME_CHANNEL=+1\nBAZ=qux\n",
    );
    await clearSignalEnv(envPath);
    const out = readFileSync(envPath, "utf8");
    expect(out).not.toContain("SIGNAL_");
    expect(out).toContain("FOO=bar");
    expect(out).toContain("BAZ=qux");
  });

  test("mergeSignalEnv on missing file creates it", async () => {
    await mergeSignalEnv(envPath, {
      httpUrl: "http://127.0.0.1:10650",
      account: "+15551234567",
      allowedUsers: "+15551234567",
      homeChannel: "+15551234567",
    });
    const out = readFileSync(envPath, "utf8");
    expect(out).toContain("SIGNAL_ACCOUNT=+15551234567");
  });
});
