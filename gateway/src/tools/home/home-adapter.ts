import { z } from "zod";

export type HomeOutcome =
  | "succeeded"
  | "not_found"
  | "ambiguous"
  | "unavailable"
  | "rejected"
  | "failed"
  | "accepted_unverified";

export interface HomeEntity {
  entityId: string;
  state: string;
  name: string;
  aliases: readonly string[];
  areaId: string | null;
  lastChanged: string;
}

export interface HomeHistoryPoint {
  state: string;
  changedAt: string;
}

export interface HomeLocation {
  id: string;
  name: string;
  kind: "floor" | "area" | "zone";
  floorId?: string | null;
}

export interface HomeOperationResult {
  outcome: Extract<HomeOutcome, "succeeded" | "rejected" | "failed" | "accepted_unverified">;
  operationId: string;
}

export interface HomeOperationStatus extends HomeOperationResult {
  targetId: string;
}

export interface HomeAdapter {
  overview(signal: AbortSignal): Promise<{ outcome: "succeeded"; entities: HomeEntity[] } | { outcome: "unavailable" }>;
  entities(signal: AbortSignal): Promise<{ outcome: "succeeded"; entities: HomeEntity[] } | { outcome: "unavailable" }>;
  state(
    entityId: string,
    signal: AbortSignal,
  ): Promise<{ outcome: "succeeded"; entity: HomeEntity } | { outcome: "not_found" | "unavailable" }>;
  history(
    entityId: string,
    start: string | undefined,
    signal: AbortSignal,
  ): Promise<{ outcome: "succeeded"; points: HomeHistoryPoint[] } | { outcome: "not_found" | "unavailable" }>;
  locations(
    signal: AbortSignal,
  ): Promise<{ outcome: "succeeded"; locations: HomeLocation[] } | { outcome: "unavailable" }>;
  camera(
    entityId: string,
    signal: AbortSignal,
  ): Promise<
    { outcome: "succeeded"; contentType: string; bytes: number } | { outcome: "not_found" | "rejected" | "unavailable" }
  >;
  control(targetId: string, action: "on" | "off" | "toggle", signal: AbortSignal): Promise<HomeOperationResult>;
  activate(
    targetId: string,
    kind: "scene" | "script" | "automation",
    signal: AbortSignal,
  ): Promise<HomeOperationResult>;
  operation(operationId: string): HomeOperationStatus | { outcome: "not_found" };
}

const stateSchema = z.object({
  entity_id: z.string().regex(/^[a-z0-9_]+\.[a-z0-9_]+$/),
  state: z.string().max(512),
  last_changed: z.string().datetime({ offset: true }),
  attributes: z.record(z.unknown()).default({}),
});
const statesSchema = z.array(stateSchema);
const historySchema = z.array(z.array(stateSchema));
const registryEnvelopeSchema = z.object({ success: z.literal(true), result: z.unknown(), id: z.number() });
const floorRegistryItemSchema = z.object({
  floor_id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
});
const areaRegistryItemSchema = z.object({
  area_id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  floor_id: z.string().nullable().optional(),
});
const entityRegistryItemSchema = z.object({
  entity_id: z.string().regex(/^[a-z0-9_]+\.[a-z0-9_]+$/),
  area_id: z.string().min(1).max(128).nullable().optional(),
  aliases: z.array(z.string().max(256)).max(20).optional(),
});

export type HomeFetch = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

export interface HomeAdapterConfig {
  baseUrl: string;
  readToken: string;
  writeToken?: string;
  requestTimeoutMs?: number;
  websocketTimeoutMs?: number;
  websocketAttempts?: number;
  maxEntities?: number;
  maxHistoryPoints?: number;
  maxCameraBytes?: number;
  fetch?: HomeFetch;
  openWebSocket?: (url: string) => WebSocket;
}

class AdapterFailure extends Error {
  constructor(
    readonly kind: "unavailable" | "not_found" | "rejected" | "failed",
    readonly possiblyDispatched = false,
  ) {
    super(kind);
  }
}

function mergeSignal(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", abort);
    },
  };
}

function toEntity(raw: z.infer<typeof stateSchema>): HomeEntity {
  const attrs = raw.attributes;
  const friendly = attrs.friendly_name;
  const aliases = attrs.aliases;
  const area = attrs.area_id;
  return {
    entityId: raw.entity_id,
    state: raw.state,
    name: typeof friendly === "string" && friendly.length <= 256 ? friendly : raw.entity_id,
    aliases: Array.isArray(aliases)
      ? aliases.filter((v): v is string => typeof v === "string" && v.length <= 256).slice(0, 10)
      : [],
    areaId: typeof area === "string" && area.length <= 128 ? area : null,
    lastChanged: raw.last_changed,
  };
}

function safeBaseUrl(value: string): URL {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("invalid Home Assistant base URL");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

export function createHomeAdapter(config: HomeAdapterConfig): HomeAdapter {
  const base = safeBaseUrl(config.baseUrl);
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const requestTimeoutMs = config.requestTimeoutMs ?? 8_000;
  const websocketTimeoutMs = config.websocketTimeoutMs ?? 5_000;
  const websocketAttempts = Math.max(1, Math.min(config.websocketAttempts ?? 2, 3));
  const maxEntities = config.maxEntities ?? 500;
  const maxHistoryPoints = config.maxHistoryPoints ?? 200;
  const maxCameraBytes = config.maxCameraBytes ?? 2_000_000;
  const openWebSocket = config.openWebSocket ?? ((url: string) => new WebSocket(url));
  const operations = new Map<string, HomeOperationStatus>();
  let entityRegistryCache: Map<string, { areaId: string | null; aliases: readonly string[] }> | null = null;

  function endpoint(path: string): URL {
    const url = new URL(path, `${base.origin}/`);
    if (url.origin !== base.origin) throw new AdapterFailure("rejected");
    return url;
  }

  async function request(
    path: string,
    init: RequestInit,
    token: string,
    parent: AbortSignal,
    write = false,
  ): Promise<{ response: Response; dispose: () => void }> {
    const bounded = mergeSignal(parent, requestTimeoutMs);
    let dispatched = false;
    let handedOff = false;
    try {
      dispatched = true;
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
      const response = await fetchImpl(endpoint(path), {
        ...init,
        headers,
        redirect: "manual",
        signal: bounded.signal,
      });
      if (response.status >= 300 && response.status < 400) throw new AdapterFailure("rejected");
      if (response.status === 404) throw new AdapterFailure("not_found");
      if (response.status === 401 || response.status === 403 || response.status === 400)
        throw new AdapterFailure("rejected");
      if (!response.ok) throw new AdapterFailure("failed");
      handedOff = true;
      return { response, dispose: bounded.dispose };
    } catch (error) {
      if (error instanceof AdapterFailure) throw error;
      throw new AdapterFailure("unavailable", write && dispatched);
    } finally {
      if (!handedOff) bounded.dispose();
    }
  }

  async function json(path: string, schema: z.ZodType, signal: AbortSignal): Promise<unknown> {
    const pending = await request(path, { method: "GET" }, config.readToken, signal);
    try {
      return schema.parse(await pending.response.json());
    } catch {
      throw new AdapterFailure("unavailable");
    } finally {
      pending.dispose();
    }
  }

  async function entities(signal: AbortSignal): ReturnType<HomeAdapter["entities"]> {
    try {
      const raw = (await json("/api/states", statesSchema, signal)) as z.infer<typeof statesSchema>;
      const mapped = raw.slice(0, maxEntities).map(toEntity);
      try {
        if (!entityRegistryCache && config.openWebSocket) {
          const registry = z
            .array(entityRegistryItemSchema)
            .parse(await websocketCommand("config/entity_registry/list", signal));
          entityRegistryCache = new Map(
            registry
              .slice(0, maxEntities * 2)
              .map((entry) => [entry.entity_id, { areaId: entry.area_id ?? null, aliases: entry.aliases ?? [] }]),
          );
        }
        return {
          outcome: "succeeded",
          entities: mapped.map((entity) => {
            const registry = entityRegistryCache?.get(entity.entityId);
            return registry
              ? {
                  ...entity,
                  areaId: registry.areaId ?? entity.areaId,
                  aliases: [...new Set([...entity.aliases, ...registry.aliases])].slice(0, 10),
                }
              : entity;
          }),
        };
      } catch {
        // Registry enrichment is optional: REST observations remain healthy if
        // the WebSocket API is unavailable. Area-constrained resolution then
        // honestly returns no match instead of guessing.
        return { outcome: "succeeded", entities: mapped };
      }
    } catch {
      return { outcome: "unavailable" };
    }
  }

  async function websocketCommand(type: string, signal: AbortSignal): Promise<unknown> {
    let last: unknown;
    for (let attempt = 0; attempt < websocketAttempts; attempt += 1) {
      try {
        return await new Promise<unknown>((resolve, reject) => {
          const wsUrl = new URL("/api/websocket", base.origin);
          wsUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
          const ws = openWebSocket(wsUrl.href);
          const bounded = mergeSignal(signal, websocketTimeoutMs);
          let authenticated = false;
          let settled = false;
          const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            bounded.dispose();
            ws.close();
            fn();
          };
          bounded.signal.addEventListener("abort", () => finish(() => reject(new AdapterFailure("unavailable"))), {
            once: true,
          });
          ws.addEventListener("message", (event) => {
            if (settled) return;
            let msg: unknown;
            try {
              msg = JSON.parse(String(event.data));
            } catch {
              return finish(() => reject(new AdapterFailure("unavailable")));
            }
            if (z.object({ type: z.literal("auth_required") }).safeParse(msg).success) {
              ws.send(JSON.stringify({ type: "auth", access_token: config.readToken }));
              return;
            }
            if (z.object({ type: z.literal("auth_invalid") }).safeParse(msg).success)
              return finish(() => reject(new AdapterFailure("rejected")));
            if (z.object({ type: z.literal("auth_ok") }).safeParse(msg).success) {
              authenticated = true;
              ws.send(JSON.stringify({ id: 1, type }));
              return;
            }
            if (authenticated) {
              const parsed = registryEnvelopeSchema.safeParse(msg);
              if (parsed.success) finish(() => resolve(parsed.data.result));
              else finish(() => reject(new AdapterFailure("unavailable")));
            }
          });
          ws.addEventListener("error", () => finish(() => reject(new AdapterFailure("unavailable"))), { once: true });
        });
      } catch (error) {
        last = error;
        if (signal.aborted || (error instanceof AdapterFailure && error.kind === "rejected")) break;
      }
    }
    throw last instanceof AdapterFailure ? last : new AdapterFailure("unavailable");
  }

  async function mutate(
    targetId: string,
    domain: string,
    service: string,
    signal: AbortSignal,
  ): Promise<HomeOperationResult> {
    const operationId = crypto.randomUUID();
    let outcome: HomeOperationResult["outcome"];
    try {
      if (!config.writeToken) throw new AdapterFailure("rejected");
      const pending = await request(
        `/api/services/${domain}/${service}`,
        { method: "POST", body: JSON.stringify({ entity_id: targetId }) },
        config.writeToken,
        signal,
        true,
      );
      pending.dispose();
      outcome = "succeeded";
    } catch (error) {
      if (error instanceof AdapterFailure && error.kind === "rejected") outcome = "rejected";
      else if (error instanceof AdapterFailure && error.possiblyDispatched) outcome = "accepted_unverified";
      else outcome = "failed";
    }
    if (operations.size >= 200) {
      const oldest = operations.keys().next().value;
      if (oldest !== undefined) operations.delete(oldest);
    }
    operations.set(operationId, { operationId, outcome, targetId });
    return { operationId, outcome };
  }

  return {
    entities,
    async overview(signal) {
      return entities(signal);
    },
    async state(entityId, signal) {
      try {
        const raw = (await json(`/api/states/${encodeURIComponent(entityId)}`, stateSchema, signal)) as z.infer<
          typeof stateSchema
        >;
        return { outcome: "succeeded", entity: toEntity(raw) };
      } catch (error) {
        return { outcome: error instanceof AdapterFailure && error.kind === "not_found" ? "not_found" : "unavailable" };
      }
    },
    async history(entityId, start, signal) {
      const since = start ? `/${encodeURIComponent(start)}` : "";
      try {
        const raw = (await json(
          `/api/history/period${since}?filter_entity_id=${encodeURIComponent(entityId)}&minimal_response`,
          historySchema,
          signal,
        )) as z.infer<typeof historySchema>;
        const points = (raw[0] ?? [])
          .slice(-maxHistoryPoints)
          .map((v) => ({ state: v.state, changedAt: v.last_changed }));
        return points.length ? { outcome: "succeeded", points } : { outcome: "not_found" };
      } catch {
        return { outcome: "unavailable" };
      }
    },
    async locations(signal) {
      try {
        const [floorsRaw, areasRaw, states] = await Promise.all([
          websocketCommand("config/floor_registry/list", signal),
          websocketCommand("config/area_registry/list", signal),
          entities(signal),
        ]);
        const floors = z
          .array(floorRegistryItemSchema)
          .parse(floorsRaw)
          .slice(0, 100)
          .map((v) => ({ id: v.floor_id, name: v.name, kind: "floor" as const }));
        const areas = z
          .array(areaRegistryItemSchema)
          .parse(areasRaw)
          .slice(0, 200)
          .map((v) => ({ id: v.area_id, name: v.name, kind: "area" as const, floorId: v.floor_id ?? null }));
        const zones =
          states.outcome === "succeeded"
            ? states.entities
                .filter((v) => v.entityId.startsWith("zone."))
                .slice(0, 100)
                .map((v) => ({ id: v.entityId, name: v.name, kind: "zone" as const }))
            : [];
        return { outcome: "succeeded", locations: [...floors, ...areas, ...zones] };
      } catch {
        return { outcome: "unavailable" };
      }
    },
    async camera(entityId, signal) {
      if (!entityId.startsWith("camera.")) return { outcome: "rejected" };
      try {
        const pending = await request(
          `/api/camera_proxy/${encodeURIComponent(entityId)}`,
          { method: "GET", headers: { Accept: "image/*" } },
          config.readToken,
          signal,
        );
        try {
          const { response } = pending;
          const length = Number(response.headers.get("content-length") ?? "0");
          if (!Number.isSafeInteger(length) || length < 0 || length > maxCameraBytes) return { outcome: "rejected" };
          const reader = response.body?.getReader();
          let bytes = 0;
          if (reader) {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > maxCameraBytes) {
                await reader.cancel();
                return { outcome: "rejected" };
              }
            }
          }
          return {
            outcome: "succeeded",
            contentType: (response.headers.get("content-type") ?? "application/octet-stream").slice(0, 128),
            bytes,
          };
        } finally {
          pending.dispose();
        }
      } catch (error) {
        return { outcome: error instanceof AdapterFailure && error.kind === "not_found" ? "not_found" : "unavailable" };
      }
    },
    control(targetId, action, signal) {
      return mutate(
        targetId,
        targetId.split(".")[0] ?? "",
        action === "on" ? "turn_on" : action === "off" ? "turn_off" : "toggle",
        signal,
      );
    },
    activate(targetId, kind, signal) {
      return mutate(targetId, kind, kind === "automation" ? "trigger" : "turn_on", signal);
    },
    operation(operationId) {
      return operations.get(operationId) ?? { outcome: "not_found" };
    },
  };
}
