#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { defaultActualPath } from "./reference-image.mjs";

function usage() {
  return "Usage: compare --platform <web|ios|android> --reference <png>";
}

function parseArguments(argv) {
  let platform;
  let reference;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!["--platform", "--reference"].includes(argument) || !value) {
      throw new Error(`Unknown or incomplete option: ${argument}`);
    }
    index += 1;
    if (argument === "--platform") platform = value;
    if (argument === "--reference") reference = value;
  }
  if (!platform || !["web", "ios", "android"].includes(platform)) {
    throw new Error("--platform must be web, ios, or android");
  }
  if (!reference) throw new Error("--reference is required");
  return { platform, referencePath: resolve(reference) };
}

let activeChild;
let interruptedSignal;

function killProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function escalateProcessGroup(child) {
  const processGroupId = child.pid;
  if (!processGroupId) return;
  setTimeout(() => {
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch {
      // The complete process group already exited.
    }
  }, 2_000).unref();
}

function interrupt(signal) {
  interruptedSignal = signal;
  if (!activeChild) {
    process.exit(signal === "SIGINT" ? 130 : 143);
  }
  killProcessGroup(activeChild, signal);
  escalateProcessGroup(activeChild);
}

process.once("SIGINT", () => interrupt("SIGINT"));
process.once("SIGTERM", () => interrupt("SIGTERM"));

function run(command, args) {
  const configured = Number(process.env.VISUAL_DIFF_TIMEOUT_MS ?? 1_200_000);
  const timeout = Number.isFinite(configured) && configured > 0 ? configured : 1_200_000;
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      detached: true,
    });
    activeChild = child;
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, "SIGTERM");
      escalateProcessGroup(child);
    }, timeout);
    deadline.unref();
    child.once("error", (error) => {
      clearTimeout(deadline);
      if (activeChild === child) activeChild = undefined;
      rejectRun(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(deadline);
      if (activeChild === child) activeChild = undefined;
      if (timedOut) {
        rejectRun(new Error(`${command} exceeded the ${timeout}ms visual diff timeout`));
      } else if (interruptedSignal) {
        rejectRun(new Error(`${command} interrupted by ${interruptedSignal}`));
      } else if (signal) {
        rejectRun(new Error(`${command} terminated with ${signal}`));
      } else {
        resolveRun(code ?? 2);
      }
    });
  });
}

let input;
try {
  input = parseArguments(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exitCode = 2;
}

if (input) {
  try {
    const actualPath = defaultActualPath(input.referencePath, input.platform);
    const capture = input.platform === "web"
      ? ["node", ["tools/visual-diff/capture-web.mjs", "--reference", input.referencePath, "--output", actualPath]]
      : ["bash", [`scripts/design/capture-${input.platform}-visual-diff.sh`, input.referencePath, actualPath]];
    const captureExit = await run(capture[0], capture[1]);
    const diffArguments = ["tools/visual-diff/visual-diff.mjs", input.referencePath, actualPath];
    if (input.platform === "android") diffArguments.push("--background", "#2B2621");
    process.exitCode = captureExit === 0
      ? await run("node", diffArguments)
      : captureExit;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = interruptedSignal === "SIGINT" ? 130 : interruptedSignal === "SIGTERM" ? 143 : 2;
  }
}
