#!/usr/bin/env bun
// mint-cube-token.ts — Local-dev helper for Phase 6 cube smoke. Mints a fresh
// PASETO v4.local user-session token against the gateway's current
// ~/.sentient/gateway/auth-secret.key, signing the first admin user from
// ~/.sentient/gateway/users.json. Prints the token to stdout.
//
// Invoked by esp32/cube/scripts/bake-creds.sh on every bake so the baked
// firmware always carries a fresh, valid token. Not suitable for prod —
// proper per-device tokens come later.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createTokenService } from "../src/user-auth/token-service.js";

const SECRET_BYTE_LENGTH = 32;
const DEV_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

async function main(): Promise<void> {
    // The docker stack mounts ~/.sentient/gateway/data → /app/gateway-data
    // and gateway-side getGatewayRoot() resolves to /app/gateway-data inside
    // the container. Both auth-secret.key and users.json live there. The
    // host-side ~/.sentient/gateway/auth-secret.key is a separate (stale)
    // copy used by host-side bun runs.
    const dataDir = join(homedir(), ".sentient", "gateway", "data");
    const secretPath = join(dataDir, "auth-secret.key");
    const usersPath = join(dataDir, "users.json");

    const secretBuf = await fs.readFile(secretPath);
    if (secretBuf.length !== SECRET_BYTE_LENGTH) {
        throw new Error(
            `mint: ${secretPath} expected ${SECRET_BYTE_LENGTH} bytes, got ${secretBuf.length}`,
        );
    }
    const secret = new Uint8Array(secretBuf);

    const usersRaw = await fs.readFile(usersPath, "utf8");
    const users = JSON.parse(usersRaw);
    if (!Array.isArray(users) || users.length === 0) {
        throw new Error(`mint: ${usersPath} has no users — run wizard first`);
    }
    // Accepts either shape: `role: "admin"` (current) or the pre-role
    // `isAdmin: true`, since a dev box may not have rewritten users.json yet.
    const admin = users.find((u) => u && (u.role === "admin" || u.isAdmin === true));
    if (!admin) {
        throw new Error(`mint: ${usersPath} has no admin user`);
    }

    // IDENTITY ONLY — the token names the user and confers nothing. The cube
    // gets whatever this account's record says it may do, resolved per request
    // by the gateway, so a baked token cannot outlive a role change.
    // (`gateway/scripts/` is outside tsconfig's `include`, so nothing would
    // have caught a stale `role:` argument here at build time.)
    const tokens = createTokenService({ secret, ttlSeconds: DEV_TTL_SECONDS });
    const token = await tokens.issue({ userId: String(admin.userId) });

    process.stdout.write(token);
    process.stderr.write(`[mint-cube-token] minted for userId=${admin.userId} ttl=${DEV_TTL_SECONDS}s\n`);
}

main().catch((err: unknown) => {
    process.stderr.write(`[mint-cube-token] ERROR: ${(err as Error).message}\n`);
    process.exit(1);
});
