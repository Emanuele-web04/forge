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

  // TASK2: the AuthKit callback and device-flow endpoints mount here. Until
  // then non-API paths answer with a plain placeholder — the ceremony UI this
  // service used to serve is gone and WorkOS hosts the sign-in pages.
  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      const body: AccountErrorBody = { error: "validation_failed", message: "Unknown API route" };
      return c.json(body, 404);
    }
    return c.text("Synara accounts", 200);
  });

  return { app, auth, pool };
}
