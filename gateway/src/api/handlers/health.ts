/** GET /health — liveness. Always 200 once the process is up. */
export function createHealthHandler(): (request: Request) => Promise<Response> {
  return async () => Response.json({ status: "ok" });
}
