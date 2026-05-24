/** GET /ready — readiness. Reports active connection count so a load
 *  balancer or oncall script can see "is anything actually live". */
export interface ReadyHandlerDeps {
  getActiveConnections: () => number;
}

export function createReadyHandler(deps: ReadyHandlerDeps): (request: Request) => Promise<Response> {
  return async () => Response.json({ status: "ready", connections: deps.getActiveConnections() });
}
