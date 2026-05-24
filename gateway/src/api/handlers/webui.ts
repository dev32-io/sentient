import { join } from "node:path";

const HTTP_NOT_FOUND = 404;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};
const DEFAULT_MIME = "application/octet-stream";
const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
const CACHE_NO_CACHE = "no-cache";

// Required for SharedArrayBuffer — Silero VAD (ONNX WASM) refuses to load
// without these. Match the Vite dev server so dev and prod behave the same.
const COOP_COEP_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

const HASHED_ASSET = /-[a-zA-Z0-9]{8,}\./;

function mimeFor(path: string): string {
  const dotIdx = path.lastIndexOf(".");
  if (dotIdx < 0) return DEFAULT_MIME;
  return MIME_TYPES[path.slice(dotIdx)] ?? DEFAULT_MIME;
}

function cacheFor(path: string): string {
  if (path.endsWith(".html")) return CACHE_NO_CACHE;
  if (HASHED_ASSET.test(path)) return CACHE_IMMUTABLE;
  return CACHE_NO_CACHE;
}

export interface WebuiHandlerDeps {
  /** Build output directory. `undefined` in `vite dev` mode — the handler
   *  returns null for every path so the dev server handles static assets. */
  distDir: string | undefined;
}

export type WebuiHandler = (request: Request) => Promise<Response | null>;

export function createWebuiHandler(deps: WebuiHandlerDeps): WebuiHandler {
  return async (request) => {
    if (!deps.distDir) return null;

    // Path traversal guard — check raw URL before the WHATWG parser normalizes
    // away ".." segments. Bun.file would resolve outside distDir otherwise.
    if (request.url.includes("..")) return null;

    const url = new URL(request.url);
    const pathname = url.pathname;

    const resolved = pathname === "/" || pathname === "" ? "/index.html" : pathname;
    const direct = Bun.file(join(deps.distDir, resolved));
    if (await direct.exists()) {
      return new Response(direct, {
        headers: {
          "Content-Type": mimeFor(resolved),
          "Cache-Control": cacheFor(resolved),
          ...COOP_COEP_HEADERS,
        },
      });
    }

    // SPA fallback — unknown routes serve index.html so client-side routing works.
    const fallback = Bun.file(join(deps.distDir, "index.html"));
    if (await fallback.exists()) {
      return new Response(fallback, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": CACHE_NO_CACHE,
          ...COOP_COEP_HEADERS,
        },
      });
    }

    return new Response("Not Found", { status: HTTP_NOT_FOUND });
  };
}
