// FILE: index.ts
// Purpose: First executable CORTEX Cloud control-plane process. It deliberately serves only
//          operational endpoints until cloud identity and tenant authorization are implemented.
// Layer: Cloud control-plane entrypoint; never import this into the local Synara server.

import { SQL } from "bun";

import { loadCloudControlConfig } from "./config";

const config = loadCloudControlConfig(process.env);
const sql = new SQL({ url: config.databaseUrl });

function requestId(request: Request): string {
  const incoming = request.headers.get("x-request-id");
  return incoming && /^[A-Za-z0-9._-]{8,128}$/u.test(incoming) ? incoming : crypto.randomUUID();
}

function response(body: unknown, status: number, id: string): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-request-id": id },
  });
}

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  async fetch(request) {
    const id = requestId(request);
    const { pathname } = new URL(request.url);
    const startedAt = performance.now();
    let status = 500;
    try {
      if (request.method === "GET" && pathname === "/healthz") {
        status = 200;
        return response({ status: "ok", service: "cortex-cloud-control" }, status, id);
      }
      if (request.method === "GET" && pathname === "/readyz") {
        await sql`SELECT 1`;
        status = 200;
        return response({ status: "ready", service: "cortex-cloud-control" }, status, id);
      }
      if (pathname.startsWith("/v1/")) {
        // Cloud user authentication and transaction-scoped tenant context must land before an
        // API handler. Rejecting rather than trusting caller-provided IDs is intentional.
        status = 503;
        return response(
          { error: { code: "cloud_auth_not_configured", message: "CORTEX Cloud is in private preview." } },
          status,
          id,
        );
      }
      status = 404;
      return response({ error: { code: "not_found", message: "Not found." } }, status, id);
    } catch (cause) {
      console.error(JSON.stringify({ event: "cloud_request_failed", requestId: id, path: pathname, cause: String(cause) }));
      status = 503;
      return response({ error: { code: "service_unavailable", message: "Service unavailable." } }, status, id);
    } finally {
      console.info(JSON.stringify({ event: "cloud_request", requestId: id, method: request.method, path: pathname, status, durationMs: Math.round(performance.now() - startedAt) }));
    }
  },
});

console.info(JSON.stringify({ event: "cloud_control_started", host: server.hostname, port: server.port, environment: config.environment }));
