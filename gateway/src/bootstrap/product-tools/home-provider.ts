import type { HomeAdapter } from "../../tools/home/home-adapter.js";
import { buildHomeTools } from "../../tools/home/home-tools.js";
import type { ProductToolProvider } from "../product-tool-providers.js";

/** Home owns its credential-bearing adapter. Bootstrap passes only this opaque
 * capability; model arguments can never supply an origin, token, or headers. */
export interface HomeProductToolConfig extends Readonly<Record<string, unknown>> {
  readonly adapter?: HomeAdapter;
}

const unavailableAdapter: HomeAdapter = {
  overview: async () => ({ outcome: "unavailable" }),
  entities: async () => ({ outcome: "unavailable" }),
  state: async () => ({ outcome: "unavailable" }),
  history: async () => ({ outcome: "unavailable" }),
  locations: async () => ({ outcome: "unavailable" }),
  camera: async () => ({ outcome: "unavailable" }),
  control: async () => ({ outcome: "failed", operationId: crypto.randomUUID() }),
  activate: async () => ({ outcome: "failed", operationId: crypto.randomUUID() }),
  operation: () => ({ outcome: "not_found" }),
  getConfig: async () => ({ outcome: "unavailable" }),
  createConfig: async (kind, id) => ({ outcome: "failed", id, entityId: `${kind}.${id}` }),
  updateConfig: async (kind, id) => ({ outcome: "failed", id, entityId: `${kind}.${id}` }),
  removeConfig: async (kind, id) => ({ outcome: "failed", id, entityId: `${kind}.${id}` }),
  todos: async () => ({ outcome: "unavailable" }),
  mutateTodo: async (listId) => ({ outcome: "failed", listId }),
  calendarEvents: async () => ({ outcome: "unavailable" }),
  mutateCalendar: async (calendarId) => ({ outcome: "failed", calendarId }),
};

export const homeProductToolProvider: ProductToolProvider<"home"> = {
  group: "home",
  create: (config) => buildHomeTools((config as HomeProductToolConfig).adapter ?? unavailableAdapter),
};
