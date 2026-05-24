import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Result } from "@sentient/protocol";
import { getLog } from "../logging/logger.js";
import { writeFileAtomic } from "../user-auth/atomic-write.js";

const log = getLog(["sentient", "gateway", "admin", "internal-secrets"]);
const FILE_NAME = "internal-secrets.json";
const FILE_MODE = 0o600;
const TOKEN_BYTES = 32;
const SCHEMA_VERSION = 2;

export interface InternalSecrets {
  hermesAuthToken: string; // 64-char hex
  searxngSecret: string; // 64-char hex
}

interface PersistedV1 {
  schemaVersion: 1;
  hermesAuthToken: string;
}

interface PersistedV2 {
  schemaVersion: 2;
  hermesAuthToken: string;
  searxngSecret: string;
}

type Persisted = PersistedV1 | PersistedV2;

export type InternalSecretsError = { kind: "io-error"; reason: string } | { kind: "corrupt-file"; reason: string };

export interface InternalSecretsStore {
  loadOrInit(): Promise<Result<InternalSecrets, InternalSecretsError>>;
  getHermesAuthTokenSync(): string;
  getSearxngSecretSync(): string;
}

export function createInternalSecretsStore(dataDir: string): InternalSecretsStore {
  const path = join(dataDir, FILE_NAME);
  let cached: InternalSecrets | null = null;

  return {
    async loadOrInit() {
      if (cached) return { ok: true, value: cached };
      try {
        let raw: string;
        try {
          raw = await fs.readFile(path, "utf8");
        } catch (e: unknown) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          raw = "";
        }
        if (raw !== "") {
          const parsed = JSON.parse(raw) as Persisted;
          if (typeof parsed.hermesAuthToken !== "string" || !/^[0-9a-f]{64}$/.test(parsed.hermesAuthToken)) {
            return { ok: false, error: { kind: "corrupt-file", reason: "invalid hermesAuthToken" } };
          }
          const hermesAuthToken = parsed.hermesAuthToken;
          let searxngSecret: string;
          if (parsed.schemaVersion === 2) {
            if (typeof parsed.searxngSecret !== "string" || !/^[0-9a-f]{64}$/.test(parsed.searxngSecret)) {
              return { ok: false, error: { kind: "corrupt-file", reason: "invalid searxngSecret" } };
            }
            searxngSecret = parsed.searxngSecret;
            cached = { hermesAuthToken, searxngSecret };
            log.info("loadOrInit.loaded", {
              schemaVersion: 2,
              hermesFp: fingerprint(hermesAuthToken),
              searxngFp: fingerprint(searxngSecret),
            });
            return { ok: true, value: cached };
          }
          // v1 → v2 migration: keep the existing hermes token, generate searxng secret.
          searxngSecret = randomBytes(TOKEN_BYTES).toString("hex");
          cached = { hermesAuthToken, searxngSecret };
          const payload: PersistedV2 = { schemaVersion: 2, hermesAuthToken, searxngSecret };
          await writeFileAtomic(path, JSON.stringify(payload, null, 2), { mode: FILE_MODE });
          log.info("loadOrInit.migrated-v1-to-v2", {
            hermesFp: fingerprint(hermesAuthToken),
            searxngFp: fingerprint(searxngSecret),
          });
          return { ok: true, value: cached };
        }
        // Fresh file: generate both.
        const fresh: InternalSecrets = {
          hermesAuthToken: randomBytes(TOKEN_BYTES).toString("hex"),
          searxngSecret: randomBytes(TOKEN_BYTES).toString("hex"),
        };
        const payload: PersistedV2 = { schemaVersion: 2, ...fresh };
        await writeFileAtomic(path, JSON.stringify(payload, null, 2), { mode: FILE_MODE });
        cached = fresh;
        log.info("loadOrInit.generated", {
          schemaVersion: SCHEMA_VERSION,
          hermesFp: fingerprint(fresh.hermesAuthToken),
          searxngFp: fingerprint(fresh.searxngSecret),
        });
        return { ok: true, value: cached };
      } catch (e: unknown) {
        const reason = (e as Error).message;
        log.error("loadOrInit.failed", { reason });
        return { ok: false, error: { kind: "io-error", reason } };
      }
    },
    getHermesAuthTokenSync() {
      if (!cached) throw new Error("InternalSecretsStore: getHermesAuthTokenSync called before loadOrInit");
      return cached.hermesAuthToken;
    },
    getSearxngSecretSync() {
      if (!cached) throw new Error("InternalSecretsStore: getSearxngSecretSync called before loadOrInit");
      return cached.searxngSecret;
    },
  };
}

/** First 4 + ellipsis + last 4 — for log lines. */
function fingerprint(token: string): string {
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
