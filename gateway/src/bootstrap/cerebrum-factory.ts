import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CerebrumConfig } from "@sentient/config";
import type { SalienceMap } from "../cerebrum/short-term-context-types.js";
import type { StartupConfig } from "../config/startup-config.js";
import { DEFAULT_PERSONA } from "../context/system-prompt-loader.js";
import { getLog } from "../logging/logger.js";
import { loadSalienceMap } from "../salience/salience-map-loader.js";

const log = getLog(["sentient", "bootstrap", "cerebrum"]);

const UNLIMITED_PERSONA = "You are Sentient, an AI assistant.";

export interface CerebrumServices {
  readonly salienceMap: SalienceMap;
  readonly cerebrumConfig: CerebrumConfig;
  readonly persona: string;
  readonly systemPrompt: string;
}

function getGatewayRoot(): string {
  return process.env.GATEWAY_RUNTIME_DIR ?? join(import.meta.dir, "..", "..");
}

function tryReadFile(path: string, kind: string): string | undefined {
  try {
    const content = readFileSync(path, "utf-8").trim();
    log.info(`${kind}-loaded`, { path });
    return content;
  } catch {
    log.warn(`${kind}-missing`, { path });
    return undefined;
  }
}

function loadPersona(runtimeDir: string, unlimited: boolean): string {
  if (unlimited) {
    // Unlimited mode: skip persona.md (it contains the family-friendly
    // guardrails). The system prompt file carries the only instructions.
    return UNLIMITED_PERSONA;
  }
  return tryReadFile(join(runtimeDir, "persona.md"), "persona") ?? DEFAULT_PERSONA;
}

function loadSystemPrompt(runtimeDir: string, unlimited: boolean): string {
  const fileName = unlimited ? "system_prompt_unlimited.md" : "system_prompt.md";
  return tryReadFile(join(runtimeDir, "system_prompts", fileName), "system-prompt") ?? "";
}

function loadSalienceMapSafe(path: string): SalienceMap {
  try {
    return loadSalienceMap(path);
  } catch (err: unknown) {
    log.warn("salience-map-load-failed", { path, error: String(err) });
    return { lookup: () => ({}) };
  }
}

export function createCerebrumServices(cfg: StartupConfig): CerebrumServices {
  const runtimeDir = getGatewayRoot();
  const salienceMapPath = cfg.cerebrum.salience_map_path;
  const unlimited = cfg.cerebrum.unlimited_mode;

  log.info("cerebrum-init", { runtimeDir, salienceMapPath, language: cfg.language, unlimitedMode: unlimited });

  const salienceMap = loadSalienceMapSafe(salienceMapPath);
  const persona = loadPersona(runtimeDir, unlimited);
  const systemPrompt = loadSystemPrompt(runtimeDir, unlimited);

  log.info("cerebrum-ready", {
    hasSystemPrompt: systemPrompt.length > 0,
    personaLength: persona.length,
    unlimitedMode: unlimited,
  });

  return {
    salienceMap,
    cerebrumConfig: cfg.cerebrum,
    persona,
    systemPrompt,
  };
}
