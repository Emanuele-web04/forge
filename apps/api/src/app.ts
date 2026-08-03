import type { AccountErrorBody } from "@synara/contracts";
import { Hono } from "hono";
import type pg from "pg";
import { createAuth, type Auth } from "./auth";
import type { ApiConfig } from "./config";
import { createDb } from "./db";
import { createV1Routes } from "./routes/v1";
import { mountUi } from "./staticUi";

export function createApp(config: ApiConfig): { app: Hono; auth: Auth; pool: pg.Pool } {
  const { db, pool } = createDb(config.databaseUrl);
  const auth = createAuth(config, db);

  const app = new Hono();

  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.route("/api/v1", createV1Routes({ auth, db, config }));

  mountUi(app, (c) => {
    const body: AccountErrorBody = { error: "validation_failed", message: "Unknown API route" };
    return c.json(body, 404);
  });

  return { app, auth, pool };
}
