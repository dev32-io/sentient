import preact from "@preact/preset-vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [preact()],
  test: {
    globals: true,
    environment: "jsdom",
    // Root-level tests cover the static server (server.ts, tls.ts);
    // src/** covers the Preact client.
    include: ["src/**/*.test.{ts,tsx}", "*.test.ts"],
  },
});
