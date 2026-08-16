import { readFile } from "node:fs/promises";
import { domainToASCII } from "node:url";

export type UrlPolicyError =
  | { code: "invalid_url"; message: string }
  | { code: "unsupported_port"; hostname: string; message: string }
  | { code: "blocked_domain"; hostname: string; message: string };

export function canonicalDomain(hostname: string): string | null {
  const stripped = hostname.trim().replace(/\.+$/, "").toLocaleLowerCase();
  const ascii = domainToASCII(stripped).toLocaleLowerCase();
  if (!ascii || ascii.length > 253 || ascii.split(".").some((label) => !label || label.length > 63)) return null;
  return ascii;
}

export function canonicalDenyRules(lines: Iterable<string>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const line of lines) {
    const value = line.trim();
    if (!value || value.startsWith("#")) continue;
    const canonical = canonicalDomain(value);
    if (canonical) out.add(canonical);
  }
  return out;
}

export function domainIsDenied(hostname: string, rules: ReadonlySet<string>): boolean {
  const canonical = canonicalDomain(hostname);
  if (!canonical) return true;
  for (const rule of rules) if (canonical === rule || canonical.endsWith(`.${rule}`)) return true;
  return false;
}

export function validateFetchUrl(
  raw: string,
  rules: ReadonlySet<string>,
): { ok: true; url: URL } | { ok: false; error: UrlPolicyError } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: { code: "invalid_url", message: "The URL is invalid." } };
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !url.hostname) {
    return {
      ok: false,
      error: { code: "invalid_url", message: "Only credential-free HTTP and HTTPS URLs are supported." },
    };
  }
  const hostname = canonicalDomain(url.hostname);
  if (!hostname) return { ok: false, error: { code: "invalid_url", message: "The URL hostname is invalid." } };
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (port !== "80" && port !== "443") {
    return {
      ok: false,
      error: { code: "unsupported_port", hostname, message: "Only standard HTTP and HTTPS ports are supported." },
    };
  }
  if (domainIsDenied(hostname, rules)) {
    return {
      ok: false,
      error: { code: "blocked_domain", hostname, message: "This hostname is blocked by domain policy." },
    };
  }
  url.hostname = hostname;
  url.hash = "";
  return { ok: true, url };
}

export async function loadDomainRules(bundledPath: string, additionsPath?: string): Promise<ReadonlySet<string>> {
  const chunks: string[] = [];
  for (const path of [bundledPath, additionsPath]) {
    if (!path) continue;
    try {
      chunks.push(await readFile(path, "utf8"));
    } catch {
      if (path === bundledPath) throw new Error("bundled domain policy unavailable");
    }
  }
  return canonicalDenyRules(chunks.flatMap((chunk) => chunk.split(/\r?\n/)));
}
