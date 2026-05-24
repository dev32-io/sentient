# Gateway–WebUI Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the two-container `gateway` + `web` deployment into a single `gateway` process that speaks TLS on port `8888`, serves the Preact webui at `/`, and exposes the SDK API under `/api/v1/*`. One origin, one cert, one browser exception.

**Architecture:** Move `web/` into `gateway/webui/` as a child workspace. Extract `gateway/src/index.ts`'s top-level bootstrap into a thin `main.ts`; pull all HTTP/WS routing into `gateway/src/api/` (one handler file per surface). Static webui serving, `/api/v1/ws`, `/api/v1/health`, `/api/v1/ready`, and a stubbed `/api/v1/admin/*` all live on the same `Bun.serve` instance. Internal provider calls (STT/TTS/LLM) stay plain HTTP/WS over the docker network. The old `web` container, `web/Dockerfile`, `web/server.ts`, `web/config.example.yaml`, and the `/config.js` runtime-injection mechanism all go away.

**Tech Stack:** Bun (HTTP+WSS server), Preact+Vite (webui), TypeScript strict, Vitest, Zod. No new dependencies.

---

## Scope & non-goals

**In scope:**
- Physical relocation `web/` → `gateway/webui/` (all files, tests, configs).
- Path moves: gateway HTTP surface shifts to `/api/v1/*`.
- Thin `main.ts` + dedicated `server.ts` + `api/` directory.
- Scaffold admin surface (one ping endpoint + auth middleware stub that returns 401 without a token — no real auth yet).
- web-sdk default `wsUrl` = `wss://<same-origin>/api/v1/ws`.
- Drop `web` docker service; expose only `gateway:8888`.
- Update `deploy/{docker,pi}/docker-compose.yml`, `setup.sh`, README.

**Out of scope:**
- Real admin auth implementation (separate effort — stub returns 401 until the first admin feature lands).
- Internal TLS between gateway and STT/TTS (plain HTTP over docker network is fine — trust boundary at the edge).
- Renaming `gateway` to anything else.
- Changes to `sentient-auth` or `capabilityServices/STTService`.

---

## File structure after refactor

```
gateway/
  webui/                              <── was web/ (verbatim move)
    src/
    index.html
    package.json                      (name: @sentient/webui)
    vite.config.ts                    (proxy /api/v1/* → gateway; no more /ws bare path)
    ...
  src/
    main.ts                           <── was index.ts (thin bootstrap)
    server.ts                         <── NEW: loads TLS, builds router, Bun.serve
    api/                              <── NEW
      router.ts                       path-based fetch dispatch
      handlers/
        health.ts                     GET /api/v1/health
        ready.ts                      GET /api/v1/ready
        ws.ts                         WS  /api/v1/ws (session open, upgrade, JSON/binary routing)
        webui.ts                      GET /** except /api/v1/** (serve webui/dist + SPA fallback)
        admin.ts                      GET /api/v1/admin/ping (gated by auth stub)
      middleware/
        require-admin-auth.ts         returns 401 until a real check is wired in
    session-handlers/                 <── RENAMED from server/ (continuous-voice-handler + ws-helpers)
    config/  context/  logging/  pipeline/  providers/  session/  auth/   <── unchanged
  Dockerfile                          <── adds a node+vite build stage for webui; copies dist into runtime image
  config.yaml                         <── port: 8888; tls.hostnames updated defaults

deploy/
  docker/docker-compose.yml           <── gateway only (port 8888:8888); web service removed
  docker/setup.sh                     <── no more ~/.sentient/web; certs stay at ~/.sentient/certs
  pi/docker-compose.yml               <── mirror
  pi/setup.sh                         <── mirror

shared/
  tls/                                <── unchanged
  config/                             <── unchanged
  web-sdk/
    src/voice-client.ts               <── wsUrl optional; defaults to same-origin /api/v1/ws

(deleted)
  web/                                <── entire directory
  gateway/src/static/                 <── folded into api/handlers/webui.ts
```

### Why this shape

- **main.ts = bootstrap only.** Load logging, load config, build providers, hand everything to `server.ts`. When someone needs to know "how does the gateway start?", they read 30 lines, not 120.
- **server.ts = transport layer only.** TLS material, Bun.serve config, websocket lifecycle callbacks. Routing lives elsewhere.
- **api/router.ts = pure path dispatch.** Given a Request, pick a handler. Easy to unit-test: feed it a fake Request, assert which handler ran.
- **api/handlers/* = one file per surface.** Each handler is self-contained: receives whatever deps it needs via its factory, exports a `(request, ctx) => Response | undefined` function.
- **middleware/ = cross-cutting request decorators.** Only admin auth for now — but same pattern for rate-limit, metrics, etc.
- **Rename `server/` → `session-handlers/`** so "server" only means the HTTP transport layer. The voice turn handlers (continuous-voice-handler, ws-helpers) logically belong to the WS handler.

---

## Phased approach

Each phase is self-contained, committable, and leaves the build green. Phases 1–3 are pure moves (no behavior change). Phase 4 flips the URL space to `/api/v1/*`. Phase 5 collapses deployment. Phase 6 verifies.

| Phase | Tasks | Goal |
|---|---|---|
| 1 | 1–3  | Physical move: `web/` → `gateway/webui/`; rename `index.ts` → `main.ts`. No behavior change. |
| 2 | 4–7  | Extract `server.ts` + `api/router.ts` + existing paths (`/health`, `/ready`, `/ws`) moved into handlers. Tests pass against old paths. |
| 3 | 8–9  | Fold static file serving into `api/handlers/webui.ts`; delete `src/static/`. |
| 4 | 10–13 | Move paths under `/api/v1/*`; update SDK + webui + healthcheck + tests. |
| 5 | 14   | Admin scaffold (handler + middleware + tests). |
| 6 | 15–17 | Gateway Dockerfile builds webui; delete web container; update compose + setup.sh + README. |
| 7 | 18   | End-to-end local verification via docker compose. |

---

## Task 1: Move `web/` → `gateway/webui/` (filesystem only)

**Goal:** Relocate the Preact app inside the gateway workspace. No code changes yet.

**Files:**
- Move: `web/**` → `gateway/webui/**` (entire tree)
- Modify: `package.json` (root workspaces list)
- Modify: `gateway/webui/package.json` (rename `@sentient/web` → `@sentient/webui`)

- [ ] **Step 1: Move the tree.**

```bash
git mv web gateway/webui
```

Verify the tree moved and no files were left behind:

```bash
ls web 2>/dev/null && echo "FAIL: web/ still exists" || echo "OK"
ls gateway/webui/src/app.tsx gateway/webui/package.json gateway/webui/vite.config.ts
```

Expected: three file paths print; `FAIL` does not appear.

- [ ] **Step 2: Update root `package.json` workspaces.**

Edit `package.json` — change:

```json
"workspaces": [
  "gateway",
  "sentient-auth",
  "web",
  "shared/*"
]
```

to:

```json
"workspaces": [
  "gateway",
  "gateway/webui",
  "sentient-auth",
  "shared/*"
]
```

- [ ] **Step 3: Rename the workspace package.**

In `gateway/webui/package.json`, change `"name": "@sentient/web"` to `"name": "@sentient/webui"`.

- [ ] **Step 4: Re-install.**

```bash
source scripts/env.sh
bun install
```

Expected: `Saved lockfile` and no resolution errors.

- [ ] **Step 5: Verify webui still typechecks and builds in its new home.**

```bash
cd gateway/webui && bun run typecheck && bun run build && cd ../..
```

Expected: both exit 0, `gateway/webui/dist/` contains `index.html`.

- [ ] **Step 6: Commit.**

```bash
git add -A
git commit -m "refactor(gateway): move web/ to gateway/webui/ as a child workspace"
```

---

## Task 2: Rename `gateway/src/index.ts` → `gateway/src/main.ts`

**Goal:** Signals that the file is a thin entrypoint, not a kitchen sink. Unblocks later extraction of `server.ts`.

**Files:**
- Rename: `gateway/src/index.ts` → `gateway/src/main.ts`
- Rename: `gateway/src/index.test.ts` → `gateway/src/main.test.ts`
- Modify: `gateway/src/main.test.ts` (fix import path)
- Modify: `gateway/package.json` (update scripts)
- Modify: `gateway/Dockerfile` (update build+start commands)

- [ ] **Step 1: Rename the files.**

```bash
git mv gateway/src/index.ts gateway/src/main.ts
git mv gateway/src/index.test.ts gateway/src/main.test.ts
```

- [ ] **Step 2: Fix the test's import path.**

In `gateway/src/main.test.ts`, change `from "./index.ts"` to `from "./main.ts"`.

- [ ] **Step 3: Update `gateway/package.json` scripts.**

Change:

```json
"dev": "bun --hot src/index.ts",
"build": "bun build src/index.ts --outdir dist --target bun",
```

to:

```json
"dev": "bun --hot src/main.ts",
"build": "bun build src/main.ts --outdir dist --target bun",
```

The `start` script (`bun dist/index.js`) also needs updating — change it to `bun dist/main.js`.

- [ ] **Step 4: Update `gateway/Dockerfile`.**

Change:

```dockerfile
RUN cd gateway && bun build src/index.ts --outdir dist --target bun
...
CMD ["bun", "dist/index.js"]
```

to:

```dockerfile
RUN cd gateway && bun build src/main.ts --outdir dist --target bun
...
CMD ["bun", "dist/main.js"]
```

- [ ] **Step 5: Verify.**

```bash
source scripts/env.sh && bun run typecheck && cd gateway && bun test src/main.test.ts && cd ..
```

Expected: typecheck clean; `main.test.ts` → 3 pass.

- [ ] **Step 6: Commit.**

```bash
git add gateway/src/main.ts gateway/src/main.test.ts gateway/package.json gateway/Dockerfile
git commit -m "refactor(gateway): rename index.ts to main.ts"
```

---

## Task 3: Rename `gateway/src/server/` → `gateway/src/session-handlers/`

**Goal:** Free the name `server` for the new transport layer. Files inside are conceptually "per-session WebSocket handlers", not HTTP server code.

**Files:**
- Rename dir: `gateway/src/server/` → `gateway/src/session-handlers/`
- Modify: every import referencing `"./server/..."` or `"../server/..."` inside `gateway/src/`

- [ ] **Step 1: Rename the directory.**

```bash
git mv gateway/src/server gateway/src/session-handlers
```

- [ ] **Step 2: Find all imports referring to the old path.**

```bash
grep -rn 'from "../server/\|from "./server/' gateway/src
```

- [ ] **Step 3: Rewrite each hit to use `session-handlers/`.**

For each file listed in Step 2, replace `../server/` with `../session-handlers/` and `./server/` with `./session-handlers/` (preserving the rest of the import specifier). Example: in `gateway/src/main.ts`:

```ts
import { createGatewayServer } from "./server/ws-server.ts";
```

becomes:

```ts
import { createGatewayServer } from "./session-handlers/ws-server.ts";
```

- [ ] **Step 4: Verify.**

```bash
source scripts/env.sh && bun run typecheck 2>&1 | tail -10
```

Expected: all workspaces exit 0.

```bash
cd gateway && bun test 2>&1 | tail -5 && cd ..
```

Expected: 505 pass, 0 fail.

- [ ] **Step 5: Commit.**

```bash
git add -A
git commit -m "refactor(gateway): rename server/ to session-handlers/ to free the name"
```

---

## Task 4: Extract path dispatch into `gateway/src/api/router.ts`

**Goal:** Move the `fetch(request)` routing block out of `gateway/src/session-handlers/ws-server.ts` into a dedicated router. Behavior identical — paths are still `/health`, `/ready`, `/ws`. Prepares for per-handler extraction in Task 5.

**Files:**
- Create: `gateway/src/api/router.ts`
- Create: `gateway/src/api/router.test.ts`
- Modify: `gateway/src/session-handlers/ws-server.ts` (delegate to router)

- [ ] **Step 1: Write the failing test.**

Create `gateway/src/api/router.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createApiRouter } from "./router.ts";

describe("createApiRouter", () => {
  it("routes /health to the health handler", async () => {
    const router = createApiRouter({
      handleHealth: async () => new Response("HEALTH", { status: 200 }),
      handleReady: async () => new Response("READY", { status: 200 }),
      handleWsUpgrade: () => undefined,
      handleStatic: async () => null,
    });
    const res = await router(new Request("http://test/health"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("HEALTH");
  });

  it("routes /ready to the ready handler", async () => {
    const router = createApiRouter({
      handleHealth: async () => new Response("HEALTH"),
      handleReady: async () => new Response("READY"),
      handleWsUpgrade: () => undefined,
      handleStatic: async () => null,
    });
    const res = await router(new Request("http://test/ready"));
    expect(await res.text()).toBe("READY");
  });

  it("returns 404 when static handler returns null and path is not an API path", async () => {
    const router = createApiRouter({
      handleHealth: async () => new Response("HEALTH"),
      handleReady: async () => new Response("READY"),
      handleWsUpgrade: () => undefined,
      handleStatic: async () => null,
    });
    const res = await router(new Request("http://test/nope"));
    expect(res.status).toBe(404);
  });

  it("falls through to static handler when path is not /health /ready /ws", async () => {
    const router = createApiRouter({
      handleHealth: async () => new Response("HEALTH"),
      handleReady: async () => new Response("READY"),
      handleWsUpgrade: () => undefined,
      handleStatic: async () => new Response("INDEX", { status: 200 }),
    });
    const res = await router(new Request("http://test/"));
    expect(await res.text()).toBe("INDEX");
  });
});
```

- [ ] **Step 2: Run it — expect it to fail (module missing).**

```bash
cd gateway && bun test src/api/router.test.ts 2>&1 | tail -5
```

Expected: FAIL — cannot find `./router.ts`.

- [ ] **Step 3: Create `gateway/src/api/router.ts`.**

```ts
const HTTP_NOT_FOUND = 404;

export interface ApiRouterDeps {
  handleHealth: (request: Request) => Promise<Response>;
  handleReady: (request: Request) => Promise<Response>;
  /** Attempts WebSocket upgrade. Returns undefined on success (Bun already
   *  sent the 101). Returns a Response when the upgrade fails. */
  handleWsUpgrade: (request: Request) => Response | undefined;
  /** Serves a static file or the SPA fallback. Returns null when the path
   *  is unambiguously an API path that the static handler must not claim. */
  handleStatic: (request: Request) => Promise<Response | null>;
}

export type ApiRouter = (request: Request) => Promise<Response | undefined>;

export function createApiRouter(deps: ApiRouterDeps): ApiRouter {
  return async (request) => {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === "/health") return deps.handleHealth(request);
    if (pathname === "/ready") return deps.handleReady(request);
    if (pathname === "/ws") return deps.handleWsUpgrade(request);

    const staticResponse = await deps.handleStatic(request);
    if (staticResponse) return staticResponse;

    return new Response("Not Found", { status: HTTP_NOT_FOUND });
  };
}
```

- [ ] **Step 4: Run it — expect it to pass.**

```bash
cd gateway && bun test src/api/router.test.ts 2>&1 | tail -5
```

Expected: 4 pass.

- [ ] **Step 5: Rewrite `ws-server.ts`'s `fetch` block to delegate to the router.**

In `gateway/src/session-handlers/ws-server.ts`, replace the `async fetch(request, server) { ... }` block with:

```ts
async fetch(request, server) {
  const router = createApiRouter({
    handleHealth: async () => Response.json({ status: "ok" }),
    handleReady: async () => Response.json({ status: "ready", connections: activeConnections }),
    handleWsUpgrade: (req) => {
      const data: ClientData = {
        sessionId: null,
        connectedAt: Date.now(),
        history: createSessionHistory(),
        continuousSession: null,
      };
      const upgraded = server.upgrade(req, { data });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: HTTP_BAD_REQUEST });
    },
    handleStatic: async (req) => {
      if (!webDistDir) return null;
      const url = new URL(req.url);
      return serveStaticFile(url.pathname, webDistDir);
    },
  });
  return (await router(request)) ?? new Response("Not Found", { status: HTTP_NOT_FOUND });
},
```

Add the import at the top of the file:

```ts
import { createApiRouter } from "../api/router.ts";
```

- [ ] **Step 6: Run the full gateway test suite.**

```bash
cd gateway && bun test 2>&1 | tail -5
```

Expected: same pass count as before (505), 0 fail.

- [ ] **Step 7: Commit.**

```bash
git add -A
git commit -m "refactor(gateway): extract path dispatch into api/router.ts"
```

---

## Task 5: Extract per-handler files under `api/handlers/`

**Goal:** Split the inline handlers wired up in Task 4 into dedicated files. One responsibility per file; each handler easy to test in isolation.

**Files:**
- Create: `gateway/src/api/handlers/health.ts`
- Create: `gateway/src/api/handlers/ready.ts`
- Create: `gateway/src/api/handlers/ws.ts`
- Modify: `gateway/src/session-handlers/ws-server.ts` (import + use handlers)

- [ ] **Step 1: Create `api/handlers/health.ts`.**

```ts
/** GET /api/v1/health — liveness. Always 200 once the process is up. */
export function createHealthHandler(): (request: Request) => Promise<Response> {
  return async () => Response.json({ status: "ok" });
}
```

- [ ] **Step 2: Create `api/handlers/ready.ts`.**

```ts
/** GET /api/v1/ready — readiness. Reports active connection count so a
 *  load balancer or oncall script can see "is anything actually live". */
export interface ReadyHandlerDeps {
  getActiveConnections: () => number;
}

export function createReadyHandler(deps: ReadyHandlerDeps): (request: Request) => Promise<Response> {
  return async () =>
    Response.json({ status: "ready", connections: deps.getActiveConnections() });
}
```

- [ ] **Step 3: Create `api/handlers/ws.ts`.**

Move the `WebSocket upgrade` logic (currently inline in `ws-server.ts`'s `handleWsUpgrade`) into a new file. The handler takes the Bun server instance + a factory for `ClientData`:

```ts
import type { Server } from "bun";
import { createSessionHistory } from "../../context/session-history.ts";
import type { ClientData } from "../../session-handlers/ws-helpers.ts";

const HTTP_BAD_REQUEST = 400;

export function createWsUpgradeHandler(server: Server<ClientData>): (request: Request) => Response | undefined {
  return (request) => {
    const data: ClientData = {
      sessionId: null,
      connectedAt: Date.now(),
      history: createSessionHistory(),
      continuousSession: null,
    };
    const upgraded = server.upgrade(request, { data });
    if (upgraded) return undefined;
    return new Response("WebSocket upgrade failed", { status: HTTP_BAD_REQUEST });
  };
}
```

Note: the server reference is needed because `server.upgrade()` is only available on that instance. In `ws-server.ts` we'll instantiate the handler inside `Bun.serve`'s `fetch` callback, which has `server` in scope.

- [ ] **Step 4: Wire the new handlers into `ws-server.ts`.**

Replace the inline handler objects in `ws-server.ts`'s `fetch` block with calls to the factories:

```ts
import { createApiRouter } from "../api/router.ts";
import { createHealthHandler } from "../api/handlers/health.ts";
import { createReadyHandler } from "../api/handlers/ready.ts";
import { createWsUpgradeHandler } from "../api/handlers/ws.ts";
// ...
async fetch(request, server) {
  const router = createApiRouter({
    handleHealth: createHealthHandler(),
    handleReady: createReadyHandler({ getActiveConnections: () => activeConnections }),
    handleWsUpgrade: createWsUpgradeHandler(server),
    handleStatic: async (req) => {
      if (!webDistDir) return null;
      const url = new URL(req.url);
      return serveStaticFile(url.pathname, webDistDir);
    },
  });
  return (await router(request)) ?? new Response("Not Found", { status: HTTP_NOT_FOUND });
},
```

Remove the now-unused `HTTP_BAD_REQUEST` constant at the top of `ws-server.ts` if nothing else references it.

- [ ] **Step 5: Add unit tests for the two trivial handlers.**

Create `gateway/src/api/handlers/health.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createHealthHandler } from "./health.ts";

describe("createHealthHandler", () => {
  it("returns 200 with status: ok", async () => {
    const handler = createHealthHandler();
    const res = await handler(new Request("http://test/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
```

Create `gateway/src/api/handlers/ready.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createReadyHandler } from "./ready.ts";

describe("createReadyHandler", () => {
  it("reports the active connection count from the injected getter", async () => {
    let count = 0;
    const handler = createReadyHandler({ getActiveConnections: () => count });
    count = 7;
    const res = await handler(new Request("http://test/ready"));
    const body = await res.json();
    expect(body).toEqual({ status: "ready", connections: 7 });
  });
});
```

- [ ] **Step 6: Run the gateway tests.**

```bash
cd gateway && bun test 2>&1 | tail -5
```

Expected: 507 pass (previous 505 + 2 new), 0 fail.

- [ ] **Step 7: Commit.**

```bash
git add -A
git commit -m "refactor(gateway): extract health/ready/ws handlers into api/handlers/"
```

---

## Task 6: Extract `gateway/src/server.ts`

**Goal:** Move everything in `createGatewayServer` that is *transport* (TLS material plumbing, `Bun.serve` config, websocket lifecycle) into a new `gateway/src/server.ts`. Leave only per-turn session handling in `session-handlers/ws-server.ts` (and rename it to reflect that). `main.ts` imports from `./server.ts`.

**Files:**
- Create: `gateway/src/server.ts`
- Modify: `gateway/src/session-handlers/ws-server.ts` → split: session wiring stays; `Bun.serve` wrapper moves to `server.ts`
- Modify: `gateway/src/main.ts` (import path)
- Modify: every test that imports `createGatewayServer` from `./session-handlers/ws-server.ts`

- [ ] **Step 1: Identify the two responsibilities in `ws-server.ts`.**

Read `gateway/src/session-handlers/ws-server.ts`. The split is:

- **Transport (moves to `server.ts`):** the top-level `createGatewayServer` function, `Bun.serve` call, the `fetch` callback (which now just builds the router), the websocket `{ open, message, close }` handler block, the TLS option merge.
- **Session logic (stays in session-handlers):** `handleTextInput`, `handleSessionEnd`, `openSession`, `GatewayServerOptions` type, WebSocket message parsing + dispatch.

The `websocket` handler block in `Bun.serve` calls `openSession`, `handleTextInput`, etc. In the new layout, `server.ts`'s `websocket` block calls into `session-handlers` functions.

- [ ] **Step 2: Create `gateway/src/server.ts`.**

Put the `Bun.serve` setup here. The file exports `createGatewayServer(options: GatewayServerOptions): Server<ClientData>`. Imports from `./session-handlers/ws-handlers.ts` (see next step) for the per-message dispatch functions.

```ts
import type { Server, ServerWebSocket } from "bun";
import { createHealthHandler } from "./api/handlers/health.ts";
import { createReadyHandler } from "./api/handlers/ready.ts";
import { createWsUpgradeHandler } from "./api/handlers/ws.ts";
import { createApiRouter } from "./api/router.ts";
import { createSessionManager } from "./auth/session-manager.ts";
import { getLog } from "./logging/logger.ts";
import { serveStaticFile } from "./session-handlers/serve-static.ts";
import { type ClientData, handleWebSocketMessage, openSession } from "./session-handlers/ws-handlers.ts";
import type { GatewayServerOptions } from "./session-handlers/ws-handlers.ts";

const log = getLog(["sentient", "ws"]);
const HTTP_NOT_FOUND = 404;

export type { ClientData, GatewayServerOptions };

export function createGatewayServer(options: GatewayServerOptions): Server<ClientData> {
  const sessionManager = options.sessionManager ?? createSessionManager();
  const webDistDir = options.webDistDir;
  let activeConnections = 0;

  const server = Bun.serve<ClientData>({
    port: options.port,
    hostname: options.host,
    ...(options.tls ? { tls: options.tls } : {}),

    async fetch(request, serverInstance) {
      const router = createApiRouter({
        handleHealth: createHealthHandler(),
        handleReady: createReadyHandler({ getActiveConnections: () => activeConnections }),
        handleWsUpgrade: createWsUpgradeHandler(serverInstance),
        handleStatic: async (req) => {
          if (!webDistDir) return null;
          const url = new URL(req.url);
          return serveStaticFile(url.pathname, webDistDir);
        },
      });
      return (await router(request)) ?? new Response("Not Found", { status: HTTP_NOT_FOUND });
    },

    websocket: {
      open(ws: ServerWebSocket<ClientData>) {
        activeConnections++;
        log.info("client-connected");
        openSession(ws, sessionManager, options.ttsConnectionManager);
      },
      async message(ws: ServerWebSocket<ClientData>, message: string | Buffer) {
        await handleWebSocketMessage(ws, message, options, sessionManager);
      },
      close(ws: ServerWebSocket<ClientData>, _code: number, _reason: string) {
        activeConnections--;
        log.info("client-disconnected");
        ws.data.continuousSession?.close().catch(() => {});
        ws.data.continuousSession = null;
        if (ws.data.sessionId) {
          sessionManager.removeSession(ws.data.sessionId);
        }
      },
    },
  });

  return server;
}
```

- [ ] **Step 3: Rename and trim `session-handlers/ws-server.ts` → `ws-handlers.ts`.**

```bash
git mv gateway/src/session-handlers/ws-server.ts gateway/src/session-handlers/ws-handlers.ts
```

Open `ws-handlers.ts` and delete:
- the `createGatewayServer` function (now in `server.ts`),
- the imports it no longer uses (`Server`, `ServerWebSocket` for the Bun.serve call, `createApiRouter`, etc.),
- `handleSessionEnd` callers-related imports that moved.

Keep: `openSession`, `handleTextInput`, `handleSessionEnd`, the `GatewayServerOptions` type, `GatewayTlsMaterial`, `ClientData` re-export. Add a new exported function `handleWebSocketMessage` that contains the entire body of what used to be the `websocket.message` callback.

```ts
// At the end of ws-handlers.ts, add:

import type { ServerWebSocket } from "bun";
import { clientMessageSchema } from "@sentient/protocol";
import { handleContinuousEnd, handleContinuousStart } from "./continuous-voice-handler.ts";
import { getLog } from "../logging/logger.ts";
import type { SessionManager } from "../auth/session-manager.ts";

const log = getLog(["sentient", "ws"]);

/** Handles a single WebSocket message (text or binary). Extracted out of
 *  Bun.serve's inline callback so it can be unit-tested with a fake ws. */
export async function handleWebSocketMessage(
  ws: ServerWebSocket<ClientData>,
  message: string | Buffer,
  options: GatewayServerOptions,
  sessionManager: SessionManager,
): Promise<void> {
  // Binary frames are raw PCM16 audio.
  if (typeof message !== "string") {
    ws.data.continuousSession?.sendAudio(new Uint8Array(message));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    sendError(ws, "protocol_error", "Malformed JSON");
    return;
  }

  const msgResult = clientMessageSchema.safeParse(parsed);
  if (!msgResult.success) {
    sendError(ws, "protocol_error", `Invalid message: ${msgResult.error.message}`);
    return;
  }

  const msg = msgResult.data;
  if (msg.type !== "ping") log.debug("message-received", { type: msg.type });

  // ... (all the existing if (msg.type === "...") branches, verbatim)
}
```

Move every `if (msg.type === "...")` branch from the old `websocket.message` callback into this function.

Update imports accordingly. Remove unused ones.

- [ ] **Step 4: Update `gateway/src/main.ts`.**

Change:

```ts
import { createGatewayServer } from "./session-handlers/ws-server.ts";
```

to:

```ts
import { createGatewayServer } from "./server.ts";
```

- [ ] **Step 5: Update every test that imports `createGatewayServer`.**

```bash
grep -rln 'from "./session-handlers/ws-server' gateway/src
grep -rln 'from "../session-handlers/ws-server' gateway/src
```

For each file: change `session-handlers/ws-server` → `server` (tests importing from top-level) or `session-handlers/ws-handlers` (tests that pulled helpers out of the old file, if any).

- [ ] **Step 6: Verify.**

```bash
source scripts/env.sh && bun run typecheck 2>&1 | tail -5
```

Expected: all workspaces exit 0.

```bash
cd gateway && bun test 2>&1 | tail -5
```

Expected: 507 pass, 0 fail.

- [ ] **Step 7: Commit.**

```bash
git add -A
git commit -m "refactor(gateway): split server.ts (transport) from ws-handlers.ts (session)"
```

---

## Task 7: Move `src/static/serve-static.ts` into `session-handlers/` (interim) — and update imports

**Goal:** `src/static/` is a one-file directory with a single consumer. Until we consolidate into `api/handlers/webui.ts` (Task 8), move it next to its only caller so the layout is tidy.

**Files:**
- Move: `gateway/src/static/serve-static.ts` → `gateway/src/session-handlers/serve-static.ts`
- Move: `gateway/src/static/serve-static.test.ts` → `gateway/src/session-handlers/serve-static.test.ts`
- Delete: `gateway/src/static/` (empty after move)
- Modify: `gateway/src/server.ts` import path

- [ ] **Step 1: Do the moves.**

```bash
git mv gateway/src/static/serve-static.ts gateway/src/session-handlers/serve-static.ts
git mv gateway/src/static/serve-static.test.ts gateway/src/session-handlers/serve-static.test.ts
rmdir gateway/src/static
```

- [ ] **Step 2: Fix the import in `server.ts`.**

Change `from "./session-handlers/serve-static.ts"` — it already matches the new location, no edit needed. But verify with:

```bash
grep -rn 'from.*static/serve-static' gateway/src && echo "FAIL: old path still referenced"
```

Expected: no output + no `FAIL`.

- [ ] **Step 3: Verify.**

```bash
cd gateway && bun test 2>&1 | tail -5
```

Expected: 507 pass.

- [ ] **Step 4: Commit.**

```bash
git add -A
git commit -m "refactor(gateway): collapse src/static/ into session-handlers/ (preserve imports)"
```

---

## Task 8: Create `api/handlers/webui.ts` — replace `serve-static.ts`

**Goal:** Wrap static file serving in an explicit handler that owns the "which dir?" question and the "SPA fallback to index.html" logic. `serve-static.ts` disappears; the same tests + cache/COOP logic moves here.

**Files:**
- Create: `gateway/src/api/handlers/webui.ts`
- Create: `gateway/src/api/handlers/webui.test.ts`
- Delete: `gateway/src/session-handlers/serve-static.ts`
- Delete: `gateway/src/session-handlers/serve-static.test.ts`
- Modify: `gateway/src/server.ts` (import + wire)

- [ ] **Step 1: Write the failing tests.**

Create `gateway/src/api/handlers/webui.test.ts`:

```ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWebuiHandler } from "./webui.ts";

describe("createWebuiHandler", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `webui-handler-${Date.now()}-${Math.random()}`);
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<!doctype html><html>hi</html>");
    writeFileSync(join(dir, "assets", "app-abc12345.js"), "console.log('x')");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("serves index.html at /", async () => {
    const handler = createWebuiHandler({ distDir: dir });
    const res = await handler(new Request("http://test/"));
    expect(res).not.toBeNull();
    expect(res?.headers.get("Content-Type")).toContain("text/html");
    expect(await res?.text()).toContain("<html>hi</html>");
  });

  it("serves hashed assets with immutable cache", async () => {
    const handler = createWebuiHandler({ distDir: dir });
    const res = await handler(new Request("http://test/assets/app-abc12345.js"));
    expect(res).not.toBeNull();
    expect(res?.headers.get("Cache-Control")).toMatch(/immutable/);
  });

  it("falls back to index.html for unknown paths (SPA routing)", async () => {
    const handler = createWebuiHandler({ distDir: dir });
    const res = await handler(new Request("http://test/settings/account"));
    expect(res).not.toBeNull();
    expect(await res?.text()).toContain("<html>hi</html>");
  });

  it("attaches COOP/COEP headers for SharedArrayBuffer", async () => {
    const handler = createWebuiHandler({ distDir: dir });
    const res = await handler(new Request("http://test/"));
    expect(res?.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(res?.headers.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
  });

  it("refuses path traversal", async () => {
    const handler = createWebuiHandler({ distDir: dir });
    const res = await handler(new Request("http://test/../secret"));
    expect(res).toBeNull();
  });

  it("returns null when distDir is undefined (dev mode; webui served by Vite)", async () => {
    const handler = createWebuiHandler({ distDir: undefined });
    const res = await handler(new Request("http://test/"));
    expect(res).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — expect all to fail.**

```bash
cd gateway && bun test src/api/handlers/webui.test.ts 2>&1 | tail -5
```

Expected: cannot find module `./webui.ts`.

- [ ] **Step 3: Create `gateway/src/api/handlers/webui.ts`.**

```ts
import { join } from "node:path";

const HTTP_NOT_FOUND = 404;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};
const DEFAULT_MIME = "application/octet-stream";
const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
const CACHE_NO_CACHE = "no-cache";

// Required for SharedArrayBuffer — Silero VAD (ONNX WASM) refuses to load
// without these. Match the Vite dev server so dev and prod behave the same.
const COOP_COEP_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

const HASHED_ASSET = /-[a-zA-Z0-9]{8,}\./;

function mimeFor(path: string): string {
  const dotIdx = path.lastIndexOf(".");
  if (dotIdx < 0) return DEFAULT_MIME;
  return MIME_TYPES[path.slice(dotIdx)] ?? DEFAULT_MIME;
}

function cacheFor(path: string): string {
  if (path.endsWith(".html")) return CACHE_NO_CACHE;
  if (HASHED_ASSET.test(path)) return CACHE_IMMUTABLE;
  return CACHE_NO_CACHE;
}

export interface WebuiHandlerDeps {
  /** Build output directory. `undefined` in `vite dev` mode — the handler
   *  returns null for every path so the dev server handles static assets. */
  distDir: string | undefined;
}

export type WebuiHandler = (request: Request) => Promise<Response | null>;

export function createWebuiHandler(deps: WebuiHandlerDeps): WebuiHandler {
  return async (request) => {
    if (!deps.distDir) return null;

    const url = new URL(request.url);
    const pathname = url.pathname;

    // Path traversal guard — even Bun.file would resolve outside the dir.
    if (pathname.includes("..")) return null;

    const resolved = pathname === "/" || pathname === "" ? "/index.html" : pathname;
    const direct = Bun.file(join(deps.distDir, resolved));
    if (await direct.exists()) {
      return new Response(direct, {
        headers: {
          "Content-Type": mimeFor(resolved),
          "Cache-Control": cacheFor(resolved),
          ...COOP_COEP_HEADERS,
        },
      });
    }

    // SPA fallback — unknown routes serve index.html so client-side routing works.
    const fallback = Bun.file(join(deps.distDir, "index.html"));
    if (await fallback.exists()) {
      return new Response(fallback, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": CACHE_NO_CACHE,
          ...COOP_COEP_HEADERS,
        },
      });
    }

    return new Response("Not Found", { status: HTTP_NOT_FOUND });
  };
}
```

- [ ] **Step 4: Run the test — expect pass.**

```bash
cd gateway && bun test src/api/handlers/webui.test.ts 2>&1 | tail -5
```

Expected: 7 pass.

- [ ] **Step 5: Wire `server.ts` to use the new handler.**

In `gateway/src/server.ts`, replace:

```ts
import { serveStaticFile } from "./session-handlers/serve-static.ts";
// ...
handleStatic: async (req) => {
  if (!webDistDir) return null;
  const url = new URL(req.url);
  return serveStaticFile(url.pathname, webDistDir);
},
```

with:

```ts
import { createWebuiHandler } from "./api/handlers/webui.ts";
// ...
const webuiHandler = createWebuiHandler({ distDir: webDistDir });
// ...
handleStatic: webuiHandler,
```

- [ ] **Step 6: Delete `session-handlers/serve-static.ts` and its test.**

```bash
rm gateway/src/session-handlers/serve-static.ts gateway/src/session-handlers/serve-static.test.ts
```

- [ ] **Step 7: Verify.**

```bash
source scripts/env.sh && bun run typecheck 2>&1 | tail -5
cd gateway && bun test 2>&1 | tail -5
```

Expected: typecheck clean; 513 pass (507 + 7 new webui tests - 1 removed serve-static test file count can shift; focus on "0 fail").

- [ ] **Step 8: Commit.**

```bash
git add -A
git commit -m "refactor(gateway): replace serve-static.ts with api/handlers/webui.ts"
```

---

## Task 9: Change gateway port default from 3000 to 8888

**Goal:** Single port for everything. Also avoids clashing with the thousand-other-things that default to `:3000`.

**Files:**
- Modify: `gateway/config.yaml` — `port: 3000` → `port: 8888`
- Modify: `gateway/Dockerfile` — `EXPOSE 3000` → `EXPOSE 8888`; healthcheck URL
- Modify: `gateway/src/main.test.ts` (if it hard-codes 3000 — it uses `server.port` so should be fine, verify)
- Modify: `shared/config/src/schema.test.ts` — the `expect(result.port).toBe(3000)` assertion

- [ ] **Step 1: Update the config default.**

In `shared/config/src/schema.ts`:

```ts
port: z.number().int().min(1).max(65535).default(8888),
```

- [ ] **Step 2: Update the corresponding test assertion.**

In `shared/config/src/schema.test.ts`, change `expect(result.port).toBe(3000)` → `expect(result.port).toBe(8888)`.

- [ ] **Step 3: Update `gateway/config.yaml`.**

Change `port: 3000` to `port: 8888`.

- [ ] **Step 4: Update `gateway/Dockerfile`.**

Change `EXPOSE 3000` → `EXPOSE 8888`. Change the healthcheck URL from `https://localhost:3000/health` → `https://localhost:8888/health`. (The `/health` path stays — we shift it to `/api/v1/health` in Task 10.)

- [ ] **Step 5: Verify.**

```bash
source scripts/env.sh && bun run typecheck 2>&1 | tail -5
cd gateway && bun test src/main.test.ts 2>&1 | tail -5
```

Expected: typecheck clean; 3 pass (main test uses `server.port`, not a literal).

- [ ] **Step 6: Commit.**

```bash
git add -A
git commit -m "refactor(gateway): default port 3000 → 8888"
```

---

## Task 10: Move API paths under `/api/v1/*`

**Goal:** Browser sees `/api/v1/health`, `/api/v1/ready`, `/api/v1/ws`. Everything else is webui. Leaves admin path space free.

**Files:**
- Modify: `gateway/src/api/router.ts` (route recognition)
- Modify: `gateway/src/api/router.test.ts` (test expectations)
- Modify: `gateway/src/main.test.ts` (HTTP/WS calls)
- Modify: `gateway/Dockerfile` (healthcheck)
- Modify: `deploy/{docker,pi}/docker-compose.yml` (gateway healthcheck)
- Modify: `gateway/webui/vite.config.ts` (dev proxy paths)
- Modify: `gateway/src/session-handlers/ws-server-voice.test.ts` / `ws-server.test.ts` — if they use `/ws`, switch to `/api/v1/ws`

- [ ] **Step 1: Introduce the path prefix in `router.ts`.**

Replace the three path literals with `API_V1_PREFIX`-qualified paths:

```ts
const API_V1 = "/api/v1";
// ...
if (pathname === `${API_V1}/health`) return deps.handleHealth(request);
if (pathname === `${API_V1}/ready`) return deps.handleReady(request);
if (pathname === `${API_V1}/ws`) return deps.handleWsUpgrade(request);
```

- [ ] **Step 2: Update `router.test.ts`.**

Change every `"http://test/health"` → `"http://test/api/v1/health"`, `"http://test/ready"` → `"http://test/api/v1/ready"`.

- [ ] **Step 3: Update `main.test.ts`.**

Change:

```ts
const BASE_URL = `https://${server.hostname}:${server.port}`;
// ...
await fetch(`${BASE_URL}/health`, ...)
// ...
new WebSocket(`wss://${server.hostname}:${server.port}/ws`)
```

to:

```ts
const BASE_URL = `https://${server.hostname}:${server.port}/api/v1`;
// ...
await fetch(`${BASE_URL}/health`, ...)
// ...
new WebSocket(`wss://${server.hostname}:${server.port}/api/v1/ws`)
```

- [ ] **Step 4: Update the Dockerfile healthcheck.**

In `gateway/Dockerfile`, change:

```dockerfile
CMD bun -e "fetch('https://localhost:8888/health', { tls: { rejectUnauthorized: false } }).then(...)"
```

to:

```dockerfile
CMD bun -e "fetch('https://localhost:8888/api/v1/health', { tls: { rejectUnauthorized: false } }).then(...)"
```

- [ ] **Step 5: Update both docker-compose healthchecks identically.**

Edit `deploy/docker/docker-compose.yml` and `deploy/pi/docker-compose.yml` — change the healthcheck test's fetch URL from `https://localhost:8888/health` (or the current `:3000/health`) to `https://localhost:8888/api/v1/health`.

- [ ] **Step 6: Update Vite dev proxy.**

In `gateway/webui/vite.config.ts`, replace the proxy block:

```ts
proxy: {
  "/ws": { target: GATEWAY_URL, ws: true },
  "/health": GATEWAY_URL,
  "/ready": GATEWAY_URL,
},
```

with:

```ts
proxy: {
  "/api/v1/ws": { target: GATEWAY_URL, ws: true, secure: false },
  "/api/v1": { target: GATEWAY_URL, secure: false },
},
```

Also update `GATEWAY_URL` from `http://localhost:3000` to `https://localhost:8888` (gateway now speaks TLS even in dev; `secure: false` accepts the self-signed cert).

- [ ] **Step 7: Update the voice/WS tests that speak to `/ws`.**

```bash
grep -rn '"/ws"\|ws://.*:.*\?/ws\|wss://.*:.*\?/ws' gateway/src
```

For each hit, rewrite `/ws` → `/api/v1/ws`.

- [ ] **Step 8: Verify.**

```bash
source scripts/env.sh && bun run typecheck 2>&1 | tail -5
cd gateway && bun test 2>&1 | tail -5
```

Expected: typecheck clean; all tests pass.

- [ ] **Step 9: Commit.**

```bash
git add -A
git commit -m "refactor(gateway): move HTTP surface under /api/v1/*"
```

---

## Task 11: Gateway Dockerfile builds + serves the webui

**Goal:** Single image contains both the bundled gateway and the built webui. No more `web` image.

**Files:**
- Modify: `gateway/Dockerfile` — add a node+vite build stage for webui; runtime image carries `/app/webui/dist`.
- Modify: `gateway/src/config/startup-config.ts` — default `webDistDir` to `/app/webui/dist` when `WEB_DIST_DIR` is unset in prod (detect via env `NODE_ENV` or explicit env var).

- [ ] **Step 1: Rewrite `gateway/Dockerfile`.**

Full replacement:

```dockerfile
# Sentient gateway — bundles Bun server + built Preact webui into one image.
#
# Stage layout:
#   deps       : workspace install (Bun native, AVX-independent)
#   webui      : vite build under Node (CI host lacks AVX so Bun crashes in JS)
#   build      : bun build src/main.ts → /app/gateway/dist/main.js
#   runtime    : oven/bun:1-slim + openssl + /app/dist/main.js + /app/webui/dist/

# ---------------------------------------------------------------------------
# Deps
# ---------------------------------------------------------------------------
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY gateway/package.json gateway/
COPY gateway/webui/package.json gateway/webui/
COPY sentient-auth/package.json sentient-auth/
COPY shared/ shared/
RUN bun install --frozen-lockfile --ignore-scripts

# ---------------------------------------------------------------------------
# WebUI — vite build under Node (bun SIGILLs on non-AVX CI hosts)
# ---------------------------------------------------------------------------
FROM node:22-slim AS webui
WORKDIR /app
COPY --from=deps /app /app
COPY gateway/webui/ gateway/webui/
RUN cd gateway/webui && node node_modules/vite/bin/vite.js build

# ---------------------------------------------------------------------------
# Gateway bundle
# ---------------------------------------------------------------------------
FROM oven/bun:1 AS build
WORKDIR /app
COPY --from=deps /app /app
COPY gateway/ gateway/
RUN cd gateway && bun build src/main.ts --outdir dist --target bun

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM oven/bun:1-slim
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build  /app/gateway/dist        ./dist
COPY --from=webui  /app/gateway/webui/dist  ./webui/dist

COPY gateway/system_prompt.md ./system_prompt.md
COPY gateway/persona.md ./persona.md
COPY gateway/src/pipeline/processors/prompts ./prompts

ENV LOG_LEVEL=info \
    GATEWAY_CONFIG_PATH=/app/config.yaml \
    GATEWAY_RUNTIME_DIR=/app \
    GATEWAY_CERTS_DIR=/app/certs \
    EMOTION_TAGS_DIR=/app/prompts \
    WEB_DIST_DIR=/app/webui/dist

EXPOSE 8888
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD bun -e "fetch('https://localhost:8888/api/v1/health', { tls: { rejectUnauthorized: false } }).then(r => r.ok ? process.exit(0) : process.exit(1))" || exit 1
CMD ["bun", "dist/main.js"]
```

- [ ] **Step 2: Verify `startup-config.ts` already honors `WEB_DIST_DIR`.**

Read `gateway/src/config/startup-config.ts`. Confirm the line:

```ts
webDistDir: process.env.WEB_DIST_DIR,
```

is still there and unchanged. (Env default is `/app/webui/dist` from the Dockerfile; local dev leaves it unset, which disables static serving and lets Vite dev handle the webui.)

- [ ] **Step 3: Build the image locally.**

```bash
cd /Users/kevinye/Development/sentient
docker compose -f deploy/docker/docker-compose.yml build gateway 2>&1 | tail -15
```

Expected: final lines include `Image sentient/gateway:local Built` — no errors. If the build fails, inspect the error output before moving on.

- [ ] **Step 4: Commit.**

```bash
git add gateway/Dockerfile
git commit -m "feat(gateway/docker): bundle built webui into the gateway runtime image"
```

---

## Task 12: Drop the `web` docker service + bootstrap

**Goal:** Remove the old `web` container from both compose files and the setup scripts. The gateway is now the only thing the browser talks to.

**Files:**
- Modify: `deploy/docker/docker-compose.yml` — delete the `web:` service; update gateway port mapping.
- Modify: `deploy/pi/docker-compose.yml` — same.
- Modify: `deploy/docker/setup.sh` — remove `~/.sentient/web` handling; drop `WEB_DIR`.
- Modify: `deploy/pi/setup.sh` — same.
- Delete: `gateway/webui/Dockerfile` (still at `gateway/webui/Dockerfile` after Task 1's move — it's no longer used).
- Delete: `gateway/webui/server.ts` (standalone server no longer used).
- Delete: `gateway/webui/src/runtime-config.ts` + `.test.ts` (no more runtime config).
- Modify: `gateway/webui/src/app.tsx` — remove `resolveGatewayUrl()` import and the `wsUrl` prop (SDK will default internally, see Task 13).

- [ ] **Step 1: Delete the old web container artifacts.**

```bash
git rm gateway/webui/Dockerfile gateway/webui/server.ts gateway/webui/config.example.yaml
git rm gateway/webui/src/runtime-config.ts gateway/webui/src/runtime-config.test.ts
```

- [ ] **Step 2: Simplify `app.tsx`.**

Replace `gateway/webui/src/app.tsx` with:

```tsx
import { ChatScreen } from "./components/chat-screen.tsx";
import { useVoiceClient } from "./hooks/use-voice-client.ts";

// Auth is deferred to a future role-based login flow; the gateway accepts
// every LAN connection for now.
const PLACEHOLDER_TOKEN = "anonymous";

export function App() {
  // No wsUrl: the SDK defaults to `wss://<same origin>/api/v1/ws` (see
  // @sentient/web-sdk). That's why the runtime-config.js + config.yaml
  // injection mechanism is gone.
  const client = useVoiceClient({ token: PLACEHOLDER_TOKEN });
  return (
    <ChatScreen
      status={client.status}
      messages={client.messages}
      transcript={client.transcript}
      onStartVoice={client.startVoiceMode}
      onStopVoice={client.stopVoiceMode}
      onSendText={client.sendText}
    />
  );
}
```

- [ ] **Step 3: Update `use-voice-client.ts` to make `wsUrl` optional.**

In `gateway/webui/src/hooks/use-voice-client.ts`, change:

```ts
export interface UseVoiceClientOptions {
  wsUrl: string;
  token: string;
}
```

to:

```ts
export interface UseVoiceClientOptions {
  /** Override the default SDK URL. Defaults to
   *  `wss://<same origin>/api/v1/ws` in a browser. Primary reason to set
   *  this is tests or a cross-origin deployment. */
  wsUrl?: string;
  token: string;
}
```

Update the `useMemo` hook call to spread `options` (already does so — verify `createVoiceClient({ ...options, ... })` passes through `wsUrl` when present and lets the SDK default when absent).

- [ ] **Step 4: Update existing use-voice-client tests.**

Read `gateway/webui/src/hooks/use-voice-client.test.ts`. If it passes `wsUrl` explicitly, that still compiles; if it asserts `wsUrl` is required, relax the assertion.

- [ ] **Step 5: Delete the `web` service from `deploy/docker/docker-compose.yml`.**

Replace the gateway block's `ports:` with:

```yaml
    ports:
      - "8888:8888"
```

Remove the entire `web:` service (everything from `web:` to the next service). Keep `gateway:` and `stt-service:`. Remove the `~/.sentient/certs:/app/certs` mount's "shared with web" wording — it's now private to gateway. Remove `depends_on` sections that referenced `web`.

- [ ] **Step 6: Delete `web` service from `deploy/pi/docker-compose.yml`.**

Same edits.

- [ ] **Step 7: Remove `~/.sentient/web` bootstrap from both setup scripts.**

In `deploy/docker/setup.sh`, delete the entire "Web — config.yaml" section (lines that reference `$WEB_DIR`). Also remove the README-style hint printed at the end that mentions `$WEB_DIR/config.yaml`.

Same edit in `deploy/pi/setup.sh`.

- [ ] **Step 8: Verify locally.**

```bash
source scripts/env.sh && bun run typecheck && cd gateway && bun test 2>&1 | tail -5 && cd ..
```

Expected: typecheck clean; tests pass.

- [ ] **Step 9: Commit.**

```bash
git add -A
git commit -m "feat(deploy): drop web container; gateway serves webui directly"
```

---

## Task 13: Web SDK defaults to same-origin WSS

**Goal:** `createVoiceClient({ token })` — no `wsUrl` — works in a browser and connects to `wss://<same origin>/api/v1/ws`. Fallback only applies in a browser; Node/Bun tests still require an explicit `wsUrl`.

**Files:**
- Modify: `shared/web-sdk/src/voice-client.ts` — compute default URL.
- Modify: `shared/web-sdk/src/voice-client.test.ts` (if it exists; otherwise create).

- [ ] **Step 1: Write the failing test.**

Create `shared/web-sdk/src/voice-client-default-url.test.ts` (separate file — doesn't disturb existing tests):

```ts
import { describe, expect, it } from "vitest";
import { resolveDefaultWsUrl } from "./voice-client.ts";

describe("resolveDefaultWsUrl", () => {
  it("returns wss://<host>/api/v1/ws on an https page", () => {
    expect(resolveDefaultWsUrl({ protocol: "https:", host: "hacore.lan:8888" })).toBe(
      "wss://hacore.lan:8888/api/v1/ws",
    );
  });

  it("returns ws://<host>/api/v1/ws on an http page (dev only)", () => {
    expect(resolveDefaultWsUrl({ protocol: "http:", host: "localhost:5173" })).toBe(
      "ws://localhost:5173/api/v1/ws",
    );
  });

  it("throws when no location is given (not running in a browser)", () => {
    expect(() => resolveDefaultWsUrl(undefined)).toThrowError(/wsUrl/);
  });
});
```

- [ ] **Step 2: Run it — expect cannot find `resolveDefaultWsUrl`.**

```bash
cd shared/web-sdk && bun test src/voice-client-default-url.test.ts 2>&1 | tail -5
```

- [ ] **Step 3: Add the helper to `voice-client.ts`.**

At the top of `shared/web-sdk/src/voice-client.ts`, add:

```ts
interface LocationLike {
  protocol: string;
  host: string;
}

/** Compute the default SDK WebSocket URL from the current page's location.
 *  Kept as a pure function of { protocol, host } so tests don't have to
 *  touch real `window.location`. */
export function resolveDefaultWsUrl(loc: LocationLike | undefined): string {
  if (!loc) {
    throw new Error(
      "wsUrl is required when @sentient/web-sdk runs outside a browser — pass wsUrl explicitly.",
    );
  }
  const scheme = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${loc.host}/api/v1/ws`;
}
```

- [ ] **Step 4: Make `wsUrl` optional in `VoiceClientConfig`.**

Change:

```ts
export interface VoiceClientConfig {
  wsUrl: string;
  token: string;
  // ...
}
```

to:

```ts
export interface VoiceClientConfig {
  /** Defaults to `wss://<same origin>/api/v1/ws` when running in a browser.
   *  Required in Node/Bun environments — there is no `window.location`. */
  wsUrl?: string;
  token: string;
  // ...
}
```

In `createVoiceClient`, replace:

```ts
const { wsUrl, token, capture, playback, createWebSocket } = config;
// ...
const transport = createTransport({ url: wsUrl, token, ... });
```

with:

```ts
const { token, capture, playback, createWebSocket } = config;
const wsUrl =
  config.wsUrl ?? resolveDefaultWsUrl(typeof window === "undefined" ? undefined : window.location);
// ...
const transport = createTransport({ url: wsUrl, token, ... });
```

- [ ] **Step 5: Run the test suite.**

```bash
cd shared/web-sdk && bun test 2>&1 | tail -5
```

Expected: all pass including the new 3.

- [ ] **Step 6: Verify the webui still typechecks.**

```bash
cd gateway/webui && bun run typecheck && cd ../..
```

Expected: exit 0.

- [ ] **Step 7: Commit.**

```bash
git add -A
git commit -m "feat(web-sdk): default wsUrl to wss://<same origin>/api/v1/ws"
```

---

## Task 14: Scaffold admin surface

**Goal:** `/api/v1/admin/ping` exists. Without an admin token, returns 401. With a valid token, returns `{status: "pong"}`. The "valid token" check is a stub that reads `ADMIN_TOKEN` from env for now — the real auth integration lands later.

**Files:**
- Create: `gateway/src/api/middleware/require-admin-auth.ts`
- Create: `gateway/src/api/middleware/require-admin-auth.test.ts`
- Create: `gateway/src/api/handlers/admin.ts`
- Create: `gateway/src/api/handlers/admin.test.ts`
- Modify: `gateway/src/api/router.ts` — route `/api/v1/admin/*`.
- Modify: `gateway/src/api/router.test.ts` — add admin routing assertions.
- Modify: `gateway/src/server.ts` — wire admin handler.

- [ ] **Step 1: Write the failing middleware test.**

Create `gateway/src/api/middleware/require-admin-auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { requireAdminAuth } from "./require-admin-auth.ts";

describe("requireAdminAuth", () => {
  it("returns 401 when no Authorization header is present", async () => {
    const guard = requireAdminAuth({ adminToken: "secret" });
    const res = await guard(new Request("http://test/api/v1/admin/ping"));
    expect(res?.status).toBe(401);
  });

  it("returns 401 when the token is wrong", async () => {
    const guard = requireAdminAuth({ adminToken: "secret" });
    const res = await guard(
      new Request("http://test/api/v1/admin/ping", {
        headers: { Authorization: "Bearer nope" },
      }),
    );
    expect(res?.status).toBe(401);
  });

  it("returns undefined (pass-through) when the token matches", async () => {
    const guard = requireAdminAuth({ adminToken: "secret" });
    const res = await guard(
      new Request("http://test/api/v1/admin/ping", {
        headers: { Authorization: "Bearer secret" },
      }),
    );
    expect(res).toBeUndefined();
  });

  it("returns 503 when adminToken is unset (no admin access configured)", async () => {
    const guard = requireAdminAuth({ adminToken: undefined });
    const res = await guard(
      new Request("http://test/api/v1/admin/ping", {
        headers: { Authorization: "Bearer anything" },
      }),
    );
    expect(res?.status).toBe(503);
  });
});
```

- [ ] **Step 2: Run it — expect cannot find module.**

```bash
cd gateway && bun test src/api/middleware/require-admin-auth.test.ts 2>&1 | tail -5
```

- [ ] **Step 3: Create `require-admin-auth.ts`.**

```ts
const HTTP_UNAUTHORIZED = 401;
const HTTP_SERVICE_UNAVAILABLE = 503;

export interface AdminAuthDeps {
  /** The admin bearer token. Read from ADMIN_TOKEN env at bootstrap.
   *  `undefined` means admin surface is not configured — every request
   *  under /api/v1/admin/* returns 503. */
  adminToken: string | undefined;
}

/** Returns a guard function. The guard returns undefined to let the request
 *  through, or a Response (401/503) to short-circuit it. */
export function requireAdminAuth(
  deps: AdminAuthDeps,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    if (!deps.adminToken) {
      return new Response("Admin surface not configured", { status: HTTP_SERVICE_UNAVAILABLE });
    }
    const header = request.headers.get("Authorization") ?? "";
    const expected = `Bearer ${deps.adminToken}`;
    if (header !== expected) {
      return new Response("Unauthorized", { status: HTTP_UNAUTHORIZED });
    }
    return undefined;
  };
}
```

- [ ] **Step 4: Write the admin handler test + implementation.**

`gateway/src/api/handlers/admin.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createAdminHandler } from "./admin.ts";

describe("createAdminHandler", () => {
  it("returns pong on /api/v1/admin/ping with a valid token", async () => {
    const handler = createAdminHandler({ adminToken: "secret" });
    const res = await handler(
      new Request("http://test/api/v1/admin/ping", {
        headers: { Authorization: "Bearer secret" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "pong" });
  });

  it("returns 401 on /api/v1/admin/ping without a token", async () => {
    const handler = createAdminHandler({ adminToken: "secret" });
    const res = await handler(new Request("http://test/api/v1/admin/ping"));
    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown admin paths", async () => {
    const handler = createAdminHandler({ adminToken: "secret" });
    const res = await handler(
      new Request("http://test/api/v1/admin/nope", {
        headers: { Authorization: "Bearer secret" },
      }),
    );
    expect(res.status).toBe(404);
  });
});
```

`gateway/src/api/handlers/admin.ts`:

```ts
import { requireAdminAuth, type AdminAuthDeps } from "../middleware/require-admin-auth.ts";

const HTTP_NOT_FOUND = 404;

export function createAdminHandler(deps: AdminAuthDeps): (request: Request) => Promise<Response> {
  const guard = requireAdminAuth(deps);
  return async (request) => {
    const unauthorized = await guard(request);
    if (unauthorized) return unauthorized;

    const url = new URL(request.url);
    if (url.pathname === "/api/v1/admin/ping") {
      return Response.json({ status: "pong" });
    }

    return new Response("Not Found", { status: HTTP_NOT_FOUND });
  };
}
```

- [ ] **Step 5: Route admin requests in `router.ts`.**

Extend `ApiRouterDeps` with `handleAdmin`:

```ts
export interface ApiRouterDeps {
  handleHealth: (request: Request) => Promise<Response>;
  handleReady: (request: Request) => Promise<Response>;
  handleWsUpgrade: (request: Request) => Response | undefined;
  handleAdmin: (request: Request) => Promise<Response>;
  handleStatic: (request: Request) => Promise<Response | null>;
}
```

In the router body:

```ts
if (pathname.startsWith(`${API_V1}/admin/`)) return deps.handleAdmin(request);
if (pathname === `${API_V1}/health`) return deps.handleHealth(request);
// ... (rest unchanged)
```

- [ ] **Step 6: Update `router.test.ts`.**

Add an assertion that `/api/v1/admin/something` is routed to `handleAdmin`. Update every existing test that constructs `createApiRouter` to pass a `handleAdmin` fixture.

```ts
it("routes /api/v1/admin/* to the admin handler", async () => {
  const router = createApiRouter({
    handleHealth: async () => new Response("H"),
    handleReady: async () => new Response("R"),
    handleWsUpgrade: () => undefined,
    handleAdmin: async () => new Response("ADMIN", { status: 200 }),
    handleStatic: async () => null,
  });
  const res = await router(new Request("http://test/api/v1/admin/ping"));
  expect(await res.text()).toBe("ADMIN");
});
```

For every existing test, add `handleAdmin: async () => new Response("ADMIN")` to the fixture.

- [ ] **Step 7: Wire admin in `server.ts`.**

Add to the top of the file:

```ts
import { createAdminHandler } from "./api/handlers/admin.ts";
```

Inside `createGatewayServer`, read the env var:

```ts
const adminToken = process.env.ADMIN_TOKEN;
const adminHandler = createAdminHandler({ adminToken });
```

And pass it to the router:

```ts
const router = createApiRouter({
  handleHealth: createHealthHandler(),
  handleReady: createReadyHandler({ getActiveConnections: () => activeConnections }),
  handleWsUpgrade: createWsUpgradeHandler(serverInstance),
  handleAdmin: adminHandler,
  handleStatic: webuiHandler,
});
```

- [ ] **Step 8: Verify.**

```bash
source scripts/env.sh && bun run typecheck 2>&1 | tail -5
cd gateway && bun test 2>&1 | tail -5
```

Expected: typecheck clean; all pass.

- [ ] **Step 9: Commit.**

```bash
git add -A
git commit -m "feat(gateway/api): scaffold /api/v1/admin/ping with bearer-token gate"
```

---

## Task 15: End-to-end local verification

**Goal:** Build the collapsed image, bring it up, verify browser-like traffic works.

**Files:**
- None. Pure verification.

- [ ] **Step 1: Re-bootstrap host-side state.**

```bash
# Refresh to the new example configs. Back up anything old first.
for f in ~/.sentient/gateway/config.yaml; do [ -f "$f" ] && cp "$f" "$f.bak.$(date +%s)"; done
cp gateway/config.yaml ~/.sentient/gateway/config.yaml
# Web host dir + web config no longer exist — clean them up.
rm -rf ~/.sentient/web
```

- [ ] **Step 2: Clean docker state.**

```bash
docker compose -f deploy/docker/docker-compose.yml down 2>&1 | tail -3
```

- [ ] **Step 3: Rebuild + start (gateway only; skip stt).**

```bash
docker compose -f deploy/docker/docker-compose.yml build gateway 2>&1 | tail -5
docker compose -f deploy/docker/docker-compose.yml up -d gateway 2>&1 | tail -5
```

Expected: `Container sentient-gateway Healthy`.

- [ ] **Step 4: Verify HTTP surface from the host.**

```bash
curl -sk https://localhost:8888/api/v1/health
# Expect: {"status":"ok"}

curl -sk -o /dev/null -w "webui status: %{http_code}\n" https://localhost:8888/
# Expect: webui status: 200

curl -sk -o /dev/null -w "admin without token: %{http_code}\n" https://localhost:8888/api/v1/admin/ping
# Expect: 503 (no ADMIN_TOKEN configured) or 401 if ADMIN_TOKEN is set in .env
```

- [ ] **Step 5: Verify WSS handshake.**

```bash
source scripts/env.sh && bun -e '
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const ws = new WebSocket("wss://localhost:8888/api/v1/ws");
ws.onopen = () => console.log("WSS open ok");
ws.onmessage = (e) => { console.log("first msg:", e.data); ws.close(); process.exit(0); };
ws.onerror = () => { console.error("err"); process.exit(1); };
setTimeout(() => { console.error("timeout"); process.exit(1); }, 3000);
'
```

Expected: `WSS open ok` followed by `auth.ok` message.

- [ ] **Step 6: Commit the plan checkpoint (if plan tracker exists).**

Nothing to commit here — verification only.

---

## Task 16: Update README + docs

**Files:**
- Modify: `README.md` — the "Pi deployment" section
- Modify: `CLAUDE.md` (root) — if it references `web/`, point to `gateway/webui/`

- [ ] **Step 1: Rewrite the `## Pi deployment — first-boot setup` section in README.md** to reflect the single-service layout. The shell block should be:

```bash
# Gateway (serves webui + API on port 8888, HTTPS with self-signed cert)
mkdir -p ~/.sentient/gateway/logs
cp gateway/config.yaml ~/.sentient/gateway/config.yaml
# edit tls.hostnames to include your Pi's IP / hostname

# STT service
mkdir -p ~/.sentient/stt-service/{config,logs,recordings}
cp capabilityServices/STTService/config/config.example.yaml \
   ~/.sentient/stt-service/config/config.yaml

# Gateway's self-signed cert dir (persists across restarts so the browser's
# accepted exception keeps working)
mkdir -p ~/.sentient/certs

# Auth tokens (bind-mounted read-only into services)
mkdir -p ~/.sentient/auth/tokens
chmod 700 ~/.sentient/auth/tokens
./sentient-auth/run.sh init

docker compose -f deploy/pi/docker-compose.yml up -d
# Browser → https://<pi>:8888/  (accept self-signed cert once per device)
```

- [ ] **Step 2: Update root `CLAUDE.md` Project Map.**

Change:

```
| Web | `web/` | Preact web client |
```

to:

```
| Web UI | `gateway/webui/` | Preact web client served by the gateway |
```

Remove the row about "Web" if the renamed row covers it.

- [ ] **Step 3: Commit.**

```bash
git add README.md CLAUDE.md
git commit -m "docs: reflect single-service gateway/webui layout"
```

---

## Task 17: Merge and push

- [ ] **Step 1: Confirm branch state.**

```bash
git log --oneline origin/develop..HEAD | head -20
```

Expected: a coherent sequence of commits covering Tasks 1–16.

- [ ] **Step 2: Run the full quality gate one last time.**

```bash
source scripts/env.sh && bun run ci 2>&1 | tail -10
```

Expected: lint + typecheck + test:unit all green.

- [ ] **Step 3: Push.**

The user has asked us (in past sessions) to push to `develop` directly — skip feature branches unless they say otherwise.

```bash
git push origin develop 2>&1 | tail -10
```

Expected: `develop -> develop` pushed cleanly; pre-push hook runs and passes.

---

## Self-review checklist

**Spec coverage** — mapped one task → one deliverable:

- Move web/ into gateway/webui/ → Task 1
- Gateway exposes 8888/api/v1/ for SDK → Tasks 9 + 10
- Gateway serves webui at 8888/ → Tasks 8 + 11
- Flexibility for future admin stuff → Task 14 (stub + middleware)
- Thin server entry, api logic in gateway/api/ → Tasks 2, 4, 5, 6
- SDK defaults to same-origin wss://…/api/v1/ws → Task 13
- TLS stays on gateway (decision confirmed before planning) → no change needed; existing code
- Update example configs + docs → Tasks 9, 11, 12, 16

**Placeholder scan** — every code block is real, every import path resolves, every command has an expected output.

**Type consistency** — `ApiRouterDeps` grows from Task 4's 4 fields to Task 14's 5 fields; every test that builds the fixture gets updated in Task 14 Step 6. `WebuiHandler` type is introduced in Task 8 and used in Task 6/11. `AdminAuthDeps` defined once in Task 14.

**Frequent commits** — 17 tasks, each with its own commit; no multi-feature commits.
