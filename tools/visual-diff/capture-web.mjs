#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { assertDisposableOutput, caseIdFromReference, defaultActualPath, readPngSize } from "./reference-image.mjs";

const toolRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(toolRoot, "../..");
const HANDOFF_SCALE = 2;
const MOBILE_BREAKPOINT = 620;
// The active loading handoff is a static frame from the source's 900ms
// rotation. Freeze its measured handoff phase so the approved frame is
// reproducible without changing the production animation.
const LOADING_ACTIVE_REFERENCE_PHASE_MS = 366;
// Non-transforming component boundaries must stay on the exact handoff canvas;
// the wider frame below is only needed for controls whose hover/press face translates.
const FIXED_CANVAS_COMPONENTS = new Set(["checkbox", "loading-state", "range", "search-field", "sentient-identity", "text-area", "text-field", "toggle", "user-avatar"]);
const VISUAL_DIFF_TARGET_SELECTOR = ".visual-diff-target";
const SENTIENT_IDENTITY_VARIANTS = new Set([
  "idle",
  "thinking",
  "responding",
  "idle-to-thinking",
  "thinking-to-responding",
  "responding-to-idle",
  "thinking-loop",
  "responding-loop",
]);

function targetSelector(caseId) {
  if (caseId.startsWith("chip--")) return ".snt-chip";
  if (caseId.startsWith("range--")) return ".snt-range";
  if (caseId.startsWith("toggle--")) return ".snt-toggle";
  if (caseId.startsWith("segmented-control--")) return ".snt-segmented .snt-segment:nth-child(2)";
  if (caseId.startsWith("user-avatar--")) return ".snt-avatar--user";
  return VISUAL_DIFF_TARGET_SELECTOR;
}

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

function captureCaseId(referencePath) {
  const frameCaseId = caseIdFromReference(referencePath);
  const recordingId = basename(dirname(referencePath));
  if (/^(?:checkbox--unchecked-to-(?:checked|mixed)|chip--unselected-to-selected|toggle--off-to-on|segmented-control--comfortable-to-compact)$/.test(recordingId)) {
    return `${recordingId}--${frameCaseId}`;
  }
  const sentientRecording = /^sentient-avatar--(.+)$/.exec(recordingId);
  if (sentientRecording && SENTIENT_IDENTITY_VARIANTS.has(sentientRecording[1])) {
    return `sentient-identity--${sentientRecording[1]}--${frameCaseId}`;
  }
  return frameCaseId;
}

function isSentientIdentityCase(caseId) {
  return caseId.startsWith("sentient-identity--");
}

function isLoadingStateActiveCase(caseId) {
  return caseId === "loading-state--settings--active";
}

function sentientIdentityVariant(caseId) {
  return caseId.split("--")[1];
}

function sentientIdentityKeyframeTimeMs(caseId) {
  if (!isSentientIdentityCase(caseId)) return undefined;
  const frameMatch = /^sentient-identity--.+--frame-\d+--(\d+)ms$/.exec(caseId);
  if (frameMatch) return Number(frameMatch[1]);
  if (caseId.endsWith("--reduced-motion")) return 0;
  const variant = sentientIdentityVariant(caseId);
  if (variant === "thinking") return 1_000;
  if (variant === "responding") return 2_000;
  if (variant === "idle") return 0;
  throw new Error(`Unsupported Sentient identity keyframe: ${caseId}`);
}

function isSentientIdentityTransition(caseId) {
  return /^sentient-identity--(?:idle-to-thinking|thinking-to-responding|responding-to-idle)--/.test(caseId);
}

function visualDiffTransitionTimeMs(caseId) {
  const checkboxMatch = /^checkbox--unchecked-to-(?:checked|mixed)--frame-\d+--(\d+)ms$/.exec(caseId);
  if (checkboxMatch) return Number(checkboxMatch[1]);
  const chipMatch = /^chip--unselected-to-selected--frame-\d+--(\d+)ms$/.exec(caseId);
  if (chipMatch) return Number(chipMatch[1]);
  const toggleMatch = /^toggle--off-to-on--frame-\d+--(\d+)ms$/.exec(caseId);
  if (toggleMatch) return Number(toggleMatch[1]);
  const segmentedMatch = /^segmented-control--comfortable-to-compact--frame-\d+--(\d+)ms$/.exec(caseId);
  return segmentedMatch ? Number(segmentedMatch[1]) : undefined;
}

function visualDiffState(caseId) {
  const separator = caseId.lastIndexOf("--");
  if (separator < 0) return undefined;
  const stateId = caseId.slice(separator + 2);
  return stateId.startsWith("compact-") ? stateId.slice("compact-".length) : stateId;
}

async function applyState(page, caseId) {
  const target = page.locator(targetSelector(caseId));
  const state = visualDiffState(caseId);
  if (state === "hover") await target.hover();
  if (state === "focus") {
    if (caseId.startsWith("segmented-control--")) {
      await page.locator(".snt-segment").first().focus();
      await page.keyboard.press("Tab");
    } else if (caseId.startsWith("checkbox--") || caseId.startsWith("chip--") || caseId.startsWith("range--") || caseId.startsWith("toggle--")) await page.keyboard.press("Tab");
    else await target.focus();
  }
  if (state === "pressed") {
    const box = await target.boundingBox();
    if (!box) throw new Error(`Unable to locate the pressed target for ${caseId}`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
  }
}

function captureFrame(caseId, referenceSize) {
  const canvas = {
    width: referenceSize.width / HANDOFF_SCALE,
    height: referenceSize.height / HANDOFF_SCALE,
  };
  const compact = caseId.startsWith("segmented-control--")
    ? caseId.endsWith("--compact-layout")
    : caseId.includes("--compact-") || caseId.endsWith("--compact");
  const componentId = caseId.split("--", 1)[0];
  const fixedCanvas = FIXED_CANVAS_COMPONENTS.has(componentId);
  const state = visualDiffState(caseId);
  const chipTransition = /^chip--unselected-to-selected--frame-\d+--\d+ms$/.test(caseId);
  const selectedChip = caseId.startsWith("chip--selected--");
  const segmentedControlCase = caseId.startsWith("segmented-control--");
  const transformOffset = fixedCanvas || segmentedControlCase
    ? 0
    : chipTransition
      ? 0
      : selectedChip
        ? state === "pressed" ? 2 : 1
        : state === "hover" ? -1
          : state === "pressed" ? 1 : 0;
  const framePadding = chipTransition ? 1 : Math.abs(transformOffset);
  if (fixedCanvas) return { viewport: canvas };

  /* Compact references can use their handoff width directly. Add a small
     source-derived frame only when the component's translated paint needs a
     boundary that follows the translated control. */
  if (compact) {
    if (!selectedChip && !chipTransition) return { viewport: canvas };
    if (framePadding === 0) return { viewport: canvas };
    return {
      viewport: { width: canvas.width, height: canvas.height + framePadding * 2 },
      clip: {
        x: 0,
        y: framePadding + transformOffset,
        width: canvas.width,
        height: canvas.height,
      },
    };
  }

  /* The isolated standard handoff canvases are cropped below the source's
     responsive width. Render above the authoritative 620px query, then crop
     back to the handoff canvas instead of accidentally selecting the mobile
     44px target. */
  const renderWidth = Math.max(canvas.width, MOBILE_BREAKPOINT + 1);
  return {
    viewport: { width: renderWidth, height: canvas.height + framePadding * 2 },
    clip: {
      x: Math.ceil((renderWidth - canvas.width) / 2),
      y: framePadding + transformOffset,
      width: canvas.width,
      height: canvas.height,
    },
    ...(chipTransition ? { normalizeTranslatedPaint: true } : {}),
  };
}

async function renderSentientIdentityAt(page, timeMs) {
  await page.evaluate((elapsedMs) => {
    const rive = window.__visualDiffRive;
    if (!rive) throw new Error("Visual diff identity Rive runtime is not ready");
    const internalRive = rive;
    rive.stopRendering();
    internalRive.lastRenderTime = 0;
    // Rive's public wrapper does not expose a clocked state-machine advance.
    // The pinned canvas runtime's renderer accepts an explicit rAF timestamp;
    // use it only in this capture fixture to render exact elapsed keyframes.
    internalRive.draw(1);
    rive.stopRendering();
    internalRive.lastRenderTime = document.timeline.currentTime;
    rive.drawFrame();
    rive.stopRendering();
    internalRive.lastRenderTime = 1;
    internalRive.draw(1 + elapsedMs);
    rive.stopRendering();
    internalRive.lastRenderTime = document.timeline.currentTime;
    rive.drawFrame();
    rive.stopRendering();
  }, timeMs);
}

async function captureSentientIdentityKeyframe(page, caseId, timeMs) {
  if (isSentientIdentityTransition(caseId)) {
    await renderSentientIdentityAt(page, 0);
    await page.evaluate(() => {
      const transitionWindow = window;
      if (!transitionWindow.__startVisualDiffTransition) throw new Error("Visual diff identity transition is not ready");
      transitionWindow.__startVisualDiffTransition();
    });
    await page.waitForFunction(() => document.documentElement.dataset.visualDiffTransitionStarted === "true");
  }
  await renderSentientIdentityAt(page, timeMs);
}

async function freezeChipTransition(page, transitionTimeMs) {
  await page.evaluate(() => {
    const transitionWindow = window;
    if (!transitionWindow.__startVisualDiffTransition) throw new Error("Visual diff transition is not ready");
    transitionWindow.__startVisualDiffTransition();
  });
  if (transitionTimeMs === 0) return;
  await page.waitForFunction(() => {
    const target = document.querySelector(".snt-chip");
    return target && document.getAnimations().some((animation) => animation.effect?.target === target);
  });
  await page.evaluate((timeMs) => {
    const target = document.querySelector(".snt-chip");
    if (!target) throw new Error("Visual diff chip target is not ready");
    for (const animation of document.getAnimations()) {
      if (animation.effect?.target !== target) continue;
      animation.pause();
      animation.currentTime = timeMs;
    }
  }, transitionTimeMs);
}

async function freezeToggleTransition(page, transitionTimeMs) {
  await page.evaluate(() => {
    const transitionWindow = window;
    if (!transitionWindow.__startVisualDiffTransition) throw new Error("Visual diff transition is not ready");
    transitionWindow.__startVisualDiffTransition();
  });
  await page.waitForFunction(() => document.querySelector(".snt-toggle")?.getAttribute("aria-checked") === "true");
  if (transitionTimeMs === 0) return;
  await page.waitForFunction(() => {
    const target = document.querySelector(".snt-toggle");
    return target && document.getAnimations().some((animation) => animation.effect?.target === target);
  });
  await page.evaluate((timeMs) => {
    const target = document.querySelector(".snt-toggle");
    if (!target) throw new Error("Visual diff toggle target is not ready");
    const animations = document.getAnimations().filter((animation) => animation.effect?.target === target);
    if (!animations.length) throw new Error("Visual diff toggle transition is not running");
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = timeMs;
    }
  }, transitionTimeMs);
}

async function resetSegmentedIndicator(page) {
  await page.waitForFunction(() => {
    const target = document.querySelector(".snt-segmented");
    return target?.dataset.sntReady === "true" && target.getAnimations({ subtree: true }).length === 0;
  });
  await page.evaluate(() => {
    const target = document.querySelector(".snt-segmented");
    if (!target) throw new Error("Visual diff segmented-control target is not ready");
    const style = document.createElement("style");
    style.textContent = ".snt-segmented[data-visual-diff-reset]::before { transition: none !important; }";
    document.head.append(style);
    target.dataset.visualDiffReset = "true";
    target.dataset.sntReady = "false";
    void target.offsetWidth;
    style.remove();
  });
}

async function freezeLoadingState(page) {
  await page.waitForFunction(() => {
    const target = document.querySelector(".snt-async-state__spinner");
    return target && target.getAnimations().length > 0;
  });
  await page.evaluate((timeMs) => {
    const target = document.querySelector(".snt-async-state__spinner");
    const animation = target?.getAnimations()[0];
    if (!animation) throw new Error("Visual diff loading-state animation is not running");
    animation.pause();
    animation.currentTime = timeMs;
  }, LOADING_ACTIVE_REFERENCE_PHASE_MS);
}

async function freezeSegmentedTransition(page, transitionTimeMs) {
  await resetSegmentedIndicator(page);
  if (transitionTimeMs === 0) return;
  await page.evaluate(() => {
    const transitionWindow = window;
    if (!transitionWindow.__startVisualDiffTransition) throw new Error("Visual diff transition is not ready");
    transitionWindow.__startVisualDiffTransition();
  });
  await page.waitForFunction(() => document.querySelectorAll(".snt-segment")[1]?.getAttribute("aria-pressed") === "true");
  await page.waitForFunction(() => {
    const target = document.querySelector(".snt-segmented");
    return target?.getAnimations({ subtree: true }).some((animation) => animation.effect?.pseudoElement === "::before");
  });
  await page.evaluate((timeMs) => {
    const target = document.querySelector(".snt-segmented");
    if (!target) throw new Error("Visual diff segmented-control target is not ready");
    const animations = target.getAnimations({ subtree: true });
    if (!animations.some((animation) => animation.effect?.pseudoElement === "::before")) throw new Error("Visual diff segmented-control transition is not running");
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = timeMs;
    }
  }, transitionTimeMs);
}

async function chipTransitionClip(page, frame) {
  if (!frame.normalizeTranslatedPaint || !frame.clip) return frame.clip;
  const translatedOffset = await page.evaluate(() => {
    const target = document.querySelector(".snt-chip");
    if (!target) throw new Error("Visual diff chip target is not ready");
    const bounds = target.getBoundingClientRect();
    return bounds.top - (window.innerHeight - bounds.height) / 2;
  });
  return { ...frame.clip, y: frame.clip.y + Math.ceil(translatedOffset) };
}

async function capture() {
  const input = parseArguments(process.argv.slice(2));
  await assertDisposableOutput(input.referencePath, input.outputPath, "web");
  const caseId = captureCaseId(input.referencePath);
  const transitionTimeMs = visualDiffTransitionTimeMs(caseId);
  const identityKeyframeTimeMs = sentientIdentityKeyframeTimeMs(caseId);
  const identityCase = identityKeyframeTimeMs !== undefined;
  const referenceSize = await readPngSize(input.referencePath);
  if (referenceSize.width % HANDOFF_SCALE !== 0 || referenceSize.height % HANDOFF_SCALE !== 0) {
    throw new Error(`Reference canvas must be divisible by the handoff ${HANDOFF_SCALE}x scale: ${referenceSize.width}x${referenceSize.height}`);
  }
  const frame = captureFrame(caseId, referenceSize);

  let server;
  let browser;
  try {
    server = input.url ? undefined : await startFixtureServer();
    const baseUrl = input.url ?? server.url;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: frame.viewport,
      deviceScaleFactor: HANDOFF_SCALE,
      colorScheme: "dark",
      locale: "en-US",
      reducedMotion: identityCase
        ? caseId.endsWith("--reduced-motion") ? "reduce" : "no-preference"
        : isLoadingStateActiveCase(caseId) ? "no-preference"
          : transitionTimeMs === undefined ? "reduce" : "no-preference",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const url = new URL(baseUrl);
    url.searchParams.set("case", caseId);
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => document.documentElement.dataset.visualDiffFixture === "sentient-v1"
      || document.documentElement.dataset.visualDiffError);
    const fixtureError = await page.evaluate(() => document.documentElement.dataset.visualDiffError);
    if (fixtureError) throw new Error(`Visual diff fixture failed: ${fixtureError}`);
    await page.addStyleTag({ content: await localFontCss() });
    await page.waitForFunction(async () => {
      await document.fonts.ready;
      return document.fonts.check('600 14px "DM Sans"', "Allow once")
        && document.fonts.check('500 22px "Fraunces"', "Sentient")
        && document.fonts.check('500 12px "JetBrains Mono"', "state");
    });
    await page.waitForFunction(() => document.documentElement.dataset.visualDiffReady === "true"
      || document.documentElement.dataset.visualDiffRiveReady === "true");
    if (identityCase) {
      await page.waitForFunction(() => document.documentElement.dataset.visualDiffRiveReady === "true"
        && document.querySelector(".sentient-identity__canvas")
        && !document.querySelector(".sentient-identity__fallback"));
      if (isSentientIdentityTransition(caseId)) {
        await page.waitForFunction(() => document.documentElement.dataset.visualDiffTransitionReady === "true");
      }
      await captureSentientIdentityKeyframe(page, caseId, identityKeyframeTimeMs);
    } else if (transitionTimeMs === undefined) {
      if (isLoadingStateActiveCase(caseId)) {
        await freezeLoadingState(page);
      } else {
        await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
        await applyState(page, caseId);
      }
    } else {
      await page.waitForFunction(() => document.documentElement.dataset.visualDiffTransitionReady === "true");
      if (caseId.startsWith("chip--unselected-to-selected--")) {
        await freezeChipTransition(page, transitionTimeMs);
      } else if (caseId.startsWith("toggle--off-to-on--")) {
        await freezeToggleTransition(page, transitionTimeMs);
      } else if (caseId.startsWith("segmented-control--comfortable-to-compact--")) {
        await freezeSegmentedTransition(page, transitionTimeMs);
      } else {
        await page.evaluate(() => {
          const transitionWindow = window;
          if (!transitionWindow.__startVisualDiffTransition) throw new Error("Visual diff transition is not ready");
          transitionWindow.__startVisualDiffTransition();
        });
        if (transitionTimeMs > 0) await page.waitForTimeout(transitionTimeMs);
      }
    }
    await mkdir(dirname(input.outputPath), { recursive: true });
    const clip = await chipTransitionClip(page, frame);
    await page.screenshot({
      path: input.outputPath,
      animations: transitionTimeMs === undefined && !isLoadingStateActiveCase(caseId) ? "disabled" : "allow",
      caret: "hide",
      omitBackground: true,
      scale: "device",
      ...(clip ? { clip } : {}),
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
