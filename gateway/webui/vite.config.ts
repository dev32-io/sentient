import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// Gateway serves HTTPS/WSS (self-signed) so we proxy to https:// and turn
// off TLS verification for the self-signed cert.
const GATEWAY_URL = "https://localhost:8888";

export default defineConfig({
  plugins: [preact()],
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
