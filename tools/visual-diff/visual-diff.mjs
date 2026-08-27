#!/usr/bin/env node

import { lstat, mkdir, mkdtemp, realpath, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { compositePng, parseHexColor } from "./image-background.mjs";

const USAGE = `Usage: visual-diff <reference-image> <actual-image> [options]

Options:
  --diff <path>                 Diff PNG output path. Defaults beside the actual image.
  --threshold <0..1>            Per-pixel color tolerance passed to ODiff. Default: 0.1.
  --max-diff-percentage <0..100>
                                Exit 1 when changed pixels exceed this percentage.
                                Without this option, comparison is report-only.
  --count-antialiasing          Count detected anti-aliased pixels as differences.
  --background <#RRGGBB>        Composite both images on one reviewed opaque canvas.
  -h, --help                    Show this help.

The command writes one compact JSON report to stdout. Invocation, decode, and
filesystem errors exit 2. A valid report exits 0 unless --max-diff-percentage
is supplied and exceeded.`;

function numericOption(name, raw, minimum, maximum) {
	const value = Number(raw);
	if (!Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be a number from ${minimum} to ${maximum}.`);
	}
	return value;
}

function defaultDiffPath(actualPath) {
	const extension = extname(actualPath);
	const stem = basename(actualPath, extension);
	return join(dirname(actualPath), `${stem}.visual-diff.png`);
}

export function parseArguments(argv) {
	if (argv.includes("--help") || argv.includes("-h")) return { help: true };
	const positional = [];
	let diffPath;
	let threshold = 0.1;
	let maxDiffPercentage;
	let antialiasing = true;
	let background;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (!argument.startsWith("-")) {
			positional.push(argument);
			continue;
		}
		if (argument === "--count-antialiasing") {
			antialiasing = false;
			continue;
		}
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("-")) throw new Error(`${argument} requires a value.`);
		index += 1;
		if (argument === "--diff") diffPath = value;
		else if (argument === "--threshold") threshold = numericOption(argument, value, 0, 1);
		else if (argument === "--max-diff-percentage") maxDiffPercentage = numericOption(argument, value, 0, 100);
		else if (argument === "--background") {
			parseHexColor(value);
			background = value;
		}
		else throw new Error(`Unknown option: ${argument}`);
	}

	if (positional.length !== 2) throw new Error("Expected exactly two image paths: reference and actual.");
	const referencePath = resolve(positional[0]);
	const actualPath = resolve(positional[1]);
	const resolvedDiffPath = resolve(diffPath ?? defaultDiffPath(actualPath));
	const artifactRoot = resolve("build", "visual-captures");
	const fromArtifactRoot = relative(artifactRoot, resolvedDiffPath);
	if (resolvedDiffPath === referencePath || resolvedDiffPath === actualPath) {
		throw new Error("Diff output must not overwrite either input image.");
	}
	if (fromArtifactRoot === "" || fromArtifactRoot === ".." || fromArtifactRoot.startsWith(`..${sep}`)) {
		throw new Error(`Diff output must stay under ${artifactRoot}.`);
	}
	return {
		help: false,
		referencePath,
		actualPath,
		diffPath: resolvedDiffPath,
		threshold,
		maxDiffPercentage,
		antialiasing,
		background,
	};
}

function differenceBounds(result) {
	if (!result.diffLines?.length || !result.diffCols?.length) return undefined;
	return {
		left: result.diffCols[0],
		top: result.diffLines[0],
		right: result.diffCols.at(-1),
		bottom: result.diffLines.at(-1),
	};
}

export async function runVisualDiff(argv, dependencies = {}) {
	const stdout = dependencies.stdout ?? ((line) => process.stdout.write(`${line}\n`));
	const stderr = dependencies.stderr ?? ((line) => process.stderr.write(`${line}\n`));
	let input;
	try {
		input = parseArguments(argv);
	} catch (error) {
		stderr(error instanceof Error ? error.message : String(error));
		stderr(USAGE);
		return 2;
	}
	if (input.help) {
		stdout(USAGE);
		return 0;
	}

	let temporaryDirectory;
	try {
		const artifactRoot = resolve("build", "visual-captures");
		await mkdir(artifactRoot, { recursive: true });
		await mkdir(dirname(input.diffPath), { recursive: true });
		const artifactRootReal = await realpath(artifactRoot);
		const diffParentReal = await realpath(dirname(input.diffPath));
		const fromArtifactRoot = relative(artifactRootReal, diffParentReal);
		if (fromArtifactRoot === ".." || fromArtifactRoot.startsWith(`..${sep}`)) {
			throw new Error(`Diff output must stay under ${artifactRootReal}.`);
		}
		try {
			if ((await lstat(input.diffPath)).isSymbolicLink()) throw new Error("Diff output must not be a symbolic link.");
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		await unlink(input.diffPath).catch(() => {});
		const compare = dependencies.compare ?? (await import("odiff-bin")).compare;
		let comparedReference = input.referencePath;
		let comparedActual = input.actualPath;
		if (input.background) {
			temporaryDirectory = await mkdtemp(join(tmpdir(), "sentient-visual-diff-"));
			comparedReference = join(temporaryDirectory, "reference.png");
			comparedActual = join(temporaryDirectory, "actual.png");
			const color = parseHexColor(input.background);
			await Promise.all([
				compositePng(input.referencePath, comparedReference, color),
				compositePng(input.actualPath, comparedActual, color),
			]);
		}
		const result = await compare(comparedReference, comparedActual, input.diffPath, {
			threshold: input.threshold,
			antialiasing: input.antialiasing,
			failOnLayoutDiff: true,
			noFailOnFsErrors: true,
			diffOverlay: true,
			captureDiffLines: true,
			captureDiffCols: true,
		});
		const report = {
			referencePath: input.referencePath,
			actualPath: input.actualPath,
			match: result.match,
			reason: result.match ? "match" : result.reason,
			threshold: input.threshold,
			antialiasingIgnored: input.antialiasing,
		};
		if (input.background) report.background = input.background;
		if (result.match) await unlink(input.diffPath).catch(() => {});
		if (!result.match && result.reason === "pixel-diff") {
			report.diffCount = result.diffCount;
			report.diffPercentage = result.diffPercentage;
			report.bounds = differenceBounds(result);
			report.diffPath = input.diffPath;
		}
		if (!result.match && result.reason === "file-not-exists") report.file = result.file;

		let exitCode = result.reason === "file-not-exists" ? 2 : 0;
		if (input.maxDiffPercentage !== undefined) {
			const withinLimit = result.match || (result.reason === "pixel-diff" && result.diffPercentage <= input.maxDiffPercentage);
			report.maxDiffPercentage = input.maxDiffPercentage;
			report.withinLimit = withinLimit;
			if (!withinLimit && exitCode === 0) exitCode = 1;
		}
		stdout(JSON.stringify(report));
		return exitCode;
	} catch (error) {
		stdout(JSON.stringify({
			referencePath: input.referencePath,
			actualPath: input.actualPath,
			match: false,
			reason: "comparison-error",
			message: error instanceof Error ? error.message : String(error),
		}));
		return 2;
	} finally {
		if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) process.exitCode = await runVisualDiff(process.argv.slice(2));
