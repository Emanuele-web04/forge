import type { AccountErrorBody } from "@synara/contracts";
import { Hono } from "hono";
import type pg from "pg";
import type { ApiConfig } from "./config";
import { createDb } from "./db";
import { createV1Routes } from "./routes/v1";
import { createWorkosAuth, type WorkosAuth } from "./workos";

export function createApp(config: ApiConfig): { app: Hono; auth: WorkosAuth; pool: pg.Pool } {
  const { db, pool } = createDb(config.databaseUrl);
  const auth = createWorkosAuth(config);

  const app = new Hono();

  app.route("/api/v1", createV1Routes({ auth, db, config }));

  /**
   * Safety net: any unhandled throw under /api/ still answers with an
   * AccountErrorBody. Without this Hono emits plain-text "Internal Server
   * Error", so a client parsing the documented JSON shape fails on exactly the
   * responses it most needs to read. Non-API paths keep the default handler.
   */
  app.onError((error, c) => {
    if (!c.req.path.startsWith("/api/")) throw error;
    console.error(`[api] unhandled error on ${c.req.method} ${c.req.path}`, error);
    const body: AccountErrorBody = {
      error: "internal_error",
      message: "Something went wrong handling this request",
    };
    return c.json(body, 500);
  });

  /**
   * This service is an API and nothing else — WorkOS AuthKit hosts every
   * sign-in page, so there is no UI to serve. A human who reaches the root
   * (or any other non-API path) gets a sentence telling them where they are
   * rather than a 404 that reads like an outage.
   */
  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      const body: AccountErrorBody = { error: "validation_failed", message: "Unknown API route" };
      return c.json(body, 404);
    }
    return c.text(
      "Synara account API. Sign-in is handled by WorkOS AuthKit. See https://github.com/Emanuele-web04/synara",
      200,
    );
  });

  return { app, auth, pool };
}
