// ---------------------------------------------------------------------------
// Shared ACP WebSocket abstraction.
//
// The minimal WS surface the ACP wire needs, plus the production Bun factory
// and the legacy `/ws` → `/acp` URL rewrite. Shared by wire-bootstrap.ts
// (orchestration) and acp-wire-socket.ts (swappable socket + reconnect) so the
// transport seam is defined once and tests can inject a mock in both places.
// ---------------------------------------------------------------------------

const ACP_PATH_SUFFIX = "/acp";
const LEGACY_WS_PATH_SUFFIX = "/ws";

export interface AcpWsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "close", listener: (e: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", listener: (e: unknown) => void): void;
  addEventListener(type: "message", listener: (e: { data: string | ArrayBuffer | Blob }) => void): void;
}

export type AcpWsFactory = (url: string, token: string) => AcpWsLike;

/** Default factory — Bun's WebSocket honors a `headers` option for Bearer auth. */
export const defaultWsFactory: AcpWsFactory = (url, token) => {
  // biome-ignore lint/suspicious/noExplicitAny: Bun supports headers param on WebSocket.
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } } as any);
  return ws as unknown as AcpWsLike;
};

/** Rewrite the legacy `/ws` suffix to `/acp` so the same per-profile port hosts both endpoints. */
export function deriveAcpUrl(wsUrl: string): string {
  if (wsUrl.endsWith(LEGACY_WS_PATH_SUFFIX)) {
    return `${wsUrl.slice(0, -LEGACY_WS_PATH_SUFFIX.length)}${ACP_PATH_SUFFIX}`;
  }
  return `${wsUrl.replace(/\/$/, "")}${ACP_PATH_SUFFIX}`;
}
