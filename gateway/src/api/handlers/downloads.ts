import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getLog } from "../../logging/logger.js";

const log = getLog(["sentient", "api", "downloads"]);

const HTTP_NOT_FOUND = 404;
const PREFIX = "/download";
const NO_CACHE = "no-cache";

// Percent-encoded traversal indicators: %2f (slash), %5c (backslash), %2e (dot)
const ENCODED_TRAVERSAL = /(%2f|%5c|%2e)/i;

// Map from URL pathname to { file relative to artifactsDir, content-type }
const ARTIFACT_ROUTES: Record<string, { file: string; mime: string }> = {
  "/download/manifest.json": { file: "manifest.json", mime: "application/json" },
  "/download/android/latest.apk": {
    file: "android/latest.apk",
    mime: "application/vnd.android.package-archive",
  },
  "/download/ios/latest.ipa": { file: "ios/latest.ipa", mime: "application/octet-stream" },
  "/download/ios/icon-57.png": { file: "ios/icon-57.png", mime: "image/png" },
  "/download/ios/icon-512.png": { file: "ios/icon-512.png", mime: "image/png" },
};

export interface DownloadsHandlerDeps {
  artifactsDir: string;
  publicBaseUrl: string;
  renderLandingPage: () => string;
  renderPlist: (manifest: unknown) => string;
}

export type DownloadsHandler = (request: Request) => Promise<Response | null>;

export function createDownloadsHandler(deps: DownloadsHandlerDeps): DownloadsHandler {
  const artifactsDirResolved = resolve(deps.artifactsDir);

  return async (request) => {
    const { pathname } = new URL(request.url);

    if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return null;

    // Guard: reject encoded traversal sequences (%2f, %5c, %2e) before further routing.
    // These survive WHATWG URL normalisation and can hide path-escape attempts.
    if (ENCODED_TRAVERSAL.test(pathname)) return notFound(pathname);

    if (pathname === PREFIX) return html(deps.renderLandingPage());
    if (pathname === "/download/ios/manifest.plist") return servePlist(deps);

    const route = ARTIFACT_ROUTES[pathname];
    if (!route) return notFound(pathname);

    return serveFile(join(deps.artifactsDir, route.file), route.mime, pathname, artifactsDirResolved);
  };
}

function html(body: string): Response {
  return new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": NO_CACHE },
  });
}

function servePlist(deps: DownloadsHandlerDeps): Response {
  const manifestPath = join(deps.artifactsDir, "manifest.json");
  if (!existsSync(manifestPath)) return notFound("/download/ios/manifest.plist");
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  return new Response(deps.renderPlist(manifest), {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": NO_CACHE },
  });
}

function serveFile(path: string, mime: string, pathname: string, artifactsDirResolved: string): Response {
  // Defense-in-depth: verify the resolved path is within artifactsDir even when routes
  // are hardcoded, to catch any future dynamic routing mistakes.
  const resolvedPath = resolve(path);
  if (!resolvedPath.startsWith(`${artifactsDirResolved}/`)) return notFound(pathname);

  if (!existsSync(resolvedPath)) return notFound(pathname);
  const size = statSync(resolvedPath).size;
  log.info("artifact-serve", { path: pathname, bytes: size, mime });
  const body = readFileSync(resolvedPath);
  return new Response(body, { headers: { "Content-Type": mime, "Cache-Control": NO_CACHE } });
}

function notFound(pathname: string): Response {
  log.warn("artifact-missing", { reason: "missing", path: pathname });
  return new Response("Not Found", { status: HTTP_NOT_FOUND });
}
