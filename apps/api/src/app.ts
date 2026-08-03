import type { AccountErrorBody } from "@synara/contracts";
import { Hono } from "hono";
import type pg from "pg";
import { createAuth, type Auth } from "./auth";
import type { ApiConfig } from "./config";
import { createDb } from "./db";
import { createV1Routes } from "./routes/v1";

// Placeholder until Task 7 wires up real static serving from a built UI
// directory; kept as its own function so that swap is a one-line change.
function renderPlaceholderUi(): string {
  return '<!doctype html><html><head><meta charset="utf-8" /><title>Synara accounts</title></head><body>Synara accounts — UI arrives with the ceremony pages build</body></html>';
}

export function createApp(config: ApiConfig): { app: Hono; auth: Auth; pool: pg.Pool } {
  const { db, pool } = createDb(config.databaseUrl);
  const auth = createAuth(config, db);

  const app = new Hono();

  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.route("/api/v1", createV1Routes({ auth, db, config }));

  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      const body: AccountErrorBody = { error: "validation_failed", message: "Unknown API route" };
      return c.json(body, 404);
    }
    return c.html(renderPlaceholderUi());
  });

  return { app, auth, pool };
}
