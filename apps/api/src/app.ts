import type { AccountErrorBody } from "@synara/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type pg from "pg";
import type { ApiConfig } from "./config";
import { createDb } from "./db";
import { createIdentityAdapters } from "./identity";
import type { IdentityAdapters } from "./identity/interfaces";
import { createV1Routes } from "./routes/v1";

/**
 * The largest request body any /api/v1 route accepts. Every payload this API
 * takes is small structured JSON — an email address, a token, a profile, a
 * host record whose contract-level field bounds sum to a few tens of KB — so
 * 64 KB is comfortably above any honest request while stopping an
 * unauthenticated caller from making `c.req.json()` buffer megabytes before
 * schema validation ever runs. The middleware rejects both an oversized
 * `Content-Length` up front and a streaming body the moment it crosses the
 * limit.
 */
export const API_MAX_BODY_BYTES = 64 * 1024;

export async function createApp(
  config: ApiConfig,
): Promise<{ app: Hono; identity: IdentityAdapters; pool: pg.Pool }> {
  const { db, pool } = createDb(config.databaseUrl);
  const identity = await createIdentityAdapters(config, db);

  const app = new Hono();

  // Before the routes, so no handler ever parses an oversized body. 413 in
  // the documented error shape: `validation_failed` because the cure is the
  // caller's (shrink the request), and the client already renders that code.
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: API_MAX_BODY_BYTES,
      onError: (c) => {
        const body: AccountErrorBody = {
          error: "validation_failed",
          message: "Request body is too large",
        };
        return c.json(body, 413);
      },
    }),
  );

  app.route(
    "/api/v1",
    createV1Routes({
      verifier: identity.verifier,
      grants: identity.grants,
      deviceCredentials: identity.deviceCredentials,
      environments: identity.environments,
      db,
      trustedProxyHops: config.trustedProxyHops,
    }),
  );

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
   * This service is an API and nothing else — there is no auth ceremony UI to
   * serve: email-code sign-in happens in the app, and SSO finishes on the
   * identity provider's own hosted page. A human who reaches the root (or any
   * other non-API path) gets a sentence telling them where they are rather
   * than a 404 that reads like an outage.
   */
  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      const body: AccountErrorBody = { error: "validation_failed", message: "Unknown API route" };
      return c.json(body, 404);
    }
    return c.text(
      "Synara account API. Sign in from the Synara app. See https://github.com/Emanuele-web04/synara",
      200,
    );
  });

  return { app, identity, pool };
}
