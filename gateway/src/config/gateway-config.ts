import { readFileSync } from "node:fs";
import { type GatewayConfig, gatewayConfigSchema, loadConfig } from "@sentient/config";

export function loadGatewayConfigFromString(yamlContent: string): GatewayConfig {
  return loadConfig(yamlContent, gatewayConfigSchema);
}

export function loadGatewayConfig(filePath: string): GatewayConfig {
  const content = readFileSync(filePath, "utf-8");
  return loadGatewayConfigFromString(content);
}
