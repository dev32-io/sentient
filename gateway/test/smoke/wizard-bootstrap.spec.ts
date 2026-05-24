/**
 * @live — drive the full wizard via Playwright MCP.
 *
 * Pre-conditions:
 *   - Fresh ~/.sentient.test/ overlay (delete before run).
 *   - Gateway dev server running with SENTIENT_HOME=~/.sentient.test
 *   - Playwright MCP available (mcp__plugin_playwright_playwright__*).
 *   - test-provider server stub configured to always return ok=true.
 *
 * Flow (driven via MCP tools):
 *   1. Read unlock code from ~/.sentient.test/.bootstrap-unlock
 *   2. browser_navigate → https://localhost:8888/
 *   3. browser_take_screenshot → verify unlock-gate rendered
 *   4. browser_fill (input[inputmode=numeric]) → unlock code
 *   5. browser_click → "Verify and start"
 *   6. browser_take_screenshot → verify provider step rendered;
 *      Ollama Cloud tab is active by default
 *   7. browser_click → "OpenRouter" tab
 *   8. browser_fill (input[type=password]) → "FAKE_sk-or-PLAYWRIGHT-TEST-KEY"
 *   9. browser_click → "Test connection"
 *  10. browser_wait_for → ".test-connection--ok" visible
 *  11. browser_click → "Continue"
 *  12. browser_take_screenshot → verify voice step rendered
 *  13. browser_click → "Skip — text only for now"
 *  14. browser_click → "Continue"
 *  15. browser_take_screenshot → verify finish step
 *  16. browser_click → "Take me in →"
 *  17. (page reloads) browser_take_screenshot → verify SetupScreen
 *
 * Server-side asserts (run via Bash after browser flow):
 *   - ~/.sentient.test/secrets/keys.yaml exists, mode 0600
 *   - keys.yaml: llm.active == "openrouter", llm.openrouter.api_key contains "FAKE_"
 *   - ~/.sentient.test/state.yaml has bootstrap_complete: true
 *   - ~/.sentient.test/.bootstrap-unlock does NOT exist
 *
 * Negative-path check:
 *   - curl -X POST .../wizard/provider after bootstrap → expect 410
 *   - keys.yaml mtime unchanged
 */

import { describe, expect, it } from "vitest";

describe.skip("@live wizard bootstrap (Playwright MCP)", () => {
  it("documents the manual MCP-driven flow above; not auto-runnable in CI", () => {
    expect(true).toBe(true);
  });
});
