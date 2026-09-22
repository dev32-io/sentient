import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import preact from "@preact/preset-vite";
import { type Plugin, defineConfig } from "vite";

// Gateway serves HTTPS/WSS (self-signed) so we proxy to https:// and turn
// off TLS verification for the self-signed cert.
const GATEWAY_URL = "https://localhost:8888";

function versionAppShell(): Plugin {
  return {
    name: "version-app-shell",
    apply: "build",
    async closeBundle() {
      const [html, packageJson, worker, buildAssets] = await Promise.all([
        readFile("dist/index.html", "utf8"),
        readFile("package.json", "utf8").then((value) => JSON.parse(value) as { version: string }),
        readFile("dist/service-worker.js", "utf8"),
        readdir("dist/assets"),
      ]);
      const assets = [...html.matchAll(/(?:src|href)="([^"#?]+)"/g)]
        .map((match) => match[1] ?? "")
        .filter((path) => path.startsWith("/"));
      const shell = [
        ...new Set([
          "/",
          "/index.html",
          "/sentient-mark.svg",
          ...assets,
          ...buildAssets.filter((name) => !name.endsWith(".map")).map((name) => `/assets/${name}`),
        ]),
      ];
      const build = `${packageJson.version}-${createHash("sha256").update(shell.join("\n")).digest("hex").slice(0, 12)}`;
      await writeFile(
        "dist/service-worker.js",
        worker
          .replace('const CACHE = "sentient-app-shell-dev";', `const CACHE = "sentient-app-shell-${build}";`)
          .replace(
            'const SHELL = ["/", "/index.html", "/sentient-mark.svg"];',
            `const SHELL = ${JSON.stringify(shell)};`,
          ),
      );
    },
  };
}

export default defineConfig({
  plugins: [preact(), versionAppShell()],
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["@ricky0123/vad-web"],
  },
  server: {
    // PINNED, and strict. Vite's default is to walk to the next free port, so a
    // second dev server (or a leftover one) silently moves the UI to 5174 and
    // every bookmark, E2E base URL and shared link breaks with "Unable to
    // connect" — while a stale instance keeps answering on 5173. Failing to
    // start is the correct outcome: it names the conflict instead of hiding it.
    port: 5173,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
    proxy: {
      "/api/v1/ws": { target: GATEWAY_URL, ws: true, secure: false },
      "/api/v1": { target: GATEWAY_URL, secure: false },
    },
  },
});
