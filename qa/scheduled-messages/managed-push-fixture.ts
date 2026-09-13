#!/usr/bin/env bun
/**
 * Credential-free loopback stand-in for gateway/supervisor outage E2E only.
 * It proves no Gorush/APNs compatibility: no outbound client exists in this
 * process, and startup fails unless bound to the fixed loopback address.
 */
const hostname = process.env.PUSH_QA_HOST ?? "127.0.0.1";
const port = Number(process.env.PUSH_QA_PORT ?? "8088");
if (hostname !== "127.0.0.1" || port !== 8088) throw new Error("push QA fixture requires 127.0.0.1:8088");

const server = Bun.serve({
  hostname,
  port,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/healthz") return Response.json({ status: "ok" });
    if (request.method === "POST" && pathname === "/api/push") {
      return Response.json({ counts: 1, logs: [] });
    }
    if (request.method === "POST" && pathname === "/qa/stop") {
      setTimeout(() => {
        server.stop(true);
        process.exit(0);
      }, 25);
      return Response.json({ status: "stopping" });
    }
    return new Response("Not Found", { status: 404 });
  },
});
