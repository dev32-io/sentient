#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { assertDisposableOutput, caseIdFromReference, defaultActualPath, readPngSize } from "./reference-image.mjs";

const toolRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(toolRoot, "../..");

function usage() {
  return "Usage: capture-web --reference <png> [--output <png>] [--url <fixture-url>]";
}

function parseArguments(argv) {
  let reference;
  let output;
  let url;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!["--reference", "--output", "--url"].includes(argument) || !value) {
      throw new Error(`Unknown or incomplete option: ${argument}`);
    }
    index += 1;
    if (argument === "--reference") reference = value;
    if (argument === "--output") output = value;
    if (argument === "--url") url = value;
  }
  if (!reference) throw new Error("--reference is required");
  const referencePath = resolve(repositoryRoot, reference);
  return {
    referencePath,
    outputPath: output ? resolve(repositoryRoot, output) : defaultActualPath(referencePath, "web"),
    url,
  };
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  if (!port) throw new Error("Unable to reserve a fixture server port");
  return port;
}

async function serverReady(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(750) });
    return response.ok;
  } catch {
    return false;
  }
}

async function startFixtureServer() {
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}/visual-diff.html`;
  const child = spawn("bun", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: resolve(repositoryRoot, "gateway/webui"),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  let spawnError;
  child.once("error", (error) => { spawnError = error; });
  child.stdout.on("data", (chunk) => { diagnostics += chunk.toString(); });
  child.stderr.on("data", (chunk) => { diagnostics += chunk.toString(); });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (spawnError) throw spawnError;
    if (await serverReady(url)) return { child, url };
    if (child.exitCode !== null) throw new Error(`Vite exited before the fixture was ready.\n${diagnostics}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  await stopServer(child);
  throw new Error(`Timed out waiting for ${url}.\n${diagnostics}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 2_000)),
  ]);
  if (!exited && child.exitCode === null) child.kill("SIGKILL");
}

async function localFontCss() {
  const fontRoot = resolve(repositoryRoot, "ios/App/Resources/Fonts");
  const fonts = [
    ["DM Sans", 400, "DMSans-Regular.ttf"],
    ["DM Sans", 500, "DMSans-Medium.ttf"],
    ["DM Sans", 600, "DMSans-SemiBold.ttf"],
    ["DM Sans", 700, "DMSans-Bold.ttf"],
    ["Fraunces", 400, "Fraunces-Regular.ttf"],
    ["Fraunces", 500, "Fraunces-Medium.ttf"],
    ["Fraunces", 600, "Fraunces-SemiBold.ttf"],
    ["JetBrains Mono", 400, "JetBrainsMono-Regular.ttf"],
    ["JetBrains Mono", 500, "JetBrainsMono-Medium.ttf"],
  ];
  const rules = await Promise.all(fonts.map(async ([family, weight, file]) => {
    const data = await readFile(resolve(fontRoot, file));
    return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/ttf;base64,${data.toString("base64")}) format("truetype")}`;
  }));
  return rules.join("\n");
}

async function applyState(page, caseId) {
  const target = page.locator(".visual-diff-target");
  if (caseId.endsWith("--hover")) await target.hover();
  if (caseId.endsWith("--focus")) await target.focus();
  if (caseId.endsWith("--pressed")) {
    const box = await target.boundingBox();
    if (!box) throw new Error(`Unable to locate the pressed target for ${caseId}`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
  }
}

async function capture() {
  const input = parseArguments(process.argv.slice(2));
  await assertDisposableOutput(input.referencePath, input.outputPath, "web");
  const caseId = caseIdFromReference(input.referencePath);
  const referenceSize = await readPngSize(input.referencePath);
  if (referenceSize.width % 2 !== 0 || referenceSize.height % 2 !== 0) {
    throw new Error(`Reference canvas must be divisible by the handoff 2x scale: ${referenceSize.width}x${referenceSize.height}`);
  }

  let server;
  let browser;
  try {
    server = input.url ? undefined : await startFixtureServer();
    const baseUrl = input.url ?? server.url;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: referenceSize.width / 2, height: referenceSize.height / 2 },
      deviceScaleFactor: 2,
      colorScheme: "dark",
      locale: "en-US",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const url = new URL(baseUrl);
    url.searchParams.set("case", caseId);
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => document.documentElement.dataset.visualDiffFixture === "sentient-v1");
    await page.addStyleTag({ content: await localFontCss() });
    await page.waitForFunction(async () => {
      await document.fonts.ready;
      return document.fonts.check('600 14px "DM Sans"', "Allow once")
        && document.fonts.check('500 22px "Fraunces"', "Sentient")
        && document.fonts.check('500 12px "JetBrains Mono"', "state");
    });
    await page.waitForFunction(() => document.documentElement.dataset.visualDiffReady === "true");
    await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
    await applyState(page, caseId);
    await mkdir(dirname(input.outputPath), { recursive: true });
    await page.screenshot({
      path: input.outputPath,
      animations: "disabled",
      caret: "hide",
      omitBackground: true,
      scale: "device",
    });
    console.log(JSON.stringify({ platform: "web", caseId, referenceSize, actualPath: input.outputPath }));
    await context.close();
  } finally {
    if (browser) await browser.close();
    if (server) await stopServer(server.child);
  }
}

try {
  await capture();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exitCode = 2;
}
