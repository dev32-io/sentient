#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const evidenceRoot = resolve(root, "qa/web/evidence/design-refresh");
const rows = (await Bun.file(resolve(root, "qa/design-refresh/inventory.json")).json()).rows.filter((row: any) => row.platform === "web");
const pageSize = 2;
const allConfigs = [
  { id: "web-desktop-1280x900", width: 1280, height: 900, scale: 1, reduced: false },
  { id: "web-narrow-390x844", width: 390, height: 844, scale: 1, reduced: false },
  { id: "web-zoom-200", width: 640, height: 450, scale: 2, reduced: false },
  { id: "web-reduced-motion", width: 1280, height: 900, scale: 1, reduced: true },
] as const;
const requestedConfig = process.env.QA_VISUAL_CONFIG;
if (!requestedConfig) {
  for (const config of allConfigs) {
    const child = Bun.spawn([process.execPath, import.meta.path], {
      cwd: root,
      env: { ...process.env, QA_VISUAL_CONFIG: config.id },
      stdout: "inherit",
      stderr: "inherit",
    });
    const status = await child.exited;
    if (status !== 0) process.exit(status);
  }
  process.exit(0);
}
const configs = allConfigs.filter((config) => config.id === requestedConfig);
if (configs.length === 0) throw new Error(`unknown QA_VISUAL_CONFIG: ${requestedConfig}`);
await mkdir(evidenceRoot, { recursive: true });

const vite = spawn(resolve(root, "gateway/webui/node_modules/.bin/vite"), ["--host", "127.0.0.1"], { cwd: resolve(root, "gateway/webui"), stdio: ["ignore", "pipe", "pipe"] });
let viteText = "";
vite.stdout.on("data", (chunk) => { viteText += chunk; });
vite.stderr.on("data", (chunk) => { viteText += chunk; });
for (let i = 0; i < 100 && !viteText.includes("Local:"); i += 1) await Bun.sleep(100);
if (!viteText.includes("Local:")) throw new Error(`Vite did not start: ${viteText}`);

const profile = `/tmp/sentient-visual-review-chrome-${process.pid}`;
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, "--remote-debugging-port=9333", "about:blank"], { stdio: "ignore" });

async function endpoint(): Promise<any> {
  for (let i = 0; i < 100; i += 1) {
    try { return await (await fetch("http://127.0.0.1:9333/json/new", { method: "PUT" })).json(); } catch { await Bun.sleep(100); }
  }
  throw new Error("Chrome DevTools endpoint unavailable");
}

const target = await endpoint();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((resolveOpen, reject) => { socket.onopen = () => resolveOpen(); socket.onerror = reject; });
let sequence = 0;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
socket.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
};
function cdp(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolveCommand, reject) => pending.set(id, { resolve: resolveCommand, reject }));
}

try {
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  for (const config of configs) {
    await cdp("Emulation.setDeviceMetricsOverride", { width: config.width, height: config.height, deviceScaleFactor: config.scale, mobile: config.width <= 390 });
    await cdp("Emulation.setEmulatedMedia", { media: "screen", features: [{ name: "prefers-reduced-motion", value: config.reduced ? "reduce" : "no-preference" }] });
    for (let page = 0; page < Math.ceil(rows.length / pageSize); page += 1) {
      const url = `http://127.0.0.1:5173/visual-review.html?page=${page}&config=${config.id}`;
      await cdp("Page.navigate", { url });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const ready = await cdp("Runtime.evaluate", { expression: "document.documentElement.dataset.qaReady === 'true'", returnByValue: true });
        if (ready.result.value) break;
        await Bun.sleep(50);
      }
      const screenshotPath = `qa/web/evidence/design-refresh/${config.id}-page-${String(page + 1).padStart(2, "0")}.png`;
      const image = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
      await writeFile(resolve(root, screenshotPath), Buffer.from(image.data, "base64"));
      const measured = await cdp("Runtime.evaluate", { expression: "window.__QA_METRICS__", returnByValue: true });
      const pageRows = rows.slice(page * pageSize, (page + 1) * pageSize);
      const sidecarPath = `qa/web/evidence/design-refresh/page-${String(page + 1).padStart(2, "0")}.json`;
      const existing = await Bun.file(resolve(root, sidecarPath)).exists() ? await Bun.file(resolve(root, sidecarPath)).json() : { version: 1, kind: "design-refresh-visual-evidence", platform: "web", inventoryIds: pageRows.map((row: any) => row.id), captures: [], measurements: {} };
      existing.captures = existing.captures.filter((capture: any) => capture.configuration !== config.id);
      existing.captures.push({ configuration: config.id, path: screenshotPath });
      existing.measurements[config.id] = measured.result.value.measurements;
      existing.observations = Object.entries(existing.measurements).flatMap(([configuration, values]: [string, any]) => values.map((value: any) => ({ inventoryId: value.inventoryId, configuration, overflow: value.overflowPx, minimumTarget: value.minimumTargetPx, focusableCount: value.focusableCount })));
      await writeFile(resolve(root, sidecarPath), `${JSON.stringify(existing, null, 2)}\n`);
    }
  }
} finally {
  socket.close();
  chrome.kill("SIGTERM");
  vite.kill("SIGTERM");
}
