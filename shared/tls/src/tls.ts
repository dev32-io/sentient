// Self-signed TLS cert material for LAN-only services.
//
// Home/LAN deployment: generates a self-signed cert via openssl and persists
// it so each family member's browser "accepted exception" survives container
// restarts. Regenerates when the configured SAN list changes so a stale cert
// does not silently mismatch after the user edits config.yaml.
//
// Consumed by both the web container (web/server.ts) and the gateway
// (gateway/src/index.ts) so they can each speak HTTPS/WSS on the LAN.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TlsConfig {
  readonly hostnames: readonly string[];
  readonly certsDir: string;
  /** Short tag for log lines (e.g. "web", "gateway"). Purely cosmetic. */
  readonly logTag?: string;
}

export interface TlsMaterial {
  readonly cert: string;
  readonly key: string;
}

const CERT_DAYS = 3650;
const LOOPBACK: readonly string[] = ["localhost", "127.0.0.1"];
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function classifySan(host: string): string {
  return IPV4.test(host) || host.includes(":") ? `IP:${host}` : `DNS:${host}`;
}

export function buildSanString(hostnames: readonly string[]): string {
  const unique = Array.from(new Set([...hostnames, ...LOOPBACK]));
  return unique.map(classifySan).join(",");
}

interface CertPaths {
  readonly cert: string;
  readonly key: string;
  readonly marker: string;
}

function pathsFor(dir: string): CertPaths {
  return {
    cert: join(dir, "cert.pem"),
    key: join(dir, "key.pem"),
    marker: join(dir, "san.txt"),
  };
}

function shouldRegenerate(paths: CertPaths, san: string): boolean {
  if (!existsSync(paths.cert) || !existsSync(paths.key)) return true;
  if (!existsSync(paths.marker)) return true;
  return readFileSync(paths.marker, "utf8").trim() !== san;
}

function runOpenssl(paths: CertPaths, san: string, tag: string): void {
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      String(CERT_DAYS),
      "-keyout",
      paths.key,
      "-out",
      paths.cert,
      "-subj",
      "/CN=sentient",
      "-addext",
      `subjectAltName=${san}`,
    ],
    { stdio: "pipe", encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`[${tag}] openssl cert generation failed: ${result.stderr || result.stdout}`);
  }
  // openssl's umask decides the key's mode otherwise, and a 0644 private key
  // mounted read-only into the inbound proxy is readable by anything else that
  // gets a mount of the same directory. Asserted in docs for a long time and
  // never actually enforced.
  chmodSync(paths.key, 0o600);
  writeFileSync(paths.marker, `${san}\n`, { mode: 0o644 });
}

export function ensureTlsMaterial(cfg: TlsConfig): TlsMaterial {
  const tag = cfg.logTag ?? "tls";
  mkdirSync(cfg.certsDir, { recursive: true });
  const paths = pathsFor(cfg.certsDir);
  const san = buildSanString(cfg.hostnames);
  if (shouldRegenerate(paths, san)) {
    runOpenssl(paths, san, tag);
    console.info(`[${tag}] generated self-signed cert for ${san} → ${cfg.certsDir}`);
  } else {
    console.info(`[${tag}] reusing cert at ${paths.cert} (SAN=${san})`);
  }
  return {
    cert: readFileSync(paths.cert, "utf8"),
    key: readFileSync(paths.key, "utf8"),
  };
}
