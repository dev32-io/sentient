import type { ToolHandler, ToolRegistry } from "./mcp-server.js";

export function createToolRegistry(handlers: ToolHandler[]): ToolRegistry {
  const map = new Map(handlers.map((h) => [h.def.name, h]));
  return {
    list() {
      return handlers.map((h) => h.def);
    },
    get(name) {
      return map.get(name) ?? null;
    },
  };
}
